import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import { tr } from "@t3tools/shared/i18n";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DEFAULT_DESKTOP_RELEASE_REPOSITORY = "pingdotgg/t3code";
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

function desktopReleaseRepositoryUrl(repository: string | undefined): string {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const releaseRepository =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? configuredRepository
      : DEFAULT_DESKTOP_RELEASE_REPOSITORY;
  return `https://github.com/${releaseRepository}/releases`;
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${desktopReleaseRepositoryUrl(repository)}/tag/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string {
  return desktopReleaseRepositoryUrl(repository);
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return tr("This install is using the correct architecture.");
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return tr(
      "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.",
    );
  }
  if (action === "install") {
    return tr(
      "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.",
    );
  }
  return tr(
    "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.",
  );
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return tr("Update {version} did not apply. Click to retry.", {
      version: state.notAppliedVersion,
    });
  }
  if (state.status === "available") {
    return state.availableVersion !== null
      ? tr("Update {version} ready to download", { version: state.availableVersion })
      : tr("Update ready to download");
  }
  if (state.status === "downloading") {
    return typeof state.downloadPercent === "number"
      ? tr("Downloading update ({percent}%)", { percent: Math.floor(state.downloadPercent) })
      : tr("Downloading update");
  }
  if (state.status === "downloaded") {
    const downloadedVersion = state.downloadedVersion ?? state.availableVersion;
    return downloadedVersion !== null
      ? tr("Update {version} downloaded. Click to restart and install.", {
          version: downloadedVersion,
        })
      : tr("Update downloaded. Click to restart and install.");
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return tr("Download failed for {version}. Click to retry.", {
        version: state.availableVersion,
      });
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return tr("Install failed for {version}. Click to retry.", {
        version: state.downloadedVersion,
      });
    }
    if (state.downloadedVersion) {
      return tr("Update {version} downloaded. Click to restart and install.", {
        version: state.downloadedVersion,
      });
    }
    return state.message ?? tr("Update failed");
  }
  return tr("Up to date");
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  const question =
    version !== null
      ? tr("Install update {version} and restart T3 Code?", { version })
      : tr("Install update and restart T3 Code?");
  return `${question}\n\n${tr(
    "Any running tasks will be interrupted. Make sure you're ready before continuing.",
  )}`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}

/** `managedDenial` is this machine's policy refusing updates (`managedUpdatesDenial`); it wins. */
export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
): string | null {
  if (managedDenial !== undefined) return managedDenial;
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return state.message?.trim() || tr("Automatic updates are not available in this build.");
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state, managedDenial);
  return disabledReason
    ? { title: tr("Updates unavailable"), detail: disabledReason }
    : { title: tr("Check for updates"), detail: null };
}
