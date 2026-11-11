import type { ReactElement } from "react";
import { tr } from "@t3tools/shared/i18n";
import { Sheet } from "../../components/ui/Sheet";

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  height: number;
  onClose: () => void;
}

export function WorktreeSetupSheet({ children, onClose }: WorktreeSetupSheetProps) {
  return (
    <Sheet title={tr("Worktree setup")} onClose={onClose}>
      {children}
    </Sheet>
  );
}
