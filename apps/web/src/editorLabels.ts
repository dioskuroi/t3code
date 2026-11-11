import { EDITORS, type EditorId } from "@t3tools/contracts";
import { tr } from "@t3tools/shared/i18n";

import { getLocalFileManagerName } from "~/lib/utils";

const editorLabels = new Map<EditorId, string>(EDITORS.map((editor) => [editor.id, editor.label]));

export function editorLabelForPlatform(editorId: EditorId, platform: string): string {
  if (editorId === "file-manager") {
    return getLocalFileManagerName(platform);
  }

  return editorLabels.get(editorId) ?? tr("Editor");
}

export function openInEditorMenuLabel(editorId: EditorId | null): string {
  return editorId === null || editorId === "file-manager"
    ? tr("Open in editor")
    : tr("Open in {editor}", { editor: editorLabels.get(editorId) ?? tr("Editor") });
}
