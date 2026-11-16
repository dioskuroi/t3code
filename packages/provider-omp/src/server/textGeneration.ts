// M1: no host-side text generation yet; omp-only turn generation arrives with the adapter (#14).
// Fail-closed keeps composer features honest instead of silently producing nothing.
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

const ompTextError = (operation: string) =>
  new TextGenerationError({
    operation,
    detail: "omp does not support this text generation operation yet.",
  });

export const makeOmpTextGeneration = (): ProviderTextGeneration => ({
  generateCommitMessage: () => Effect.fail(ompTextError("generateCommitMessage")),
  generatePrContent: () => Effect.fail(ompTextError("generatePrContent")),
  generateBranchName: () => Effect.fail(ompTextError("generateBranchName")),
  generateThreadTitle: () => Effect.fail(ompTextError("generateThreadTitle")),
  generateReviewGuide: () => Effect.fail(ompTextError("generateReviewGuide")),
});
