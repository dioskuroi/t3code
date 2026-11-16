import { Pressable, View } from "react-native";
import { tr } from "@t3tools/shared/i18n";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import type { ActivityFilter } from "./pullRequestActivityFilter";

export function PullRequestActivityFilters({
  value,
  onChange,
  hiddenCount,
}: {
  readonly value: ActivityFilter;
  readonly onChange: (value: ActivityFilter) => void;
  readonly hiddenCount: number;
}) {
  const kinds = [
    { id: "all", title: tr("All activity") },
    { id: "comments", title: tr("Comments") },
    { id: "commits", title: tr("Commits") },
  ] as const;
  return (
    <View className="mb-4 flex-row items-center justify-between gap-3">
      <Menu
        title={tr("Activity")}
        actions={kinds.map((kind) => ({ ...kind, state: value.kind === kind.id ? "on" : "off" }))}
        onPressAction={({ nativeEvent }) => {
          const kind = kinds.find((item) => item.id === nativeEvent.event);
          if (kind) onChange({ ...value, kind: kind.id });
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr("Activity type, {title}", {
            title: kinds.find((kind) => kind.id === value.kind)?.title ?? "",
          })}
          className="min-h-11 flex-row items-center gap-2 active:opacity-60"
        >
          <Text className="text-sm font-t3-semibold">
            {kinds.find((kind) => kind.id === value.kind)?.title}
          </Text>
          <SymbolView name="chevron.down" size={11} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </Menu>
      <View className="flex-row items-center gap-3">
        <Menu
          title={tr("Show in activity")}
          actions={[
            { id: "bots", title: tr("Bot comments"), state: value.bots ? "on" : "off" },
            {
              id: "resolved",
              title: tr("Resolved or dismissed"),
              state: value.resolved ? "on" : "off",
            },
          ]}
          onPressAction={({ nativeEvent: { event } }) => {
            if (event === "bots" || event === "resolved")
              onChange({ ...value, [event]: !value[event] });
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tr("Filter activity, {hiddenCount} hidden", {
              hiddenCount: hiddenCount,
            })}
            className="min-h-11 flex-row items-center gap-1.5 active:opacity-60"
          >
            {hiddenCount > 0 ? (
              <Text className="text-xs text-foreground-muted">
                {hiddenCount} {tr("hidden")}
              </Text>
            ) : null}
            <SymbolView
              name="line.3.horizontal.decrease"
              size={18}
              tintColorClassName="accent-icon-muted"
            />
          </Pressable>
        </Menu>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={value.newestFirst ? tr("Newest first") : tr("Oldest first")}
          onPress={() => onChange({ ...value, newestFirst: !value.newestFirst })}
          className="h-11 flex-row items-center gap-1 active:opacity-60"
        >
          <SymbolView
            name={value.newestFirst ? "arrow.down" : "arrow.up"}
            size={18}
            tintColorClassName="accent-icon-muted"
          />
          <Text className="text-xs text-foreground-muted">
            {value.newestFirst ? tr("Newest") : tr("Oldest")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
