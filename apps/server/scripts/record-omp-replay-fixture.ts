// Live omp replay-fixture recorder (#24): drives the real omp CLI through the real adapter in
// the orchestrator replay scenario, recording the raw omp RPC frame tape into the fixture NDJSON.
// Usage: node scripts/record-omp-replay-fixture.ts --scenario simple|multi_turn|turn_interrupt [--out <path>]
// Prompts run on whatever model omp resolves by default, so an authenticated provider is required.
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayEntry, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  makeOmpRecordingSpawner,
  materializeOmpReplayWorkspace,
  OmpOrchestratorReplayHarness,
} from "../src/orchestration-v2/Adapters/OmpAdapterV2.testkit.ts";
import * as OmpAdapterV2Testkit from "../src/orchestration-v2/Adapters/OmpAdapterV2.testkit.ts";
import { OMP_PROVIDER } from "@t3tools/provider-omp/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  checkpointWorkspace,
  makeCheckpointWorkspace,
} from "@t3tools/provider-testing/replayWorkspace";

// Follow wall time for live omp timers while retaining replay's TestClock steps.
const CLOCK_TICK = Duration.millis(20);

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const scenario = readArgValue("--scenario");
const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === scenario);
const variant = fixture?.providers.find((provider) => provider.driver === OMP_PROVIDER);
if (fixture === undefined || variant === undefined) {
  process.stderr.write(
    `Unknown --scenario ${scenario ?? "<missing>"}; expected one of ${ORCHESTRATOR_REPLAY_FIXTURES.filter(
      (entry) => entry.providers.some((provider) => provider.driver === OMP_PROVIDER),
    )
      .map((entry) => entry.name)
      .join(", ")}\n`,
  );
  process.exit(1);
}

const ompBinary = process.env.T3_OMP_BIN ?? "omp";
const home = process.env.HOME ?? "";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;
const NORMALIZED_EPOCH_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Normalize both directions consistently so echoed paths, UUIDs and times still match on replay.
function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly workspace: string;
}): ReadonlyArray<ProviderReplayEntry> {
  const sessionFiles = new Map<string, string>();
  const uuids = new Map<string, string>();
  let timeAnchorMs: number | undefined;
  const shiftTime = (ms: number): number => {
    timeAnchorMs ??= ms;
    return NORMALIZED_EPOCH_MS + (ms - timeAnchorMs);
  };
  // Session file names embed a wall-clock stamp + session UUID; rewrite to a stable per-recording name.
  const sessionStampPattern =
    /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl/gu;
  const normalizeString = (value: string): string =>
    value
      .replace(sessionStampPattern, (file) => {
        const existing = sessionFiles.get(file);
        if (existing !== undefined) return existing;
        const next = `/omp-sessions/session-${sessionFiles.size + 1}.jsonl`;
        sessionFiles.set(file, next);
        return next;
      })
      .replaceAll(input.workspace, "<workspace>")
      .replaceAll(home.length > 1 ? home : "\0", "~")
      .replace(ISO_TIMESTAMP_PATTERN, (iso) => {
        const shifted = DateTime.makeUnsafe(
          shiftTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso))),
        );
        return DateTime.formatIso(shifted);
      })
      .replace(UUID_PATTERN, (uuid) => {
        const existing = uuids.get(uuid.toLowerCase());
        if (existing !== undefined) return existing;
        const next = `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, "0")}`;
        uuids.set(uuid.toLowerCase(), next);
        return next;
      });
  const normalizeValue = (value: unknown): unknown => {
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "timestamp" && typeof entry === "number" ? shiftTime(entry) : normalizeValue(entry),
      ]),
    );
  };
  return input.entries.map((entry) =>
    entry.type === "runtime_exit" ? entry : { ...entry, frame: normalizeValue(entry.frame) },
  );
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function encodeTranscriptNdjson(transcript: ProviderReplayTranscript): string {
  const { entries, ...metadata } = transcript;
  return [
    encodeJson({ type: "transcript_start", ...metadata }),
    ...entries.map((entry) => encodeJson(entry)),
    "",
  ].join("\n");
}

// Follow wall time for live omp timers while retaining replay's TestClock steps.
const followWallClock = Effect.gen(function* () {
  while (true) {
    yield* TestClock.withLive(Effect.sleep(CLOCK_TICK));
    yield* TestClock.adjust(CLOCK_TICK);
  }
});

const readOmpVersion = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return (yield* spawner.string(ChildProcess.make(ompBinary, ["--version"]))).trim();
});

const record = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ompVersion = yield* readOmpVersion;
  const outputPath = readArgValue("--out") ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const fixtureInput = fixture.buildInput();
  const workspace = yield* Effect.promise(() =>
    makeCheckpointWorkspace(`omp-rpc-record-${fixture.name}`, fixtureInput.workspaceFiles),
  );
  const entries: Array<ProviderReplayEntry> = [];
  const placeholder: ProviderReplayTranscript = {
    provider: OMP_PROVIDER,
    protocol: "omp.rpc-jsonl",
    version: ompVersion,
    scenario: fixture.name,
    entries: [],
  };
  const layerRecordingSpawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(Effect.service(ChildProcessSpawner.ChildProcessSpawner), (live) =>
      makeOmpRecordingSpawner(live, entries),
    ),
  ).pipe(Layer.provide(NodeServices.layer));

  const materializeInput = materializeFixtureInput({
    scenario: fixture.name,
    fixtureInput,
    driver: variant.driver,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer));
  const continuationOptions =
    variant.runContinuationWorker === true ? { runContinuationWorker: true } : {};

  yield* Effect.gen(function* () {
    yield* followWallClock.pipe(Effect.forkScoped);
    const materialized = yield* materializeInput;
    yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/omp:record`,
        transcript: placeholder,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: workspace },
      },
      {
        driver: OMP_PROVIDER,
        decodeTranscript: Effect.succeed,
        makeProviderAdapterRegistryLayer: () =>
          OmpAdapterV2Testkit.layer({ scenario: fixture.name, spawner: layerRecordingSpawner }),
      },
      continuationOptions,
    );
  }).pipe(Effect.scoped, provideDeterministicTestRuntime);

  const transcript = {
    ...placeholder,
    metadata: {
      generatedBy: "live-omp-recorder",
      ompVersion,
      model: variant.modelSelection.model,
      // The adapter spawns exactly `omp --mode rpc [--approval-mode <mode>]`; the tape carries
      // the argv verbatim in its process_start entry.
      ompBinary,
    },
    entries: normalizeEntries({ entries, workspace }),
  } satisfies ProviderReplayTranscript;

  // Assert on normalized replay; the live projection has raw paths. Failed assertions preserve the fixture.
  yield* Effect.gen(function* () {
    const replayWorkspace = yield* checkpointWorkspace(fixture.name, fixtureInput.workspaceFiles);
    const materialized = yield* materializeInput;
    const replayResult = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/omp:verify`,
        transcript: yield* OmpOrchestratorReplayHarness.decodeTranscript(
          materializeOmpReplayWorkspace(transcript, replayWorkspace),
        ),
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: replayWorkspace },
      },
      OmpOrchestratorReplayHarness,
      continuationOptions,
    );
    variant.assertOutput(replayResult, transcript);
  }).pipe(Effect.scoped, provideDeterministicTestRuntime);

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* fs.writeFileString(outputPath, encodeTranscriptNdjson(transcript));
  yield* Console.log(`Wrote ${transcript.entries.length} omp RPC replay entries to ${outputPath}`);
});

await Effect.runPromise(record.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
