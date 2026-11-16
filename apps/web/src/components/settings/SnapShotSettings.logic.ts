import type { ClientSettingsPatch, DesktopSnapShotState, SnapShotSound } from "@t3tools/contracts";
import { tr } from "@t3tools/shared/i18n";
import {
  captureSetupBackend,
  captureSetupDesktopName,
  captureSetupAccessReady,
  captureSetupMacPermissionsReady,
} from "./SnapShotSetupDialog.logic";

export function snapShotStatus(state: DesktopSnapShotState | null, enabled: boolean): string {
  if (!state) return tr("Checking snapshots\u2026");
  if (state.mode === "unavailable") return state.message ?? tr("Not supported on this platform.");
  if (!enabled) return tr("Turn this on to set up snapshots.");
  return snapShotSetupSummary(state, enabled);
}

export function snapShotSetupSummary(state: DesktopSnapShotState, enabled: boolean): string {
  if (state.message) return tr("Capture needs attention");
  if (state.linuxBackend === "hyprland" && state.hyprlandHelper?.status !== "ready")
    return state.hyprlandHelper?.status === "error"
      ? tr("Check capture access in setup")
      : tr("Install the capture helper to continue");
  if (captureSetupBackend(state) === "gnome" && state.gnomeExtension?.status !== "enabled")
    return tr("Set up active-window snapshots");
  if (captureSetupBackend(state) === "kde" && state.kdeHelper?.status !== "ready")
    return state.kdeHelper?.status === "error"
      ? tr("Check capture access in setup")
      : tr("Install the capture helper to continue");
  if (captureSetupBackend(state) === "picker")
    return tr("Manual capture only. You'll choose a window each time");
  if (!enabled) return tr("Enable capture to continue");
  if (state.shortcutPending)
    return state.linuxBackend === "hyprland"
      ? tr("Connecting your shortcut\u2026")
      : tr("Waiting for shortcut permission");
  if (state.shortcutVerified) return tr("Ready to capture");
  if (state.linuxBackend === "niri" && state.shortcutBinding)
    return tr("Use your shortcut from another app");
  if (state.linuxBackend === "hyprland" && state.shortcutActionRegistered)
    return tr("Use your shortcut from another app");
  if (state.shortcutRegistered)
    return state.shortcutLabel ? tr("Ready to capture") : tr("Shortcut saved");
  return tr("Finish shortcut setup");
}

export function snapShotShortcutStatus(state: DesktopSnapShotState | null): string | null {
  if (!state) return null;
  if (state.linuxBackend === "hyprland") return state.shortcutMessage;
  if (state.shortcutPending) return tr("Approve the shortcut permission prompt to continue.");
  if (state.shortcutRegistered) return state.mode === "portal" ? null : tr("Shortcut saved.");
  return state.shortcutMessage;
}

export function snapShotSetupButtonLabel(state: DesktopSnapShotState | null): string {
  if (!state) return tr("Continue setup");
  if (captureSetupAccessReady(state)) return tr("Manage capture");
  const desktop = captureSetupDesktopName(state);
  return desktop ? tr("Set up {desktop} capture", { desktop: desktop }) : tr("Continue setup");
}

export function snapShotSetupComplete(
  state: DesktopSnapShotState | null,
  includeAccessibility: boolean,
): boolean {
  if (state?.windows) return true;
  return (
    state?.macPermissions !== undefined &&
    captureSetupAccessReady(state) &&
    captureSetupMacPermissionsReady(state, includeAccessibility) &&
    state.shortcutRegistered
  );
}

export type SnapShotSoundSelection = SnapShotSound | "off";

export function snapShotFeedbackUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal" || state.linuxFeedbackAvailable) return undefined;
  if (state.linuxBackend === "hyprland")
    return state.hyprlandHelper?.status === "ready"
      ? tr("Capture effects aren't available on this desktop.")
      : tr("Install or update the capture helper to enable effects.");
  if (state.linuxBackend === "niri") return tr("Capture effects aren't available on Niri.");
  if (state.linuxBackend === "kde")
    return state.kdeHelper?.status === "ready"
      ? tr("Capture effects aren't available on this desktop.")
      : tr("Install or update the capture helper to enable effects.");
  return state.linuxBackend === "gnome-extension"
    ? tr("Update the GNOME extension, then sign out and back in to enable effects.")
    : captureSetupBackend(state) === "gnome"
      ? tr("Finish extension setup to enable effects.")
      : tr("Capture effects aren't available on this desktop.");
}

export function snapShotDescription(state: DesktopSnapShotState | null): string {
  return state?.mode === "portal" && captureSetupBackend(state) === "picker"
    ? tr("Automatic capture isn't available here. Choose a window instead.")
    : tr("Capture a window and attach it to your current draft.");
}

export function snapShotAccessibilityUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal") return undefined;
  if (state.linuxBackend === "picker" || state.linuxBackend === "screenshot-portal")
    return tr("This desktop only provides a screenshot.");
  return undefined;
}

export function snapShotUnavailableMessage(hasBridge: boolean): string | undefined {
  if (hasBridge) return undefined;
  return typeof window !== "undefined" && window.desktopBridge
    ? tr("Update the desktop app to use snapshots.")
    : tr("Only available in the desktop app.");
}

export function snapShotSoundPatch(sound: SnapShotSoundSelection): ClientSettingsPatch {
  return sound === "off"
    ? { snapShotPlaySound: false }
    : { snapShotPlaySound: true, snapShotSound: sound };
}

export function createRecordingRequestTracker() {
  let currentRequest: symbol | null = null;

  return {
    tryBegin() {
      if (currentRequest) return null;
      currentRequest = Symbol();
      return currentRequest;
    },
    clear() {
      currentRequest = null;
    },
    owns(request: symbol) {
      return currentRequest === request;
    },
  };
}
