import { expect } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";

import {
  __collectTrKeysForTest,
  globToRegExp,
  placeholderMismatches,
  routePath,
  survivesWordWhitelist,
  translationContentIssues,
} from "./i18n-check.ts";

describe("globToRegExp", () => {
  it("expands brace alternates", () => {
    const re = globToRegExp("**/*.test.{ts,tsx}");
    expect(re.test("apps/web/src/x.test.ts")).toBe(true);
    expect(re.test("x.test.tsx")).toBe(true);
    expect(re.test("x.test.js")).toBe(false);
  });

  it("matches directories at any depth, including zero", () => {
    const re = globToRegExp("**/testkit/**");
    expect(re.test("testkit/handler.ts")).toBe(true);
    expect(re.test("apps/web/src/testkit/handler.ts")).toBe(true);
    expect(re.test("apps/testkit.ts")).toBe(false);
  });

  it("escapes dots and keeps single * within one segment", () => {
    const re = globToRegExp("apps/*/vite.config.ts");
    expect(re.test("apps/web/vite.config.ts")).toBe(true);
    expect(re.test("apps/web/ui/vite.config.ts")).toBe(false);
    expect(re.test("apps/web/vite.configxts")).toBe(false);
  });
});

describe(".ts 泛型箭头不再因 TSX 解析丢 AST", () => {
  it("collects tr() keys after <E>(…) in .ts files", () => {
    const src = [
      'import { tr } from "@t3tools/shared/i18n";',
      "export const identity = <E>(x: E) => x;",
      'const a = tr("Actual Size");',
      "export const runMenuEffect = <E extends unknown>(fn: () => E) => fn();",
      'const b = tr("Zoom In");',
    ].join("\n");
    expect(__collectTrKeysForTest("apps/desktop/src/app/menu.ts", src)).toEqual([
      "Actual Size",
      "Zoom In",
    ]);
  });

  it("still parses .tsx as TSX", () => {
    const src = 'export const el = () => <div label={tr("Open")}>Body</div>;';
    expect(__collectTrKeysForTest("apps/web/src/x.tsx", src)).toEqual(["Open"]);
  });
});

describe("placeholderMismatches", () => {
  it("matching placeholders pass regardless of word order", () => {
    expect(placeholderMismatches("{count} items loaded", "已加载 {count} 项")).toEqual([]);
    // 风格指南 §6：必要时调整词序而非删占位符。
    expect(placeholderMismatches("{a} sent to {b}", "已发送至 {b}（{a}）")).toEqual([]);
  });

  it("missing and extra placeholders are reported separately", () => {
    expect(placeholderMismatches("{count} items", "已加载 N 项")).toEqual(["缺少 {count}"]);
    expect(placeholderMismatches("Loading", "正在加载 {count}")).toEqual(["多出 {count}"]);
  });

  it("treats each placeholder as a whole {name} token", () => {
    expect(placeholderMismatches("{count}/{total}", "{total}/{count}")).toEqual([]);
    expect(placeholderMismatches("{count}/{total}", "{count}")).toEqual(["缺少 {total}"]);
  });
});

describe("translationContentIssues", () => {
  it("flags single and double em dash", () => {
    expect(translationContentIssues("这是说明——更多")).toEqual(["破折号 U+2014"]);
    expect(translationContentIssues("这是 — 说明")).toEqual(["破折号 U+2014"]);
  });

  it("flags en dash and horizontal bar as dash family", () => {
    expect(translationContentIssues("3–5 分钟")).toEqual(["破折号 U+2013"]);
    expect(translationContentIssues("说明―补充")).toEqual(["破折号 U+2015"]);
  });

  it("whitelist English words pass", () => {
    expect(translationContentIssues("Provider 已连接")).toEqual([]);
    expect(translationContentIssues("已用 25,000 个 token")).toEqual([]);
    expect(translationContentIssues("按 Shift+Tab 切换")).toEqual([]);
    expect(translationContentIssues("Agent")).toEqual([]);
  });

  it("non-whitelist English mixing into translation is flagged", () => {
    expect(translationContentIssues("正在 Loading 文件")).toEqual(["白名单外英文混入"]);
    expect(translationContentIssues("Loading files")).toEqual(["白名单外英文混入"]);
  });

  it("placeholder names, HTML entities and URLs are not English copy", () => {
    expect(translationContentIssues("{error} · 重试")).toEqual([]);
    expect(translationContentIssues("&middot; 已复制")).toEqual([]);
    expect(translationContentIssues("访问 https://t3code.dev/docs 查看文档")).toEqual([]);
  });
});

describe("survivesWordWhitelist", () => {
  it("brand-only strings are fully deducted", () => {
    expect(survivesWordWhitelist("VS Code")).toBe(false);
    expect(survivesWordWhitelist("GitHub · MCP")).toBe(false);
  });

  it("mixed copy survives after deduction", () => {
    expect(survivesWordWhitelist("Open VS Code")).toBe(true);
    expect(survivesWordWhitelist("Sign in with GitHub")).toBe(true);
    // "code" alone is an ordinary word, not the brand phrase "vs code".
    expect(survivesWordWhitelist("Copy code")).toBe(true);
  });

  it("digit-glued units are deductible, embedded letters are not", () => {
    // `0ms` is one \w+ word, so \b boundaries never see the unit; letter-lookaround does.
    expect(survivesWordWhitelist("0ms")).toBe(false);
    expect(survivesWordWhitelist("10 KB")).toBe(false);
    // "Items" contains "ms" with letters adjacent, so it survives deduction.
    expect(survivesWordWhitelist("Items")).toBe(true);
  });
});

describe("routePath", () => {
  it("maps nested settings routes", () => {
    assert.strictEqual(routePath("_chat.settings.about.tsx"), "/chat/settings/about");
  });

  it("root layout maps to /", () => {
    assert.strictEqual(routePath("__root.tsx"), "/");
  });

  it("index routes collapse to the parent path", () => {
    assert.strictEqual(routePath("_chat.index.tsx"), "/chat");
  });

  it("params become :name segments", () => {
    assert.strictEqual(
      routePath("_chat.$environmentId.$threadId.tsx"),
      "/chat/:environmentId/:threadId",
    );
  });

  it("plain routes keep their segment", () => {
    assert.strictEqual(routePath("pair.tsx"), "/pair");
  });
});
