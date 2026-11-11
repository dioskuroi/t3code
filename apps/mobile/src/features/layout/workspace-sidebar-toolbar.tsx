import { Platform } from "react-native";
import { tr } from "@t3tools/shared/i18n";

import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";

import { useAdaptiveWorkspaceLayout } from "./adaptive-workspace-context";

export function AndroidWorkspaceSidebarButton() {
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  if (Platform.OS !== "android" || !layout.usesSplitView) return null;

  return (
    <AndroidHeaderIconButton
      accessibilityLabel={panes.primarySidebarVisible ? tr("Maximize content") : tr("Show sidebar")}
      icon={panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"}
      onPress={togglePrimarySidebar}
    />
  );
}
