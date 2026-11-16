import type { LinkedPrompt } from "@t3tools/shared/promptLinks";
import { tr } from "@t3tools/shared/i18n";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";

import { toastManager } from "../ui/toast";

export function warnAboutHiddenCharacters(prompt: LinkedPrompt): void {
  if (prompt.hiddenCharacters === 0) return;
  toastManager.add({
    type: "warning",
    title: tr("This prompt had hidden characters, it may be malicious"),
    description:
      prompt.hiddenCharacters === 1
        ? tr("T3 Code removed {count} hidden character. Read the prompt before you send it.", {
            count: prompt.hiddenCharacters,
          })
        : tr("T3 Code removed {count} hidden characters. Read the prompt before you send it.", {
            count: prompt.hiddenCharacters,
          }),
    timeout: 0,
  });
}

export function placeLinkedPrompt(
  target: ComposerThreadTarget,
  prompt: LinkedPrompt,
  notes: ReadonlyArray<string> = [],
): void {
  warnAboutHiddenCharacters(prompt);
  const place = () => {
    useComposerDraftStore.getState().setPrompt(target, prompt.text);
    toastManager.add({
      type: "info",
      title: tr("Prompt added from a link"),
      description: [tr("Read it before you send."), ...notes].join(" "),
    });
  };
  const existing = useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
  if (existing.trim().length === 0 || existing === prompt.text) {
    place();
    return;
  }
  const id = toastManager.add({
    type: "info",
    title: tr("Linked prompt ready"),
    description: tr("This thread already has a draft. Replace it with the linked prompt?"),
    timeout: 0,
    actionProps: {
      children: tr("Replace draft"),
      onClick: () => {
        toastManager.close(id);
        place();
      },
    },
  });
}
