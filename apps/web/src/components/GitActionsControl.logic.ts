import type {
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { tr } from "@t3tools/shared/i18n";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import {
  changeRequestTerminologyFor,
  type DefaultBranchActionDialogCopy,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
  type GitDialogAction,
} from "@t3tools/client-runtime/state/vcs";

export {
  requiresDefaultBranchConfirmation,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
} from "@t3tools/client-runtime/state/vcs";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface GitActionProgressPresentation {
  readonly status: string;
  readonly output: string | null;
  readonly startedAtMs: number | null;
}

export interface GitActionResultToastTiming {
  readonly timeout: 0;
  readonly dismissAfterVisibleMs: number | null;
}

export const GIT_ACTION_SUCCESS_VISIBLE_MS = 10_000;

export function resolveGitActionResultToastTiming(
  type: "error" | "success",
): GitActionResultToastTiming {
  return {
    timeout: 0,
    dismissAfterVisibleMs: type === "success" ? GIT_ACTION_SUCCESS_VISIBLE_MS : null,
  };
}

export function resolveGitActionProgressPresentation(input: {
  readonly isRunning: boolean;
  readonly operation: string | null;
  readonly currentLabel: string | null;
  readonly lastOutputLine: string | null;
  readonly phaseStartedAtMs: number | null;
  readonly hookStartedAtMs: number | null;
}): GitActionProgressPresentation | null {
  if (
    !input.isRunning ||
    (input.operation !== "run_change_request" && input.operation !== "pull")
  ) {
    return null;
  }

  const currentLabel = input.currentLabel?.trim();
  const output = input.lastOutputLine?.trim();
  const isPull = input.operation === "pull";
  return {
    status:
      currentLabel && currentLabel !== "Running source control action"
        ? currentLabel
        : isPull
          ? tr("Pulling latest changes...")
          : tr("Starting source control action..."),
    output: !isPull && output ? output : null,
    startedAtMs: isPull
      ? input.phaseStartedAtMs
      : (input.hookStartedAtMs ?? input.phaseStartedAtMs),
  };
}

export function formatGitActionElapsed(startedAtMs: number | null, nowMs: number): string | null {
  if (startedAtMs === null) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = changeRequestTerminologyFor(gitStatus);

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasOpenPr &&
    hasDefaultBranchDelta &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);

  const commitItem: GitActionMenuItem = {
    id: "commit",
    label: tr("Commit"),
    disabled: !canCommit,
    icon: "commit",
    kind: "open_dialog",
    dialogAction: "commit",
  };

  if (!hasPrimaryRemote) {
    return [commitItem];
  }

  const pushItem: GitActionMenuItem = {
    id: "push",
    label: tr("Push"),
    disabled: !canPush,
    icon: "push",
    kind: "open_dialog",
    dialogAction: "push",
  };

  if (hasOpenPr) {
    return [commitItem, pushItem];
  }

  return [
    commitItem,
    pushItem,
    {
      id: "pr",
      label: tr("Create {shortLabel}", { shortLabel: terminology.shortLabel }),
      disabled: !canCreatePr,
      icon: "pr",
      kind: "open_dialog",
      dialogAction: "create_pr",
    },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
): GitQuickAction {
  if (isBusy) {
    return {
      label: tr("Commit"),
      disabled: true,
      kind: "show_hint",
      hint: tr("Git action in progress."),
    };
  }

  if (!gitStatus) {
    return {
      label: tr("Commit"),
      disabled: true,
      kind: "show_hint",
      hint: tr("Git status is unavailable."),
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (!hasBranch) {
    return {
      label: tr("Commit"),
      disabled: true,
      kind: "show_hint",
      hint: tr("Create and checkout a ref before pushing or opening a {singular}.", {
        singular: terminology.singular,
      }),
    };
  }

  if (hasChanges) {
    if (isBehind || (!gitStatus.hasUpstream && !hasPrimaryRemote)) {
      return { label: tr("Commit"), disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: tr("Commit & push"),
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    }
    return {
      label: tr("Commit, push & {shortLabel}", { shortLabel: terminology.shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      return {
        label: tr("Publish repository"),
        disabled: false,
        kind: "open_publish",
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return {
          label: tr("Commit"),
          disabled: true,
          kind: "show_hint",
          hint: tr("Branch is up to date. No action needed."),
        };
      }
      return {
        label: tr("Push"),
        disabled: true,
        kind: "show_hint",
        hint: tr("No local commits to push."),
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: tr("Push"),
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: tr("Push & create {shortLabel}", { shortLabel: terminology.shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: tr("Sync ref"),
      disabled: true,
      kind: "show_hint",
      hint: tr("Branch has diverged from upstream. Rebase/merge first."),
    };
  }

  if (isBehind) {
    return {
      label: tr("Pull"),
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        label: tr("Push"),
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: tr("Push & create {shortLabel}", { shortLabel: terminology.shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: tr("Commit"),
      disabled: true,
      kind: "show_hint",
      hint: tr("Branch is up to date. No action needed."),
    };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      label: tr("Create {shortLabel}", { shortLabel: terminology.shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return {
    label: tr("Commit"),
    disabled: true,
    kind: "show_hint",
    hint: tr("Branch is up to date. No action needed."),
  };
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology: ChangeRequestTerminology;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const { terminology } = input;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: tr("Commit & push to default ref?"),
        description: tr(
          'This action will commit and push changes on "{branchLabel}". You can continue on this ref or create a feature ref and run the same action there.',
          { branchLabel: branchLabel },
        ),
        continueLabel: tr("Commit & push to {branchLabel}", { branchLabel: branchLabel }),
      };
    }
    return {
      title: tr("Push to default ref?"),
      description: tr(
        'This action will push local commits on "{branchLabel}". You can continue on this ref or create a feature ref and run the same action there.',
        { branchLabel: branchLabel },
      ),
      continueLabel: tr("Push to {branchLabel}", { branchLabel: branchLabel }),
    };
  }

  if (input.includesCommit) {
    return {
      title: tr("Commit, push & create {shortLabel} from default ref?", {
        shortLabel: terminology.shortLabel,
      }),
      description: tr(
        'This action will commit, push, and create a {singular} on "{branchLabel}". You can continue on this ref or create a feature ref and run the same action there.',
        { singular: terminology.singular, branchLabel: branchLabel },
      ),
      continueLabel: tr("Commit, push & create {shortLabel}", {
        shortLabel: terminology.shortLabel,
      }),
    };
  }
  return {
    title: tr("Push & create {shortLabel} from default ref?", {
      shortLabel: terminology.shortLabel,
    }),
    description: tr(
      'This action will push local commits and create a {singular} on "{branchLabel}". You can continue on this ref or create a feature ref and run the same action there.',
      { singular: terminology.singular, branchLabel: branchLabel },
    ),
    continueLabel: tr("Push & create {shortLabel}", { shortLabel: terminology.shortLabel }),
  };
}

/** Clean trees cannot create feature branches because the server derives names from uncommitted changes. */
export function resolveFeatureBranchUnavailableReason(input: {
  branchName: string;
  hasWorkingTreeChanges: boolean;
}): string | null {
  if (input.hasWorkingTreeChanges) return null;
  return tr(
    "There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on {branchName}.",
    { branchName: input.branchName },
  );
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveThreadBranchMetadataPatch(
  branch: string | null,
  expectedBranch: string | null,
): {
  branch: string | null;
  expectedBranch: string | null;
} {
  return { branch, expectedBranch };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.refName === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.refName) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.refName !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.gitStatus.refName)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.refName,
  };
}

export type ChangesLineTotals = {
  readonly insertions: number;
  readonly deletions: number;
};

// `branchChanges ?? workingTree` treats `{0,0}` as present, so a zero branch total hid a dirty
// working tree and the Changes row read +0 while Diff still showed the work.
export function resolveChangesTotals(
  status: VcsStatusResult | null | undefined,
): ChangesLineTotals | null {
  if (!status) return null;
  const branch = status.branchChanges;
  const tree = status.workingTree;
  if (branch && (branch.insertions > 0 || branch.deletions > 0)) {
    return { insertions: branch.insertions, deletions: branch.deletions };
  }
  if (tree.insertions > 0 || tree.deletions > 0) {
    return { insertions: tree.insertions, deletions: tree.deletions };
  }
  if (branch) {
    return { insertions: branch.insertions, deletions: branch.deletions };
  }
  return { insertions: tree.insertions, deletions: tree.deletions };
}
