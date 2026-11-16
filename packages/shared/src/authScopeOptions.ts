import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type AuthGrantScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
} from "@t3tools/contracts";
import { tr } from "@t3tools/shared/i18n";

export const AUTH_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthGrantScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: AuthOrchestrationReadScope,
    title: tr("View environment"),
    description: tr("Read threads, status, checkpoints, and configuration."),
  },
  {
    scope: AuthOrchestrationOperateScope,
    title: tr("Operate tasks"),
    description: tr("Start, update, and stop tasks."),
  },
  {
    scope: AuthSettingsWriteScope,
    title: tr("Change environment settings"),
    description: tr("Edit environment preferences and keybindings."),
  },
  {
    scope: AuthProvidersManageScope,
    title: tr("Manage providers"),
    description: tr("Configure, install, sign in to, and update providers and usage sources."),
  },
  {
    scope: AuthEnvironmentMaintainScope,
    title: tr("Maintain environment"),
    description: tr("Update the server and control environment processes."),
  },
  {
    scope: AuthPreviewOperateScope,
    title: tr("Control previews"),
    description: tr("Open browser previews and host browser automation."),
  },
  {
    scope: AuthDiagnosticsReadScope,
    title: tr("View diagnostics and usage"),
    description: tr("Read process diagnostics, resource history, and usage totals."),
  },
  {
    scope: AuthTerminalReadScope,
    title: tr("View terminals"),
    description: tr("Read existing terminal output and status."),
  },
  {
    scope: AuthTerminalOperateScope,
    title: tr("Use terminals"),
    description: tr("Create terminals and send input to running shells."),
  },
  {
    scope: AuthSourceControlWriteScope,
    title: tr("Change source control"),
    description: tr("Commit, push, manage branches and repositories, and change pull requests."),
  },
  {
    scope: AuthFilesystemReadScope,
    title: tr("Read files"),
    description: tr("Browse host files, search workspaces, and inspect local changes."),
  },
  {
    scope: AuthFilesystemWriteScope,
    title: tr("Write files"),
    description: tr("Edit workspace files and save plans to disk."),
  },
  {
    scope: AuthAccessReadScope,
    title: tr("View access"),
    description: tr("Inspect pairing links and authorized clients."),
  },
  {
    scope: AuthAccessWriteScope,
    title: tr("Manage access"),
    description: tr("Issue and revoke credentials for other clients."),
  },
  {
    scope: AuthRelayReadScope,
    title: tr("View relay"),
    description: tr("Inspect managed relay connectivity."),
  },
  {
    scope: AuthRelayWriteScope,
    title: tr("Manage relay"),
    description: tr("Change managed tunnel connectivity."),
  },
];

/** Shown instead of the granted scopes while they are unknown, so every surface says the same thing. */
export function sessionPermissionsUnavailableMessage(input: {
  readonly connected: boolean;
  /** The check errored; the client retries it while connected. */
  readonly failed: boolean;
  /** The environment answered that this session is not signed in; retrying will not change that. */
  readonly rejected: boolean;
}): string {
  if (!input.connected)
    return tr("Connect to this environment to view this session\u2019s permissions.");
  if (input.rejected)
    return tr("This environment did not accept your session. Reconnect to try again.");
  return input.failed
    ? tr("Could not verify your permissions. Retrying automatically.")
    : tr("Checking permissions\u2026");
}
