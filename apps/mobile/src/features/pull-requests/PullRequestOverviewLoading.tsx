import { Chip } from "../../components/ui/Chip";
import { tr } from "@t3tools/shared/i18n";
import { PullRequestSectionHeading } from "./PullRequestSectionHeading";
import type { PullRequestListEntry } from "@t3tools/contracts";
import { View } from "react-native";
import { PullRequestCardGroup, PullRequestCardRow } from "./PullRequestControls";
import { PullRequestStackCard } from "./PullRequestStackCard";
import type { PullRequestParams } from "./usePullRequestDiff";
import type { PullRequestStackState } from "./usePullRequestStack";
import { pullRequestListReviewStatus } from "./pullRequestList";
import { PullRequestGlyph } from "./pullRequestGlyphs";

export function PullRequestOverviewLoading({
  summary,
  params,
  stack,
}: {
  readonly summary: PullRequestListEntry;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
}) {
  const review = pullRequestListReviewStatus(summary);
  const conflicting = summary.mergeability === "conflicting";
  const clean = summary.mergeability === "mergeable";
  return (
    <View
      className="gap-5"
      accessibilityLabel={tr("Loading pull request details")}
      accessibilityState={{ busy: true }}
    >
      <PullRequestStackCard params={params} state={stack} />
      <PullRequestCardGroup>
        <PullRequestCardRow
          compact
          title={
            summary.checksState === "passing"
              ? tr("Checks completed")
              : summary.checksState === "failing"
                ? tr("Checks failing")
                : summary.checksState === "pending"
                  ? tr("Checks running")
                  : tr("Checks")
          }
          icon={
            summary.checksState === "passing"
              ? "checkmark.circle"
              : summary.checksState === "failing"
                ? "exclamationmark.circle"
                : "clock"
          }
          tint={
            summary.checksState === "passing"
              ? "accent-adaptive-emerald-600-400"
              : summary.checksState === "failing"
                ? "accent-danger-foreground"
                : "accent-icon-muted"
          }
        >
          <View className="h-3 w-16 rounded bg-subtle-strong" />
        </PullRequestCardRow>
        <PullRequestCardRow
          compact
          title={review?.accessibleLabel ?? tr("Reviews")}
          icon={review?.icon ?? "bubble.left"}
          tint={review?.tint}
        >
          <View className="h-3 w-20 rounded bg-subtle-strong" />
        </PullRequestCardRow>
        <PullRequestCardRow
          compact
          title={
            conflicting
              ? tr("Conflicts with {branch}", { branch: summary.baseBranch })
              : clean
                ? tr("No conflicts with {branch}", { branch: summary.baseBranch })
                : tr("Branch")
          }
          icon={
            conflicting ? PullRequestGlyph.conflicting : clean ? "checkmark.circle" : "arrow.branch"
          }
          tint={
            conflicting
              ? "accent-danger-foreground"
              : clean
                ? "accent-adaptive-emerald-600-400"
                : undefined
          }
        />
        <View className="border-t border-border-subtle p-3">
          <View className="h-11 rounded-xl bg-subtle-strong" />
        </View>
      </PullRequestCardGroup>
      {summary.labels.length ? (
        <View className="flex-row flex-wrap gap-2">
          {summary.labels.map((label) => (
            <Chip key={label.name} label={label.name} size="small" />
          ))}
        </View>
      ) : null}
      <View className="gap-3">
        <PullRequestSectionHeading>{tr("Description")}</PullRequestSectionHeading>
        <View className="gap-3 py-1">
          <View className="h-4 w-full rounded bg-subtle-strong" />
          <View className="h-4 w-full rounded bg-subtle-strong" />
          <View className="h-4 w-3/4 rounded bg-subtle-strong" />
        </View>
      </View>
    </View>
  );
}
