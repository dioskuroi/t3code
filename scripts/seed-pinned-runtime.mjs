#!/usr/bin/env node
// Seed the pinned runtime for the fork version, fully offline: build via the
// existing scripts, unpack into <T3 home>/runtime/versions/<version>/, write
// the .install-complete sentinel so `t3 service install` skips the feed.
// Usage: node scripts/seed-pinned-runtime.mjs [--skip-build] [--force]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const TAG = "[seed]";

class SeedError extends Error {}

function fail(message) {
  throw new SeedError(message);
}

function log(message) {
  console.log(`${TAG} ${message}`);
}

function parseArgs(argv) {
  let force = false;
  let skipBuild = false;
  for (const arg of argv) {
    if (arg === "--force") force = true;
    else if (arg === "--skip-build") skipBuild = true;
    else fail(`unknown argument ${arg} (expected --skip-build or --force)`);
  }
  return { force, skipBuild };
}

function hostBuildTarget() {
  const { platform: hostPlatform, arch: hostArch } = process;
  const platform =
    hostPlatform === "darwin"
      ? "mac"
      : hostPlatform === "linux"
        ? "linux"
        : hostPlatform === "win32"
          ? "win"
          : undefined;
  const arch = hostArch === "arm64" ? "arm64" : hostArch === "x64" ? "x64" : undefined;
  if (platform === undefined || arch === undefined) {
    fail(`unsupported host ${hostPlatform}-${hostArch}; seeding is host-only`);
  }
  return { platform, arch, entryName: platform === "win" ? "t3.exe" : "t3" };
}

function run(command, args, cwd, label) {
  log(`${label}`);
  // Children must resolve the same node that runs this script (build-exe
  // hard-checks it, and vp's wrapper execs `node` from PATH), and the
  // repo-local vp install wins over any global one.
  const childPath = [
    NodePath.dirname(process.execPath),
    NodePath.join(cwd, "node_modules/.bin"),
    process.env.PATH ?? "",
  ].join(NodePath.delimiter);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, PATH: childPath },
  });
  if (result.error !== undefined) {
    fail(
      `${label}: could not run ${command} (${result.error.message}); is it installed and on PATH?`,
    );
  }
  if (result.status !== 0) {
    fail(`${label}: exited with status ${String(result.status)}`);
  }
}

/** Mirror bootService's check: stdout must end with `v<version>`. */
function reportedVersion(stdout) {
  return stdout.trimEnd().match(/(?:^|\s)v(\S+)\s*$/)?.[1];
}

/** Run `<entry> --version` and return the reported version, or undefined. */
function entryReportedVersion(entry) {
  const result = NodeChildProcess.spawnSync(entry, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  return reportedVersion(result.stdout);
}

/** True when the directory holds a sentinel for this version and its entry reports it. */
function probeSeededRuntime(dir, entryName, version) {
  const sentinel = NodePath.join(dir, ".install-complete");
  if (!NodeFS.existsSync(sentinel) || NodeFS.readFileSync(sentinel, "utf8").trim() !== version) {
    return false;
  }
  const entry = NodePath.join(dir, entryName);
  if (!NodeFS.existsSync(entry)) return false;
  return entryReportedVersion(entry) === version;
}

function main() {
  const { force, skipBuild } = parseArgs(process.argv.slice(2));
  const repoRoot = NodePath.resolve(import.meta.dirname, "..");
  const serverPackage = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "apps/server/package.json"), "utf8"),
  );
  const version = serverPackage.version;
  if (typeof version !== "string" || version.length === 0) {
    fail("could not read version from apps/server/package.json");
  }

  const { platform, arch, entryName } = hostBuildTarget();
  const home = process.env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3");
  const versionsDir = NodePath.join(home, "runtime", "versions");
  const versionDir = NodePath.join(versionsDir, version);
  const stagingDir = `${versionDir}.staging`;
  log(`seeding ${version} for ${platform}-${arch} into ${versionDir}`);

  if (!force && probeSeededRuntime(versionDir, entryName, version)) {
    log(`already seeded and valid; nothing to do (use --force to reseed)`);
    return;
  }

  if (skipBuild) {
    const builtEntry = NodePath.join(repoRoot, "apps/server/dist-exe", entryName);
    if (!NodeFS.existsSync(builtEntry)) {
      fail(`--skip-build: ${builtEntry} is missing; build first without --skip-build`);
    }
  } else {
    run(
      process.execPath,
      ["apps/server/scripts/cli.ts", "build-exe"],
      repoRoot,
      "building CLI single-executable (build-exe)",
    );
    run(
      "cargo",
      ["build", "--locked", "--release", "--manifest-path", "native/resource-monitor/Cargo.toml"],
      repoRoot,
      "building resource monitor (cargo build --release)",
    );
    if (!NodeFS.existsSync(NodePath.join(repoRoot, "apps/server/dist/client"))) {
      run(
        process.execPath,
        ["apps/server/scripts/cli.ts", "build"],
        repoRoot,
        "bundling web client (build)",
      );
    }
  }

  const archiveDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-archive-"));
  let swapped = false;
  try {
    run(
      process.execPath,
      [
        "scripts/build-cli-archive.ts",
        "--platform",
        platform,
        "--arch",
        arch,
        "--version",
        version,
        "--resource-monitor-dir",
        "native/resource-monitor/target/release",
        "--output-dir",
        archiveDir,
      ],
      repoRoot,
      "packaging release archive (build-cli-archive)",
    );
    const archiveName = NodeFS.readdirSync(archiveDir).find(
      (name) =>
        name.startsWith(`t3-${version}-`) && (name.endsWith(".tar.gz") || name.endsWith(".zip")),
    );
    if (archiveName === undefined) {
      fail(`no t3-${version}-* archive was produced in ${archiveDir}`);
    }
    const archivePath = NodePath.join(archiveDir, archiveName);

    NodeFS.rmSync(stagingDir, { recursive: true, force: true });
    NodeFS.mkdirSync(versionsDir, { recursive: true });
    NodeFS.mkdirSync(stagingDir, { recursive: true });
    run(
      "tar",
      [
        archivePath.endsWith(".zip") ? "-xf" : "-xzf",
        archivePath,
        "-C",
        stagingDir,
        "--strip-components=1",
      ],
      repoRoot,
      `unpacking ${archiveName} into staging`,
    );
    if (entryName !== "t3.exe") {
      NodeFS.chmodSync(NodePath.join(stagingDir, entryName), 0o755);
    }

    // Validate before touching the installed directory: on failure the old
    // runtime stays intact.
    const stagedEntry = NodePath.join(stagingDir, entryName);
    const stagedVersion = entryReportedVersion(stagedEntry);
    if (stagedVersion !== version) {
      fail(
        `staged entry ${stagedEntry} reports ${stagedVersion === undefined ? "no version" : stagedVersion}; expected ${version} (the directory name must match the SEA version)`,
      );
    }
    NodeFS.writeFileSync(NodePath.join(stagingDir, ".install-complete"), `${version}\n`);

    const retiredDir = `${versionDir}.old-${String(process.pid)}`;
    let retired = false;
    try {
      if (NodeFS.existsSync(versionDir)) {
        NodeFS.renameSync(versionDir, retiredDir);
        retired = true;
      }
      NodeFS.renameSync(stagingDir, versionDir);
      swapped = true;
    } catch (error) {
      if (retired && !NodeFS.existsSync(versionDir)) {
        NodeFS.renameSync(retiredDir, versionDir);
      }
      throw error;
    }
    if (retired) {
      NodeFS.rmSync(retiredDir, { recursive: true, force: true });
    }
  } finally {
    NodeFS.rmSync(archiveDir, { recursive: true, force: true });
    if (!swapped) {
      NodeFS.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  log(`seeded ${versionDir}`);
  log(
    `next: run \`t3 service install\` within the 1h prune grace, or confirm the service activeVersion already points at ${version}`,
  );
  if (force) {
    log(
      "note: if the background service is running this version, restart it to pick up the new build",
    );
  }
}

try {
  main();
} catch (error) {
  if (error instanceof SeedError) {
    console.error(`${TAG} error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
