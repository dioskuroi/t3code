// One-way credential follow (ADR-0006): the t3code profile never logs in; every RPC spawn
// replays `omp auth export | omp --profile t3code auth import -` when the default profile's
// auth_change_revision is ahead. Outcomes never throw; client.ts refuses the spawn on
// Failed (fail-closed), so stale credentials can never pass silently.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OMP_PROFILE_NAME } from "./profile.ts";

const REVISION_TIMEOUT_MS = 5_000;
const REPLAY_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 2048;

// The spawner's structural shape (the class-as-type is the tag machinery, not the value).
type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

export type CredentialFollowOutcome =
  | { readonly _tag: "Synced"; readonly profileRevision: number; readonly defaultRevision: number }
  | { readonly _tag: "UpToDate"; readonly revision: number }
  | { readonly _tag: "Skipped"; readonly reason: string }
  | { readonly _tag: "Failed"; readonly reason: string };

export interface CredentialFollowOptions {
  /** Resolved omp executable; defaults to `omp` (PATH discovery). */
  readonly command?: string | undefined;
  /** Spawn env for every child; also the source of PI_CONFIG_DIR (default `~/.omp`). */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Human-readable outcome line (e.g. for the T3 server log). */
  readonly onNotice?: ((message: string) => void) | undefined;
}

const describeOutcome = (outcome: CredentialFollowOutcome): string => {
  switch (outcome._tag) {
    case "Synced":
      return `synced credentials from the default profile (revision ${outcome.profileRevision} → ${outcome.defaultRevision})`;
    case "UpToDate":
      return `credentials up to date (revision ${outcome.revision})`;
    case "Skipped":
      return `skipped: ${outcome.reason}`;
    case "Failed":
      return `failed: ${outcome.reason}`;
  }
};

const ompHomeFromEnv = (env: NodeJS.ProcessEnv | undefined): string => {
  // Resolve strictly from the caller's env (the same env the omp children get): PI_CONFIG_DIR
  // is omp's config-dir override, HOME relocates everything else. Falling back to the main
  // process homedir() here would desync path resolution from the child's view (a caller that
  // passes a different HOME, e.g. a sandbox, would silently read the real ~/.omp).
  const configured = env?.["PI_CONFIG_DIR"]?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const home = env?.["HOME"]?.trim();
  if (home !== undefined && home !== "") return NodePath.join(home, ".omp");
  return NodePath.join(NodeOS.homedir(), ".omp");
};

// One bounded child run: collect stdout/stderr-tail/exit; never fails — spawn errors,
// signal deaths and timeouts all come back as `null` and map onto Skipped/Failed upstream.
const runChild = Effect.fn("CredentialFollow.runChild")(function* (
  spawner: Spawner,
  options: CredentialFollowOptions,
  command: string,
  args: ReadonlyArray<string>,
  stdinPayload?: string | undefined,
  timeoutMs: number = REPLAY_TIMEOUT_MS,
) {
  const collected = yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(command, [...args], {
        env: options.env,
        extendEnv: true,
        stdin: { stream: "pipe" },
      }),
    );
    if (stdinPayload === undefined) {
      // End stdin unconditionally: children that read stdin (or probe it) must see EOF
      // even when the command takes no payload — a never-closed stdin pipe hangs them.
      yield* Stream.make(new Uint8Array(0)).pipe(Stream.run(child.stdin));
    } else {
      yield* Stream.make(new TextEncoder().encode(stdinPayload)).pipe(Stream.run(child.stdin));
    }
    return yield* Effect.all({
      stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      exitCode: child.exitCode.pipe(Effect.option),
    });
  }).pipe(
    Effect.timeout(Duration.millis(timeoutMs)),
    Effect.catchCause(() => Effect.succeed(null)),
  );
  if (collected === null || collected.exitCode._tag === "None") return null;
  return {
    exitCode: collected.exitCode.value,
    stdout: collected.stdout,
    stderrTail: collected.stderr.slice(-STDERR_TAIL_CHARS),
  };
});

const readRevision = Effect.fn("CredentialFollow.readRevision")(function* (
  spawner: Spawner,
  options: CredentialFollowOptions,
  dbPath: string,
) {
  const run = yield* runChild(
    spawner,
    options,
    "sqlite3",
    ["-readonly", dbPath, "SELECT revision FROM auth_change_revision WHERE id = 1"],
    undefined,
    REVISION_TIMEOUT_MS,
  );
  if (run === null) return { revision: null, detail: "sqlite3 unavailable or timed out" };
  if (run.exitCode !== 0) {
    return {
      revision: null,
      detail: `sqlite3 exited ${String(run.exitCode)}: ${run.stderrTail.trim()}`,
    };
  }
  const trimmed = run.stdout.trim();
  if (!/^\d+$/.test(trimmed)) return { revision: null, detail: "no auth_change_revision row" };
  return { revision: Number(trimmed), detail: "ok" };
});

// The onNotice callback is the single log owner: callers with a context (thread id, span)
// forward it to their own log; this module never double-logs and never throws — outcomes
// carry the failure and the caller decides (client.ts refuses the spawn on Failed).
export const followCredentialsIfStale = Effect.fn("CredentialFollow.follow")(function* (
  options: CredentialFollowOptions,
): Effect.fn.Return<CredentialFollowOutcome, never, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const omp = options.command ?? "omp";
  const finish = (outcome: CredentialFollowOutcome) =>
    Effect.sync(() => {
      options.onNotice?.(describeOutcome(outcome));
      return outcome;
    });
  // Each short-lived child (revision reads, export, import) is scoped to this follow run —
  // the spawn service requires a Scope and the caller's thread scope must not own them.
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const home = ompHomeFromEnv(options.env ?? process.env);
      const defaultRead = yield* readRevision(
        spawner,
        options,
        NodePath.join(home, "agent", "agent.db"),
      );
      if (defaultRead.revision === null) {
        return yield* finish({
          _tag: "Skipped",
          reason: `default profile unreadable (${defaultRead.detail})`,
        });
      }
      const profileRead = yield* readRevision(
        spawner,
        options,
        NodePath.join(home, "profiles", OMP_PROFILE_NAME, "agent", "agent.db"),
      );
      const profileRevision = profileRead.revision ?? 0;
      if (defaultRead.revision <= profileRevision) {
        return yield* finish({ _tag: "UpToDate", revision: profileRevision });
      }
      const exported = yield* runChild(spawner, options, omp, ["auth", "export"]);
      if (exported === null) {
        return yield* finish({
          _tag: "Failed",
          reason: "omp auth export failed to run (binary missing or timed out)",
        });
      }
      if (exported.exitCode !== 0) {
        return yield* finish({
          _tag: "Failed",
          reason: `omp auth export exited ${String(exported.exitCode)}: ${exported.stderrTail.trim()}`,
        });
      }
      const imported = yield* runChild(
        spawner,
        options,
        omp,
        ["--profile", OMP_PROFILE_NAME, "auth", "import", "-"],
        exported.stdout,
      );
      if (imported === null || imported.exitCode !== 0) {
        const detail =
          imported === null
            ? "omp auth import failed to run (binary missing or timed out)"
            : `omp auth import exited ${String(imported.exitCode)}: ${imported.stderrTail.trim()}`;
        return yield* finish({ _tag: "Failed", reason: detail });
      }
      return yield* finish({
        _tag: "Synced",
        profileRevision,
        defaultRevision: defaultRead.revision,
      });
    }),
  );
});
