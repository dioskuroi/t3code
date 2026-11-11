import type { OrchestrationV2UserMessageInputIntent } from "@t3tools/contracts";
import { tr } from "@t3tools/shared/i18n";

export interface UserMessageIntentBadgePresentation {
  readonly label: string;
  readonly accessibilityLabel: string;
}

export function resolveUserMessageIntentBadge(
  intent: OrchestrationV2UserMessageInputIntent | undefined,
): UserMessageIntentBadgePresentation | null {
  switch (intent) {
    case "steer":
      return {
        label: tr("Steer"),
        accessibilityLabel: tr("Steered the active turn"),
      };
    case "promoted_queued_to_steer":
      return {
        label: tr("Steer"),
        accessibilityLabel: tr("Originally queued, then promoted to steer the active turn"),
      };
    case "queued_turn":
    case "turn_start":
    case undefined:
      return null;
  }
}
