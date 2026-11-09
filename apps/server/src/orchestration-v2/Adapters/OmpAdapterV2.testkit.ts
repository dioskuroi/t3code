// Omp RPC replay harness (spec §4/#24): mirrors PiAdapterV2.testkit.ts. The transcript is a
// tape of raw omp RPC frames — `expect_outbound` lines the adapter wrote to the process stdin
// (plus a `process_start` entry per spawn) and `emit_inbound` lines the process emitted on
// stdout — replayed through the real OmpAdapterV2 by replacing ChildProcessSpawner.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderReplayEntry,
  ProviderInstanceId,
  type ProviderReplayEntry as ProviderReplayEntryType,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { makeOmpAdapterV2, OMP_PROVIDER } from "@t3tools/provider-omp/testing";

const OMP_RPC_REPLAY_PROTOCOL = "omp.rpc-jsonl";
const OMP_REPLAY_ANY = "<any>";

const OmpRpcReplayTranscript = Schema.Struct({
  provider: Schema.Literal(OMP_PROVIDER),
  protocol: Schema.Literal(OMP_RPC_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
type OmpRpcReplayTranscript = typeof OmpRpcReplayTranscript.Type;
const decodeOmpRpcReplayTranscript = Schema.decodeUnknownEffect(OmpRpcReplayTranscript);

class OmpReplayTranscriptDecodeError extends Schema.TaggedError<OmpReplayTranscriptDecodeError>()(
  "OmpReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode omp RPC replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

class OmpReplayMismatchError extends Schema.TaggedError<OmpReplayMismatchError>()(
  "OmpReplayMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    process: Schema.Number,
    label: Schema.optional(Schema.String),
    actualType: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Omp replay frame mismatch at cursor ${this.cursor} (expected ${this.label ?? "<none>"}, received ${this.actualType ?? "<untyped>"} from process ${this.process}) in scenario ${this.scenario}.`;
  }
}

class OmpReplayIncompleteError extends Schema.TaggedError<OmpReplayIncompleteError>()(
  "OmpReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
    nextLabel: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Omp replay ended with ${this.remaining} unconsumed entries at cursor ${this.cursor} (next ${this.nextLabel ?? "<none>"}) in scenario ${this.scenario}.`;
  }
}

function entryLabel(entry: ProviderReplayEntryType | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return entry.type === "runtime_exit" ? "runtime_exit" : (entry.label ?? entry.type);
}

const OmpOrchestratorReplayHarnessError = Schema.Union([
  OmpReplayTranscriptDecodeError,
  ProviderAdapterDriverCreateError,
]);
type OmpOrchestratorReplayHarnessError = typeof OmpOrchestratorReplayHarnessError.Type;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replayValueMatches(expected: unknown, actual: unknown): boolean {
  if (expected === OMP_REPLAY_ANY) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => replayValueMatches(entry, actual[index]))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].every((key) => replayValueMatches(expected[key], actual[key]));
  }
  return Object.is(expected, actual);
}

const ADAPTER_REQUEST_ID = /^t3-\d+$/u;

function adapterRequestId(frame: unknown): string | undefined {
  const id = isRecord(frame) ? frame.id : undefined;
  return typeof id === "string" && ADAPTER_REQUEST_ID.test(id) ? id : undefined;
}

/** Rebind adapter request ids without pinning counters; omp dialog ids must stay exact. */
function withRequestId(expected: unknown, actual: unknown): unknown {
  const actualId = adapterRequestId(actual);
  return isRecord(expected) && adapterRequestId(expected) !== undefined && actualId !== undefined
    ? { ...expected, id: actualId }
    : expected;
}

function startsTurn(entry: ProviderReplayEntryType): boolean {
  if (entry.type !== "expect_outbound") return false;
  const type = isRecord(entry.frame) ? entry.frame.type : undefined;
  return type === "prompt";
}

function processStartFrame(command: ChildProcess.Command) {
  const args = ChildProcess.isStandardCommand(command) ? command.args : [];
  return { type: "process_start", args: [...args] };
}

function entryProcess(entry: ProviderReplayEntryType): number {
  const label = entry.type === "runtime_exit" ? undefined : entry.label;
  const match = label === undefined ? null : /@p(\d+)$/u.exec(label);
  return match === null ? 1 : Number(match[1]);
}

function recordLabel(frame: unknown, process: number): string | undefined {
  const base = !isRecord(frame)
    ? undefined
    : frame.type === "response" && typeof frame.command === "string"
      ? `response:${frame.command}`
      : typeof frame.type === "string"
        ? frame.type
        : undefined;
  if (base === undefined || process === 1) return base;
  return `${base}@p${process}`;
}

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function makeLineSplitter() {
  let buffer = "";
  const decoder = new TextDecoder();
  return (chunk: Uint8Array): ReadonlyArray<string> => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    return lines.map((line) => line.replace(/\r$/u, "")).filter((line) => line.length > 0);
  };
}

interface OmpReplayProcess {
  readonly ordinal: number;
  readonly stdout: Queue.Queue<Uint8Array, Cause.Done>;
  /** Resolved with the child's exit code when the process closes (drain-to-EOF semantics). */
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  readonly ids: Map<string, string>;
  open: boolean;
}

/** Adapter fibers can reorder stdin writes; hold matches within the turn until reached, and fail unmatched writes. */
class OmpReplayController {
  private cursor = 0;
  private failure: unknown = null;
  private readonly consumed = new Set<number>();
  private readonly held: Array<{ readonly process: OmpReplayProcess; readonly actual: unknown }> =
    [];
  private readonly processes: Array<OmpReplayProcess> = [];
  private readonly transcript: OmpRpcReplayTranscript;

  constructor(transcript: OmpRpcReplayTranscript) {
    this.transcript = transcript;
  }

  spawn(
    command: ChildProcess.Command,
    stdout: Queue.Queue<Uint8Array, Cause.Done>,
    exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>,
  ): OmpReplayProcess {
    const process: OmpReplayProcess = {
      ordinal: this.processes.length + 1,
      stdout,
      exit,
      ids: new Map(),
      open: true,
    };
    this.processes.push(process);
    this.receive(process, processStartFrame(command));
    return process;
  }

  receive(process: OmpReplayProcess, actual: unknown): void {
    if (this.failure !== null) return;
    const entries = this.transcript.entries;
    let possible = false;
    for (let index = this.cursor; index < entries.length && !possible; index += 1) {
      const entry = entries[index]!;
      const pending = entry.type === "expect_outbound" && !this.consumed.has(index);
      possible =
        pending &&
        entryProcess(entry) === process.ordinal &&
        replayValueMatches(withRequestId(entry.frame, actual), actual);
      if (!possible && pending && startsTurn(entry)) break;
    }
    if (!possible) {
      const expected = entries[this.cursor];
      const label = entryLabel(expected);
      const actualType = isRecord(actual) ? actual.type : undefined;
      this.fail(
        new OmpReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          process: process.ordinal,
          ...(label === undefined ? {} : { label }),
          ...(typeof actualType === "string" ? { actualType } : {}),
          expected: expected ?? null,
          actual,
        }),
      );
      return;
    }
    this.held.push({ process, actual });
    this.advance();
  }

  /** Stdin EOF or kill: remaining tape drains (drain-to-EOF, notes §7), then exit code lands. */
  close(process: OmpReplayProcess, exitCode = 0): void {
    process.open = false;
    this.advance();
    Queue.endUnsafe(process.stdout);
    Deferred.doneUnsafe(process.exit, Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)));
  }

  assertComplete(): void {
    if (this.failure !== null) throw this.failure;
    if (this.cursor !== this.transcript.entries.length || this.held.length > 0) {
      const nextLabel = entryLabel(this.transcript.entries[this.cursor]);
      throw new OmpReplayIncompleteError({
        scenario: this.transcript.scenario,
        cursor: this.cursor,
        remaining: this.transcript.entries.length - this.cursor,
        ...(nextLabel === undefined ? {} : { nextLabel }),
      });
    }
  }

  private advance(): void {
    let progressed = true;
    while (progressed && this.failure === null) {
      progressed = this.drainInbound();
      for (const [heldIndex, write] of this.held.entries()) {
        if (this.consumePending(write.process, write.actual)) {
          this.held.splice(heldIndex, 1);
          progressed = true;
          break;
        }
      }
    }
  }

  private consumePending(process: OmpReplayProcess, actual: unknown): boolean {
    const entries = this.transcript.entries;
    for (let index = this.cursor; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.type !== "expect_outbound") return false;
      if (this.consumed.has(index) || entryProcess(entry) !== process.ordinal) continue;
      if (!replayValueMatches(withRequestId(entry.frame, actual), actual)) continue;
      const recordedId = adapterRequestId(entry.frame);
      const actualId = adapterRequestId(actual);
      if (recordedId !== undefined && actualId !== undefined) {
        process.ids.set(recordedId, actualId);
      }
      this.consumed.add(index);
      while (this.consumed.has(this.cursor)) this.cursor += 1;
      return true;
    }
    return false;
  }

  private drainInbound(): boolean {
    let emitted = false;
    while (this.failure === null) {
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type === "runtime_exit") {
        this.cursor += 1;
        emitted = true;
        const process = this.processes[entryProcess(entry) - 1] ?? this.processes.at(-1);
        if (process !== undefined) {
          this.close(
            process,
            entry.status === "error" ? 1 : entry.status === "cancelled" ? 130 : 0,
          );
        }
        continue;
      }
      if (entry?.type !== "emit_inbound") return emitted;
      const process = this.processes[entryProcess(entry) - 1];
      if (process === undefined) return emitted;
      this.cursor += 1;
      emitted = true;
      if (!process.open) continue;
      const frame = entry.frame;
      const recordedId = isRecord(frame) ? frame.id : undefined;
      const reboundId = typeof recordedId === "string" ? process.ids.get(recordedId) : undefined;
      const rebound =
        isRecord(frame) && reboundId !== undefined ? { ...frame, id: reboundId } : frame;
      Queue.offerUnsafe(process.stdout, new TextEncoder().encode(`${encodeJsonLine(rebound)}\n`));
    }
    return emitted;
  }

  private fail(cause: unknown): void {
    if (this.failure !== null) return;
    this.failure = cause;
    for (const process of this.processes) {
      process.open = false;
      Queue.endUnsafe(process.stdout);
      Deferred.doneUnsafe(process.exit, Effect.succeed(ChildProcessSpawner.ExitCode(1)));
    }
  }
}

/** Any value outside plausible exit codes; the replay process never gets a real pid. */
const REPLAY_PID = 999_999_999;

function makeOmpReplaySpawner(
  controller: OmpReplayController,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const process = controller.spawn(command, stdout, exit);
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.close(process)));
      const split = makeLineSplitter();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(REPLAY_PID),
        exitCode: Deferred.await(exit),
        isRunning: Effect.sync(() => process.open),
        kill: () => Effect.sync(() => controller.close(process, 137)),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            for (const line of split(chunk)) controller.receive(process, decodeJsonLine(line));
          }),
        ).pipe(
          // Stdin EOF makes real omp drain its remaining stdout and exit (notes §7); the
          // adapter's close awaits the exit code, so EOF must resolve it here too.
          Sink.ensuring(Effect.sync(() => controller.close(process))),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

export function layer<E, R>(input: {
  readonly scenario: string;
  readonly spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, E, R>;
  readonly command?: string | undefined;
}) {
  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.map(
      makeOmpAdapterV2({
        instanceId: ProviderInstanceId.make(OMP_PROVIDER),
        ...(input.command === undefined ? {} : { command: input.command }),
      }),
      (adapter) => [adapter],
    ),
  ).pipe(
    Layer.provide(input.spawner),
    Layer.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );
}

function metadataString(transcript: OmpRpcReplayTranscript, key: string): string {
  const value = transcript.metadata?.[key];
  return typeof value === "string" ? value : "";
}

const OMP_REPLAY_WORKSPACE_PLACEHOLDER = "<workspace>";

/**
 * omp frames embed the workspace path inside larger strings (open_session sessionDir, session
 * file refs), so unlike materializeReplayTranscriptWorkspace this replaces every `<workspace>`
 * occurrence in every string, not just standalone values.
 */
export function materializeOmpReplayWorkspace(
  transcript: ProviderReplayTranscript,
  workspace: string,
): ProviderReplayTranscript {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.split(OMP_REPLAY_WORKSPACE_PLACEHOLDER).join(workspace);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
  };
  return {
    ...transcript,
    ...(transcript.metadata === undefined ? {} : { metadata: walk(transcript.metadata) }),
    entries: transcript.entries.map((entry) =>
      entry.type === "runtime_exit" ? entry : { ...entry, frame: walk(entry.frame) },
    ),
  };
}

export const OmpOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  OmpRpcReplayTranscript,
  OmpOrchestratorReplayHarnessError
> = {
  driver: OMP_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodeOmpRpcReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new OmpReplayTranscriptDecodeError({
            driver: transcript.provider,
            protocol: transcript.protocol,
            scenario: transcript.scenario,
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    layer({
      scenario: transcript.scenario,
      command: metadataString(transcript, "command") || undefined,
      spawner: Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const controller = new OmpReplayController(transcript);
          yield* Effect.addFinalizer(() => Effect.sync(() => controller.assertComplete()));
          return makeOmpReplaySpawner(controller);
        }),
      ),
    }),
};

export function makeOmpRecordingSpawner(
  live: ChildProcessSpawner.ChildProcessSpawner["Service"],
  entries: Array<ProviderReplayEntryType>,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  let spawned = 0;
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const handle = yield* live.spawn(command);
      const process = ++spawned;
      const record = (type: "expect_outbound" | "emit_inbound", frame: unknown) => {
        const label = recordLabel(frame, process);
        entries.push({ type, ...(label === undefined ? {} : { label }), frame });
      };
      const recordLines = (
        type: "expect_outbound" | "emit_inbound",
        lines: ReadonlyArray<string>,
      ) => {
        for (const line of lines) {
          try {
            record(type, decodeJsonLine(line));
          } catch {
            // Non-JSON stdout lines are not protocol frames, so the transcript drops them.
          }
        }
      };
      record("expect_outbound", processStartFrame(command));
      const splitIn = makeLineSplitter();
      const splitOut = makeLineSplitter();
      return ChildProcessSpawner.makeHandle({
        ...handle,
        stdin: handle.stdin.pipe(
          Sink.mapInput((chunk: Uint8Array) => {
            recordLines("expect_outbound", splitIn(chunk));
            return chunk;
          }),
        ),
        stdout: handle.stdout.pipe(
          Stream.tap((chunk) => Effect.sync(() => recordLines("emit_inbound", splitOut(chunk)))),
        ),
      });
    }),
  );
}
