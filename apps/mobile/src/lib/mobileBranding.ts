import { tr } from "@t3tools/shared/i18n";
export type MobileStageLabel = "Beta" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return tr("Dev") as MobileStageLabel;
  if (appVariant === "preview") return tr("Nightly") as MobileStageLabel;
  return tr("Beta") as MobileStageLabel;
}
