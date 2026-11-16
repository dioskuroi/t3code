// @effect-diagnostics nodeBuiltinImport:off - codemod 直读直写源文件，无 Effect 运行时需求。
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeProcess from "node:process";
import type * as TsTypes from "typescript-legacy";

// The workspace "typescript" is the @tsc-rs drop-in (no Compiler API); resolve real
// typescript through apps/marketing, which depends on it.
const require = NodeModule.createRequire(
  new URL("../apps/marketing/package.json", import.meta.url),
);
const ts = require("typescript") as typeof TsTypes;

/** ADR-0005 wrap route: rewrite user-visible English copy into `tr()` calls; text-spliced
 * rewrites keep untouched lines intact (minimal fork patch surface); idempotent. */

const TR_IMPORT = 'import { tr } from "@t3tools/shared/i18n";';

/** JSX attribute names whose string values are never user-visible copy. */
export const NON_COPY_ATTRS = new Set([
  "className",
  "class",
  "id",
  "key",
  "testID",
  "testId",
  "href",
  "src",
  "variant",
  "size",
  "type",
  "autoComplete",
  "role",
  "dir",
  "lang",
  "ref",
  "htmlFor",
  "method",
  "action",
  "target",
  "rel",
  "loading",
  "viewBox",
  "fill",
  "stroke",
  "d",
  "as",
  "mode",
  "align",
  "gap",
  "color",
]);

/** Object property names that always carry copy regardless of heuristics. */
const COPY_PROP_NAMES = new Set([
  "title",
  "description",
  "label",
  "detail",
  "message",
  "placeholder",
  "heading",
  "subtitle",
  "tooltip",
  "error",
  "text",
]);

export function decodeJsxEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

export function isLikelyEnglishCopy(s: string): boolean {
  if (!/[A-Za-z]/.test(s)) return false;
  if (s.trim().length < 3) return false;
  // Copy is sentence-cased in this codebase; lowercase-initial strings are logic values.
  if (/^[a-z]/.test(s.trim())) return false;
  // Control characters (NUL-joined composite keys etc.) never reach the UI.
  if (/[\u0000-\u001f]/.test(s)) return false;
  if (/^https?:|^\/|^\.{1,2}\//.test(s)) return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return false;
  // "$"-led placeholders and multi-cap no-space strings ("SettingsAuth") are identifiers.
  if (/^[$([{]/.test(s.trim())) return false;
  if (!s.includes(" ") && /[A-Z].*[A-Z]/.test(s)) return false;
  if (!s.includes(" ")) {
    if (/[-_.]/.test(s)) return false;
    if (s === s.toUpperCase() && s.length <= 6) return false;
  }
  return true;
}

/** String methods whose arguments are logic values (matching/parsing), not display copy. */
export const STRING_PROTOCOL_METHODS = new Set([
  "startsWith",
  "endsWith",
  "includes",
  "indexOf",
  "lastIndexOf",
  "split",
  "slice",
  "replace",
  "replaceAll",
  "match",
  "test",
  "concat",
]);

/** Logic positions a string literal can occupy: comparisons, text-protocol call args, case labels. */
export function isLogicPosition(node: TsTypes.Expression): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isBinaryExpression(parent)) {
    const kind = parent.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      kind === ts.SyntaxKind.EqualsEqualsToken ||
      kind === ts.SyntaxKind.ExclamationEqualsToken
    ) {
      return true;
    }
  }
  // A literal receiving member access ("copy".length, "copy".trim()) is logic, not display.
  if (ts.isPropertyAccessExpression(parent)) return true;
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const method = parent.expression.name.text;
    if (STRING_PROTOCOL_METHODS.has(method)) return true;
    // Navigation targets are route identifiers, never copy.
    if (method === "navigate" || method === "push" || method === "replace" || method === "jumpTo")
      return true;
  }
  if (ts.isCaseClause(parent)) return true;
  return false;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

interface Skipped {
  file: string;
  line: number;
  text: string;
  reason: string;
}

export interface FileResult {
  file: string;
  wrapped: number;
  replacements: Replacement[];
  skipped: Skipped[];
  needsImport: boolean;
  hasImport: boolean;
}

/**
 * `.ts` 按 TS、`.tsx` 按 TSX 解析。TSX 模式会把 `<E>(…)` 泛型箭头当 JSX 开标签，
 * 解析失败后该文件其余 AST 全丢（tr key 漏收、裸串漏检、误 wrap）——D1 review 实证。
 */
export function scriptKindFor(file: string): TsTypes.ScriptKind {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

export function collect(file: string, source: string): FileResult {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const result: FileResult = {
    file,
    wrapped: 0,
    replacements: [],
    skipped: [],
    needsImport: false,
    hasImport: false,
  };

  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const isInsideTrCall = (node: TsTypes.Node): boolean => {
    let p = node.parent;
    while (p) {
      if (ts.isCallExpression(p) && p.expression.getText(sf) === "tr") return true;
      p = p.parent;
    }
    return false;
  };

  const makeTrCall = (
    key: string,
    params?: Array<{ name: string; expr: TsTypes.Expression }>,
  ): string => {
    const keyLit = ts.factory.createStringLiteral(key);
    const args: TsTypes.Expression[] = [keyLit];
    if (params && params.length > 0) {
      const props = params.map((p) => ts.factory.createPropertyAssignment(p.name, p.expr));
      args.push(ts.factory.createObjectLiteralExpression(props));
    }
    const call = ts.factory.createCallExpression(
      ts.factory.createIdentifier("tr"),
      undefined,
      args,
    );
    return printer.printNode(ts.EmitHint.Expression, call, sf);
  };

  /** Convert a template literal into a tr() call with {name} placeholders. */
  const templateToTr = (node: TsTypes.TemplateExpression, file: string): string | null => {
    const parts: string[] = [];
    const params: Array<{ name: string; expr: TsTypes.Expression }> = [];
    parts.push(node.head.text);
    for (const span of node.templateSpans) {
      const exprText = span.expression.getText(sf).trim();
      if (ts.isIdentifier(span.expression)) {
        parts.push(`{${exprText}}`);
        params.push({ name: exprText, expr: span.expression });
      } else {
        result.skipped.push({
          file,
          line: lineOf(span.expression.getStart(sf)),
          text: exprText,
          reason: "complex interpolation (needs named param or manual wrap)",
        });
        return null;
      }
      parts.push(span.literal.text);
    }
    return makeTrCall(parts.join(""), params);
  };

  const wrapLiteral = (
    node: TsTypes.StringLiteral | TsTypes.NoSubstitutionTemplateLiteral,
  ): void => {
    if (isInsideTrCall(node)) return;
    const key = node.text;
    if (!isLikelyEnglishCopy(key)) return;
    result.replacements.push({
      start: node.getStart(sf),
      end: node.getEnd(),
      text: makeTrCall(key),
    });
    result.wrapped += 1;
    result.needsImport = true;
  };

  const visit = (node: TsTypes.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier.getText(sf).includes("@t3tools/shared/i18n"))
        result.hasImport = true;
    }

    if (ts.isJsxText(node)) {
      const raw = node.getText(sf);
      const inner = raw.trim();
      const leading = raw.slice(0, raw.length - raw.trimStart().length);
      const trailing = raw.slice(raw.trimEnd().length);
      if (inner.length > 0 && !inner.startsWith("{")) {
        const key = decodeJsxEntities(inner);
        if (/[A-Za-z]/.test(key)) {
          result.replacements.push({
            start: node.getStart(sf),
            end: node.getEnd(),
            text: `${leading}{${makeTrCall(key)}}${trailing}`,
          });
          result.wrapped += 1;
          result.needsImport = true;
        }
      }
      return;
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (NON_COPY_ATTRS.has(name)) return;
      const init = node.initializer;
      if (init && ts.isStringLiteral(init)) {
        const key = init.text;
        if (!isLikelyEnglishCopy(key)) {
          if (/[A-Za-z]/.test(key) && key.trim().length >= 3 && !NON_COPY_ATTRS.has(name)) {
            result.skipped.push({
              file,
              line: lineOf(init.getStart(sf)),
              text: key,
              reason: `attr "${name}" failed copy heuristic`,
            });
          }
          return;
        }
        result.replacements.push({
          start: init.getStart(sf),
          end: init.getEnd(),
          text: `{${makeTrCall(key)}}`,
        });
        result.wrapped += 1;
        result.needsImport = true;
        return;
      }
    }

    if (ts.isTemplateExpression(node)) {
      // Judge copy-ness by the text parts only, so `New ${x} copy` wraps but `${x}` alone does not.
      const textParts = node.head.text + node.templateSpans.map((s) => s.literal.text).join("");
      if (isLikelyEnglishCopy(textParts) && !isInsideTrCall(node)) {
        const replacement = templateToTr(node, file);
        if (replacement !== null) {
          result.replacements.push({
            start: node.getStart(sf),
            end: node.getEnd(),
            text: replacement,
          });
          result.wrapped += 1;
          result.needsImport = true;
          return;
        }
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const nameText = node.name.getText(sf).replaceAll(/["']/g, "");
      if (COPY_PROP_NAMES.has(nameText)) {
        if (
          ts.isStringLiteral(node.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(node.initializer)
        ) {
          wrapLiteral(node.initializer);
          return;
        }
      }
    }

    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !ts.isJsxAttribute(node.parent ?? node)
    ) {
      // Bare string in expression position: conditional branches, call args, returns.
      // Never rewrite module specifiers or `require()` ids.
      const parent = node.parent;
      if (
        parent &&
        (ts.isImportDeclaration(parent) ||
          ts.isExportDeclaration(parent) ||
          ts.isImportTypeNode(parent) ||
          (ts.isCallExpression(parent) && parent.expression.getText(sf) === "require"))
      ) {
        return;
      }
      if (isLogicPosition(node)) return;
      const inCopyProp =
        parent &&
        ts.isPropertyAssignment(parent) &&
        COPY_PROP_NAMES.has(parent.name.getText(sf).replaceAll(/["']/g, ""));
      const looksCopy = isLikelyEnglishCopy(node.text);
      if (inCopyProp || looksCopy) {
        wrapLiteral(node);
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  // The bare-literal branch above handles expression position; attribute
  // string values are handled by the JsxAttribute branch. Walk everything.
  visit(sf);

  // Deduplicate overlapping replacements (child + parent both matched).
  result.replacements.sort((a, b) => a.start - b.start);
  const deduped: Replacement[] = [];
  let lastEnd = -1;
  for (const r of result.replacements) {
    if (r.start >= lastEnd) {
      deduped.push(r);
      lastEnd = r.end;
    }
  }
  result.replacements = deduped;
  return result;
}

function apply(file: string, r: FileResult, source: string): string {
  let out = source;
  for (const rep of [...r.replacements].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, rep.start) + rep.text + out.slice(rep.end);
  }
  if (r.needsImport && !r.hasImport) {
    const sf = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    let insertAt = 0;
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st)) {
        insertAt = st.getEnd();
        break;
      }
    }
    out = out.slice(0, insertAt) + `\n${TR_IMPORT}` + out.slice(insertAt);
  }
  return out;
}

export function main(): void {
  const out = (s: string) => NodeProcess.stdout.write(`${s}\n`);
  const files = NodeProcess.argv.slice(2);
  if (files.length === 0) {
    NodeProcess.stderr.write("usage: node scripts/i18n-codemod.ts <file...>\n");
    NodeProcess.exit(1);
  }

  let totalWrapped = 0;
  const allSkipped: Skipped[] = [];
  for (const file of files) {
    const source = NodeFS.readFileSync(file, "utf8");
    const r = collect(file, source);
    if (r.wrapped > 0) {
      NodeFS.writeFileSync(file, apply(file, r, source));
    }
    totalWrapped += r.wrapped;
    allSkipped.push(...r.skipped);
    out(`${file}: wrapped ${r.wrapped}`);
  }
  out(`\ntotal wrapped: ${totalWrapped}`);
  if (allSkipped.length > 0) {
    out(`\nskipped (needs review):`);
    for (const s of allSkipped)
      out(`  ${s.file}:${s.line}  ${JSON.stringify(s.text).slice(0, 90)}  [${s.reason}]`);
  }
}

if (
  NodeProcess.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${NodeProcess.argv[1]}`).href
) {
  main();
}
