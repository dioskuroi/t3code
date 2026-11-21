// Host-side text generation tests: driven by the fake omp JSONL harness at
// the ProviderTextGeneration seam — spawn → prompt → assistant frames → structured output.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ModelSelection, TextGenerationError } from "@t3tools/contracts";

import {
  makeOmpTextGeneration,
  writeFakeOmp,
  type FakeOmpProgram,
  type OmpTextGenerationOptions,
} from "../testing.ts";

const decodeModelSelection = Schema.decodeSync(ModelSelection);
const isTextGenerationError = Schema.is(TextGenerationError);

/** Narrows an `Effect.result` outcome to its failure branch, failing the test on Success. */
const failOf = <A, E>(result: Result.Result<A, E>): E => {
  if (result._tag !== "Failure") {
    throw new Error(`expected a Failure outcome, got ${result._tag}`);
  }
  return result.failure;
};

const readRequestLog = Effect.fn("textGenTest.readRequestLog")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(path);
  return contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
});

const makeTextGeneration = Effect.fn("textGenTest.makeTextGeneration")(function* (
  program: FakeOmpProgram = {},
  options: OmpTextGenerationOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-textgen-" });
  const requestLog = `${directory}/requests.jsonl`;
  const argvLog = `${directory}/argv.jsonl`;
  const command = writeFakeOmp({
    directory,
    program,
    env: { FAKE_OMP_REQUEST_LOG: requestLog, FAKE_OMP_ARGV_LOG: argvLog },
  });
  const generation = yield* makeOmpTextGeneration({ command, ...options });
  return { generation, requestLog, cwd: directory, argvLog };
});

// One assistant reply that answers the core title prompt's JSON contract, then a real
// terminal sequence (message_end inside the stream, terminal agent_end, prompt_result).
const titleProgram: FakeOmpProgram = {
  responses: {},
  eventsPerRequest: {
    prompt: [
      {
        frame: {
          type: "message_update",
          messageId: "m1",
          assistantMessageEvent: { type: "text_start", contentIndex: 0 },
        },
      },
      {
        frame: {
          type: "message_update",
          messageId: "m1",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: '{"title":' },
        },
      },
      {
        delayMs: 20,
        frame: {
          type: "message_update",
          messageId: "m1",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: ' "Fix Lazy Thread Feed Test", "needsRefinement": false}',
          },
        },
      },
      {
        frame: {
          type: "message_update",
          messageId: "m1",
          assistantMessageEvent: { type: "text_end", contentIndex: 0 },
        },
      },
      { frame: { type: "agent_end", isTerminal: true } },
      { frame: { type: "prompt_result", status: "completed" } },
    ],
  },
};

// Commit-schema assistant reply: exercises a different outputSchema than the title flow.
const commitProgram: FakeOmpProgram = {
  responses: {},
  eventsPerRequest: {
    prompt: [
      {
        frame: {
          type: "message_update",
          messageId: "m1",
          assistantMessageEvent: { type: "text_start", contentIndex: 0 },
        },
      },
      {
        frame: {
          type: "message_update",
          messageId: "m1",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: '{"subject": "Fix lazy thread feed test", "body": ""}',
          },
        },
      },
      {
        frame: {
          type: "message_update",
          messageId: "m1",
          assistantMessageEvent: { type: "text_end", contentIndex: 0 },
        },
      },
      { frame: { type: "prompt_result", status: "completed" } },
    ],
  },
};

it.layer(NodeServices.layer)("omp host-side text generation", (it) => {
  it.effect(
    "generates a thread title through a one-shot omp RPC session (spawn → prompt → assistant → title)",
    () =>
      Effect.gen(function* () {
        const { generation, requestLog, cwd, argvLog } = yield* makeTextGeneration(titleProgram);
        const fs = yield* FileSystem.FileSystem;
        const result = yield* generation.generateThreadTitle({
          cwd,
          message: "Fix the lazy thread feed test that flakes on CI",
          modelSelection: decodeModelSelection({
            instanceId: "omp-test-instance",
            model: "default",
          }),
        });
        expect(result.title).toBe("Fix Lazy Thread Feed Test");
        expect(result.needsRefinement).toBeUndefined();
        const argv = JSON.parse(yield* fs.readFileString(argvLog)) as ReadonlyArray<string>;
        expect(argv).toContain("--profile");
        expect(argv).toContain("t3code");

        const requests = yield* readRequestLog(requestLog);
        // The one-shot session attaches via switch_session onto a unique
        // thread-private file — never a bare open_session directory pick.
        const switches = requests.filter((request) => request["type"] === "switch_session");
        expect(switches).toHaveLength(1);
        const sessionPath = String(switches[0]?.["sessionPath"]);
        expect(sessionPath.startsWith(`${cwd}/.t3code/omp-generation/generation-`)).toBe(true);
        expect(sessionPath.endsWith(".jsonl")).toBe(true);
        expect(requests.some((request) => request["type"] === "open_session")).toBe(false);
        const prompt = requests.find((request) => request["type"] === "prompt");
        expect(typeof prompt?.["message"]).toBe("string");
        expect(prompt?.["message"]).toContain("Fix the lazy thread feed test that flakes on CI");
        expect(prompt?.["message"]).toContain("Return JSON with keys title and needsRefinement");
        // "default" never drives set_model (adapter convention): a fresh session follows omp.
        expect(requests.some((request) => request["type"] === "set_model")).toBe(false);
      }),
  );

  it.effect("applies a concrete omp model slug via set_model before the prompt", () =>
    Effect.gen(function* () {
      const { generation, requestLog, cwd } = yield* makeTextGeneration(commitProgram);
      const result = yield* generation.generateCommitMessage({
        cwd,
        branch: "main",
        stagedSummary: "M apps/server/src/device/DeviceService.ts",
        stagedPatch: "diff --git a/x b/x\n+console.log(1)",
        modelSelection: decodeModelSelection({
          instanceId: "omp-test-instance",
          model: "zai/glm-5.3",
        }),
      });
      expect(result.subject).toBe("Fix lazy thread feed test");
      const requests = yield* readRequestLog(requestLog);
      const setModel = requests.find((request) => request["type"] === "set_model");
      expect(setModel?.["provider"]).toBe("zai");
      expect(setModel?.["modelId"]).toBe("glm-5.3");
      const prompt = requests.find((request) => request["type"] === "prompt");
      expect(prompt?.["message"]).toContain("You write concise git commit messages.");
      // Adapter protocol order: the session exists before the model is applied.
      const switchIndex = requests.findIndex((request) => request["type"] === "switch_session");
      const setModelIndex = requests.findIndex((request) => request["type"] === "set_model");
      const promptIndex = requests.findIndex((request) => request["type"] === "prompt");
      expect(switchIndex).toBeGreaterThanOrEqual(0);
      expect(switchIndex).toBeLessThan(setModelIndex);
      expect(setModelIndex).toBeLessThan(promptIndex);
    }),
  );

  it.effect("fails closed on an unparseable model slug instead of silently using the default", () =>
    Effect.gen(function* () {
      const { generation, cwd } = yield* makeTextGeneration(titleProgram);
      const failure = failOf(
        yield* Effect.result(
          generation.generateBranchName({
            cwd,
            message: "add a search page",
            modelSelection: decodeModelSelection({
              instanceId: "omp-test-instance",
              model: "not-a-slug",
            }),
          }),
        ),
      );
      expect(isTextGenerationError(failure)).toBe(true);
      expect(failure.detail).toContain("must use provider/model format");
    }),
  );

  it.effect("surfaces an omp error turn status as TextGenerationError", () =>
    Effect.gen(function* () {
      const { generation, cwd } = yield* makeTextGeneration({
        eventsPerRequest: {
          prompt: [
            {
              frame: { type: "prompt_result", status: "error", error: { message: "rate limited" } },
            },
          ],
        },
      });
      const failure = failOf(
        yield* Effect.result(
          generation.generateThreadTitle({
            cwd,
            message: "Fix the lazy thread feed test that flakes on CI",
            modelSelection: decodeModelSelection({
              instanceId: "omp-test-instance",
              model: "default",
            }),
          }),
        ),
      );
      expect(isTextGenerationError(failure)).toBe(true);
      expect(failure.detail).toContain("rate limited");
    }),
  );

  it.effect("fails closed when the omp process exits mid-generation", () =>
    Effect.gen(function* () {
      // Crash lands AFTER the prompt ack with no terminal frames ever sent: only the exit
      // watcher backstop can end the wait (a pending-request failure cannot fire here).
      const { generation, cwd } = yield* makeTextGeneration({
        crash: { delayMs: 50, exitCode: 1 },
      });
      const failure = failOf(
        yield* Effect.result(
          generation.generateThreadTitle({
            cwd,
            message: "Fix the lazy thread feed test that flakes on CI",
            modelSelection: decodeModelSelection({
              instanceId: "omp-test-instance",
              model: "default",
            }),
          }),
        ),
      );
      expect(isTextGenerationError(failure)).toBe(true);
      expect(failure.detail).toContain("exited during generation");
    }),
  );

  it.effect("fails closed on review guide: one-shot sessions cannot investigate read-only", () =>
    Effect.gen(function* () {
      const { generation, cwd } = yield* makeTextGeneration(titleProgram);
      const failure = failOf(
        yield* Effect.result(
          generation.generateReviewGuide({
            cwd,
            number: 103,
            title: "provider-omp text generation",
            description: "Implement host-side text generation.",
            baseBranch: "main",
            baseCommit: "abc123",
            settledReview: "LGTM except for the timeout.",
            modelSelection: decodeModelSelection({
              instanceId: "omp-test-instance",
              model: "default",
            }),
          }),
        ),
      );
      expect(isTextGenerationError(failure)).toBe(true);
      expect(failure.detail).toContain("cannot investigate a checkout read-only");
    }),
  );
});

// Real clock: the fail-closed timeout must fire against wall-clock silence, and it.effect's
// frozen TestClock would never advance either the runner timeout or the RPC request timeout.
it.live("times out fail-closed when omp never completes the generation turn", () =>
  Effect.gen(function* () {
    const { generation, cwd } = yield* makeTextGeneration(
      { responses: { prompt: { never: true } } },
      { timeoutMs: 300 },
    );
    const failure = failOf(
      yield* Effect.result(
        generation.generateThreadTitle({
          cwd,
          message: "Fix the lazy thread feed test that flakes on CI",
          modelSelection: decodeModelSelection({
            instanceId: "omp-test-instance",
            model: "default",
          }),
        }),
      ),
    );
    expect(isTextGenerationError(failure)).toBe(true);
    expect(failure.detail).toContain("timed out after 300ms");
  }).pipe(Effect.provide(NodeServices.layer)),
);
