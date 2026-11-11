import { NativeAppBarExample } from "./NativeAppBarExample";
import { tr } from "@t3tools/shared/i18n";
import { Toast } from "../../components/ui/Toast";
import { Progress } from "../../components/ui/Progress";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import { View, type TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { Chip } from "../../components/ui/Chip";
import { Menu } from "../../components/ui/Menu";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { FloatingActionButton } from "../../components/ui/FloatingActionButton";
import { SearchField } from "../../components/ui/SearchField";
import { Notice } from "../../components/ui/Notice";
import { NumberField } from "../../components/ui/NumberField";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SliderRow } from "../../components/ui/SliderRow";
import * as Dialog from "../../components/ui/Dialog";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { MOBILE_THEME_IDS } from "../../lib/mobileTheme";

const CHOICES = [
  { value: "overview", label: tr("Overview") },
  { value: "activity", label: tr("Activity") },
];

export function ComponentCatalogScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const appearance = useAppearancePreferences();
  const [page, setPage] = useState("controls");
  const [tab, setTab] = useState("overview");
  const [enabled, setEnabled] = useState(true);
  const [value, setValue] = useState(3);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [sheet, setSheet] = useState(false);
  const [notice, setNotice] = useState(true);
  const searchRef = useRef<TextInputInstance>(null);
  const announceAction = () => setNotice(true);
  const confirm = () => {
    Dialog.confirm({
      title: tr("Discard changes?"),
      message: tr("This example only changes local catalog state."),
      confirmText: tr("Discard"),
      destructive: true,
      onConfirm: () => setText(""),
    });
  };
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={tr("UI components")} onBack={() => navigation.goBack()} sidebar={false} />
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-3">
          <AppText className="text-sm text-foreground-muted">{tr("Theme preview")}</AppText>
          <View className="flex-row flex-wrap gap-2">
            {MOBILE_THEME_IDS.filter(
              (id) => id !== "material-you" || appearance.systemColorsAvailable,
            ).map((id) => (
              <Chip
                key={id}
                label={id}
                selected={appearance.themeId === id}
                onPress={() => appearance.setThemeIdForBothAppearances(id)}
              />
            ))}
          </View>
          <SegmentedControl
            options={[
              { value: "light", label: tr("Light") },
              { value: "dark", label: tr("Dark") },
            ]}
            selected={appearance.themeAppearance}
            onSelect={appearance.setThemeMode}
            size="compact"
          />
        </View>
        <SegmentedControl
          options={[
            { value: "controls", label: tr("Controls") },
            { value: "forms", label: tr("Forms") },
            { value: "feedback", label: tr("Feedback") },
          ]}
          selected={page}
          onSelect={setPage}
          size="compact"
        />
        {page === "controls" ? (
          <>
            <View className="gap-3">
              <AppText className="text-lg font-t3-semibold">{tr("Lists and selection")}</AppText>
              <ListSection>
                <View className="p-4">
                  <SegmentedControl
                    variant="card"
                    options={CHOICES}
                    selected={tab}
                    onSelect={setTab}
                    size="compact"
                    role="tab"
                  />
                </View>
                <ListRow
                  icon="folder"
                  label={tr("Projects")}
                  detail="4"
                  onPress={() => setSheet(true)}
                />
                <ListToggleRow
                  icon="bell.badge"
                  label={tr("Notifications")}
                  description={tr("Updates from your active threads")}
                  value={enabled}
                  onValueChange={setEnabled}
                />
                <ListChoiceRow label={tr("Selected option")} selected onPress={announceAction} />
                <ListActionRow
                  icon="trash"
                  label={tr("Discard changes")}
                  tone="danger"
                  onPress={confirm}
                />
              </ListSection>
              <SegmentedControl
                options={CHOICES}
                selected={tab}
                onSelect={setTab}
                size="compact"
                role="tab"
              />
              <View className="flex-row flex-wrap gap-2">
                <Chip
                  label={tr("Selected filter")}
                  selected={enabled}
                  onPress={() => setEnabled(!enabled)}
                />
                <Chip label={tr("Label")} size="small" />
                <Chip label={tr("Disabled")} disabled onPress={announceAction} />
              </View>
            </View>
            <View className="gap-3">
              <NativeAppBarExample />
              <AppText className="text-lg font-t3-semibold">{tr("Buttons")}</AppText>
              <View className="flex-row flex-wrap gap-2">
                <Button label={tr("Primary")} tone="primary" onPress={announceAction} />
                <Button label={tr("Secondary")} onPress={announceAction} />
                <Button label={tr("Contrast")} tone="contrast" onPress={announceAction} />
              </View>
              <View className="flex-row flex-wrap gap-2">
                <Button label={tr("Disabled")} disabled onPress={announceAction} />
                <Button label={tr("Loading")} loading onPress={announceAction} />
                <IconButton
                  accessibilityLabel={tr("Open example sheet")}
                  icon="plus"
                  variant="tonal"
                  onPress={() => setSheet(true)}
                />
              </View>
            </View>
          </>
        ) : null}
        {page === "forms" ? (
          <View className="gap-3">
            <AppText className="text-lg font-t3-semibold">{tr("Forms")}</AppText>
            <AppTextInput
              accessibilityLabel={tr("Example name")}
              placeholder={tr("Name")}
              value={text}
              onChangeText={setText}
            />
            <View className="flex-row">
              <SearchField
                inputRef={searchRef}
                accessibilityLabel={tr("Search examples")}
                clearAccessibilityLabel={tr("Clear examples search")}
                placeholder={tr("Search examples")}
                value={search}
                onChangeText={setSearch}
                autoFocus={false}
              />
            </View>
            <View className="flex-row items-center justify-between">
              <AppText>{tr("Count")}</AppText>
              <NumberField
                label={tr("Example count")}
                min={1}
                max={10}
                value={value}
                onValueChange={setValue}
              />
            </View>
            <ListSection>
              <SliderRow
                icon="textformat.size"
                label={tr("Example slider")}
                valueLabel={String(value)}
                min={1}
                max={10}
                step={1}
                value={value}
                onChange={setValue}
              />
            </ListSection>
          </View>
        ) : null}
        {page === "feedback" ? (
          <View className="gap-3">
            <AppText className="text-lg font-t3-semibold">
              {tr("Feedback and presentation")}
            </AppText>
            <Notice message={tr("This action could not finish. Try again.")} tone="danger" />
            <Button label={tr("Show notice")} onPress={announceAction} />
            <View className="flex-row flex-wrap gap-2">
              <Button label={tr("Sheet")} onPress={() => setSheet(true)} />
              <Button label={tr("Dialog")} onPress={confirm} />
              <Button
                label={tr("Alert")}
                onPress={() =>
                  Dialog.alert(tr("Example alert"), tr("Choose an action."), [
                    {
                      text: tr("More info"),
                      onPress: () =>
                        Dialog.alert(tr("More information"), tr("This second alert stays open.")),
                    },
                    { text: tr("Cancel"), style: "cancel" },
                    { text: tr("Continue"), onPress: announceAction },
                  ])
                }
              />
              <Button
                label={tr("Prompt")}
                onPress={() =>
                  Dialog.prompt({
                    title: tr("Rename example"),
                    initialValue: text,
                    confirmText: tr("Rename"),
                    onConfirm: setText,
                  })
                }
              />
              <Menu
                title={tr("Example menu")}
                actions={[
                  { id: "copy", title: tr("Copy"), image: "doc.on.doc" },
                  { id: "discard", title: tr("Discard"), attributes: { destructive: true } },
                ]}
                onPressAction={({ nativeEvent }) =>
                  nativeEvent.event === "discard" ? confirm() : announceAction()
                }
              >
                <Chip label={tr("Menu")} trailingIcon="chevron.down" />
              </Menu>
            </View>
            <Progress value={0.6} label={tr("Example upload")} />
            <Progress label={tr("Connecting")} />
            <View className="items-start">
              <FloatingActionButton
                label={tr("New thread")}
                icon="plus"
                variant="extended"
                tone="primary"
                onPress={() => setSheet(true)}
              />
            </View>
          </View>
        ) : null}
      </ScreenScrollView>
      {page === "feedback" && notice ? (
        <View
          collapsable={false}
          className="absolute inset-x-3 z-[100]"
          style={{ bottom: insets.bottom + 12 }}
          pointerEvents="box-none"
        >
          <Toast
            message={tr("Changes are ready to review.")}
            tone="success"
            dismissMode="swipe"
            action={{
              label: tr("Undo"),
              onPress: () => {
                setNotice(false);
                setText(tr("Restored example"));
              },
            }}
            onDismiss={() => setNotice(false)}
          />
        </View>
      ) : null}
      {sheet ? (
        <Sheet title={tr("Example sheet")} onClose={() => setSheet(false)}>
          <ScreenScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="p-4"
          >
            <ListSection>
              <ListChoiceRow
                label={tr("Overview")}
                selected={tab === "overview"}
                onPress={() => setTab("overview")}
              />
              <ListChoiceRow
                label={tr("Activity")}
                selected={tab === "activity"}
                onPress={() => setTab("activity")}
              />
            </ListSection>
          </ScreenScrollView>
        </Sheet>
      ) : null}
    </View>
  );
}
