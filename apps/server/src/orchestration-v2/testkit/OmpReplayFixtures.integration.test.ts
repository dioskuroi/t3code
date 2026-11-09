import { describe } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  materializeOmpReplayWorkspace,
  OmpOrchestratorReplayHarness,
} from "../Adapters/OmpAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

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
});
