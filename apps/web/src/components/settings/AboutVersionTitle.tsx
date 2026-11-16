import { useRef } from "react";
import { tr } from "@t3tools/shared/i18n";

import { APP_VERSION } from "../../branding";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { showAnchoredCopySuccessToast } from "../ui/anchoredCopyToast";
import { InlineButton } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function AboutVersionTitle() {
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const { copyToClipboard } = useCopyToClipboard<void>({
    target: "version",
    onCopy: () => showAnchoredCopySuccessToast(copyButtonRef),
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: tr("Could not copy version"),
          description: error.message,
        }),
      );
    },
  });

  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{tr("Version")}</span>
      <code className="text-2xs font-medium">
        <Tooltip>
          <TooltipTrigger
            render={
              <InlineButton
                ref={copyButtonRef}
                tone="muted"
                aria-label={tr("Copy version {APP_VERSION}", { APP_VERSION: APP_VERSION })}
                onClick={() => copyToClipboard(APP_VERSION, undefined)}
              >
                {APP_VERSION}
              </InlineButton>
            }
          />
          <TooltipPopup>{tr("Copy version")}</TooltipPopup>
        </Tooltip>
      </code>
    </span>
  );
}
