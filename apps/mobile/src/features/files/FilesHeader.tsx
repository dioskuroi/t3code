import { useRef, useState, type ReactNode } from "react";
import { tr } from "@t3tools/shared/i18n";
import { Keyboard, type TextInputInstance, View } from "react-native";

import {
  AndroidHeaderIconButton,
  AndroidScreenHeader,
} from "../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { SearchField } from "../../components/ui/SearchField";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { useHardwareBack } from "../../lib/backHandler";

export function FilesHeader(props: {
  readonly projectName: string;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onBack?: () => void;
  readonly leading?: ReactNode;
}) {
  const { paddingTop, paddingBottom } = useToolbarLayout();
  const searchRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || props.searchQuery.length > 0;
  const { onSearchQueryChange } = props;
  const closeSearch = () => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  };

  useHardwareBack(searching, () => {
    closeSearch();
    return true;
  });

  return (
    <View>
      {}
      <View
        pointerEvents={searching ? "none" : "auto"}
        accessibilityElementsHidden={searching}
        importantForAccessibility={searching ? "no-hide-descendants" : "auto"}
        style={{ opacity: searching ? 0 : 1 }}
      >
        <AndroidScreenHeader
          title={tr("Files")}
          subtitle={props.projectName}
          hideBottomBorder
          onBack={props.onBack}
          leading={props.leading}
          actions={[
            {
              accessibilityLabel: tr("Search files"),
              icon: "magnifyingglass",
              onPress: () => setSearchOpen(true),
            },
          ]}
          trailing={
            <AndroidAnchoredMenu
              title={tr("File options")}
              actions={[{ id: "refresh", title: tr("Refresh files") }]}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "refresh") props.onRefresh();
              }}
            >
              {(open) => (
                <AndroidHeaderIconButton
                  accessibilityLabel={tr("File options")}
                  icon="ellipsis"
                  onPress={open}
                />
              )}
            </AndroidAnchoredMenu>
          }
        />
      </View>
      {searching ? (
        <View className="absolute inset-0 bg-header px-2" style={{ paddingTop, paddingBottom }}>
          <View className="flex-1 flex-row items-center gap-1">
            <AndroidHeaderIconButton
              accessibilityLabel={tr("Close file search")}
              icon="arrow.left"
              onPress={closeSearch}
            />
            <SearchField
              inputRef={searchRef}
              accessibilityLabel={tr("Search files")}
              clearAccessibilityLabel={tr("Clear file search")}
              placeholder={tr("Search files")}
              value={props.searchQuery}
              onChangeText={onSearchQueryChange}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}
