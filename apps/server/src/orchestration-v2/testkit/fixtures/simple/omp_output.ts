import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";
import { assertSimpleOutput } from "./codex_output.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Real omp streams a thinking block before the answer; `thinking_end` carries its full text. */
export function recordedThinkingTexts(
  transcript: ProviderReplayTranscript,
): ReadonlyArray<unknown> {
  return transcript.entries.flatMap((entry) => {
    const update = field(
      entry.type === "emit_inbound" ? entry.frame : undefined,
      "assistantMessageEvent",
    );
    return field(update, "type") === "thinking_end" ? [field(update, "content")] : [];
  });
}

export function assertReasoningItemsMatchRecording(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const recorded = recordedThinkingTexts(transcript);
  assert.isNotEmpty(recorded, "the recording must stream omp thinking blocks");
  assert.deepEqual(
    projectionFor(result, transcript.scenario).turnItems.flatMap((item) =>
      item.type === "reasoning" ? [item.text] : [],
    ),
    recorded,
    "omp thinking deltas must project as reasoning items with the recorded text",
  );
}

export function assertOmpSimpleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(transcript.provider, "omp");
  assertSimpleOutput(result, transcript);
  assertReasoningItemsMatchRecording(result, transcript);

  const projection = projectionFor(result, transcript.scenario);
  const [turn] = projection.providerTurns;
  // omp has no native turn identity; the adapter synthesizes `<thread>:t1:r1` and keeps it weak.
  assert.equal(turn?.nativeTurnRef?.strength, "weak");
  assert.isDefined(turn?.nativeTurnRef?.nativeId);
}
