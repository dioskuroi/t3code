import {
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import { tr } from "@t3tools/shared/i18n";
import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { PullRequestGlyph } from "./pullRequestGlyphs";

type ActionDetail = Pick<
  PullRequestDetail,
  "state" | "isDraft" | "mergeability" | "autoMergeEnabled" | "workflowApprovalsRequired"
> & {
  readonly capabilities: Pick<
    PullRequestDetail["capabilities"],
    "actions" | "mergeMethods" | "updateMethods" | "deleteBranch"
  >;
  readonly viewerPermissions: Pick<
    PullRequestDetail["viewerPermissions"],
    "actions" | "updateMethods"
  >;
  readonly mergeCapabilities: PullRequestDetail["mergeCapabilities"];
};

export const MERGE_METHODS = {
  squash: {
    title: tr("Squash and merge"),
    description: tr("Combine the commits into one commit."),
  },
  merge: {
    title: tr("Create a merge commit"),
    description: tr("Keep the commits and add a merge commit."),
  },
  rebase: {
    title: tr("Rebase and merge"),
    description: tr("Add the commits without a merge commit."),
  },
} as const satisfies Record<PullRequestMergeMethod, { title: string; description: string }>;

export function pullRequestActionLabel(
  action: PullRequestAction,
  terminology: ChangeRequestTerminology,
): string {
  switch (action) {
    case "merge":
      return tr("Merge {singular}", { singular: terminology.singular });
    case "ready":
      return tr("Mark ready for review");
    case "draft":
      return tr("Convert to draft");
    case "close":
      return tr("Close {singular}", { singular: terminology.singular });
    case "reopen":
      return tr("Reopen {singular}", { singular: terminology.singular });
    case "update-branch":
      return tr("Update branch");
    case "enable-auto-merge":
      return tr("Enable auto-merge");
    case "disable-auto-merge":
      return tr("Disable auto-merge");
    case "revert":
      return tr("Create revert {singular}", { singular: terminology.singular });
    case "delete-branch":
      return tr("Delete branch");
    case "approve-workflows":
      return tr("Approve workflows");
  }
}

export const PR_ACTION_ICONS = {
  merge: PullRequestGlyph.merged,
  ready: "checkmark.circle",
  draft: "pencil",
  close: "xmark",
  reopen: "arrow.clockwise",
  "update-branch": "arrow.up.circle",
  "enable-auto-merge": "clock",
  "disable-auto-merge": "xmark",
  revert: "arrow.uturn.backward",
  "delete-branch": "trash",
  "approve-workflows": "checkmark",
} as const satisfies Record<PullRequestAction, AppSymbolName>;

export function allowedMergeMethods(pr: ActionDetail) {
  return pr.capabilities.mergeMethods.filter((method) => pr.mergeCapabilities[method]);
}

export function allowedUpdateMethods(pr: ActionDetail) {
  return (pr.capabilities.updateMethods ?? []).filter((method) =>
    pr.viewerPermissions.updateMethods?.includes(method),
  );
}

export function canPerformPullRequestAction(pr: ActionDetail, action: PullRequestAction) {
  if (!pr.capabilities.actions.includes(action) || !pr.viewerPermissions.actions.includes(action))
    return false;
  if (action === "reopen") return pr.state === "closed";
  if (action === "revert") return pr.state === "merged";
  if (action === "delete-branch")
    return pr.state !== "open" && pr.capabilities.deleteBranch === true;
  if (pr.state !== "open") return false;
  switch (action) {
    case "update-branch":
      return allowedUpdateMethods(pr).length > 0;
    case "approve-workflows":
      return (pr.workflowApprovalsRequired ?? 0) > 0;
    case "ready":
      return pr.isDraft;
    case "draft":
      return !pr.isDraft;
    case "merge":
      return !pr.isDraft && pr.mergeability !== "conflicting" && allowedMergeMethods(pr).length > 0;
    case "enable-auto-merge":
      return !pr.isDraft && pr.autoMergeEnabled === false && allowedMergeMethods(pr).length > 0;
    case "disable-auto-merge":
      return pr.autoMergeEnabled === true;
    default:
      return true;
  }
}

export function mergeUnavailableReason(
  pr: ActionDetail,
  connectionAllowsWrites: boolean,
  terminology: ChangeRequestTerminology,
) {
  if (pr.state === "merged")
    return tr("This {singular} has been merged.", { singular: terminology.singular });
  if (pr.state === "closed")
    return tr("Reopen this {singular} before merging.", { singular: terminology.singular });
  if (!connectionAllowsWrites) return tr("This environment connection is read-only.");
  if (!pr.capabilities.actions.includes("merge"))
    return tr("This provider does not support merging here.");
  if (!pr.viewerPermissions.actions.includes("merge"))
    return tr("Your account cannot merge this {singular}.", { singular: terminology.singular });
  if (pr.isDraft) return tr("Mark this draft ready for review before merging.");
  if (pr.mergeability === "conflicting") return tr("Resolve the branch conflicts before merging.");
  if (!allowedMergeMethods(pr).length) return tr("This repository has no available merge methods.");
  return null;
}

export const openOnProviderLabel = (provider: SourceControlProviderKind) =>
  tr("Open on {provider}", { provider: sourceControlClients.get(provider).label });
