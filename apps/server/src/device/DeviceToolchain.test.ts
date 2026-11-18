import * as NodeFS from "node:fs";
import * as NodeLock from "proper-lockfile";
import * as PlatformError from "effect/PlatformError";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";

import type { ProcessRunInput } from "../processRunner.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  deviceToolVersions,
  DEVICE_HUB_VERSION,
  ensureDeviceHub,
  isDeviceHubInstalled,
} from "./DeviceToolchain.ts";

const successResult = {
  code: ChildProcessSpawner.ExitCode(0),
  stdout: "added 1 package",
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};

/** Fake npm: creates the staged entry tree under `--prefix` so the post-install probe passes. */
const stagingRunner = Effect.fn("DeviceToolchainTest.stagingRunner")(function* (
  calls: Ref.Ref<number>,
  started?: Deferred.Deferred<void>,
) {
  const fs = yield* FileSystem.FileSystem;
  return {
    run: (input: ProcessRunInput) =>
      Ref.update(calls, (n) => n + 1).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (started !== undefined)
              yield* Deferred.succeed(started, undefined).pipe(Effect.ignore);
            const prefix = input.args[input.args.indexOf("--prefix") + 1];
            const entry = `${prefix}/node_modules/expo-device-hub/dist/server/cli.mjs`;
            yield* fs.makeDirectory(entry.slice(0, entry.lastIndexOf("/")), { recursive: true });
            yield* fs.writeFileString(entry, "export {};");
            return successResult;
          }),
        ),
      ),
  };
});

// proper-lockfile waits on its own wall-clock poll cycle — an external-process fixture,
// the case the no-real-time-wait rule carves out for `it.live`.
it.live("install waits for a concurrent holder of the tools lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-install-" });
    const toolsRoot = path.join(baseDir, "tools");
    yield* fs.makeDirectory(toolsRoot, { recursive: true });
    const lockPath = path.join(toolsRoot, ".install-lock");
    const holder = yield* Effect.tryPromise({
      try: () =>
        NodeLock.lock(toolsRoot, {
          realpath: false,
          lockfilePath: lockPath,
          update: 3_600_000,
          retries: 0,
        }),
      catch: () => new Error("failed to hold the lock"),
    });
    const calls = yield* Ref.make(0);
    const started = yield* Deferred.make<void>();
    const runner = yield* stagingRunner(calls, started);
    const fiber = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.forkChild,
    );
    // A broken implementation grabs the lock instantly; a working one cannot start npm while
    // this holder is alive, so the started milestone must stay unset across the window.
    const startedOrNone = yield* Deferred.await(started).pipe(Effect.timeoutOption("1500 millis"));
    expect(startedOrNone._tag).toBe("None");
    yield* Effect.promise(() => holder());
    const paths = yield* Fiber.join(fiber);
    expect(yield* Ref.get(calls)).toBe(1);
    expect((yield* fs.readFileString(paths.sentinelPath)).trim()).toBe(DEVICE_HUB_VERSION);
    expect(yield* fs.exists(lockPath)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a stale lock left by a dead holder is stolen", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-install-" });
    const toolsRoot = path.join(baseDir, "tools");
    yield* fs.makeDirectory(toolsRoot, { recursive: true });
    const lockPath = path.join(toolsRoot, ".install-lock");
    // A dead holder simulated directly: proper-lockfile's lock is a mkdir'd directory, so an
    // empty dir with a fixed-epoch mtime is a fully deterministic stale lock (no live holder).
    NodeFS.mkdirSync(lockPath);
    NodeFS.utimesSync(lockPath, new Date(0), new Date(0));
    const calls = yield* Ref.make(0);
    const runner = yield* stagingRunner(calls);
    const paths = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
    expect((yield* fs.readFileString(paths.sentinelPath)).trim()).toBe(DEVICE_HUB_VERSION);
    expect(yield* fs.exists(lockPath)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("abandoned staging directories are recycled under the lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-install-" });
    const orphan = path.join(baseDir, "tools", "expo-device-hub", ".staging-orphan");
    yield* fs.makeDirectory(path.join(orphan, "node_modules", "expo-device-hub"), {
      recursive: true,
    });
    yield* fs.writeFileString(path.join(orphan, "package.json"), "{}");
    const calls = yield* Ref.make(0);
    const runner = yield* stagingRunner(calls);
    const paths = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
    expect(yield* Ref.get(calls)).toBe(1);
    expect((yield* fs.readFileString(paths.sentinelPath)).trim()).toBe(DEVICE_HUB_VERSION);
    expect(yield* fs.readDirectory(path.join(baseDir, "tools", "expo-device-hub"))).toEqual([
      DEVICE_HUB_VERSION,
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("failed installation cleans staging and exposes only a safe failure message", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-install-" });
    const result = {
      code: ChildProcessSpawner.ExitCode(1),
      stdout: "",
      stderr: "registry rejected https://private:credential@example.test/package",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    const error = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.succeed(result),
      }),
      Effect.flip,
    );
    expect(error.message).toBe(
      "Installing expo-device-hub failed while running npm install (exit code 1).",
    );
    expect(error.cause).toBe(result);
    expect(yield* isDeviceHubInstalled(baseDir)).toBe(false);
    expect(yield* fs.readDirectory(path.join(baseDir, "tools", "expo-device-hub"))).toEqual([]);
    expect(yield* fs.exists(path.join(baseDir, "tools", ".install-lock"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("inventory reports only completed versions without installing the required version", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    for (const [version, sentinel] of [
      ["0.9.0", "0.9.0"],
      [DEVICE_HUB_VERSION, "wrong"],
      [".staging-123", ".staging-123"],
    ]) {
      const dir = path.join(base, "tools", "expo-device-hub", version!);
      yield* fs.makeDirectory(path.join(dir, "node_modules/expo-device-hub/dist/server"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(dir, "node_modules/expo-device-hub/dist/server/cli.mjs"),
        "",
      );
      yield* fs.writeFileString(path.join(dir, ".install-complete"), sentinel!);
    }
    const tools = yield* deviceToolVersions(base);
    expect(tools?.hub).toEqual({
      requiredVersion: DEVICE_HUB_VERSION,
      installedVersions: ["0.9.0"],
      runningVersion: null,
    });
    expect(tools?.agent.installedVersions).toEqual([]);
    expect(yield* isDeviceHubInstalled(base)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("unreadable inventory stays unknown instead of reporting no installs", () =>
  Effect.gen(function* () {
    const tools = yield* deviceToolVersions("/unreadable");
    expect(tools).toBeUndefined();
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readDirectory: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readDirectory",
              description: "denied",
            }),
          ),
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
