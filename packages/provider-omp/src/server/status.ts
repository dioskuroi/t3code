import { ServerProviderModel } from "@t3tools/contracts";
import { OmpSettings } from "../settings.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import { makeOmpRpcClient } from "./rpc/client.ts";
import { OmpProtocolUnsupportedError } from "./rpc/frames.ts";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export { OmpProtocolUnsupportedError } from "./rpc/frames.ts";

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

const describeProbeFailure = (failure: unknown): string => {
  const message = (failure as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.trim() !== "" ? message : String(failure);
};

const isProtocolUnsupported = Schema.is(OmpProtocolUnsupportedError);

/**
 * Short-lived status probe (spec §5.3): `omp --mode rpc --no-session`, ready → negotiate →
 * get_available_models → close stdin and drain to EOF. Uses the same RPC client module as the
 * long-lived session path so drain/timeout/protocol semantics never diverge. Fails with
 * OmpProtocolUnsupportedError untouched so the upgrade hint reaches the user.
 */
const probeOmpModelCatalog = Effect.fn("OmpProviderStatus.probeOmpModelCatalog")(function* (input: {
  readonly command: string;
  readonly spawnArgs: ReadonlyArray<string>;
  readonly shell: boolean | undefined;
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly cwd: string | undefined;
}): Effect.fn.Return<
  ReadonlyArray<ServerProviderModel>,
  OmpRpcProbeError | OmpProtocolUnsupportedError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return yield* Effect.gen(function* () {
    const client = yield* makeOmpRpcClient({
      command: input.command,
      args: input.spawnArgs,
      ...(input.shell !== undefined ? { shell: input.shell } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      env: input.environment,
      readyTimeoutMs: OMP_RPC_READY_TIMEOUT_MS,
      requestTimeoutMs: OMP_RPC_REQUEST_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((cause) =>
        isProtocolUnsupported(cause)
          ? cause
          : new OmpRpcProbeError({ operation: "spawn", detail: describeProbeFailure(cause) }),
      ),
    );
    const catalog = yield* client.request("get_available_models").pipe(
      Effect.mapError(
        (cause) =>
          new OmpRpcProbeError({
            operation: "get_available_models",
            detail: describeProbeFailure(cause),
          }),
      ),
    );
    // Close stdin: omp drains accepted work, flushes stdout, exits 0 (notes §7).
    const exitCode = yield* client.close;
    if (exitCode !== 0) {
      return yield* new OmpRpcProbeError({
        operation: "exit",
        detail: `omp exited with code ${String(exitCode)}`,
      });
    }
    const parsed = parseOmpModels(catalog);
    return yield* Result.isSuccess(parsed)
      ? Effect.succeed(parsed.success)
      : Effect.fail(parsed.failure);
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
  const catalog = yield* probeOmpModelCatalog({
    command: spawnCommand.success.command,
    spawnArgs: spawnCommand.success.args,
    shell: spawnCommand.success.shell,
    environment: spawnEnvironment,
    cwd,
  }).pipe(Effect.result);

  if (Result.isFailure(catalog)) {
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
        message: catalog.failure.message,
      },
    });
  }
  return yield* readyModelsSnapshot(
    { installed: true, version, status: "ready", auth: { status: "unknown" } },
    catalog.success,
  );
});
