import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";
import { tr } from "@t3tools/shared/i18n";

export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return tr("Reveal in Finder");
  if (normalized.includes("win")) return tr("Reveal in File Explorer");
  return tr("Reveal in Files");
}

export function revealInFileExplorerLabelForOs(os: ExecutionEnvironmentPlatformOs): string {
  if (os === "darwin") return tr("Reveal in Finder");
  if (os === "windows") return tr("Reveal in File Explorer");
  return tr("Reveal in Files");
}

export function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return tr("Reveal in Finder");
  if (kind === "file-explorer") return tr("Reveal in File Explorer");
  return tr("Reveal in Files");
}
