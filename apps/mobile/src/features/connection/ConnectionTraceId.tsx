import { AppText as Text } from "../../components/ui/AppText";
import { tr } from "@t3tools/shared/i18n";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

export function ConnectionTraceId({
  traceId,
  tone = "muted",
  activation = "press",
}: {
  readonly traceId: string;
  readonly tone?: "muted" | "danger";
  readonly activation?: "press" | "longPress";
}) {
  const copy = () => copyTextWithHaptic(traceId, { target: "connection-trace-id" });
  return (
    <>
      {tr(" Trace ID: ")}
      <Text
        accessibilityHint={
          activation === "longPress"
            ? tr("Long press to copy the trace ID")
            : tr("Copies the trace ID")
        }
        accessibilityLabel={tr("Copy trace ID {traceId}", { traceId: traceId })}
        accessibilityRole="button"
        accessibilityActions={[{ name: "activate", label: tr("Copy trace ID") }]}
        onAccessibilityAction={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.actionName === "activate") copy();
        }}
        className={cn(
          "underline decoration-dotted",
          tone === "danger" ? "text-danger-foreground" : "text-foreground-muted",
        )}
        onLongPress={
          activation === "longPress"
            ? (event) => {
                event.stopPropagation();
                copy();
              }
            : undefined
        }
        onPress={(event) => {
          event.stopPropagation();
          if (activation === "press") copy();
        }}
      >
        {traceId}
      </Text>
    </>
  );
}
