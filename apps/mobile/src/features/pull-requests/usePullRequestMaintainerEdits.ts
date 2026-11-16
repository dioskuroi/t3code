import { useAtomRefresh } from "@effect/atom-react";
import { tr } from "@t3tools/shared/i18n";
import {
  maintainerEditsChoiceInForce,
  type MaintainerEditsChoice,
} from "@t3tools/client-runtime/pull-request-editing";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestDetail } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import * as Dialog from "../../components/ui/Dialog";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

export function usePullRequestMaintainerEdits(
  params: PullRequestParams,
  pr: PullRequestDetail | null,
  canEdit: boolean,
) {
  const target = pullRequestTarget(params);
  const update = useAtomCommand(composerPullRequests.update, { reportFailure: false });
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(target));
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [choice, setChoice] = useState<MaintainerEditsChoice | null>(null);
  const kept = maintainerEditsChoiceInForce(choice, pr?.url ?? "", pr?.observedAt, saving);
  if (kept !== choice) {
    setChoice(kept);
  }
  const value = kept?.value ?? pr?.maintainerCanModify === true;
  const save = async (next: boolean) => {
    if (pending.current || pr === null || !canEdit) return;
    pending.current = true;
    const previousChoice = choice;
    setSaving(true);
    setChoice({ key: pr.url, observedAt: pr.observedAt, value: next });
    const response = await update({
      ...target,
      input: { ...target.input, maintainerCanModify: next },
    });
    pending.current = false;
    setSaving(false);
    if (AsyncResult.isFailure(response)) {
      setChoice(previousChoice);
      const cause = squashAtomCommandFailure(response);
      Dialog.alert(
        tr("Could not save maintainer access"),
        cause instanceof Error ? cause.message : tr("Try again."),
      );
      return;
    }
    refreshDetail();
  };
  return {
    visible: canEdit,
    value,
    saving,
    subtitle: saving
      ? tr("Saving\u2026")
      : tr(
          "Maintainers can push to this branch. If your fork has workflows, this can also give access to its secrets.",
        ),
    toggle: () => void save(!value),
  };
}
