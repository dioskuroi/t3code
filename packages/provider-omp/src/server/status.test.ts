import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { OmpSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import {
  checkOmpProviderStatus,
  isOmpReadyFrame,
  isOmpResponseFrame,
  ompSupportsProtocolV2,
  parseOmpRpcFrame,
  writeFakeOmp,
  type FakeOmpProgram,
} from "../testing.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

// Drain marker only appears after stdin EOF, then the process exits 0 — proving the caller
// closed stdin and kept reading stdout until the child finished.
const FAKE_OMP_DRAIN_MARKER = "FAKE_OMP_DRAIN_MARKER";

const writeFakeOmpIntoTemp = Effect.fn("statusTest.writeFakeOmp")(function* (
  program: FakeOmpProgram = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-status-test-" });
  return { command: writeFakeOmp({ directory, program }), directory };
});

it.layer(NodeServices.layer)("omp status check", (it) => {
  it.effect("reports ready with the model catalog and exits after stdin closes", () =>
    Effect.gen(function* () {
      const { command, directory } = yield* writeFakeOmpIntoTemp({
        responses: {
          get_available_models: {
            data: {
              models: [
                {
                  provider: "zai",
                  id: "glm-5.3",
                  name: "GLM-5.3",
                  reasoning: true,
                  contextWindow: 200000,
                },
                { provider: "moonshot", id: "kimi-k3", name: "Kimi K3", reasoning: false },
              ],
            },
          },
        },
      });
      const markerPath = `${directory}/drain-marker`;
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({}),
        { ...process.env, [FAKE_OMP_DRAIN_MARKER]: markerPath },
        undefined,
        command,
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("18.18.1");
      // Spec §7 (ADR-0004): the plan-mode interaction toggle is never presented; /plan rides
      // the slash-command passthrough instead. Context-window metering is presented (#20).
      expect(snapshot.showInteractionModeToggle).toBe(false);
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

  it.effect(
    "attaches a reasoning thinking-level descriptor from get_available_thinking_levels",
    () =>
      Effect.gen(function* () {
        const { command } = yield* writeFakeOmpIntoTemp({
          responses: {
            get_available_models: {
              data: {
                models: [{ provider: "zai", id: "glm-5.3", name: "GLM-5.3", reasoning: true }],
              },
            },
            get_available_thinking_levels: {
              // Measured omp 18.18.1 shape (migration notes rpc-protocol.md).
              data: { levels: ["off", "low", "high", "max"] },
            },
          },
        });
        const snapshot = yield* checkOmpProviderStatus(
          decodeOmpSettings({}),
          { ...process.env },
          undefined,
          command,
        );
        expect(snapshot.status).toBe("ready");
        const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
        if (descriptor === undefined) throw new Error("expected a thinking-level descriptor");
        expect(descriptor).toEqual({
          id: "thinking",
          label: "Thinking",
          type: "select",
          role: "reasoning",
          options: [
            { id: "off", label: "Off" },
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
            { id: "max", label: "Max" },
          ],
        });
        // The runtime-level control attaches to every catalog entry.
        expect(snapshot.models.map((model) => model.capabilities?.optionDescriptors?.[0])).toEqual([
          descriptor,
        ]);
      }),
  );

  it.effect("omits the thinking descriptor when omp reports no thinking levels", () =>
    Effect.gen(function* () {
      const { command } = yield* writeFakeOmpIntoTemp({
        responses: {
          get_available_models: {
            data: {
              models: [{ provider: "zai", id: "glm-5.3", name: "GLM-5.3", reasoning: true }],
            },
          },
          get_available_thinking_levels: { data: { levels: [] } },
        },
      });
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({}),
        { ...process.env },
        undefined,
        command,
      );
      expect(snapshot.status).toBe("ready");
      // Spec §7 default rule: unmapped means unpresented.
      expect(snapshot.models[0]?.capabilities).toBeNull();
    }),
  );

  it.effect("fails closed with an upgrade hint when omp does not support protocol v2", () =>
    Effect.gen(function* () {
      const { command } = yield* writeFakeOmpIntoTemp({ supportedProtocolVersions: [1] });
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({}),
        process.env,
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
