import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { followCredentialsIfStale } from "./credentialFollow.ts";
import { OMP_PROFILE_NAME } from "./profile.ts";
import { makeOmpRpcClient, OmpRpcCredentialSyncError, writeFakeOmp } from "../testing.ts";

const isSyncError = Schema.is(OmpRpcCredentialSyncError);

// Fake sqlite3: prints the revision keyed by the queried db path (FAKE_REVS JSON); a path
// missing from the map prints nothing, modeling a table/db that does not exist yet.
const writeFakeSqlite3 = (directory: string, revisions: Record<string, number>): string =>
  writeFakeCli({
    directory,
    name: "sqlite3",
    source: [
      "const map = JSON.parse(process.env.FAKE_REVS ?? '{}');",
      "const db = process.argv[process.argv.length - 2] ?? '';",
      "const revision = map[db];",
      "if (revision !== undefined) process.stdout.write(String(revision));",
    ].join("\n"),
    env: { FAKE_REVS: JSON.stringify(revisions) },
  });

interface FakeOmpRecord {
  readonly argv: ReadonlyArray<string>;
  readonly stdin: string;
}

// Fake omp: records argv + stdin per invocation so tests assert the export→import sequence;
// stdout carries FAKE_EXPORT_BODY (the exported credential JSON) on `auth export`.
const writeFakeRecordingOmp = (
  directory: string,
  options?: { readonly exportBody?: string; readonly exitCode?: number },
): string =>
  writeFakeCli({
    directory,
    name: "omp",
    source: [
      "import { appendFileSync } from 'node:fs';",
      "import { readFileSync } from 'node:fs';",
      "const record = { argv: process.argv.slice(2), stdin: readFileSync(0, 'utf8') };",
      `appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify(record) + "\\n");`,
      `if (process.argv.includes("export")) process.stdout.write(process.env.FAKE_EXPORT_BODY ?? "");`,
      "const exit = Number(process.env.FAKE_EXIT ?? '0');",
      "process.exit(exit);",
    ].join("\n"),
    env: {
      FAKE_OMP_LOG: NodePath.join(directory, "omp-calls.jsonl"),
      ...(options?.exportBody !== undefined ? { FAKE_EXPORT_BODY: options.exportBody } : {}),
      ...(options?.exitCode !== undefined ? { FAKE_EXIT: String(options.exitCode) } : {}),
    },
  });

const readOmpCalls = (directory: string): Array<FakeOmpRecord> => {
  const log = NodePath.join(directory, "omp-calls.jsonl");
  const contents = NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8") : "";
  return contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FakeOmpRecord);
};

const sandboxHome = (
  fs: FileSystem.FileSystem,
  directory: string,
  revisions: { readonly default: number; readonly profile: number } | null,
  options?: { readonly exportBody?: string; readonly exitCode?: number },
) =>
  Effect.gen(function* () {
    const agentDir = NodePath.join(directory, "agent");
    const profileAgentDir = NodePath.join(directory, "profiles", OMP_PROFILE_NAME, "agent");
    yield* fs.makeDirectory(agentDir, { recursive: true });
    yield* fs.makeDirectory(profileAgentDir, { recursive: true });
    const defaultDb = NodePath.join(agentDir, "agent.db");
    const profileDb = NodePath.join(profileAgentDir, "agent.db");
    const revisionMap: Record<string, number> = {};
    if (revisions !== null) {
      revisionMap[defaultDb] = revisions.default;
      revisionMap[profileDb] = revisions.profile;
    }
    const sqlite3 = writeFakeSqlite3(directory, revisionMap);
    const omp = writeFakeRecordingOmp(directory, options);
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env["PATH"] ?? ""}`,
      PI_CONFIG_DIR: directory,
    };
    return { sqlite3, omp, env, defaultDb, profileDb };
  });

// Dispatching omp: `--mode rpc` delegates to the writeFakeOmp stub (real protocol); the
// `auth` subcommands land in the same call log the follow tests assert on.
const writeDispatchingOmp = (
  directory: string,
  options?: { readonly exportBody?: string; readonly exitCode?: number },
): string => {
  const rpcDirectory = NodePath.join(directory, "rpc");
  writeFakeOmp({ directory: rpcDirectory, program: {} });
  return writeFakeCli({
    directory,
    name: "omp",
    source: [
      'import { pathToFileURL } from "node:url";',
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'if (args.includes("--mode")) {',
      `  await import(pathToFileURL(${JSON.stringify(NodePath.join(rpcDirectory, "omp-stub.mjs"))}).href);`,
      "  // No exit here: the stub exits itself on stdin EOF; exiting on import-resolution",
      "  // would race the RPC handshake (import resolves once listeners are attached).",
      "} else {",
      `  appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify({ argv: args, stdin: readFileSync(0, "utf8") }) + "\\n");`,
      '  if (args[0] === "auth" && args[1] === "export") process.stdout.write(process.env.FAKE_EXPORT_BODY ?? "");',
      "  process.exit(Number(process.env.FAKE_EXIT ?? '0'));",
      "}",
    ].join("\n"),
    env: {
      FAKE_OMP_LOG: NodePath.join(directory, "omp-calls.jsonl"),
      ...(options?.exportBody !== undefined ? { FAKE_EXPORT_BODY: options.exportBody } : {}),
      ...(options?.exitCode !== undefined ? { FAKE_EXIT: String(options.exitCode) } : {}),
    },
  });
};

describe("credential follow (ADR-0006)", () => {
  it.live("revisions in lockstep → up to date, omp never invoked", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cred-follow-" });
      const { omp, env } = yield* sandboxHome(fs, directory, { default: 42, profile: 42 });
      const outcome = yield* followCredentialsIfStale({ command: omp, env });
      expect(outcome).toEqual({ _tag: "UpToDate", revision: 42 });
      expect(readOmpCalls(directory)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("default profile ahead → exports and imports into the t3code profile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cred-follow-" });
      const exportBody = '{"credentials":{"zhipu-coding-plan":{"kind":"api_key"}}}';
      const { omp, env } = yield* sandboxHome(
        fs,
        directory,
        { default: 43, profile: 42 },
        { exportBody },
      );
      const outcome = yield* followCredentialsIfStale({ command: omp, env });
      expect(outcome).toEqual({ _tag: "Synced", profileRevision: 42, defaultRevision: 43 });
      const calls = readOmpCalls(directory);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.argv).toEqual(["auth", "export"]);
      expect(calls[1]?.argv).toEqual(["--profile", OMP_PROFILE_NAME, "auth", "import", "-"]);
      expect(calls[1]?.stdin).toBe(exportBody);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("profile ahead of default → up to date, never reverse-syncs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cred-follow-" });
      const { omp, env } = yield* sandboxHome(fs, directory, { default: 42, profile: 43 });
      const outcome = yield* followCredentialsIfStale({ command: omp, env });
      expect(outcome).toEqual({ _tag: "UpToDate", revision: 43 });
      expect(readOmpCalls(directory)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("default agent.db unreadable → skipped without touching omp", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cred-follow-" });
      const { omp, env } = yield* sandboxHome(fs, directory, null);
      const outcome = yield* followCredentialsIfStale({ command: omp, env });
      expect(outcome._tag).toBe("Skipped");
      expect(readOmpCalls(directory)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("import failure → failed outcome, never throws", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cred-follow-" });
      const { omp, env } = yield* sandboxHome(
        fs,
        directory,
        { default: 43, profile: 42 },
        { exportBody: "{}", exitCode: 1 },
      );
      const outcome = yield* followCredentialsIfStale({ command: omp, env });
      expect(outcome._tag).toBe("Failed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("spawn-path wire-in: stale revision replays credentials before the RPC child", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cred-follow-" });
      const { env } = yield* sandboxHome(
        fs,
        directory,
        { default: 43, profile: 42 },
        { exportBody: "{}" },
      );
      const omp = writeDispatchingOmp(directory);
      const client = yield* makeOmpRpcClient({ command: omp, args: ["--mode", "rpc"], env });
      expect(client.protocolVersion).toBe(2);
      const calls = readOmpCalls(directory);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.argv).toEqual(["auth", "export"]);
      expect(calls[1]?.argv).toEqual(["--profile", OMP_PROFILE_NAME, "auth", "import", "-"]);
      yield* client.close;
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("failed follow → spawn refused with rescue command (fail-closed)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cred-follow-" });
      const { env } = yield* sandboxHome(
        fs,
        directory,
        { default: 43, profile: 42 },
        { exportBody: "{}", exitCode: 1 },
      );
      const omp = writeDispatchingOmp(directory, { exitCode: 1 });
      const error = yield* Effect.flip(
        makeOmpRpcClient({ command: omp, args: ["--mode", "rpc"], env }),
      );
      expect(isSyncError(error)).toBe(true);
      if (isSyncError(error)) {
        expect(error.message).toContain("credential follow failed before spawn");
        expect(error.message).toContain(OMP_PROFILE_NAME);
        expect(error.message).toContain("auth import");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("followCredentials: false → probe skips the follow entirely", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cred-follow-" });
      const { env } = yield* sandboxHome(fs, directory, { default: 43, profile: 42 });
      const omp = writeDispatchingOmp(directory);
      const client = yield* makeOmpRpcClient({
        command: omp,
        args: ["--mode", "rpc"],
        env,
        followCredentials: false,
      });
      expect(client.protocolVersion).toBe(2);
      expect(readOmpCalls(directory)).toEqual([]);
      yield* client.close;
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
