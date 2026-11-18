// Host-side text generation: each operation runs a one-shot `omp --mode rpc` session (spec §5.2
// spawn semantics), injects the core-built prompt, and fail-closed decodes the first assistant
// reply. Throwaway sessions live in `.t3code/omp-generation` (never thread recovery); review
// guide stays unreachable — one-shot sessions cannot guarantee read-only investigation.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import { frameRecord, frameString } from "./frameFields.ts";
import { OMP_INHERIT_MODEL_SLUG, parseOmpModelSlug } from "./projection.ts";
import { makeOmpRpcClient, OMP_REQUEST_TIMEOUT_MS } from "./rpc/client.ts";
import type { OmpRpcFrame } from "./rpc/frames.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

export interface OmpTextGenerationOptions {
  /** Resolved executable; defaults to `omp` (PATH discovery). Tests inject the fake omp. */
  readonly command?: string | undefined;
  /** Whole-operation fail-closed timeout; tests shorten it. Defaults to the 30s convention. */
  readonly timeoutMs?: number | undefined;
}

type GenerationOutcome =
  | { readonly status: "completed"; readonly text: string }
  | {
      readonly status: "failed";
      readonly detail: string;
    };

/**
 * Collects the first assistant reply from raw omp frames. Mirrors the projection's terminal
 * semantics (projection.ts): a maintenance `agent_end` (isTerminal:false) holds an early
 * `prompt_result` until the real terminal `agent_end`; only `text_delta` counts as content.
 */
const makeGenerationCollector = (onDone: (outcome: GenerationOutcome) => void) => {
  let text = "";
  let awaitingAgentEnd = false;
  let heldPromptResult: OmpRpcFrame | undefined;
  let done = false;
  const finish = (outcome: GenerationOutcome) => {
    if (done) return;
    done = true;
    onDone(outcome);
  };
  const handlePromptResult = (frame: OmpRpcFrame) => {
    const status = frameString(frame, "status");
    if (status === "aborted") {
      finish({ status: "failed", detail: "omp generation was aborted." });
      return;
    }
    if (status === "error") {
      const error = frameRecord(frame, "error") ?? {};
      finish({
        status: "failed",
        detail: frameString(error, "message") ?? "omp generation turn failed.",
      });
      return;
    }
    finish({ status: "completed", text });
  };
  return {
    observe: (frame: OmpRpcFrame) => {
      if (done) return;
      if (frame["type"] === "message_update") {
        const event = frameRecord(frame, "assistantMessageEvent");
        if (event !== undefined && event["type"] === "text_delta") {
          text += typeof event["delta"] === "string" ? event["delta"] : "";
        }
        return;
      }
      if (frame["type"] === "agent_end") {
        if (frame["isTerminal"] === false) {
          awaitingAgentEnd = true;
          return;
        }
        if (heldPromptResult !== undefined) {
          const held = heldPromptResult;
          heldPromptResult = undefined;
          handlePromptResult(held);
          return;
        }
        finish({ status: "completed", text });
        return;
      }
      if (frame["type"] === "prompt_result") {
        if (awaitingAgentEnd) {
          heldPromptResult = frame;
          return;
        }
        handlePromptResult(frame);
      }
    },
    /** Exit watcher backstop: a dead child can never deliver the terminal frames. */
    fail: (detail: string) => finish({ status: "failed", detail }),
  };
};

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  options: OmpTextGenerationOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Whole-operation fail-closed timeout rides the RPC client's 30s convention (one value,
  // spec §5.2); tests shorten it via the option.
  const timeoutMs = options.timeoutMs ?? OMP_REQUEST_TIMEOUT_MS;

  const runOmpGeneration: TextGenerationOperations.Runner = Effect.fn("OmpTextGeneration.run")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const completed = yield* Deferred.make<GenerationOutcome>();
      const collector = makeGenerationCollector((outcome) =>
        Deferred.doneUnsafe(completed, Effect.succeed(outcome)),
      );
      const client = yield* makeOmpRpcClient({
        ...(options.command !== undefined ? { command: options.command } : {}),
        cwd,
        // Child stderr goes to the server log (spec §5.2 / #14 client contract), mirroring
        // the adapter's wiring: generation failures would otherwise lose omp's diagnostics.
        onStderr: (chunk) => {
          const text = chunk.trim();
          if (text === "") return;
          Effect.runFork(Effect.logWarning(`omp stderr [${operation}]: ${text}`));
        },
        onEvent: (frame) => collector.observe(frame),
        onExit: (exit) =>
          collector.fail(`omp process exited during generation (code ${String(exit.exitCode)}).`),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      // Protocol order mirrors the adapter's verified lifecycle (adapter.ts): the session
      // must exist before set_model — without it omp rejects the model or open_session
      // resets a fresh session back to its default model.
      yield* client.request("open_session", { sessionDir: `${cwd}/.t3code/omp-generation` });
      // Model selection rides the adapter convention: a concrete omp slug applies via
      // set_model; "default" keeps the fresh session on omp's own resolution.
      const slug = modelSelection.model;
      if (slug !== OMP_INHERIT_MODEL_SLUG) {
        const parsed = parseOmpModelSlug(slug);
        if (parsed === null) {
          return yield* new TextGenerationError({
            operation,
            detail: `omp model '${slug}' must use provider/model format.`,
          });
        }
        yield* client.request("set_model", { provider: parsed.provider, modelId: parsed.modelId });
      }

      yield* client.request("prompt", { message: prompt, streamingBehavior: "followUp" });
      // The prompt ack returns immediately; the reply lands via terminal events.
      const outcome = yield* Deferred.await(completed);
      // Orderly teardown: close stdin and drain to EOF before the run scope tears down.
      yield* client.close.pipe(Effect.ignore);
      if (outcome.status === "failed") {
        return yield* new TextGenerationError({ operation, detail: outcome.detail });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "omp", outcome.text);
    },
    // Wrapper: whole-operation 30s fail-closed timeout, TextGenerationError mapping, and a
    // per-run scope so every spawn is torn down even when a timeout interrupts mid-turn.
    (effect, request) =>
      effect.pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: request.operation,
                  detail: `omp text generation timed out after ${String(timeoutMs)}ms (fail-closed).`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: "omp text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );

  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("omp", runOmpGeneration),
  ) satisfies ProviderTextGeneration;
});
