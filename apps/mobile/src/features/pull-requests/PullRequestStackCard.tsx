import { StackActions, useNavigation } from "@react-navigation/native";
import { tr } from "@t3tools/shared/i18n";
import { useState } from "react";
import { Platform, View } from "react-native";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { AppText as Text } from "../../components/ui/AppText";
import { PullRequestCardGroup, PullRequestCardRow } from "./PullRequestControls";
import { pullRequestLayerParams } from "./pullRequestStack";
import { pullRequestStatus } from "./pullRequestStatus";
import type { PullRequestParams } from "./usePullRequestDiff";
import type { PullRequestStackState } from "./usePullRequestStack";
import { PullRequestGlyph } from "./pullRequestGlyphs";

export function PullRequestStackCard(props: {
  readonly params: PullRequestParams;
  readonly state: PullRequestStackState;
}) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const [expanded, setExpanded] = useState(false);
  const stack = props.state.stack;
  if (!stack) {
    const summary =
      props.params.initialSummary?.number === props.params.number
        ? props.params.initialSummary.stack
        : undefined;
    if (!summary) return null;
    return (
      <PullRequestCardGroup>
        <PullRequestCardRow
          title={tr("Stack")}
          icon={PullRequestGlyph.stack}
          value={`${summary.position} of ${summary.size}`}
          last
        />
      </PullRequestCardGroup>
    );
  }
  const position = stack.layers.findIndex((layer) => layer.number === props.params.number) + 1;
  return (
    <PullRequestCardGroup>
      <PullRequestCardRow
        title={tr("Stack")}
        icon={PullRequestGlyph.stack}
        value={tr("{position} of {total}", { position, total: stack.layers.length })}
        accessibilityLabel={
          props.state.isFresh
            ? tr("Stack, {position} of {total}", { position, total: stack.layers.length })
            : tr("Stack, {position} of {total}, showing saved stack", {
                position,
                total: stack.layers.length,
              })
        }
        expanded={expanded}
        onPress={() => setExpanded(!expanded)}
        last={!expanded}
      />
      {expanded ? (
        <View>
          {stack.layers.map((layer, index) => {
            const selected = layer.number === props.params.number;
            const status = pullRequestStatus({
              state: layer.state,
              isDraft: layer.isDraft === true,
            });
            return (
              <View key={layer.number} className={selected ? "bg-thread-selected" : undefined}>
                <PullRequestCardRow
                  title={layer.title ?? layer.headBranch}
                  icon={status.icon}
                  tint={status.tint}
                  value={selected ? tr("Current") : status.label}
                  detail={`#${layer.number} · ${tr("{position} of {total}", { position: index + 1, total: stack.layers.length })}`}
                  onPress={
                    selected
                      ? undefined
                      : () => {
                          const params = pullRequestLayerParams(props.params, layer.number);
                          if (Platform.OS === "android")
                            selectDetail({ name: "PullRequest", params });
                          else navigation.dispatch(StackActions.push("PullRequest", params));
                        }
                  }
                  last={index === stack.layers.length - 1}
                />
              </View>
            );
          })}
          <Text className="px-4 py-3 text-xs text-foreground-muted">
            {stack.base
              ? tr(
                  "Base: {base}. Open a layer to review it or merge the stack through that layer.",
                  { base: stack.base },
                )
              : tr("Base:")}
          </Text>
        </View>
      ) : null}
    </PullRequestCardGroup>
  );
}
