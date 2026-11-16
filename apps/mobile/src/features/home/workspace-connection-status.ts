import type { WorkspaceState } from "../../state/workspaceModel";
import { tr } from "@t3tools/shared/i18n";

export interface WorkspaceConnectionStatusPresentation {
  readonly label: string;
  readonly showsProgress: boolean;
}

function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  if (state.networkStatus === "offline") return true;
  if (state.hasReadyEnvironment) return state.hasSyncingConnectedEnvironment;
  return (
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  if (state.networkStatus === "offline") return tr("You are offline");
  if (state.hasReadyEnvironment && state.hasSyncingConnectedEnvironment) {
    return state.hasLoadedShellSnapshot ? tr("Syncing threads...") : tr("Loading threads...");
  }
  if (state.connectingEnvironments.length === 1) {
    return tr("Reconnecting to {label}", {
      label: state.connectingEnvironments[0]!.environmentLabel,
    });
  }
  if (state.connectingEnvironments.length > 1) {
    return tr("Reconnecting {count} environments", { count: state.connectingEnvironments.length });
  }
  if (state.connectionError !== null) return state.connectionError;
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? tr("Syncing threads...") : tr("Loading threads...");
  }
  return tr("Not connected");
}

export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
): WorkspaceConnectionStatusPresentation | null {
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  return {
    label: workspaceConnectionStatusLabel(state),
    showsProgress:
      state.networkStatus !== "offline" &&
      (state.hasReadyEnvironment || state.connectionError === null) &&
      (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot),
  };
}
