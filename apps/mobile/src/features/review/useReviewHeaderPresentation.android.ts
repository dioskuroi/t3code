import type { useReviewHeaderPresentation as useIosReviewHeaderPresentation } from "./useReviewHeaderPresentation";
import { tr } from "@t3tools/shared/i18n";

// oxlint-disable-next-line t3code/no-hookless-use-function -- Android stub of a hook; the iOS file calls hooks.
export function useReviewHeaderPresentation(
  props: Parameters<typeof useIosReviewHeaderPresentation>[0],
): ReturnType<typeof useIosReviewHeaderPresentation> {
  return {
    title: tr("Review changes"),
    subtitle: props.androidSubtitle || tr("Select a diff"),
    gitMenu: null,
    menuIcon: "ellipsis.circle",
    refreshAction: {
      id: "refresh",
      title: tr("Refresh current diff"),
      disabled: !props.selectedSection || props.selectedSection.isLoading,
      onPress: () => {
        void props.onRefresh();
      },
    },
  };
}
