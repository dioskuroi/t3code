import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_PROMPT,
} from "../shared.ts";
import { recordedThinkingTexts } from "../simple/omp_output.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function assertOmpTurnInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(transcript.provider, "omp");
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_PROMPT]);

  // The abort must have reached omp: the tape records its abort ack and the aborted
  // prompt_result, and the run ends interrupted with the thread back to idle.
  const inboundTypes = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" ? [field(entry.frame, "type")] : [],
  );
  assert.include(inboundTypes, "prompt_result");
  const aborted = transcript.entries.some(
    (entry) =>
      entry.type === "emit_inbound" &&
      field(entry.frame, "type") === "prompt_result" &&
      field(entry.frame, "status") === "aborted",
  );
  assert.isTrue(aborted, "recording must contain a prompt_result with status aborted");

  const interruptRequest = projection.turnItems.find(
    (item) => item.type === "run_interrupt_request",
  );
  const interruptResult = projection.turnItems.find((item) => item.type === "run_interrupt_result");
  assert.isDefined(interruptRequest);
  assert.isDefined(interruptResult);
  assert.equal(interruptRequest.status, "completed");
  assert.equal(interruptResult.status, "interrupted");
  assert.equal(interruptResult.parentItemId, interruptRequest.id);
  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["interrupted"],
  );
  assert.deepEqual(
    projection.nodes.map((node) => node.status),
    ["interrupted"],
  );
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.equal(projection.providerTurns[0]?.status, "interrupted");

  // Whatever omp streamed before the abort (thinking deltas, tool frames) still projects.
  const recorded = recordedThinkingTexts(transcript);
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "reasoning" ? [item.text] : [])),
    recorded,
    "thinking streamed before the abort must still project as reasoning items",
  );
  // Tool projection follows the tape: frames recorded before the abort appear as dynamic_tool.
  const tapeHasToolStart = transcript.entries.some(
    (entry) =>
      entry.type === "emit_inbound" && field(entry.frame, "type") === "tool_execution_start",
  );
  assert.equal(
    tapeHasToolStart,
    projection.turnItems.some((item) => item.type === "dynamic_tool"),
  );
}
