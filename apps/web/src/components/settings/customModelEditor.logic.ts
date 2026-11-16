import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { tr } from "@t3tools/shared/i18n";
import { type CustomModelDefinition, createModelCapabilities } from "@t3tools/shared/model";

export interface EditorChoice {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly description?: string;
}

export interface EditorDescriptor {
  readonly key: string;
  readonly type: "select" | "boolean";
  readonly id: string;
  readonly label: string;
  readonly choices: ReadonlyArray<EditorChoice>;
  readonly currentBooleanValue?: boolean | undefined;
  readonly description?: string | undefined;
}

export interface CustomModelDraft {
  readonly slug: string;
  readonly name: string;
  readonly descriptors: ReadonlyArray<EditorDescriptor>;
}

export interface DescriptorPreset {
  readonly id: string;
  readonly label: string;
  readonly type: "select" | "boolean";
  readonly choices?: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>;
}

const EFFORT_CHOICES = [
  { id: "low", label: tr("Low") },
  { id: "medium", label: tr("Medium"), isDefault: true },
  { id: "high", label: tr("High") },
  { id: "xhigh", label: tr("Extra High") },
] as const;

export const DESCRIPTOR_PRESETS_BY_KIND: Partial<
  Record<ProviderDriverKind, ReadonlyArray<DescriptorPreset>>
> = {
  [ProviderDriverKind.make("codex")]: [
    { id: "reasoningEffort", label: tr("Reasoning"), type: "select", choices: EFFORT_CHOICES },
    {
      id: "serviceTier",
      label: tr("Speed"),
      type: "select",
      choices: [
        { id: "default", label: tr("Standard"), isDefault: true },
        { id: "fast", label: tr("Fast") },
      ],
    },
  ],
  [ProviderDriverKind.make("claudeAgent")]: [
    {
      id: "effort",
      label: tr("Reasoning"),
      type: "select",
      choices: [
        { id: "low", label: tr("Low") },
        { id: "medium", label: tr("Medium") },
        { id: "high", label: tr("High"), isDefault: true },
        { id: "xhigh", label: tr("Extra High") },
        { id: "max", label: tr("Max") },
      ],
    },
    { id: "fastMode", label: tr("Fast Mode"), type: "boolean" },
    { id: "thinking", label: tr("Thinking"), type: "boolean" },
  ],
  [ProviderDriverKind.make("cursor")]: [
    { id: "reasoning", label: tr("Reasoning"), type: "select", choices: EFFORT_CHOICES },
    { id: "fastMode", label: tr("Fast Mode"), type: "boolean" },
    { id: "thinking", label: tr("Thinking"), type: "boolean" },
  ],
  [ProviderDriverKind.make("grok")]: [
    { id: "reasoningEffort", label: tr("Reasoning"), type: "select", choices: EFFORT_CHOICES },
  ],
  [ProviderDriverKind.make("pi")]: [
    {
      id: "thinking",
      label: tr("Thinking"),
      type: "select",
      choices: [
        { id: "off", label: tr("Off") },
        { id: "minimal", label: tr("Minimal") },
        { id: "low", label: tr("Low") },
        { id: "medium", label: tr("Medium"), isDefault: true },
        { id: "high", label: tr("High") },
        { id: "xhigh", label: tr("Extra High") },
        { id: "max", label: tr("Max") },
      ],
    },
  ],
  [ProviderDriverKind.make("opencode")]: [
    { id: "variant", label: tr("Reasoning"), type: "select", choices: EFFORT_CHOICES },
    {
      id: "agent",
      label: tr("Agent"),
      type: "select",
      choices: [
        { id: "build", label: tr("Build"), isDefault: true },
        { id: "plan", label: tr("Plan") },
      ],
    },
  ],
};

let nextKey = 0;
function newEditorKey(): string {
  nextKey += 1;
  return `k${nextKey}`;
}

export function choiceFromPreset(choice: {
  id: string;
  label: string;
  isDefault?: boolean;
}): EditorChoice {
  return { key: newEditorKey(), id: choice.id, label: choice.label, isDefault: !!choice.isDefault };
}

export function descriptorFromPreset(preset: DescriptorPreset): EditorDescriptor {
  return {
    key: newEditorKey(),
    type: preset.type,
    id: preset.id,
    label: preset.label,
    choices: (preset.choices ?? []).map(choiceFromPreset),
  };
}

export function emptyEditorDescriptor(): EditorDescriptor {
  return { key: newEditorKey(), type: "select", id: "", label: "", choices: [] };
}

export function emptyEditorChoice(): EditorChoice {
  return { key: newEditorKey(), id: "", label: "", isDefault: false };
}

/** Custom entries lack runtime profiles for prompt-injected choices, so do not store them as ordinary
 * options. */
function descriptorToEditor(descriptor: ProviderOptionDescriptor): EditorDescriptor {
  const promptInjected = new Set(
    descriptor.type === "select" ? (descriptor.promptInjectedValues ?? []) : [],
  );
  const choices =
    descriptor.type === "select"
      ? descriptor.options.filter((option) => !promptInjected.has(option.id))
      : [];
  const defaultChoice =
    choices.find((option) => option.id === descriptor.currentValue) ??
    choices.find((option) => option.isDefault);
  return {
    key: newEditorKey(),
    type: descriptor.type,
    id: descriptor.id,
    label: descriptor.label,
    ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
    ...(descriptor.type === "boolean" && descriptor.currentValue !== undefined
      ? { currentBooleanValue: descriptor.currentValue }
      : {}),
    choices: choices.map((option) => ({
      key: newEditorKey(),
      id: option.id,
      label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}),
      isDefault: option === defaultChoice,
    })),
  };
}

export function draftFromDefinition(entry: CustomModelDefinition): CustomModelDraft {
  return {
    slug: entry.slug,
    name: entry.name === entry.slug ? "" : entry.name,
    descriptors: (entry.capabilities?.optionDescriptors ?? []).map(descriptorToEditor),
  };
}

/** Claude context choices require runtime suffix mappings that custom entries do not carry. */
export function descriptorsFromCapabilities(
  capabilities: ModelCapabilities | null | undefined,
  driverKind: ProviderDriverKind | null,
): EditorDescriptor[] {
  return (capabilities?.optionDescriptors ?? [])
    .filter((descriptor) => driverKind !== "claudeAgent" || descriptor.id !== "contextWindow")
    .map(descriptorToEditor);
}

export function validateDraft(draft: CustomModelDraft): string | null {
  const seenIds = new Set<string>();
  for (const [index, descriptor] of draft.descriptors.entries()) {
    const position = tr("Option {index}", { index: index + 1 });
    const id = descriptor.id.trim();
    if (!id) return tr("{position} needs an id.", { position: position });
    if (seenIds.has(id))
      return tr('{position}: id "{id}" is used twice.', { position: position, id: id });
    seenIds.add(id);
    if (!descriptor.label.trim()) return tr("{position} needs a label.", { position: position });
    if (descriptor.type !== "select") continue;
    if (descriptor.choices.length === 0)
      return tr("{position} needs at least one choice.", { position: position });
    const seenChoices = new Set<string>();
    for (const choice of descriptor.choices) {
      const choiceId = choice.id.trim();
      if (!choiceId) return tr("{position} has a choice without a value.", { position: position });
      if (seenChoices.has(choiceId)) {
        return tr('{position}: choice "{choiceId}" is used twice.', {
          position: position,
          choiceId: choiceId,
        });
      }
      seenChoices.add(choiceId);
    }
  }
  return null;
}

export function definitionFromDraft(draft: CustomModelDraft): CustomModelDefinition {
  const descriptors: ProviderOptionDescriptor[] = draft.descriptors.map((descriptor) => {
    const id = descriptor.id.trim();
    const label = descriptor.label.trim();
    if (descriptor.type === "boolean") {
      return {
        id,
        label,
        type: "boolean",
        ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
        ...(descriptor.currentBooleanValue !== undefined
          ? { currentValue: descriptor.currentBooleanValue }
          : {}),
      };
    }
    const options = descriptor.choices.map((choice) => ({
      id: choice.id.trim(),
      label: choice.label.trim() || choice.id.trim(),
      ...(choice.description !== undefined ? { description: choice.description } : {}),
      ...(choice.isDefault ? { isDefault: true } : {}),
    }));
    const currentValue = options.find((option) => option.isDefault)?.id;
    return {
      id,
      label,
      type: "select",
      ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
      options,
      ...(currentValue ? { currentValue } : {}),
    };
  });
  const name = draft.name.trim();
  return {
    slug: draft.slug,
    name: name || draft.slug,
    capabilities:
      descriptors.length > 0 ? createModelCapabilities({ optionDescriptors: descriptors }) : null,
  };
}
