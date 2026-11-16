import zh from "./i18n.zh.json" with { type: "json" };

export type TrParams = Record<string, string | number>;

// `?? {}`: belt-and-suspenders for bundler interop; a missing dictionary falls
// back to English keys instead of throwing at render time.
const dictionary: Record<string, string> = zh ?? {};

/**
 * Compile-time localization lookup: keys are the original English source strings,
 * the value is the Simplified Chinese rendering. Unknown keys fall back to the
 * key itself, so untranslated copy renders as English until the dictionary catches up.
 */
export function tr(key: string, params?: TrParams): string {
  let out = dictionary[key];
  if (out === undefined) return key;
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      out = out.split(`{${name}}`).join(String(value));
    }
  }
  return out;
}

// 服务端给未命名会话线填的默认标题是数据面英文串（存储与检索都按原文，见下方判等），
// 只有展示层经此处本地化；重命名等写路径不走这里。
export function threadDisplayTitle(title: string | null | undefined): string {
  return title === "New thread" ? tr("New thread") : (title ?? "");
}
