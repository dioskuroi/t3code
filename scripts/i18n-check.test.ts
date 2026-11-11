import { expect } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";

import { globToRegExp, routePath, survivesWordWhitelist } from "./i18n-check.ts";

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
