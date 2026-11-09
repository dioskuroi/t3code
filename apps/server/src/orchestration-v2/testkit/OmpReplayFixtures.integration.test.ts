import { describe, it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import {
  materializeOmpReplayWorkspace,
  OmpOrchestratorReplayHarness,
} from "../Adapters/OmpAdapterV2.testkit.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { OMP_PROVIDER } from "@t3tools/provider-omp/testing";

const OMP_VARIANTS = ORCHESTRATOR_REPLAY_FIXTURES.flatMap((fixture) =>
  fixture.providers
    .filter((provider) => provider.driver === OMP_PROVIDER)
    .map((provider) => ({ fixtureName: fixture.name, provider })),
);

describe("Omp replay fixtures", () => {
  itRunsReplayFixtures("omp", (input) =>
    runReplayFixture({
      ...input,
      harness: OmpOrchestratorReplayHarness,
      // The tape's open_session/session frames carry the recording workspace; omp thread
      // metadata points at them, so materialize the placeholder onto the replay workspace.
      materializeWorkspace: (transcript, workspace) =>
        Effect.succeed(materializeOmpReplayWorkspace(transcript, workspace)),
    }),
  );

  // Review #2, tape-fact: omp answers the `prompt` request immediately — the response frame
  // is the very next transcript entry, before any streamed message event. This pins the fact
  // that the shared 30s request timeout never races a long turn (the turn ends later via
  // prompt_result, outside the request/response window).
  it.effect("answers every prompt request on the immediately following frame", () =>
    Effect.gen(function* () {
      expect(OMP_VARIANTS.length).toBeGreaterThanOrEqual(3);
      for (const { fixtureName, provider } of OMP_VARIANTS) {
        const transcript = yield* readProviderReplayTranscript(provider.transcriptFile);
        const entries = transcript.entries;
        const frameId = (frame: unknown): unknown => {
          if (typeof frame !== "object" || frame === null || !("id" in frame)) return undefined;
          return frame.id;
        };
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index]!;
          if (entry.type !== "expect_outbound" || entry.label !== "prompt") continue;
          const requestId = frameId(entry.frame);
          const next = entries[index + 1];
          expect(
            next !== undefined &&
              next.type === "emit_inbound" &&
              next.label === `response:prompt` &&
              frameId(next.frame) === requestId,
            `${fixtureName}: prompt ${String(requestId)} must be answered by the next frame`,
          ).toBe(true);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
