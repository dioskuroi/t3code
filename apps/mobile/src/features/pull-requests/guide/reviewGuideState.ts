import type { PullRequestReviewGuideResult } from "@t3tools/contracts";
import { tr } from "@t3tools/shared/i18n";

export function reviewGuideState(data: PullRequestReviewGuideResult | null) {
  const guide = data?.guide ?? null;
  return {
    guide,
    running: data?.run?._tag === "Running",
    stale: guide !== null && data?.currentHeadSha != null && guide.headSha !== data.currentHeadSha,
    failure:
      data?.run?._tag === "Failed" && data.run.headSha === data.currentHeadSha
        ? data.run.detail
        : null,
  };
}

export function guideNoticeState(state: {
  readonly data: PullRequestReviewGuideResult | null;
  readonly isPending: boolean;
  readonly running: boolean;
  readonly startError: string | null;
  readonly error: string | null;
}) {
  const { guide, stale, failure } = reviewGuideState(state.data);
  if (state.running) {
    return {
      kind: "writing" as const,
      title: tr("Rewriting guide"),
      description: guide
        ? tr("You can keep reading this guide while the agent writes the update.")
        : tr(
            "An agent is reading the change and writing the tour. You can leave and come back when it\u2019s ready.",
          ),
      action: guide ? tr("Rewriting\u2026") : tr("Writing guide\u2026"),
    };
  }
  const error = state.startError ?? failure;
  if (error) {
    return {
      kind: "failed" as const,
      title: tr("Could not write guide"),
      description: error,
      action: tr("Try again"),
    };
  }
  if (state.error) {
    return {
      kind: "unavailable" as const,
      title: tr("Could not refresh guide"),
      description: state.error,
      action: tr("Try again"),
    };
  }
  if (!state.data) {
    return {
      kind: "loading" as const,
      title: tr("Review guide"),
      description: tr("Checking for a saved guide\u2026"),
      action: tr("Loading guide\u2026"),
    };
  }
  if (stale) {
    return {
      kind: "stale" as const,
      title: tr("New changes since this guide"),
      description: tr("You can read the previous guide, or rewrite it for the latest changes."),
      action: tr("Rewrite guide"),
    };
  }
  return {
    kind: guide ? ("ready" as const) : ("empty" as const),
    title: tr("Review guide"),
    description: tr(
      "Get a tour of the change, with code excerpts and notes on what needs a closer look.",
    ),
    action: tr("Write guide"),
  };
}
