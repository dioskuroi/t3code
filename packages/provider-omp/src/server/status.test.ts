import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { OmpSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import {
  checkOmpProviderStatus,
  isOmpReadyFrame,
  isOmpResponseFrame,
  ompSupportsProtocolV2,
  parseOmpRpcFrame,
} from "../testing.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

// Fake omp JSONL v2 process: ready frame, negotiate, model catalog, drain-exit on stdin EOF.
// The drain marker only appears after stdin EOF, then the process exits 0 — proving the caller
// closed stdin and kept reading stdout until the child finished.
const FAKE_OMP_SCRIPT = `
import { appendFileSync } from "node:fs";
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
if (process.argv.includes("--version")) {
  process.stdout.write("omp/18.18.1\\n");
  process.exit(0);
}
const scenario = process.env.FAKE_OMP_SCENARIO ?? "ok";
if (scenario === "protocol-v1") {
  send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
  setInterval(() => {}, 1_000);
} else {
  send({ type: "ready", protocolVersion: 2, supportedProtocolVersions: [1, 2] });
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      if (request.type === "negotiate_protocol") {
        send({ id: request.id, type: "response", success: true, data: { protocolVersion: request.protocolVersion } });
      }
      if (request.type === "get_available_models") {
        send({
          id: request.id,
          type: "response",
          success: true,
          data: {
            models: [
              { provider: "zai", id: "glm-5.3", name: "GLM-5.3", reasoning: true, contextWindow: 200000 },
              { provider: "moonshot", id: "kimi-k3", name: "Kimi K3", reasoning: false },
            ],
          },
        });
      }
    }
  });
  process.stdin.on("end", () => {
    if (process.env.FAKE_OMP_DRAIN_MARKER) appendFileSync(process.env.FAKE_OMP_DRAIN_MARKER, "drained");
    process.exit(0);
  });
}
`;

const writeFakeOmp = Effect.fn("statusTest.writeFakeOmp")(function* (
  env?: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-status-test-" });
  return {
    command: writeFakeCli({
      directory,
      name: "omp",
      source: FAKE_OMP_SCRIPT,
      ...(env ? { env } : {}),
    }),
    directory,
  };
});

it.layer(NodeServices.layer)("omp status check", (it) => {
  it.effect("reports ready with the model catalog and exits after stdin closes", () =>
    Effect.gen(function* () {
      const { command, directory } = yield* writeFakeOmp();
      const markerPath = `${directory}/drain-marker`;
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({}),
        { ...process.env, FAKE_OMP_DRAIN_MARKER: markerPath },
        undefined,
        command,
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("18.18.1");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "zai/glm-5.3",
        "moonshot/kimi-k3",
      ]);
      expect(snapshot.models.map((model) => model.subProvider)).toEqual(["zai", "moonshot"]);
      expect(snapshot.models[0]?.name).toBe("GLM-5.3");
      const marker = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFile(markerPath)),
        Effect.map((bytes) => new TextDecoder().decode(bytes)),
      );
      expect(marker).toBe("drained");
      const readyFrame = parseOmpRpcFrame(
        '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2]}',
      );
      expect(readyFrame !== undefined && isOmpReadyFrame(readyFrame)).toBe(true);
      const responseFrame = parseOmpRpcFrame('{"type":"response","success":true}');
      expect(responseFrame !== undefined && isOmpResponseFrame(responseFrame)).toBe(true);
      expect(
        readyFrame !== undefined &&
          isOmpReadyFrame(readyFrame) &&
          ompSupportsProtocolV2(readyFrame),
      ).toBe(true);
    }),
  );

  it.effect("fails closed with an upgrade hint when omp does not support protocol v2", () =>
    Effect.gen(function* () {
      const { command } = yield* writeFakeOmp({ FAKE_OMP_SCENARIO: "protocol-v1" });
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({}),
        { ...process.env, FAKE_OMP_SCENARIO: "protocol-v1" },
        undefined,
        command,
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.message).toMatch(/upgrade/i);
      expect(snapshot.message).toMatch(/omp/i);
    }),
  );

  it.effect("reports a missing binary as not installed", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({}),
        process.env,
        undefined,
        "/nonexistent-dir-omp/omp",
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(false);
    }),
  );
});
