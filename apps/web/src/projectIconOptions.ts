import { lucideIconNames } from "./lib/lucideIconByName";
import { tr } from "@t3tools/shared/i18n";
export { PROJECT_ICON_COLORS, projectIconColorClassName } from "./projectIconColors";

const POPULAR_PROJECT_ICONS: ReadonlyArray<string> = [
  "folder-code",
  "code-2",
  "terminal",
  "globe-2",
  "server",
  "database",
  "bot",
  "sparkles",
  "smartphone",
  "monitor",
  "cloud-cog",
  "package",
  "book-open",
  "flask-conical",
  "shield-check",
  "rocket",
  "gamepad-2",
  "music",
  "image",
  "shopping-bag",
  "git-branch",
  "workflow",
  "wrench",
  "layers-3",
];

export const PROJECT_EMOJIS: ReadonlyArray<{ readonly emoji: string; readonly label: string }> = [
  { emoji: "💻", label: tr("Computer") },
  { emoji: "🛠️", label: tr("Tools") },
  { emoji: "🚀", label: tr("Rocket") },
  { emoji: "🤖", label: tr("Robot") },
  { emoji: "✨", label: tr("Sparkles") },
  { emoji: "⚡", label: tr("Lightning") },
  { emoji: "🌐", label: tr("Web") },
  { emoji: "📱", label: tr("Mobile") },
  { emoji: "🖥️", label: tr("Desktop") },
  { emoji: "⌨️", label: tr("Keyboard") },
  { emoji: "⚙️", label: tr("Gear") },
  { emoji: "🗄️", label: tr("Database") },
  { emoji: "☁️", label: tr("Cloud") },
  { emoji: "📦", label: tr("Package") },
  { emoji: "📚", label: tr("Books") },
  { emoji: "🧪", label: tr("Test tube") },
  { emoji: "🔒", label: tr("Lock") },
  { emoji: "🎮", label: tr("Game") },
  { emoji: "🎵", label: tr("Music") },
  { emoji: "🎬", label: tr("Movie") },
  { emoji: "🖼️", label: tr("Picture") },
  { emoji: "🛍️", label: tr("Shopping") },
  { emoji: "🔥", label: tr("Fire") },
  { emoji: "💡", label: tr("Idea") },
  { emoji: "🧩", label: tr("Puzzle") },
  { emoji: "📊", label: tr("Chart") },
  { emoji: "🧠", label: tr("Brain") },
  { emoji: "🦄", label: tr("Unicorn") },
  { emoji: "🐙", label: tr("Octopus") },
  { emoji: "🌱", label: tr("Seedling") },
];

export function filterProjectIconNames(query: string): ReadonlyArray<string> {
  const normalized = query.trim().toLowerCase().replaceAll(/\s+/g, "-");
  if (!normalized) return POPULAR_PROJECT_ICONS;
  return lucideIconNames.filter((name) => name.includes(normalized)).slice(0, 60);
}

export function firstEmoji(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  const segment = segments[Symbol.iterator]().next().value?.segment;
  const isFlag = /^\p{Regional_Indicator}{2}$/u.test(segment ?? "");
  const isKeycap = /^[#*0-9]\uFE0F?\u20E3$/u.test(segment ?? "");
  if (!segment || (!/\p{Extended_Pictographic}/u.test(segment) && !isFlag && !isKeycap)) {
    return null;
  }
  return segment;
}
