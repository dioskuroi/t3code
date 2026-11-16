import { View } from "react-native";
import { tr } from "@t3tools/shared/i18n";
import { Text } from "@expo/ui/jetpack-compose";
import { IconButton } from "../../components/ui/IconButton";
import { NativeAppBar } from "../../components/ui/NativeAppBar.android";

export function NativeAppBarExample() {
  return (
    <NativeAppBar
      title={<Text style={{ fontSize: 21 }}>{tr("Native app bar")}</Text>}
      navigationIcon={
        <IconButton icon="arrow.left" accessibilityLabel={tr("Example back")} onPress={() => {}} />
      }
      actions={
        <View className="flex-row">
          <IconButton
            icon="magnifyingglass"
            accessibilityLabel={tr("Example search")}
            onPress={() => {}}
          />
        </View>
      }
    />
  );
}
