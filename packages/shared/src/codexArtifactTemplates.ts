import { tr } from "@t3tools/shared/i18n";
const CODEX_ARTIFACT_TEMPLATE_KINDS = [
  "document",
  "presentation",
  "spreadsheet",
  "site",
  "google-docs",
  "google-slides",
  "google-sheets",
  "image",
  "email",
  "slack",
] as const;

export type CodexArtifactTemplateKind = (typeof CODEX_ARTIFACT_TEMPLATE_KINDS)[number];

const CODEX_ARTIFACT_TEMPLATE_GALLERY_KINDS = ["imagegen", "product-design"] as const;

export type CodexArtifactTemplateGalleryKind =
  (typeof CODEX_ARTIFACT_TEMPLATE_GALLERY_KINDS)[number];

export interface CodexArtifactTemplate {
  readonly artifactKind: CodexArtifactTemplateKind;
  readonly displayName: string;
  readonly galleryKind?: CodexArtifactTemplateGalleryKind;
  readonly skillDirectory: string;
  readonly skillName: string;
}

const CODEX_ARTIFACT_TEMPLATE_LABEL_BY_KIND = {
  document: tr("Document template"),
  presentation: tr("Presentation template"),
  spreadsheet: tr("Spreadsheet template"),
  site: tr("Site template"),
  "google-docs": tr("Google Doc template"),
  "google-slides": tr("Google Slides template"),
  "google-sheets": tr("Google Sheet template"),
  image: tr("Image template"),
  email: tr("Email template"),
  slack: tr("Slack template"),
} satisfies Record<CodexArtifactTemplateKind, string>;

export type CodexArtifactTemplateAttributes = Readonly<Record<string, string | null | undefined>>;

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_REGEX = /^(?:\\\\[^\\]+\\[^\\]+|\/\/[^/]+\/[^/]+)/;

function isCodexArtifactTemplateKind(value: unknown): value is CodexArtifactTemplateKind {
  return CODEX_ARTIFACT_TEMPLATE_KINDS.some((kind) => kind === value);
}

function isCodexArtifactTemplateGalleryKind(
  value: unknown,
): value is CodexArtifactTemplateGalleryKind {
  return CODEX_ARTIFACT_TEMPLATE_GALLERY_KINDS.some((kind) => kind === value);
}

function isAbsoluteSkillDirectory(value: string): boolean {
  return (
    (value.startsWith("/") && !value.startsWith("//")) ||
    WINDOWS_DRIVE_PATH_REGEX.test(value) ||
    WINDOWS_UNC_PATH_REGEX.test(value)
  );
}

export function resolveCodexArtifactTemplate(
  attributes: CodexArtifactTemplateAttributes | null | undefined,
): CodexArtifactTemplate | null {
  const artifactKind = attributes?.artifact_kind;
  const displayNameValue = attributes?.display_name;
  const displayName = typeof displayNameValue === "string" ? displayNameValue.trim() : undefined;
  const galleryKind = attributes?.gallery_kind;
  const skillDirectory = attributes?.skill_directory;
  const skillName = attributes?.skill_name;

  if (
    !isCodexArtifactTemplateKind(artifactKind) ||
    !displayName ||
    typeof skillDirectory !== "string" ||
    !isAbsoluteSkillDirectory(skillDirectory) ||
    typeof skillName !== "string" ||
    !skillName.startsWith("artifact-template-") ||
    (galleryKind !== undefined && !isCodexArtifactTemplateGalleryKind(galleryKind))
  ) {
    return null;
  }

  return {
    artifactKind,
    displayName,
    ...(galleryKind === undefined ? {} : { galleryKind }),
    skillDirectory,
    skillName,
  };
}

const USE_PROMPT_BY_KIND: Record<CodexArtifactTemplateKind, (skill: string) => string> = {
  document: (skill) => tr("Create a document using this {skill} about\u2026", { skill: skill }),
  presentation: (skill) =>
    tr("Create a presentation using the {skill} template about\u2026", { skill: skill }),
  spreadsheet: (skill) =>
    tr("Create a spreadsheet using this {skill} about\u2026", { skill: skill }),
  site: (skill) => tr("Create a Site using this {skill} about\u2026", { skill: skill }),
  "google-docs": (skill) =>
    tr("Create a Google Doc using this {skill} about\u2026", { skill: skill }),
  "google-slides": (skill) =>
    tr("Create a Google Slides presentation using this {skill} about\u2026", { skill: skill }),
  "google-sheets": (skill) =>
    tr("Create a Google Sheet using this {skill} about\u2026", { skill: skill }),
  image: (skill) => tr("Create an image using this {skill} of\u2026", { skill: skill }),
  email: (skill) => tr("Draft an email using this {skill} about\u2026", { skill: skill }),
  slack: (skill) => tr("Draft a Slack message using this {skill} about\u2026", { skill: skill }),
};

export function codexArtifactTemplateUsePrompt(template: CodexArtifactTemplate): string {
  return USE_PROMPT_BY_KIND[template.artifactKind](`$${template.skillName}`);
}

export function codexArtifactTemplatePresentationLabel(kind: CodexArtifactTemplateKind): string {
  return CODEX_ARTIFACT_TEMPLATE_LABEL_BY_KIND[kind];
}

export function appendCodexArtifactTemplateUsePrompt(
  draft: string,
  template: CodexArtifactTemplate,
): string {
  const prompt = codexArtifactTemplateUsePrompt(template);
  const trimmedDraft = draft.trimEnd();
  const promptStart = trimmedDraft.length - prompt.length;
  const alreadyEndsWithPrompt =
    promptStart >= 0 &&
    trimmedDraft.slice(promptStart) === prompt &&
    (promptStart === 0 || /\s/.test(trimmedDraft[promptStart - 1] ?? ""));

  if (alreadyEndsWithPrompt) {
    return draft;
  }

  const needsLeadingSpace = draft.length > 0 && !/\s$/.test(draft);
  return `${draft}${needsLeadingSpace ? " " : ""}${prompt}`;
}
