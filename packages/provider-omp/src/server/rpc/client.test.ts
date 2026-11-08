import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics anyUnknownInErrorContext:off - assertions flip the unknown-valued RPC response payload into the error channel on purpose.
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  makeOmpFrameDecoder,
  makeOmpRpcClient,
  OmpProtocolUnsupportedError,
  OmpRpcError,
  OmpRpcExitError,
  OmpRpcTimeoutError,
  writeFakeOmp,
  type FakeOmpProgram,
} from "../../testing.ts";

const isProtocolUnsupported = Schema.is(OmpProtocolUnsupportedError);
const isRpcError = Schema.is(OmpRpcError);
const isTimeoutError = Schema.is(OmpRpcTimeoutError);
const isExitError = Schema.is(OmpRpcExitError);

const readLines = Effect.fn("clientTest.readLines")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
  return contents
    .split("\n")
    .filter((line: string) => line.trim() !== "")
    .map((line: string) => JSON.parse(line) as Record<string, unknown>);
});

const spawnClient = Effect.fn("clientTest.spawnClient")(function* (
  directory: string,
  program: FakeOmpProgram = {},
  spawnEnv?: Record<string, string>,
) {
  const command = writeFakeOmp({ directory, program });
  return yield* makeOmpRpcClient({
    command,
    args: ["--mode", "rpc"],
    env: { ...process.env, ...spawnEnv },
  });
});

it.layer(NodeServices.layer)("omp RPC client", (it) => {
  it.effect("negotiates protocol v2, subscribes to events, and correlates responses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-rpc-client-" });
      const requestLog = `${directory}/requests.jsonl`;
      const models = [{ provider: "zai", id: "glm-5.3", name: "GLM-5.3" }];
      const client = yield* spawnClient(
        directory,
        { responses: { get_available_models: { data: { models } } } },
        { FAKE_OMP_REQUEST_LOG: requestLog },
      );
      expect(client.protocolVersion).toBe(2);

      const response = (yield* client.request("get_available_models")) as { models: unknown };
      expect(response.models).toEqual(models);

      yield* client.close;
      const requests = yield* readLines(requestLog);
      const types = requests.map((request: Record<string, unknown>) => request["type"]);
      expect(types).toContain("negotiate_protocol");
      // Spec §5.2 event subscriptions are part of client startup, before any user request.
      const eventFilter = requests.find(
        (request: Record<string, unknown>) => request["type"] === "set_event_filter",
      );
      expect(eventFilter?.["messageUpdates"]).toBe("delta");
      const subagentSubscription = requests.find(
        (request: Record<string, unknown>) => request["type"] === "set_subagent_subscription",
      );
      expect(subagentSubscription?.["level"]).toBe("events");
    }),
  );

  it.effect("fails closed with an upgrade hint when omp does not support protocol v2", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-rpc-client-" });
      const error = yield* Effect.flip(spawnClient(directory, { supportedProtocolVersions: [1] }));
      expect(isProtocolUnsupported(error)).toBe(true);
      if (isProtocolUnsupported(error)) expect(error.message).toMatch(/upgrade/i);
    }),
  );

  it.effect("refuses negotiation when omp rejects protocol v2", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-rpc-client-" });
      const error = yield* Effect.flip(spawnClient(directory, { refuseNegotiation: true }));
      expect(isRpcError(error)).toBe(true);
      if (isRpcError(error)) expect(error.message).toMatch(/negotiate_protocol/);
    }),
  );

  it.effect("reassembles rpc_chunk sequences into the original response frame", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-rpc-client-" });
      const models = Array.from({ length: 200 }, (_, index) => ({
        provider: "zai",
        id: `glm-${index}`,
        name: `GLM model ${index} ${"x".repeat(200)}`,
      }));
      const client = yield* spawnClient(directory, {
        responses: { get_available_models: { data: { models }, chunkBytes: 256 } },
      });
      const response = (yield* client.request("get_available_models")) as { models: typeof models };
      expect(response.models).toEqual(models);
      yield* client.close;
    }),
  );

  it.effect("fails closed when a reassembled payload exceeds the advertised cap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-rpc-client-" });
      const client = yield* spawnClient(directory, {
        maxReassembledFrameBytes: 1024,
        responses: {
          get_available_models: {
            data: { models: [Array.from({ length: 50 }, () => "y".repeat(100))] },
            chunkBytes: 256,
          },
        },
      });
      const error = yield* Effect.flip(client.request("get_available_models"));
      expect(isRpcError(error)).toBe(true);
      if (isRpcError(error)) expect(error.message).toMatch(/rpc_chunk/);
      yield* client.close;
    }),
  );

  it.effect("fails closed when an outbound request exceeds the single-frame limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-rpc-client-" });
      const client = yield* spawnClient(directory, { maxFrameBytes: 1024 });
      const error = yield* Effect.flip(client.request("prompt", { message: "z".repeat(4000) }));
      expect(isRpcError(error)).toBe(true);
      if (isRpcError(error)) expect(error.message).toMatch(/single-frame limit/);
      yield* client.close;
    }),
  );

  it.effect("fails closed on the request timeout without real waiting (injected clock)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-rpc-client-" });
      const client = yield* spawnClient(directory, {
        responses: { get_state: { never: true } },
      });
      const fiber = yield* Effect.forkChild(Effect.flip(client.request("get_state")));
      yield* TestClock.adjust(Duration.seconds(31));
      const error = yield* Fiber.join(fiber);
      expect(isTimeoutError(error)).toBe(true);
      if (isTimeoutError(error)) expect(error.timeoutMs).toBe(30_000);
      yield* client.close;
    }),
  );

  it.effect("closes stdin, drains stdout to EOF, and surfaces the exit code", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-rpc-client-" });
      const marker = `${directory}/drain-marker`;
      const events: Array<Record<string, unknown>> = [];
      const command = writeFakeOmp({
        directory,
        program: { framesOnStdinEnd: [{ type: "notice", message: "final" }] },
      });
      const client = yield* makeOmpRpcClient({
        command,
        args: ["--mode", "rpc"],
        env: { ...process.env, FAKE_OMP_DRAIN_MARKER: marker },
        onEvent: (frame) => events.push(frame),
      });
      const exitCode = yield* client.close;
      expect(exitCode).toBe(0);
      // The stdin-end frame is only emitted after we closed stdin — receiving it proves the
      // client kept reading stdout until EOF instead of tearing down at close.
      expect(events).toEqual([{ type: "notice", message: "final" }]);
      const markerContents = yield* fs.readFileString(marker);
      expect(markerContents).toBe("drained");
    }),
  );

  it.effect("reports abnormal exit to the caller and fails in-flight requests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-rpc-client-" });
      const exits: Array<{ exitCode: number | null }> = [];
      const command = writeFakeOmp({
        directory,
        program: {
          responses: { get_available_models: { never: true } },
          crash: { delayMs: 50, exitCode: 3 },
        },
      });
      const client = yield* makeOmpRpcClient({
        command,
        args: ["--mode", "rpc"],
        onExit: (exit) => exits.push(exit),
      });
      const error = yield* Effect.flip(client.request("get_available_models"));
      expect(isExitError(error)).toBe(true);
      if (isExitError(error)) expect(error.exitCode).toBe(3);
      const exitCode = yield* client.close;
      expect(exitCode).toBe(3);
      expect(exits).toEqual([{ exitCode: 3 }]);
    }),
  );

  it.effect("delivers scripted event frames to the consumer after reassembly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-rpc-client-" });
      const events: Array<Record<string, unknown>> = [];
      const command = writeFakeOmp({
        directory,
        program: {
          events: [
            { frame: { type: "notice", message: "one" } },
            { delayMs: 10, frame: { type: "notice", message: "two" } },
          ],
        },
      });
      const client = yield* makeOmpRpcClient({
        command,
        args: ["--mode", "rpc"],
        onEvent: (frame) => events.push(frame),
      });
      // close() drains stdout to EOF, so scripted frames (even delayed ones) are delivered
      // before the child exits — no real-time sleep needed.
      yield* client.close;
      expect(events.map((frame) => frame["message"])).toEqual(["one", "two"]);
    }),
  );

  describe("frame facts", () => {
    it.effect("rejects an interleaved rpc_chunk sequence fail-closed", () =>
      Effect.sync(() => {
        const decode = makeOmpFrameDecoder({ maxReassembledFrameBytes: 64 * 1024 * 1024 });
        const payload = (message: string) =>
          Buffer.from(JSON.stringify({ type: "notice", message }), "utf8");
        const chunk = (chunkId: string, bytes: Buffer, index: number, count: number) => ({
          type: "rpc_chunk",
          chunkId,
          index,
          count,
          byteLength: bytes.byteLength,
          data: bytes.toString("base64"),
        });
        const a = payload("a");
        const first = decode(chunk("a", a, 0, 1));
        expect(first.error).toBeUndefined();
        expect(first.frames).toEqual([{ type: "notice", message: "a" }]);

        const b = payload("b");
        const c = payload("c");
        expect(decode(chunk("b", b, 0, 2)).error).toBeUndefined();
        const interleaved = decode(chunk("c", c, 0, 1));
        expect(interleaved.error).toMatch(/interleaved|interrupted/);
        expect(interleaved.frames).toEqual([]);
        // The interrupted sequence was dropped, so a fresh sequence starts cleanly at index 0.
        const restarted = decode(chunk("d", c, 0, 1));
        expect(restarted.error).toBeUndefined();
        expect(restarted.frames).toEqual([{ type: "notice", message: "c" }]);
      }),
    );
  });
});
