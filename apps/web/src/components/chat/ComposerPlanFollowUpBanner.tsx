import { memo } from "react";
import { tr } from "@t3tools/shared/i18n";
import { ComposerBanner } from "./ComposerBanner";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon />
      <ComposerBanner.Content>
        <span className="shrink-0 font-medium text-muted-foreground">{tr("Plan ready")}</span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate text-foreground/85">{planTitle}</span>
        ) : null}
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
});
