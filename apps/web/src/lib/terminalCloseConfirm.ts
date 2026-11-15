import { readLocalApi } from "~/localApi";
import { tr } from "@t3tools/shared/i18n";

let pendingConfirmations = 0;

export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

export async function confirmTerminalClose(
  labels: readonly [string, ...string[]],
): Promise<boolean> {
  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            tr('Close terminal "{title}"?', { title: labels[0] }),
            tr("This stops the running process and clears its history."),
          ].join("\n")
        : [
            tr("Close {count} terminals?", { count: labels.length }),
            tr("This stops their running processes and clears their histories: {titles}.", {
              titles: labels.map((label) => `"${label}"`).join(", "),
            }),
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
