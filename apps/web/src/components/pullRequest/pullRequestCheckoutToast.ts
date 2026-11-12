import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { tr } from "@t3tools/shared/i18n";

export function offHeadPullRequestCheckoutToast(terminology: ChangeRequestTerminology) {
  return {
    type: "warning",
    title: tr("Checked out, but not confirmed on the latest commit"),
    description: tr(
      "This checkout could not be confirmed at the {term}'s latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.",
      { term: terminology.singular },
    ),
  } as const;
}
