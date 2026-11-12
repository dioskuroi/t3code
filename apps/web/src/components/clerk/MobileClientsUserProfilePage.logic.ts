import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";
import { tr } from "@t3tools/shared/i18n";

const mobileClientUpdatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const NOTIFICATION_PREFERENCES = [
  ["notifyOnApproval", tr("approvals")],
  ["notifyOnInput", tr("input requests")],
  ["notifyOnCompletion", tr("completions")],
  ["notifyOnFailure", tr("failures")],
] as const satisfies ReadonlyArray<
  readonly [keyof RelayClientDeviceRecord["notifications"], string]
>;

export function mobileClientPlatformLabel(device: RelayClientDeviceRecord): string {
  const platform =
    device.platform === "android"
      ? tr("Android")
      : device.iosMajorVersion === null
        ? tr("iOS")
        : tr("iOS {version}", { version: device.iosMajorVersion });
  return `${platform}${device.appVersion ? tr(" · T3 Code {version}", { version: device.appVersion }) : ""}`;
}

export function mobileClientNotificationDetail(device: RelayClientDeviceRecord): string {
  if (!device.notifications.enabled) {
    return tr("Push notifications are disabled on this device.");
  }

  const enabledPreferences = NOTIFICATION_PREFERENCES.flatMap(([preference, label]) =>
    device.notifications[preference] ? [label] : [],
  );
  return enabledPreferences.length > 0
    ? tr("Alerts enabled for {types}.", { types: enabledPreferences.join("、") })
    : tr("Push notifications are enabled, but no alert types are selected.");
}

export function mobileClientUpdatedAtLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? tr("Update time unavailable")
    : tr("Updated {time}", { time: mobileClientUpdatedAtFormatter.format(date) });
}
