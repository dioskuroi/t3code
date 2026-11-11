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
