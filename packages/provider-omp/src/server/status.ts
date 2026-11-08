import { ServerProviderModel } from "@t3tools/contracts";
import { OmpSettings } from "../settings.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";
import {
  isOmpReadyFrame,
  isOmpResponseFrame,
  ompSupportsProtocolV2,
  parseOmpRpcFrame,
  type OmpRpcFrame,
} from "./rpc/frames.ts";

const OMP_PRESENTATION = {
  displayName: "omp",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  // Per spec §6: omp enforces permissions natively via --approval-mode; auto is never declared.
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
} as const;

const OMP_VERSION_TIMEOUT_MS = 8_000;
const OMP_RPC_READY_TIMEOUT_MS = 15_000;
const OMP_RPC_REQUEST_TIMEOUT_MS = 30_000;

export class OmpProtocolUnsupportedError extends Schema.TaggedError<OmpProtocolUnsupportedError>()(
  "OmpProtocolUnsupportedError",
  {
    operation: Schema.Literals(["negotiate_protocol"]),
    supportedProtocolVersions: Schema.Array(Schema.Number),
  },
) {
  override get message(): string {
    const versions = this.supportedProtocolVersions.join(", ") || "none";
    return (
      `omp does not support RPC protocol v2 (supported versions: ${versions}). ` +
      "Upgrade the omp CLI to the latest version and refresh the provider status."
    );
  }
}

class OmpRpcProbeError extends Schema.TaggedError<OmpRpcProbeError>()("OmpRpcProbeError", {
  operation: Schema.String,
  detail: Schema.String,
}) {}

export const makePendingOmpProvider = Effect.fn("makePendingOmpProvider")(function* (
  settings: OmpSettings,
) {
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: settings.enabled,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models: [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking the omp CLI..."
        : "omp is disabled in T3 Code settings.",
    },
  });
});

const readyModelsSnapshot = Effect.fn("OmpProviderStatus.readyModelsSnapshot")(function* (
  probe: ProviderProbeResult,
  models: ReadonlyArray<ServerProviderModel>,
) {
  const catalog =
    models.length > 0
      ? { status: "ready" as const }
      : {
          status: "warning" as const,
          message:
            "omp reported no models. Run `omp login` on this T3 server host and refresh the provider status.",
        };
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: true,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models,
    probe: { ...probe, ...catalog },
  });
});

/**
 * Spec §5.3 (migration notes §7): the client must keep reading stdout after closing stdin, or the
 * child can hang on backpressure. The reader fiber below runs until EOF, so the final exit await
 * is a real drain, not a guess.
 */
const probeOmpModelCatalog = Effect.fn("OmpProviderStatus.probeOmpModelCatalog")(function* (input: {
  readonly command: string;
  readonly spawnArgs: ReadonlyArray<string>;
  readonly shell: boolean | undefined;
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly cwd: string | undefined;
}) {
  return yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(input.command, [...input.spawnArgs], {
        env: input.environment,
        extendEnv: true,
        ...(input.shell !== undefined ? { shell: input.shell } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        stdin: { stream: "pipe" },
      }),
    );

    const frames = yield* Queue.unbounded<OmpRpcFrame>();
    // Reader lives until stdout EOF — this is the post-close drain the protocol requires.
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const frame = parseOmpRpcFrame(line);
          if (frame !== undefined) yield* Queue.offer(frames, frame);
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const stderrFiber = yield* collectStreamAsString(child.stderr).pipe(Effect.forkScoped);
    const exitFiber = yield* child.exitCode.pipe(Effect.map(Number), Effect.forkScoped);

    // Outgoing queue: shutting it down completes the writer, which ends stdin (endOnDone default).
    const encoder = new TextEncoder();
    const outgoing = yield* Queue.unbounded<Uint8Array>();
    yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(child.stdin),
      Effect.ignore,
      Effect.forkScoped,
    );
    const closeStdin = Queue.shutdown(outgoing);

    let nextRequestId = 0;
    const takeResponse = Effect.fn("OmpProviderStatus.takeResponse")(function* (id: string) {
      while (true) {
        const frame = yield* Queue.take(frames);
        if (isOmpResponseFrame(frame) && frame.id === id) return frame;
      }
    });
    const request = (type: string, params: Record<string, unknown> = {}) => {
      const id = `t3-status-${nextRequestId++}`;
      const payload = encoder.encode(JSON.stringify({ id, type, ...params }) + "\n");
      return Effect.gen(function* () {
        yield* Queue.offer(outgoing, payload);
        const response = yield* takeResponse(id);
        if (!response.success) {
          return yield* new OmpRpcProbeError({
            operation: type,
            detail: typeof response.error === "string" ? response.error : "request failed",
          });
        }
        return response.data;
      }).pipe(
        Effect.timeoutOrElse({
          duration: OMP_RPC_REQUEST_TIMEOUT_MS,
          orElse: () =>
            new OmpRpcProbeError({
              operation: type,
              detail: `Timed out after ${OMP_RPC_REQUEST_TIMEOUT_MS}ms`,
            }),
        }),
      );
    };

    const ready = yield* Effect.gen(function* () {
      while (true) {
        const frame = yield* Queue.take(frames);
        if (isOmpReadyFrame(frame)) return frame;
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: OMP_RPC_READY_TIMEOUT_MS,
        orElse: () =>
          new OmpRpcProbeError({
            operation: "ready",
            detail: `No ready frame within ${OMP_RPC_READY_TIMEOUT_MS}ms`,
          }),
      }),
    );

    if (!ompSupportsProtocolV2(ready)) {
      return yield* new OmpProtocolUnsupportedError({
        operation: "negotiate_protocol",
        supportedProtocolVersions: [...ready.supportedProtocolVersions],
      });
    }
    yield* request("negotiate_protocol", { protocolVersion: 2 });
    const catalog = (yield* request("get_available_models")) as { models?: unknown } | undefined;

    // Close stdin: omp drains accepted work, flushes stdout, exits 0 (notes §7).
    yield* closeStdin;

    const stderr = yield* Fiber.join(stderrFiber);
    const exitCode = yield* Fiber.join(exitFiber);
    if (exitCode !== 0) {
      return yield* new OmpRpcProbeError({
        operation: "exit",
        detail: `omp exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      });
    }
    return parseOmpModels(catalog);
  }).pipe(Effect.scoped);
});

function parseOmpModels(
  data: unknown,
): Result.Result<ReadonlyArray<ServerProviderModel>, OmpRpcProbeError> {
  const models = (data as { models?: unknown } | undefined)?.models;
  if (!Array.isArray(models)) {
    return Result.fail(
      new OmpRpcProbeError({
        operation: "get_available_models",
        detail: "Invalid model inventory",
      }),
    );
  }
  const seen = new Set<string>();
  const parsed: Array<ServerProviderModel> = [];
  for (const model of models) {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    if (provider === undefined || id === undefined) {
      return Result.fail(
        new OmpRpcProbeError({
          operation: "get_available_models",
          detail: "Invalid model identity",
        }),
      );
    }
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    parsed.push({
      slug,
      name: recordString(model, "name") ?? slug,
      subProvider: provider,
      isCustom: false,
      capabilities: null,
    });
  }
  return Result.succeed(parsed);
}

function recordString(record: unknown, key: string): string | undefined {
  const value = (record as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  command = "omp",
) {
  if (!settings.enabled) return yield* makePendingOmpProvider(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const spawnEnvironment = environment ?? process.env;

  const versionResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: spawnEnvironment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: spawnEnvironment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(OMP_VERSION_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "The omp CLI was not found on PATH. Install omp, then run `omp login` on this T3 server host for your model providers."
          : "Failed to execute the omp CLI on this T3 server host.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "The omp CLI version check timed out.",
      },
    });
  }
  const version = parseGenericCliVersion(versionResult.success.value.stdout);
  if (versionResult.success.value.code !== 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "omp is installed but failed to run.",
      },
    });
  }

  const spawnCommand = yield* resolveSpawnCommand(command, ["--mode", "rpc", "--no-session"], {
    env: spawnEnvironment,
  }).pipe(Effect.result);
  if (Result.isFailure(spawnCommand)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "The omp CLI was not found on PATH. Install omp, then run `omp login` on this T3 server host for your model providers.",
      },
    });
  }

  // Short-lived `omp --mode rpc --no-session`: no login, no MCP startup side effects, no session.
  const probeOutcome = yield* probeOmpModelCatalog({
    command: spawnCommand.success.command,
    spawnArgs: spawnCommand.success.args,
    shell: spawnCommand.success.shell,
    environment: spawnEnvironment,
    cwd,
  }).pipe(Effect.result);

  if (Result.isFailure(probeOutcome)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: probeOutcome.failure.message,
      },
    });
  }
  const modelsResult = probeOutcome.success;
  if (Result.isFailure(modelsResult)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: modelsResult.failure.message,
      },
    });
  }
  return yield* readyModelsSnapshot(
    { installed: true, version, status: "ready", auth: { status: "unknown" } },
    modelsResult.success,
  );
});
