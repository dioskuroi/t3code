import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  removeEnvironmentSpeechModel,
  selectEnvironmentSpeechModel,
  updateEnvironmentSpeechAcceleration,
  updateEnvironmentSpeechModelUnloadTimeout,
} from "@t3tools/client-runtime/voice-input";
import { tr } from "@t3tools/shared/i18n";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { openRouterIcon } from "@t3tools/client-runtime/provider-clients";
import {
  AuthSettingsWriteScope,
  CLOUD_SPEECH_LABELS,
  CloudSpeechProvider,
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  type EnvironmentId,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
  type ProjectId,
  ProviderDriverKind,
  type SpeechAcceleration,
  type SpeechCustomWords,
  type SpeechModelUnloadTimeout,
  type VoiceShortcutMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";
import { cloudSpeechLanguages } from "@t3tools/shared/speech";
import {
  AudioLinesIcon,
  CheckIcon,
  DownloadIcon,
  LanguagesIcon,
  KeyRoundIcon,
  MonitorIcon,
  MicOffIcon,
  MicIcon,
  RefreshCwIcon,
  StarIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { listBrowserMicrophones, type BrowserMicrophone } from "../../speech/browserMicrophones";
import { preferredSpeechLanguages } from "../../speech/preferredSpeechLanguages";
import {
  chooseAudioDestination,
  chooseTranscriptCleanup,
  useCleanupGrant,
} from "../../speech/voiceConsent";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import {
  useEnvironmentSpeechInput,
  useVoiceTranscriptionDestination,
} from "../../speech/useEnvironmentSpeechInput";
import { ComposerSpeechRecordingPill } from "../chat/ComposerSpeechButton";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderPackageIcon } from "../chat/ProviderPackageIcon";
import { TraitsPicker } from "../chat/TraitsPicker";
import { VoiceInputSetup } from "../chat/VoiceInputSetup";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { MicrophoneTest } from "./MicrophoneTest";
import { CloudVoiceConfiguration } from "./CloudVoiceConfiguration";
import { LanguageRow, ModelBenchmarks, orderSpeechLanguages } from "./SpeechModelComparison";
import { languageLabel, SpeechLanguageSelect } from "./SpeechLanguageSelect";
import { filterSpeechModels, type SpeechModelSort } from "./speechModelBrowser";
import { AdvancedSettings } from "./AdvancedSettings";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const OFF = "off";
function CloudSpeechLogo({ provider }: { provider: CloudSpeechProvider }) {
  if (provider === "openrouter")
    return <ProviderPackageIcon icon={openRouterIcon} aria-hidden className="size-4 shrink-0" />;
  return (
    <ProviderInstanceIcon
      driverKind={ProviderDriverKind.make(provider === "openai" ? "codex" : "grok")}
      displayName={CLOUD_SPEECH_LABELS[provider]}
      iconClassName="size-4"
    />
  );
}
const SYSTEM_DEFAULT = "system-default";
const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const SHORTCUT_MODE_LABELS: Record<VoiceShortcutMode, string> = {
  auto: tr("Auto: press to toggle, hold to record"),
  hold: tr("Hold: record while held"),
  toggle: tr("Toggle: press to start, press again to stop"),
};
const UNLOAD_LABELS: Record<SpeechModelUnloadTimeout, string> = {
  never: tr("Never"),
  immediately: tr("Immediately"),
  min_2: tr("After 2 minutes"),
  min_5: tr("After 5 minutes"),
  min_10: tr("After 10 minutes"),
  min_15: tr("After 15 minutes"),
  hour_1: tr("After 1 hour"),
};
const normalizeTerm = (value: string) => value.replace(/\s+/g, " ").trim().normalize("NFC");
const spellingsOf = (words: SpeechCustomWords) =>
  new Set(
    words.flatMap(({ term, aliases }) =>
      [term, ...aliases].map((spelling) => spelling.toLocaleLowerCase()),
    ),
  );

type ModelCardProps = {
  readonly model: EnvironmentSpeechModel;
  readonly comparisonLanguages: readonly string[];
  readonly busy: boolean;
  readonly canCancel: boolean;
  readonly onDownload: () => void;
  readonly onSelect: () => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
  readonly testControls?: ReactNode;
  readonly children?: ReactNode;
};

function ModelBadge(props: { icon: ReactNode; label: string; tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" />}>
        {props.icon}
        {props.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function ModelCard(props: ModelCardProps) {
  const { model } = props;
  const downloading = model.state === "downloading" || model.state === "verifying";
  const progress = model.downloaded === undefined ? 0 : (model.downloaded / model.size) * 100;
  return (
    <div className="flex flex-wrap items-start gap-3 px-3 py-2.5 sm:px-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium leading-5">{model.name}</span>
          {model.recommended ? (
            <ModelBadge
              icon={<StarIcon className="mr-1 size-3" />}
              label={tr("Recommended")}
              tooltip={tr("A good default pick for the languages it covers.")}
            />
          ) : null}
          {model.supportsStreaming ? (
            <ModelBadge
              icon={<AudioLinesIcon className="mr-1 size-3" />}
              label={tr("Live preview")}
              tooltip={tr("Shows words in your draft as you speak, before the recording finishes.")}
            />
          ) : null}
          {model.supportsTranslation ? (
            <ModelBadge
              icon={<LanguagesIcon className="mr-1 size-3" />}
              label={tr("Translate")}
              tooltip={tr("Can write English text from speech in another language. Turn on Translate to English to use it.")}
            />
          ) : null}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{model.description}</p>
        <ModelBenchmarks
          model={model}
          languages={props.comparisonLanguages}
          facts={[
            ...(model.languages.length > 1
              ? [`${model.languages.length} languages`]
              : model.benchmark
                ? []
                : [languageLabel(model.languages[0] ?? "")]),
            formatSize(model.size),
          ]}
        />
        {downloading ? (
          <div className="mt-2">
            <div
              role="progressbar"
              aria-label={`${model.name} download progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
              className="h-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-1 text-2xs text-muted-foreground">
              {model.state === "verifying"
                ? tr("Verifying download\u2026")
                : tr("{percent}% downloaded", { percent: Math.round(progress) })}
            </p>
          </div>
        ) : null}
      </div>
      <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
        {props.testControls}
        {downloading ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={tr("Cancel {model} download", { model: model.name })}
            disabled={!props.canCancel}
            onClick={props.onCancel}
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : model.state === "downloadable" ? (
          <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onDownload}>
            <DownloadIcon className="mr-1.5 size-3.5" />
            {tr("Download")}
          </Button>
        ) : model.active ? (
          <Button size="sm" variant="secondary" disabled>
            <CheckIcon className="mr-1.5 size-3.5" />
            {tr("Selected")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onSelect}>
            {tr("Use model")}
          </Button>
        )}
        {model.state === "installed" ? (
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={props.busy}
            aria-label={`Delete ${model.name}`}
            onClick={props.onDelete}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}

function DictionaryEditor(props: {
  readonly label: string;
  readonly words: SpeechCustomWords;
  readonly disabled?: boolean;
  readonly onChange: (words: SpeechCustomWords) => void;
}) {
  const { words, label, disabled = false, onChange } = props;
  const [termDraft, setTermDraft] = useState("");
  const [aliasDraft, setAliasDraft] = useState<{ term: string; value: string } | null>(null);
  const spellings = spellingsOf(words);
  const seen = new Set(spellings);
  const newTerms = termDraft
    .split(/[,\n]/)
    .map(normalizeTerm)
    .filter((term) => {
      const key = term.toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const canAddTerm =
    !disabled &&
    newTerms.length > 0 &&
    newTerms.every((term) => term.length <= 50) &&
    words.length + newTerms.length <= 100;
  const addTerm = () => {
    if (!canAddTerm) return;
    onChange([...words, ...newTerms.map((term) => ({ term, aliases: [] }))]);
    setTermDraft("");
  };
  const addAlias = () => {
    if (!aliasDraft) return;
    const value = normalizeTerm(aliasDraft.value);
    if (!value || value.length > 50 || spellings.has(value.toLocaleLowerCase())) return;
    onChange(
      words.map((entry) =>
        entry.term === aliasDraft.term && entry.aliases.length < 8
          ? { term: entry.term, aliases: [...entry.aliases, value] }
          : entry,
      ),
    );
    setAliasDraft(null);
  };
  return (
    <>
      <div className="flex items-start gap-1.5">
        <Textarea
          value={termDraft}
          rows={1}
          maxLength={5_100}
          disabled={disabled}
          placeholder={tr("Add words or phrases, separated by commas or line breaks")}
          aria-label={tr("Add a word or phrase to the {label}", { label: label })}
          onChange={(event) => setTermDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            addTerm();
          }}
        />
        <Button type="button" disabled={!canAddTerm} onClick={addTerm}>
          {tr("Add")}
        </Button>
      </div>
      {words.length > 0 ? (
        <ul aria-label={`${label} entries`} className="mt-3 flex flex-wrap gap-1.5">
          {words.map(({ term, aliases }) => (
            <li
              key={term}
              className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 py-0.5 pl-2 pr-0.5 text-xs"
            >
              <span className="font-medium">{term}</span>
              {aliases.length > 0 ? (
                <span className="text-muted-foreground">← {aliases.join(", ")}</span>
              ) : null}
              {aliasDraft?.term === term ? (
                <Input
                  autoFocus
                  value={aliasDraft.value}
                  maxLength={50}
                  aria-label={tr("Alias for {term}", { term: term })}
                  placeholder={tr("Misspelling")}
                  className="w-32"
                  onChange={(event) => setAliasDraft({ term, value: event.target.value })}
                  onBlur={() => setAliasDraft(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setAliasDraft(null);
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addAlias();
                  }}
                />
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled || aliases.length >= 8}
                  aria-label={tr("Add an alias for {term}", { term: term })}
                  onClick={() => setAliasDraft({ term, value: "" })}
                >
                  {tr("Alias")}
                </Button>
              )}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                disabled={disabled}
                aria-label={tr("Remove {term}", { term: term })}
                onClick={() => onChange(words.filter((entry) => entry.term !== term))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Vocabulary stored on the environment with the project, read by everyone who dictates there. */
function ProjectDictionaryRow() {
  const scope = useOptionalSettingsScope();
  const words = useScopedSettings((settings) => settings.speechProjectCustomWords);
  const updateScopedSettings = useUpdateScopedSettings();
  if (scope === null) return null;
  const isProjectScope = scope.scope.kind === "project" || scope.scope.kind === "checkout";
  return (
    <SettingsRow
      serverScoped
      settingKeys={["speechProjectCustomWords"]}
      {...searchableSetting("speech-project-dictionary")}
      title={isProjectScope ? tr("Project dictionary") : tr("Shared dictionary")}
      description={
        isProjectScope
          ? tr("Saved with {scope} on its environment. Everyone who dictates in this project gets these spellings, along with their own dictionary. Project spellings win when the two overlap.", {
              scope: scope.scope.label,
            })
          : tr("Saved on the environment and used in every project there, along with each person\u2019s own dictionary. Pick a project above to limit these words to one project.")
      }
      control={
        <span className="text-xs text-muted-foreground">
          {words.length} {words.length === 1 ? "entry" : "entries"}
        </span>
      }
    >
      <div className="mt-2 pb-3.5">
        <DictionaryEditor
          label={isProjectScope ? "project dictionary" : "shared dictionary"}
          words={words}
          disabled={scope.connectedEnvironments.length === 0}
          onChange={(next) => updateScopedSettings({ speechProjectCustomWords: next })}
        />
      </div>
    </SettingsRow>
  );
}

/** Cleanup runs on the draft's environment, so its model is an environment setting there. */
function CleanupModelRow() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = providers.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = providerInstanceEntriesFor(textGenerationProviders, settings, null);
  const hasProvider = instanceEntries.some((entry) => entry.enabled && entry.isAvailable);
  const dedicated = settings.speechPostProcessingModelSelection !== null;
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveSpeechPostProcessingModelSelection(
        settings,
        textGenerationProviders,
      ),
    },
    textGenerationProviders,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const setModel = (next: ReturnType<typeof createModelSelection>) => {
    const reason = modelDisabledReason(next.instanceId, next.model);
    if (reason) {
      toastManager.add({ type: "error", title: tr("Cleanup model not saved"), description: reason });
      return;
    }
    updateSettings({ speechPostProcessingModelSelection: next });
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={["speechPostProcessingModelSelection"]}
      {...searchableSetting("speech-post-processing-model")}
      title={tr("Cleanup model")}
      description={
        dedicated
          ? tr("Drafts on {environment} use this model for cleanup instead of the environment\u2019s text generation model.", {
              environment: environment?.label ?? "this environment",
            })
          : tr("Cleanup currently uses the text generation model on {environment}. Pick another model if you want a cheaper or faster one.", {
              environment: environment?.label ?? "this environment",
            })
      }
      resetAction={
        dedicated ? (
          <SettingResetButton
            label="cleanup model"
            onClick={() => updateSettings({ speechPostProcessingModelSelection: null })}
          />
        ) : null
      }
      control={
        connectedEnvironments.length === 0 ? (
          <span className="text-sm text-muted-foreground">{tr("Connect an environment first.")}</span>
        ) : !hasProvider || !instanceEntry ? (
          <span className="text-sm text-muted-foreground">{tr("No providers available.")}</span>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={environment?.environmentId ?? null}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              getModelDisabledReason={modelDisabledReason}
              onInstanceModelChange={(instanceId, model) =>
                setModel(createModelSelection(instanceId, model))
              }
            />
            <TraitsPicker
              provider={instanceEntry.driverKind}
              models={instanceEntry.models}
              model={selection.model}
              modelOptions={selection.options ?? []}
              allowPromptInjectedEffort={false}
              planModeEnabled={settings.planModeEnabled}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={(options) =>
                setModel(createModelSelection(selection.instanceId, selection.model, options))
              }
            />
          </div>
        )
      }
    />
  );
}

function useVoiceModels(prepared: PreparedConnection | null) {
  const canManage = useEnvironmentScope(prepared?.environmentId ?? null, AuthSettingsWriteScope);
  const [models, setModels] = useState<readonly EnvironmentSpeechModel[]>([]);
  const [status, setStatus] = useState<EnvironmentSpeechStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestedDownload, setRequestedDownload] = useState<string | null>(null);
  const [actionConnection, setActionConnection] = useState(prepared);
  if (actionConnection !== prepared) {
    setActionConnection(prepared);
    setBusy(false);
    setRequestedDownload(null);
    setModels([]);
    setStatus(null);
  }
  const epoch = useRef(0);
  const refreshRevision = useRef(0);
  const refresh = useStableCallback(
    async (connection: PreparedConnection, mode: "foreground" | "progress") => {
      const current = epoch.current;
      const revision = ++refreshRevision.current;
      try {
        const [nextStatus, nextModels] = await Promise.all([
          runEnvironmentSpeech(getEnvironmentSpeechStatus(connection)),
          runEnvironmentSpeech(getEnvironmentSpeechModels(connection, mode === "foreground")),
        ]);
        if (current !== epoch.current || revision !== refreshRevision.current) return;
        setStatus(nextStatus);
        setModels((previous) => {
          if (mode === "foreground") return nextModels.models;
          const benchmarks = new Map(previous.map((model) => [model.id, model.benchmark]));
          return nextModels.models.map((model) => {
            const benchmark = benchmarks.get(model.id);
            return benchmark ? { ...model, benchmark } : model;
          });
        });
      } catch (error) {
        if (mode === "progress") return;
        if (current !== epoch.current || revision !== refreshRevision.current) return;
        toastManager.add({
          type: "error",
          title: tr("Could not load transcription models"),
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's model catalog when its connection becomes available
  useEffect(() => {
    epoch.current += 1;
    if (prepared) void refresh(prepared, "foreground");
    return () => {
      epoch.current += 1;
    };
  }, [prepared, refresh]);
  const downloading =
    requestedDownload !== null ||
    models.some((model) => model.state === "downloading" || model.state === "verifying");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls progress while a local request or the environment reports an active download
  useEffect(() => {
    if (!prepared || !downloading) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh(prepared, "progress");
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1_000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [downloading, prepared, refresh]);

  const run = async (label: string, work: () => Promise<unknown>, downloadId?: string) => {
    if (!prepared || !canManage) return;
    const current = epoch.current;
    if (downloadId) setRequestedDownload(downloadId);
    else setBusy(true);
    try {
      await work();
    } catch (error) {
      if (current === epoch.current)
        toastManager.add({
          type: "error",
          title: label,
          description: error instanceof Error ? error.message : String(error),
        });
    }
    if (current === epoch.current) {
      if (downloadId) setRequestedDownload(null);
      else setBusy(false);
      await refresh(prepared, "foreground");
    }
  };
  return {
    models,
    status,
    run,
    controlsDisabled: busy || downloading || !canManage,
    canCancel: canManage && !busy,
    requestedDownload,
  };
}

type VoiceModels = ReturnType<typeof useVoiceModels>;

function AdvancedSpeechSettings({
  prepared,
  catalog,
}: {
  prepared: PreparedConnection;
  catalog: VoiceModels;
}) {
  const { run, controlsDisabled, status } = catalog;
  if (!status?.supported) return null;
  const supported = status;
  return (
    <AdvancedSettings targetIds={[searchableSetting("speech-hardware").id]}>
      <SettingsRow
        {...searchableSetting("speech-hardware")}
        title={tr("Hardware")}
        description={tr("Auto uses the environment\u2019s GPU when it has one.")}
        control={
          <Select
            value={supported.acceleration}
            disabled={controlsDisabled}
            onValueChange={(value) => {
              if (value)
                void run(tr("Could not change transcription hardware"), () =>
                  runEnvironmentSpeech(
                    updateEnvironmentSpeechAcceleration(prepared, value as SpeechAcceleration),
                  ),
                );
            }}
          >
            <SelectTrigger size="sm" aria-label={tr("Transcription hardware")} className="max-w-72">
              <SelectValue>
                {supported.acceleration === "auto"
                  ? tr("Auto")
                  : supported.acceleration === "cpu"
                    ? "CPU"
                    : (supported.gpuDevices.find(
                        (device) => `gpu:${device.id}` === supported.acceleration,
                      )?.name ?? tr("Selected GPU"))}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="auto">{tr("Auto")}</SelectItem>
              <SelectItem value="cpu">{tr("CPU")}</SelectItem>
              {supported.gpuDevices.map((device) => (
                <SelectItem key={device.id} value={`gpu:${device.id}`}>
                  {device.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title={tr("Unload model")}
        description={tr("Release the model\u2019s memory on the environment after it sits idle.")}
        control={
          <Select
            value={supported.modelUnloadTimeout}
            disabled={controlsDisabled}
            onValueChange={(value) => {
              if (value)
                void run(tr("Could not change when the model unloads"), () =>
                  runEnvironmentSpeech(
                    updateEnvironmentSpeechModelUnloadTimeout(
                      prepared,
                      value as SpeechModelUnloadTimeout,
                    ),
                  ),
                );
            }}
          >
            <SelectTrigger size="sm" aria-label={tr("Unload model")} className="max-w-72">
              <SelectValue>{UNLOAD_LABELS[supported.modelUnloadTimeout]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(UNLOAD_LABELS) as SpeechModelUnloadTimeout[]).map((timeout) => (
                <SelectItem key={timeout} value={timeout}>
                  {UNLOAD_LABELS[timeout]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </AdvancedSettings>
  );
}

function SpeechModelBrowser(props: {
  prepared: PreparedConnection;
  catalog: VoiceModels;
  testEnvironmentId: EnvironmentId;
  projectId: ProjectId | null;
  projectName: string | null;
}) {
  const {
    prepared,
    catalog: { status, models, run, controlsDisabled, canCancel, requestedDownload },
  } = props;
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SpeechModelSort>("recommended");
  const [downloadedOnly, setDownloadedOnly] = useState(false);
  const [languageSearch, setLanguageSearch] = useState("");
  const [selection, setSelection] = useState<string[] | null>(null);
  const [preferred] = useState(preferredSpeechLanguages);
  const supportedLanguages = [...new Set(models.flatMap((model) => model.languages))];
  const defaultLanguage = preferred.find((code) => supportedLanguages.includes(code));
  const selectedLanguages = selection ?? (defaultLanguage ? [defaultLanguage] : []);
  const languages = orderSpeechLanguages(supportedLanguages, preferred);
  const needle = languageSearch.trim().toLocaleLowerCase();
  const visibleLanguages = languages.filter(
    (code) =>
      !needle || code.includes(needle) || languageLabel(code).toLocaleLowerCase().includes(needle),
  );
  const accuracyLanguage = selectedLanguages[0] ?? "en";
  const sortLabels: Record<SpeechModelSort, string> = {
    recommended: tr("Recommended"),
    size: tr("Smallest download"),
    accuracy: tr("Best {language} accuracy", { language: languageLabel(accuracyLanguage) }),
    speed: tr("Fastest transcription"),
  };
  const sortedModels = filterSpeechModels(models, {
    search,
    languages: selectedLanguages,
    downloadedOnly,
    sort,
    accuracyLanguage,
  });
  const activeModel = models.find((model) => model.active);
  const renderedModels =
    activeModel && !sortedModels.includes(activeModel)
      ? [activeModel, ...sortedModels]
      : sortedModels;

  return (
    <SettingsSearchTarget
      {...searchableSetting("speech-models")}
      className="@container/voice-models"
    >
      {status && !status.supported ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {tr("This environment can\u2019t transcribe audio:")} {status.reason}.
        </p>
      ) : null}
      {status?.supported ? (
        <>
          <p className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground sm:px-4">
            {tr("Pick languages to see models that support all of them. Accuracy is word or character\n            error rate: lower is better. Speed is the time to transcribe 30 seconds of audio on\n            Handy\u2019s benchmark GPU.")}
          </p>
          <div className="@min-[32rem]/voice-models:grid @min-[32rem]/voice-models:grid-cols-[11rem_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col border-b border-border/60 bg-muted/10 @min-[32rem]/voice-models:border-r @min-[32rem]/voice-models:border-b-0">
              <div className="space-y-2 p-3">
                <p className="text-sm font-medium">{tr("Languages")}</p>
                <Input
                  size="compact"
                  aria-label={tr("Search languages")}
                  placeholder={tr("Search languages")}
                  value={languageSearch}
                  onChange={(e) => setLanguageSearch(e.target.value)}
                />
              </div>
              <div
                role="group"
                aria-label={tr("Browse models by language")}
                className="flex gap-1 overflow-x-auto px-2 pb-2 @min-[32rem]/voice-models:h-72 @min-[32rem]/voice-models:flex-col @min-[32rem]/voice-models:overflow-y-auto"
              >
                <LanguageRow
                  label={tr("All languages")}
                  selected={selectedLanguages.length === 0}
                  onClick={() => setSelection([])}
                />
                {visibleLanguages.map((code) => (
                  <LanguageRow
                    key={code}
                    label={languageLabel(code)}
                    selected={selectedLanguages.includes(code)}
                    onClick={() =>
                      setSelection(
                        selectedLanguages.includes(code)
                          ? selectedLanguages.filter((language) => language !== code)
                          : [...selectedLanguages, code],
                      )
                    }
                  />
                ))}
                {visibleLanguages.length === 0 && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">{tr("No languages match.")}</p>
                )}
              </div>
            </div>
            <div className="flex min-w-0 flex-col">
              <div className="space-y-2 p-3">
                <p className="text-sm font-medium">
                  {selectedLanguages.length
                    ? tr("Models for ") + selectedLanguages.map(languageLabel).join(", ")
                    : tr("All models")}
                </p>
                <InputGroup>
                  <InputGroupInput
                    size="compact"
                    aria-label={tr("Search transcription models")}
                    placeholder={tr("Search models")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <InputGroupAddon align="inline-end">
                    <Menu>
                      <MenuTrigger
                        render={<Button size="compact" variant="ghost-muted" />}
                        aria-label={tr("Sort and filter models: {label}{suffix}", {
                          label: sortLabels[sort],
                          suffix: downloadedOnly ? tr(", downloaded only") : "",
                        })}
                      >
                        <SlidersHorizontalIcon />
                        <span className="hidden @min-[40rem]/voice-models:inline">
                          {sortLabels[sort]}
                        </span>
                        {downloadedOnly && <span>1</span>}
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuGroup>
                          <MenuGroupLabel>{tr("Sort by")}</MenuGroupLabel>
                          <MenuRadioGroup
                            value={sort}
                            onValueChange={(value) => setSort(value as SpeechModelSort)}
                          >
                            {(Object.keys(sortLabels) as SpeechModelSort[]).map((value) => (
                              <MenuRadioItem key={value} value={value} closeOnClick>
                                <span className="flex items-center justify-between gap-3">
                                  {sortLabels[value]}
                                  <MenuRadioItemIndicator />
                                </span>
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </MenuGroup>
                        <MenuSeparator />
                        <MenuCheckboxItem
                          checked={downloadedOnly}
                          onCheckedChange={setDownloadedOnly}
                        >
                          {tr("Downloaded only")}
                        </MenuCheckboxItem>
                      </MenuPopup>
                    </Menu>
                  </InputGroupAddon>
                </InputGroup>
              </div>
              <div
                className="h-72 overflow-y-auto divide-y divide-border/60"
                role="region"
                aria-label={tr("Transcription models")}
                tabIndex={0}
              >
                {sortedModels.length === 0 && (
                  <p className="px-4 py-2 text-sm text-muted-foreground">{tr("No models match.")}</p>
                )}
                {renderedModels.map((model) => {
                  const card: ModelCardProps = {
                    model:
                      model.id === requestedDownload && model.state === "downloadable"
                        ? { ...model, state: "downloading" }
                        : model,
                    busy: controlsDisabled,
                    canCancel,
                    comparisonLanguages: selectedLanguages,
                    onDownload: () =>
                      void run(
                        tr("Could not download the model"),
                        () =>
                          runEnvironmentSpeech(downloadEnvironmentSpeechModel(prepared, model.id)),
                        model.id,
                      ),
                    onSelect: () =>
                      void run(tr("Could not select the model"), () =>
                        runEnvironmentSpeech(selectEnvironmentSpeechModel(prepared, model.id)),
                      ),
                    onCancel: () =>
                      void run(tr("Could not cancel the download"), () =>
                        runEnvironmentSpeech(
                          cancelEnvironmentSpeechModelDownload(prepared, model.id),
                        ),
                      ),
                    onDelete: () =>
                      void run(tr("Could not delete the model"), () =>
                        runEnvironmentSpeech(removeEnvironmentSpeechModel(prepared, model.id)),
                      ),
                  };
                  return model.active ? (
                    <TranscriptionTest
                      key={model.id}
                      card={card}
                      hidden={!sortedModels.includes(model)}
                      environmentId={props.testEnvironmentId}
                      projectId={props.projectId}
                      projectName={props.projectName}
                    />
                  ) : (
                    <ModelCard key={model.id} {...card} />
                  );
                })}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </SettingsSearchTarget>
  );
}

function TranscriptionTest(props: {
  readonly card: ModelCardProps;
  readonly hidden: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly projectName: string | null;
}) {
  const [transcript, setTranscript] = useState<string | null>(null);
  const draft = transcript ?? "";
  const [showTranscript, setShowTranscript] = useState(false);
  const draftRef = useRef(draft);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed draft to the asynchronous transcription controller
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const speech = useEnvironmentSpeechInput({
    environmentId: props.environmentId,
    projectId: props.projectId,
    projectName: props.projectName,
    ownerKey: JSON.stringify([props.environmentId, props.projectId]),
    draftText: draft,
    cleanup: false,
    readDraft: () => ({
      text: draftRef.current,
      selection: { start: draftRef.current.length, end: draftRef.current.length },
    }),
    commitDraft: (text) => setTranscript(text),
  });
  return (
    <SettingsSearchTarget {...searchableSetting("transcription-test")} hidden={props.hidden}>
      <ModelCard
        {...props.card}
        testControls={
          <div className="flex min-w-0 max-w-full items-center gap-1">
            <ComposerSpeechRecordingPill
              state={speech.state}
              progress={null}
              level={speech.level}
              onStart={() => void speech.start()}
              onStop={() => void speech.stop()}
              onCancel={() => speech.cancel()}
              onSkipPostProcessing={() => speech.skipPostProcessing()}
            />
            {speech.available ? (
              speech.state.phase === "idle" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowTranscript(true);
                    void speech.start();
                  }}
                >
                  <MicIcon />
                  {tr("Test model")}
                </Button>
              ) : null
            ) : (
              <span className="text-xs text-muted-foreground">
                {speech.status?.supported === false
                  ? speech.status.reason
                  : tr("Waiting for the environment to connect")}
              </span>
            )}
          </div>
        }
      >
        {showTranscript ? (
          <div className="w-full">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
                {tr("Say a sentence in the language above. Cleanup is skipped, so you see exactly what\n                the model heard. The transcript stays on this page.")}
              </p>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={tr("Close model test")}
                onClick={() => {
                  speech.cancel();
                  setShowTranscript(false);
                }}
              >
                <XIcon />
              </Button>
            </div>
            {speech.preview || transcript !== null ? (
              <p
                role="status"
                aria-label={tr("Test transcript")}
                className="mt-2 select-text whitespace-pre-wrap break-words text-sm leading-relaxed"
              >
                {speech.preview ? (
                  <>
                    {speech.preview.committed}
                    <span className="text-muted-foreground">{speech.preview.tentative}</span>
                  </>
                ) : (
                  transcript || tr("No speech recognized. Try again.")
                )}
              </p>
            ) : null}
          </div>
        ) : null}
      </ModelCard>
      <VoiceInputSetup
        environmentId={speech.transcriptionEnvironmentId}
        open={speech.setup.open}
        step={speech.setup.step}
        status={speech.status}
        model={speech.setup.model}
        language={speech.setup.language}
        downloading={speech.setup.downloading}
        error={speech.setup.error}
        onOpenChange={speech.setup.setOpen}
        onRetryCatalog={speech.setup.retryCatalog}
        onDownload={() => void speech.setup.download()}
        onCancelDownload={() => void speech.setup.cancelDownload()}
        onStartRecording={() => void speech.setup.startRecording()}
      />
    </SettingsSearchTarget>
  );
}

export function VoiceSettingsPanel() {
  const cleanupEnabled = useCleanupGrant() !== null;
  const settings = useClientSettings();
  const settingsScope = useOptionalSettingsScope();
  const destination = useVoiceTranscriptionDestination();
  const canManageKey = useEnvironmentScope(destination.environmentId, AuthSettingsWriteScope);
  const [pendingCloud, setPendingCloud] = useState<{
    provider: CloudSpeechProvider;
    environmentId: EnvironmentId;
  } | null>(null);
  const { environments } = useEnvironments();
  const [microphones, setMicrophones] = useState<BrowserMicrophone[]>([]);
  const prepared = destination.cloudProvider ? null : destination.prepared;
  const catalog = useVoiceModels(prepared);

  const refreshMicrophones = useStableCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      setMicrophones(await listBrowserMicrophones());
    } catch {
      setMicrophones([]);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to microphone device changes while settings are open
  useEffect(() => {
    queueMicrotask(() => void refreshMicrophones());
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onChange = () => void refreshMicrophones();
    mediaDevices.addEventListener("devicechange", onChange);
    return () => mediaDevices.removeEventListener("devicechange", onChange);
  }, [refreshMicrophones]);
  const modelStatus = catalog.status;
  const target = settingsScope?.target;
  const members = settingsScope?.scope.members;
  const project =
    members?.find(
      (member) => member.environmentId === target?.environmentId && member.id === target.projectId,
    ) ?? members?.[0];

  const selectedMicrophone = settings.voiceMicrophone;
  const selectedMicrophoneLabel = selectedMicrophone
    ? (microphones.find((device) => device.deviceId === selectedMicrophone)?.label ??
      tr("Selected microphone (unavailable)"))
    : tr("System default");
  const environmentChoices = environments.map((environment) => ({
    environment,
    value: JSON.stringify(["environment", environment.environmentId]),
  }));
  const cloudGroups = environments
    .filter(
      (environment) => environment.serverConfig?.environment.capabilities.cloudVoiceTranscription,
    )
    .map((environment) => ({
      environment,
      choices: CloudSpeechProvider.literals.map((provider) => ({
        environment,
        provider,
        value: JSON.stringify(["cloud", environment.environmentId, provider]),
      })),
    }));
  const cloudChoices = cloudGroups.flatMap((group) => group.choices);
  const destinationValue = destination.cloudProvider
    ? JSON.stringify(["cloud", destination.environmentId, destination.cloudProvider])
    : destination.environmentId
      ? JSON.stringify(["environment", destination.environmentId])
      : OFF;
  const cloudEnvironment = environments.find(
    (env) => env.environmentId === pendingCloud?.environmentId,
  );
  // OpenRouter users without settings access still manage their own model choice.
  const manageLabel =
    destination.cloudProvider === "openrouter" ? tr("Manage OpenRouter") : tr("Manage key");
  const chosenEnvironment = environments.find(
    (environment) => environment.environmentId === destination.environmentId,
  );
  const chosenUnsupported =
    !destination.cloudProvider &&
    chosenEnvironment?.serverConfig != null &&
    chosenEnvironment.serverConfig.environment.capabilities.voiceTranscription !== true;
  const model = prepared && modelStatus?.supported ? modelStatus : null;

  return (
    <SettingsPageContainer
      searchTargetFallbacks={{
        "speech-language":
          model || destination.cloudProvider ? undefined : "voice-transcription-destination",
        "speech-models": prepared ? undefined : "voice-transcription-destination",
        "speech-hardware": prepared && model ? undefined : "voice-transcription-destination",
        "transcription-test": !prepared
          ? "voice-transcription-destination"
          : !model || model.state === "missing-model"
            ? "speech-models"
            : undefined,
        "speech-post-processing-model":
          cleanupEnabled && settingsScope ? undefined : "speech-post-processing",
        "speech-correction-word": cleanupEnabled ? undefined : "speech-post-processing",
      }}
    >
      <SettingsSection id="voice-input" title={tr("Input")}>
        <SettingsRow
          {...searchableSetting("voice-microphone")}
          title={tr("Microphone")}
          description={tr("System default follows your operating system. Record a ten-second test and play it back here. Test audio stays on this device and is never transcribed.")}
          control={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              <SettingsSearchTarget {...searchableSetting("microphone-test")}>
                <MicrophoneTest key={selectedMicrophone} microphoneId={selectedMicrophone} />
              </SettingsSearchTarget>
              <div className="flex min-w-0 items-center gap-1.5">
                <Select
                  value={selectedMicrophone ? `device:${selectedMicrophone}` : SYSTEM_DEFAULT}
                  onValueChange={(value) => {
                    if (value)
                      void updateClientSettings({
                        voiceMicrophone:
                          value === SYSTEM_DEFAULT ? "" : value.slice("device:".length),
                      });
                  }}
                >
                  <SelectTrigger size="sm" aria-label={tr("Microphone")} className="max-w-64">
                    <SelectValue>{selectedMicrophoneLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value={SYSTEM_DEFAULT}>{tr("System default")}</SelectItem>
                    {microphones.map((device) => (
                      <SelectItem key={device.deviceId} value={`device:${device.deviceId}`}>
                        {device.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={tr("Refresh microphones")}
                  onClick={() => void refreshMicrophones()}
                >
                  <RefreshCwIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("dictation-shortcut-mode")}
          title={tr("Dictation shortcut")}
          description={tr("How the dictation shortcut starts and stops recording.")}
          control={
            <Select
              value={settings.voiceShortcutMode}
              onValueChange={(value) => {
                if (value)
                  void updateClientSettings({ voiceShortcutMode: value as VoiceShortcutMode });
              }}
            >
              <SelectTrigger size="sm" aria-label={tr("Dictation shortcut mode")} className="max-w-72">
                <SelectValue>{SHORTCUT_MODE_LABELS[settings.voiceShortcutMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(Object.keys(SHORTCUT_MODE_LABELS) as VoiceShortcutMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {SHORTCUT_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection id="voice-transcription" title={tr("Transcription")}>
        <SettingsSearchTarget
          {...searchableSetting("voice-transcription-destination")}
          className="@container/destination px-3 py-3 sm:px-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="shrink-0 text-sm font-medium">
              <span className="@max-[18rem]/destination:hidden">{tr("Transcribe with")}</span>
              <span className="@min-[18rem]/destination:hidden">{tr("Use")}</span>
            </h3>
            <div className="flex min-w-0 items-center justify-end gap-1">
              <Select
                value={destinationValue}
                onValueChange={(value) => {
                  if (!value) return;
                  const cloud = cloudChoices.find((choice) => choice.value === value);
                  if (cloud) {
                    setPendingCloud({
                      environmentId: cloud.environment.environmentId,
                      provider: cloud.provider,
                    });
                    return;
                  }
                  setPendingCloud(null);
                  const chosen = environmentChoices.find((choice) => choice.value === value);
                  if (value === OFF) chooseAudioDestination(null);
                  else if (chosen)
                    chooseAudioDestination({
                      kind: "environment",
                      environmentId: chosen.environment.environmentId,
                    });
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={tr("Transcribe with")}
                  className="w-auto min-w-0 max-w-72"
                >
                  <SelectValue>
                    <span className="flex min-w-0 items-center gap-2">
                      {destination.cloudProvider ? (
                        <CloudSpeechLogo provider={destination.cloudProvider} />
                      ) : destination.environmentId ? (
                        <MonitorIcon aria-hidden className="size-4" />
                      ) : (
                        <MicOffIcon aria-hidden className="size-4" />
                      )}
                      <span className="truncate">
                        {destination.cloudProvider
                          ? CLOUD_SPEECH_LABELS[destination.cloudProvider]
                          : destination.environmentId
                            ? (chosenEnvironment?.label ?? tr("Chosen environment (unavailable)"))
                            : tr("Off")}
                        {destination.cloudProvider && (
                          <span className="text-muted-foreground">
                            {" via "}
                            {chosenEnvironment?.label ?? "unavailable environment"}
                          </span>
                        )}
                      </span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={OFF}>
                    <span className="flex items-center gap-2">
                      <MicOffIcon aria-hidden className="size-4" />
                      {tr("Off")}
                    </span>
                  </SelectItem>
                  {environmentChoices.length > 0 && (
                    <SelectGroup>
                      <SelectGroupLabel>{tr("On an environment")}</SelectGroupLabel>
                      {environmentChoices.map(({ environment, value }) => (
                        <SelectItem key={value} value={value}>
                          <span className="flex items-center gap-2">
                            <MonitorIcon aria-hidden className="size-4" />
                            {environment.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {cloudGroups.map(({ environment, choices }) => (
                    <SelectGroup key={environment.environmentId}>
                      <SelectGroupLabel>{tr("Cloud via")} {environment.label}</SelectGroupLabel>
                      {choices.map(({ value, provider }) => (
                        <SelectItem
                          key={value}
                          value={value}
                          aria-label={`${CLOUD_SPEECH_LABELS[provider]} via ${environment.label}`}
                        >
                          <span className="flex items-center gap-2">
                            <CloudSpeechLogo provider={provider} />
                            {CLOUD_SPEECH_LABELS[provider]}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                  {destination.environmentId &&
                  (!chosenEnvironment ||
                    (destination.cloudProvider &&
                      !cloudChoices.some((option) => option.value === destinationValue))) ? (
                    <SelectItem value={destinationValue}>
                      {tr("Chosen environment (unavailable)")}
                    </SelectItem>
                  ) : null}
                </SelectPopup>
              </Select>
              {destination.cloudProvider &&
                chosenEnvironment &&
                (canManageKey || destination.cloudProvider === "openrouter") && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                          aria-label={manageLabel}
                          onClick={() => {
                            if (destination.cloudProvider)
                              setPendingCloud({
                                provider: destination.cloudProvider,
                                environmentId: chosenEnvironment.environmentId,
                              });
                          }}
                        >
                          <KeyRoundIcon aria-hidden className="size-4" />
                        </Button>
                      }
                    />
                    <TooltipPopup>{manageLabel}</TooltipPopup>
                  </Tooltip>
                )}
            </div>
          </div>
          {destination.environmentId && chosenUnsupported ? (
            <p className="mt-2 text-xs text-destructive">
              {chosenEnvironment.label} {tr("can\u2019t transcribe audio locally. Choose a different\n              destination.")}
            </p>
          ) : null}
        </SettingsSearchTarget>

        {pendingCloud && cloudEnvironment && (
          <CloudVoiceConfiguration
            key={JSON.stringify(pendingCloud)}
            provider={pendingCloud.provider}
            environment={cloudEnvironment}
            active={
              destination.environmentId === pendingCloud.environmentId &&
              destination.cloudProvider === pendingCloud.provider
            }
            close={() => setPendingCloud(null)}
          />
        )}
        {(model || destination.cloudProvider) && (
          <SettingsRow
            {...searchableSetting("speech-language")}
            title={tr("Language")}
            description={
              destination.cloudProvider
                ? tr("The cloud provider can detect your language automatically.")
                : model
                  ? `${model.model} ${model.supportsLanguageDetection ? "detects the language automatically" : "uses one fixed language"}.`
                  : tr("Choose an environment above to see the languages its transcription model supports.")
            }
            control={
              <SpeechLanguageSelect
                model={destination.cloudProvider ? cloudSpeechLanguages : model}
              />
            }
          />
        )}
        {model?.supportsTranslation ? (
          <SettingsRow
            title={tr("Translate to English")}
            description={tr("Speak any language and get English text.")}
            control={
              <Switch
                aria-label={tr("Translate to English")}
                checked={settings.speechTranslateToEnglish}
                onCheckedChange={(checked) =>
                  void updateClientSettings({ speechTranslateToEnglish: checked })
                }
              />
            }
          />
        ) : null}
        {prepared ? (
          <SpeechModelBrowser
            key={prepared.environmentId}
            prepared={prepared}
            catalog={catalog}
            testEnvironmentId={
              project?.environmentId ?? target?.environmentId ?? prepared.environmentId
            }
            projectId={project?.id ?? null}
            projectName={project?.title ?? null}
          />
        ) : null}
        {prepared && <AdvancedSpeechSettings prepared={prepared} catalog={catalog} />}
      </SettingsSection>
      <SettingsSection id="voice-recognition" title={tr("Transcription options")}>
        <SettingsRow
          {...searchableSetting("speech-silence-filtering")}
          title={tr("Silence filtering")}
          description={
            destination.cloudProvider === "openai"
              ? tr("OpenAI handles silence automatically.")
              : tr("Skip silence and other non-speech audio before transcription, keeping a short buffer so words aren\u2019t cut off.")
          }
          control={
            <Switch
              aria-label={tr("Silence filtering")}
              disabled={destination.cloudProvider === "openai"}
              checked={settings.speechSilenceFiltering}
              onCheckedChange={(checked) =>
                void updateClientSettings({ speechSilenceFiltering: checked })
              }
            />
          }
        />
        <SettingsRow
          {...searchableSetting("remove-filler-words")}
          title={tr("Remove filler words")}
          description={tr("Remove filler words like \u201Cum\u201D and \u201Cuh\u201D from transcripts.")}
          control={
            <Switch
              aria-label={tr("Remove filler words")}
              checked={settings.speechRemoveFillerWords}
              onCheckedChange={(checked) =>
                void updateClientSettings({ speechRemoveFillerWords: checked })
              }
            />
          }
        />
        <SettingsRow
          {...searchableSetting("speech-dictionary")}
          title={tr("Dictionary")}
          description={tr("Names and terms transcription should spell your way, saved on this device. Add an alias when it keeps hearing a term wrong. The name of the project you dictate in is also sent as a hint.")}
          control={
            <span className="text-xs text-muted-foreground">
              {settings.speechCustomWords.length}{" "}
              {settings.speechCustomWords.length === 1 ? "entry" : "entries"}
            </span>
          }
        >
          <div className="mt-2 pb-3.5">
            <DictionaryEditor
              label="dictionary"
              words={settings.speechCustomWords}
              onChange={(words) => void updateClientSettings({ speechCustomWords: words })}
            />
          </div>
        </SettingsRow>
        <ProjectDictionaryRow />
      </SettingsSection>

      <SettingsSection id={searchableSetting("speech-post-processing").id} title={tr("Cleanup")}>
        <SettingsRow
          title={tr("Clean up transcripts with a provider")}
          description={tr("Sends the transcript and nearby draft text to the text generation provider on the draft\u2019s environment to fix punctuation, numbers, and spoken corrections. Sends text only; off by default.")}
          control={
            <Switch
              aria-label={tr("Clean up transcripts with a provider")}
              checked={cleanupEnabled}
              onCheckedChange={chooseTranscriptCleanup}
            />
          }
        />
        {cleanupEnabled ? (
          <SettingsRow
            title={tr("Cleanup instructions")}
            description={tr("Use the built-in instructions or write your own.")}
            control={
              <Select
                value={settings.speechPostProcessingPrompt.mode}
                onValueChange={(value) => {
                  if (value === "default" || value === "custom")
                    void updateClientSettings({
                      speechPostProcessingPrompt: {
                        ...settings.speechPostProcessingPrompt,
                        mode: value,
                      },
                    });
                }}
              >
                <SelectTrigger size="sm" aria-label={tr("Cleanup instructions")} className="max-w-64">
                  <SelectValue>
                    {settings.speechPostProcessingPrompt.mode === "custom" ? tr("Custom") : "Built-in"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="default">{tr("Built-in")}</SelectItem>
                  <SelectItem value="custom">{tr("Custom")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          >
            <Textarea
              aria-label={tr("Custom cleanup instructions")}
              className="mt-2"
              maxLength={10_000}
              disabled={settings.speechPostProcessingPrompt.mode !== "custom"}
              value={
                settings.speechPostProcessingPrompt.mode === "custom"
                  ? settings.speechPostProcessingPrompt.customInstructions
                  : DEFAULT_SPEECH_POST_PROCESSING_PROMPT
              }
              onChange={(event) =>
                void updateClientSettings({
                  speechPostProcessingPrompt: {
                    mode: "custom",
                    customInstructions: event.target.value,
                  },
                })
              }
            />
          </SettingsRow>
        ) : null}
        {cleanupEnabled && settingsScope !== null ? <CleanupModelRow /> : null}
        {cleanupEnabled ? (
          <SettingsRow
            {...searchableSetting("speech-correction-word")}
            title={tr("Correction cue")}
            description={tr("The word or phrase you say to flag a correction, like \u201Csorry\u201D or \u201Cscratch that\u201D. Cleanup applies the correction only where one is meant, and hears the cue as a hint.")}
            control={
              <Input
                key={settings.speechCorrectionWord}
                defaultValue={settings.speechCorrectionWord}
                maxLength={50}
                placeholder="sorry"
                aria-label={tr("Correction cue")}
                className="w-40"
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next !== settings.speechCorrectionWord)
                    void updateClientSettings({ speechCorrectionWord: next });
                }}
              />
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
