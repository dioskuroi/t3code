import { Pressable, View } from "react-native";
import { tr } from "@t3tools/shared/i18n";

import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

export function DevicePreviewButton(props: {
  readonly count: number;
  readonly onPress: () => void;
  readonly compact?: boolean;
}) {
  const compact = props.compact ?? true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.count === 1 ? tr("View device") : tr("View {count} devices", { count: props.count })
      }
      accessibilityHint={tr("Watch and control devices open in this thread")}
      onPress={props.onPress}
      className={
        compact
          ? "size-11 shrink-0 items-center justify-center rounded-full active:bg-subtle"
          : "h-11 shrink-0 flex-row items-center justify-center gap-2 rounded-full px-4 active:bg-subtle"
      }
    >
      <SymbolView
        name={{ ios: "iphone", android: "smartphone" }}
        size={20}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
      {!compact ? (
        <AppText className="font-t3-medium text-xs text-foreground">
          {props.count === 1
            ? tr("One device open")
            : tr("{count} devices open", { count: props.count })}
        </AppText>
      ) : props.count > 1 ? (
        <View className="absolute right-1.5 top-1.5 min-w-4 items-center rounded-full bg-primary px-1">
          <AppText className="text-2xs font-t3-bold text-primary-foreground">{props.count}</AppText>
        </View>
      ) : null}
    </Pressable>
  );
}
