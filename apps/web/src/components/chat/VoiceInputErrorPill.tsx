import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { tr } from "@t3tools/shared/i18n";
import { useNavigate } from "@tanstack/react-router";
import { RotateCcwIcon, SettingsIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";

const VOICE_ERROR_LABELS: Record<string, string> = {
  [MICROPHONE_PERMISSION_ERROR]: tr("Microphone access needed"),
  [tr("Microphone access is required for voice input.")]: tr("Microphone access needed"),
  [tr("This draft is no longer available.")]: tr("Draft unavailable"),
  [tr("Another voice recording is already active.")]: tr("Another recording active"),
  [tr("Voice transcription is not available.")]: tr("Voice input unavailable"),
  [tr("Voice transcription is still finishing. Try again shortly.")]: tr("Transcription still busy"),
  [tr("Voice transcription is not available for this language.")]: tr("Language unsupported"),
  [tr("Could not prepare voice transcription.")]: tr("Couldn\u2019t prepare dictation"),
  [tr("Could not start voice recording.")]: tr("Couldn\u2019t start recording"),
  [tr("Voice recording was interrupted.")]: tr("Recording interrupted"),
  [tr("Could not finish voice recording.")]: tr("Couldn\u2019t finish recording"),
  [tr("Could not transcribe this recording.")]: tr("Transcription failed"),
  [tr("Voice transcription on this environment failed.")]: tr("Transcription failed"),
  [tr("The draft changed while voice input was running. The transcript was not added.")]: tr(
    "Draft changed",
  ),
  [tr("No speech was detected.")]: tr("No speech detected"),
  [tr("Microphone processing failed.")]: tr("Microphone processing failed"),
  [tr("The microphone disconnected.")]: tr("Microphone disconnected"),
};

function voiceErrorLabel(error: string | null): string {
  return (error && VOICE_ERROR_LABELS[error]) || tr("Voice input failed");
}

export function VoiceInputErrorPill(props: {
  error: string | null;
  errorAction: "retry" | "settings" | null;
  disabled?: boolean;
  cancelShortcutLabel?: string | null;
  onRetry(): void;
  onDismiss(): void;
}) {
  const navigate = useNavigate();
  const openSettings = props.errorAction === "settings";
  const actionLabel = openSettings
    ? tr("Open voice settings")
    : props.error === "Could not transcribe this recording." ||
        props.error === "Voice transcription on this environment failed."
      ? tr("Retry transcription")
      : tr("Record again");
  return (
    <VoiceInputPill>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm-pill"
              variant="ghost"
              aria-label={tr("Dismiss voice input error")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onDismiss}
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          {tr("Dismiss voice input error")}
          {props.cancelShortcutLabel ? ` (${props.cancelShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              role="status"
              aria-label={props.error ?? tr("Voice input failed")}
              className="min-w-0 flex-1 truncate text-sm text-destructive"
            />
          }
        >
          {voiceErrorLabel(props.error)}
        </TooltipTrigger>
        <TooltipPopup side="top">{props.error ?? tr("Voice input failed")}</TooltipPopup>
      </Tooltip>
      {props.errorAction ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm-pill"
                variant="ghost"
                aria-label={actionLabel}
                disabled={props.disabled}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (openSettings) {
                    props.onDismiss();
                    void navigate({ to: "/settings/voice" });
                  } else {
                    props.onRetry();
                  }
                }}
              >
                {openSettings ? <SettingsIcon /> : <RotateCcwIcon />}
              </Button>
            }
          />
          <TooltipPopup side="top">{actionLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </VoiceInputPill>
  );
}
