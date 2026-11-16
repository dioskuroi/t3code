import { tr } from "@t3tools/shared/i18n";
export const CODE_BLOCK_LANGUAGES = [
  { id: "", label: tr("Plain text") },
  { id: "asm", label: tr("Assembly") },
  { id: "bash", label: tr("Bash") },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "csharp", label: "C#" },
  { id: "css", label: "CSS" },
  { id: "dart", label: tr("Dart") },
  { id: "diff", label: tr("Diff") },
  { id: "dockerfile", label: tr("Dockerfile") },
  { id: "elixir", label: tr("Elixir") },
  { id: "go", label: "Go" },
  { id: "graphql", label: "GraphQL" },
  { id: "haskell", label: tr("Haskell") },
  { id: "html", label: "HTML" },
  { id: "java", label: tr("Java") },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "jsx", label: "JSX" },
  { id: "kotlin", label: tr("Kotlin") },
  { id: "lua", label: tr("Lua") },
  { id: "markdown", label: tr("Markdown") },
  { id: "php", label: "PHP" },
  { id: "powershell", label: "PowerShell" },
  { id: "python", label: tr("Python") },
  { id: "r", label: "R" },
  { id: "ruby", label: tr("Ruby") },
  { id: "rust", label: tr("Rust") },
  { id: "scala", label: tr("Scala") },
  { id: "scss", label: "SCSS" },
  { id: "sql", label: "SQL" },
  { id: "svelte", label: tr("Svelte") },
  { id: "swift", label: tr("Swift") },
  { id: "toml", label: "TOML" },
  { id: "tsx", label: "TSX" },
  { id: "typescript", label: "TypeScript" },
  { id: "vue", label: tr("Vue") },
  { id: "xml", label: "XML" },
  { id: "yaml", label: "YAML" },
  { id: "zig", label: tr("Zig") },
] as const;

export type CodeBlockLanguage = { readonly id: string; readonly label: string };

const LANGUAGE_ALIASES: Record<string, string> = {
  assembly: "asm",
  cs: "csharp",
  "c++": "cpp",
  js: "javascript",
  md: "markdown",
  plaintext: "",
  py: "python",
  rb: "ruby",
  rs: "rust",
  s: "asm",
  sh: "bash",
  shell: "bash",
  text: "",
  ts: "typescript",
  txt: "",
  yml: "yaml",
};

export function languageOfInfoString(info: string): string {
  return info.trim().split(/\s+/, 1)[0] ?? "";
}

/** Plain text clears the language unless trailing metadata would be parsed as one. */
export function withInfoStringLanguage(info: string, language: string): string {
  const leading = /^\s*/.exec(info)![0];
  const rest = info.slice(leading.length + languageOfInfoString(info).length);
  if (language) return `${leading}${language}${rest}`;
  return rest.trim() ? `${leading}text${rest}` : "";
}

export function codeLanguageEntry(language: string): CodeBlockLanguage | null {
  const id = LANGUAGE_ALIASES[language.toLowerCase()] ?? language;
  return CODE_BLOCK_LANGUAGES.find((entry) => entry.id === id.toLowerCase()) ?? null;
}

export function codeLanguageLabel(language: string): string {
  return codeLanguageEntry(language)?.label ?? language;
}
