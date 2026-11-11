// @effect-diagnostics nodeBuiltinImport:off - 静态检查工具直读文件系统，无 Effect 运行时需求。
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import type * as TsTypes from "typescript-legacy";
import {
  NON_COPY_ATTRS,
  decodeJsxEntities,
  isLikelyEnglishCopy,
  isLogicPosition,
  scriptKindFor,
} from "./i18n-codemod.ts";

// The workspace "typescript" resolves to the @tsc-rs drop-in; resolve the real one (see i18n-codemod.ts).
const require = NodeModule.createRequire(
  new NodeURL.URL("../apps/marketing/package.json", import.meta.url),
);
const ts = require("typescript") as typeof TsTypes;

const REPO_ROOT = NodeURL.fileURLToPath(new NodeURL.URL("..", import.meta.url));

/**
 * i18n 静态检查与验收（ADR-0005 / map #50）：三面检查（tr-字典双向 diff、裸串残留、
 * 动态 key）、白名单豁免、走查清单与 --json 增量基线；文案启发式共享自 i18n-codemod。
 * 用法：node scripts/i18n-check.ts [<file...> | walkthrough] [--json]，任何面非零 exit 1。
 */

/** 汉化范围（GLOSSARY「全量汉化」）：三端渲染层 + 双端共享 UI 文案包 */
const SCAN_ROOTS = [
  "apps/web/src",
  "apps/mobile/src",
  "apps/desktop/src",
  "packages/shared/src",
  "packages/contracts/src",
];

const DICTIONARY_PATH = "packages/shared/src/i18n.zh.json";

const print = (line: string): void => {
  NodeProcess.stdout.write(`${line}\n`);
};

const printError = (line: string): void => {
  NodeProcess.stderr.write(`${line}\n`);
};

/** 白名单：「不翻」声明，与字典的「翻成什么」解耦（#47 决议） */
interface Whitelist {
  /** 整串精确豁免 */
  exact: string[];
  /** 子串包含即豁免（无词边界，谨慎添加） */
  contains: string[];
  /** 文件路径 glob 豁免（测试代码、生成物等；`**`、`*`、`?`、`{a,b}`） */
  globs: string[];
  /** 词边界扣除豁免：品牌/技术词（术语表 §3 派生），扣除后整串无英文词则豁免 */
  words: string[];
}

function loadWhitelist(): Whitelist {
  const raw = JSON.parse(
    NodeFS.readFileSync(new NodeURL.URL("./whitelist.json", import.meta.url), "utf8"),
  );
  return {
    exact: raw.exact ?? [],
    contains: raw.contains ?? [],
    globs: raw.globs ?? [],
    words: raw.words ?? [],
  };
}

const whitelist = loadWhitelist();

/** glob → RegExp（`**`、`*`、`?`、`{a,b}` 交替；不引第三方依赖，减小 fork 补丁面） */
export function globToRegExp(pattern: string): RegExp {
  const compile = (p: string): string => {
    let re = "";
    for (let i = 0; i < p.length; i++) {
      const ch = p.charAt(i);
      if (ch === "{") {
        let depth = 0;
        let end = -1;
        for (let j = i; j < p.length; j++) {
          if (p.charAt(j) === "{") depth++;
          else if (p.charAt(j) === "}") {
            depth--;
            if (depth === 0) {
              end = j;
              break;
            }
          }
        }
        if (end === -1) {
          re += "\\{";
          continue;
        }
        const body = p.slice(i + 1, end);
        const parts: string[] = [];
        let nested = 0;
        let current = "";
        for (const c of body) {
          if (c === "{") nested++;
          if (c === "}") nested--;
          if (c === "," && nested === 0) {
            parts.push(current);
            current = "";
          } else {
            current += c;
          }
        }
        parts.push(current);
        re += `(?:${parts.map(compile).join("|")})`;
        i = end;
      } else if (ch === "*") {
        if (p.charAt(i + 1) === "*") {
          // `**/` 可匹配零层目录；裸 `**` 匹配任意
          if (p.charAt(i + 2) === "/") {
            re += "(?:.*/)?";
            i += 2;
          } else {
            re += ".*";
            i += 1;
          }
        } else {
          re += "[^/]*";
        }
      } else if (ch === "?") {
        re += "[^/]";
      } else {
        re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
    }
    return re;
  };
  return new RegExp(`^${compile(pattern)}$`);
}

const globRegexps = whitelist.globs.map(globToRegExp);

function isWhitelistedFile(file: string): boolean {
  return globRegexps.some((g) => g.test(file));
}

/**
 * 词级扣除后仍有英文词 → 串不豁免。
 * 边界用字母 lookaround 而非 `\b`：数字与字母同属 \w，`\bms\b` 扣不掉 "0ms"；
 * 单位与数字粘连（0ms/10KB）是常态，而 "items" 里的 ms（字母相邻）不扣。
 */
export function survivesWordWhitelist(text: string): boolean {
  let rest = text;
  for (const w of [...whitelist.words].sort((a, b) => b.length - a.length)) {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rest = rest.replace(new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, "gi"), " ");
  }
  return /[A-Za-z]{2,}/.test(rest);
}

/**
 * 占位符集合（tr() 的 {name} 插值，见 packages/shared/src/i18n.ts）。
 * 模板串插值经 codemod 统一改写为 {name}；UI 文案不存在裸花括号字面量。
 */
export function placeholderSet(text: string): Set<string> {
  return new Set([...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!));
}

/**
 * 占位符 parity（风格指南 §6：{0}/{1} 原位保留、不增删，必要时调词序）。
 * 词序可调 → 比较集合而非序列。返回失配描述，空数组 = 通过。
 */
export function placeholderMismatches(key: string, value: string): string[] {
  const expected = placeholderSet(key);
  const actual = placeholderSet(value);
  return [
    ...[...expected]
      .filter((p) => !actual.has(p))
      .sort()
      .map((p) => `缺少 {${p}}`),
    ...[...actual]
      .filter((p) => !expected.has(p))
      .sort()
      .map((p) => `多出 {${p}}`),
  ];
}

/** 破折号家族（风格指南 §2：中文 UI 文案一律不用；「——」同为 U+2014 序列） */
const DASHES = /[\u2013\u2014\u2015]/;

/**
 * 译文内容检查：① 禁破折号 ② 白名单词之外的英文混入信号（术语表 §3 派生词表，
 * 与裸串面共用 survivesWordWhitelist）。占位符名、HTML 实体、URL 不是文案，
 * 先扣除再判词。返回违规描述，空数组 = 通过。
 */
export function translationContentIssues(value: string): string[] {
  const issues: string[] = [];
  const dash = DASHES.exec(value);
  if (dash) issues.push(`破折号 U+${dash[0]!.codePointAt(0)!.toString(16).toUpperCase()}`);
  const stripped = value
    .replace(/\{[^{}]+\}/g, " ")
    .replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  // contains 豁免（与裸串面 isWhitelisted 同语义）：命中子串先整体扣除再判词，
  // 使示例路径等「不译片段」在字典内容面与裸串面行为一致。
  const afterContains = whitelist.contains.reduce((acc, c) => acc.split(c).join(" "), stripped);
  if (survivesWordWhitelist(afterContains)) issues.push("白名单外英文混入");
  return issues;
}

function isWhitelisted(s: string, file: string): boolean {
  const t = s.trim();
  if (whitelist.exact.includes(t)) return true;
  if (whitelist.contains.some((c) => t.includes(c))) return true;
  if (isWhitelistedFile(file)) return true;
  return !survivesWordWhitelist(t);
}

const dictionary: Record<string, string> = (() => {
  const abs = NodePath.join(REPO_ROOT, DICTIONARY_PATH);
  if (!NodeFS.existsSync(abs)) {
    printError(`i18n-check: dictionary missing at ${DICTIONARY_PATH}, treating as empty`);
    return {};
  }
  return JSON.parse(NodeFS.readFileSync(abs, "utf8"));
})();

interface Finding {
  file: string;
  line: number;
  text: string;
}

const trKeys = new Set<string>();
const bareFindings: Finding[] = [];
const dynamicKeySites: Finding[] = [];

/** 字典面 finding：key + 违规描述列表 */
interface DictIssue {
  key: string;
  issues: string[];
}

/**
 * 新两面为字典内在检查（key/value 自洽），与扫描范围无关：任何模式都查全字典。
 * 各批因此共享同一份全局干净的字典；并集合并后由本面兜底。
 */
function checkDictionaryValues(): { placeholder: DictIssue[]; content: DictIssue[] } {
  const placeholder: DictIssue[] = [];
  const content: DictIssue[] = [];
  for (const key of Object.keys(dictionary).sort()) {
    const value = dictionary[key]!;
    const parity = placeholderMismatches(key, value);
    if (parity.length > 0) placeholder.push({ key, issues: parity });
    const contentIssues = translationContentIssues(value);
    if (contentIssues.length > 0) content.push({ key, issues: contentIssues });
  }
  return { placeholder, content };
}

function checkFile(repoRelativeFile: string, source: string): void {
  if (isWhitelistedFile(repoRelativeFile)) return;
  const sf = ts.createSourceFile(
    repoRelativeFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(repoRelativeFile),
  );
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const insideTrCall = (node: TsTypes.Node): boolean => {
    let p = node.parent;
    while (p) {
      if (ts.isCallExpression(p) && p.expression.getText(sf) === "tr") return true;
      p = p.parent;
    }
    return false;
  };

  const inImportOrRequire = (node: TsTypes.Node): boolean => {
    let p: TsTypes.Node | undefined = node.parent;
    while (p) {
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode(p))
        return true;
      p = p.parent;
    }
    return false;
  };

  const reportIfBare = (node: TsTypes.Node, text: string): void => {
    if (!isLikelyEnglishCopy(text)) return;
    if (
      insideTrCall(node) ||
      isLogicPosition(node as TsTypes.Expression) ||
      inImportOrRequire(node)
    )
      return;
    if (isWhitelisted(text, repoRelativeFile)) return;
    bareFindings.push({ file: repoRelativeFile, line: lineOf(node.getStart(sf)), text });
  };

  const visit = (node: TsTypes.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === "tr") {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) trKeys.add(arg.text);
      else if (arg) {
        dynamicKeySites.push({
          file: repoRelativeFile,
          line: lineOf(arg.getStart(sf)),
          text: arg.getText(sf),
        });
      }
    }

    if (ts.isJsxText(node)) {
      const inner = node.getText(sf).trim();
      if (inner.length > 0 && !inner.startsWith("{")) reportIfBare(node, decodeJsxEntities(inner));
      return;
    }

    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      if (!NON_COPY_ATTRS.has(node.name.getText(sf))) {
        reportIfBare(node.initializer, node.initializer.text);
      }
      return;
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      reportIfBare(node, node.text);
      return;
    }

    if (ts.isTemplateExpression(node)) {
      // Judge by the text parts only: `${x}` alone is not copy, `New ${x} copy` is.
      // 不提前 return：span 内的 tr() 与字面量仍需递归（M3 review 实证漏收致
      // untranslated 假阴性 + stale 误报）。
      const textParts = node.head.text + node.templateSpans.map((s) => s.literal.text).join("");
      reportIfBare(node, textParts);
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** 回归测试入口（.ts 解析修复等红绿测试）：内存源码直接驱动扫描，不依赖磁盘 fixture。 */
export function __collectTrKeysForTest(file: string, source: string): string[] {
  const before = new Set(trKeys);
  checkFile(file, source);
  return [...trKeys].filter((k) => !before.has(k));
}

function listSourceFiles(root: string): string[] {
  const abs = NodePath.join(REPO_ROOT, root);
  if (!NodeFS.existsSync(abs)) return [];
  return NodeFS.readdirSync(abs, { recursive: true })
    .map((entry) => NodePath.join(root, entry.toString()).replaceAll(NodePath.sep, "/"))
    .filter((file) => /\.(ts|tsx)$/.test(file));
}

function printDictSection(label: string, findings: DictIssue[]): void {
  if (findings.length === 0) return;
  print(`\n${label} ${findings.length} 例：`);
  for (const f of findings.slice(0, 20)) {
    print(`  ${JSON.stringify(f.key)} → ${f.issues.join("、")}`);
  }
  if (findings.length > 20) print(`  … 共 ${findings.length} 条`);
}

function printCheck(
  scannedFiles: number,
  untranslated: string[],
  stale: string[],
  dictIssues: { placeholder: DictIssue[]; content: DictIssue[] },
  fullScan: boolean,
): number {
  const { placeholder, content } = dictIssues;
  const dictionaryState =
    Object.keys(dictionary).length > 0 ? `${Object.keys(dictionary).length} entries` : "empty";
  const staleState = fullScan ? `${stale.length}` : "仅全仓扫描可判";
  print(`t3code i18n check（扫描 ${scannedFiles} 个文件）`);
  print(`  字典 ${DICTIONARY_PATH}：${dictionaryState}`);
  print(`  tr() key：${trKeys.size}（未翻译 ${untranslated.length}，字典废弃 ${staleState}）`);
  print(`  占位符失配：${placeholder.length} 例`);
  print(`  译文内容违规：${content.length} 例`);
  if (dynamicKeySites.length > 0) {
    print(`  动态 key 调用点（需人工确认）：${dynamicKeySites.length}`);
  }

  if (untranslated.length > 0) {
    print(`\n[1/5] 未翻译 key ${untranslated.length} 例：`);
    for (const k of untranslated.slice(0, 20)) print(`  ${JSON.stringify(k)}`);
    if (untranslated.length > 20) print(`  … 共 ${untranslated.length} 条`);
  }
  if (fullScan && stale.length > 0) {
    print(`\n[2/5] 废弃译文 key ${stale.length} 例：`);
    for (const k of stale.slice(0, 20)) print(`  ${JSON.stringify(k)}`);
    if (stale.length > 20) print(`  … 共 ${stale.length} 条`);
  }
  if (bareFindings.length > 0) {
    const byFile = new Map<string, number>();
    for (const f of bareFindings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
    print(`\n[3/5] 裸英文残留 ${bareFindings.length}（全量清单用 --json，走查面用 walkthrough）：`);
    for (const [file, count] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      print(`  ${String(count).padStart(5)}  ${file}`);
    }
    print(`  … 共 ${byFile.size} 个文件`);
  }
  printDictSection("[4/5] 占位符失配", placeholder);
  printDictSection("[5/5] 译文内容违规", content);

  const failed =
    untranslated.length > 0 ||
    stale.length > 0 ||
    bareFindings.length > 0 ||
    dynamicKeySites.length > 0 ||
    placeholder.length > 0 ||
    content.length > 0;
  print(
    failed
      ? "\n非零退出：存在未翻译/废弃/裸串/占位符失配/译文内容面（全量汉化完成前为预期状态）。"
      : "\n全部通过：无未翻译 key、无废弃译文、无裸英文残留、无占位符失配、无译文内容违规。",
  );
  return failed ? 1 : 0;
}

function printJson(
  scannedFiles: number,
  untranslated: string[],
  stale: string[],
  dictIssues: { placeholder: DictIssue[]; content: DictIssue[] },
): number {
  print(
    JSON.stringify(
      {
        scannedFiles,
        dictionaryEntries: Object.keys(dictionary).length,
        trKeys: [...trKeys].sort(),
        untranslated,
        stale,
        bare: bareFindings,
        dynamicKeySites,
        dictPlaceholder: dictIssues.placeholder,
        dictContent: dictIssues.content,
      },
      null,
      2,
    ),
  );
  return 0;
}

interface WalkthroughScreen {
  name: string;
  path: string;
  file?: string;
}

/** tanstack 文件路由名 → 路由路径（`_chat.settings.about.tsx` → `/chat/settings/about`） */
export function routePath(fileName: string): string {
  if (fileName.startsWith("__root")) return "/";
  const segments = fileName.replace(/\.tsx$/, "").split(".");
  const parts: string[] = [];
  for (const segment of segments) {
    const bare = segment.replace(/^_+/, "");
    if (bare === "index" || bare === "") continue;
    parts.push(bare.startsWith("$") ? `:${bare.slice(1)}` : bare);
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function bareCountUnder(prefix: string): number {
  let n = 0;
  for (const f of bareFindings) if (f.file.startsWith(prefix)) n++;
  return n;
}

function collectWebRoutes(): WalkthroughScreen[] {
  const routesDir = NodePath.join(REPO_ROOT, "apps/web/src/routes");
  return NodeFS.readdirSync(routesDir)
    .filter((f) => f.endsWith(".tsx"))
    .sort()
    .map((f) => ({ name: f, path: routePath(f), file: `apps/web/src/routes/${f}` }));
}

function collectMobileScreens(): string[] {
  const stack = NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/mobile/src/Stack.tsx"), "utf8");
  return [...stack.matchAll(/^\s{2}([A-Za-z0-9]+): createNativeStackScreen\(/gm)].map(
    (m) => m[1] ?? "",
  );
}

function collectDesktopMenuLabels(): string[] {
  const menu = NodeFS.readFileSync(
    NodePath.join(REPO_ROOT, "apps/desktop/src/window/DesktopApplicationMenu.ts"),
    "utf8",
  );
  // label 值有字符串与模板字面量两种形态（如 `About ${environment.displayName}`）
  return [...menu.matchAll(/label: (?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
}

/** 原生面：InfoPlist 权限串（app.config.ts）+ Kotlin/Swift 模块多词英文串 */
function collectNativeStrings(): { infoPlist: string[]; kotlin: Map<string, number> } {
  const config = NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/mobile/app.config.ts"), "utf8");
  const infoPlist = [
    ...config.matchAll(/^\s*([A-Z]\w*UsageDescription):\s*"((?:[^"\\]|\\.)*)"/gm),
  ].map((m) => `${m[1] ?? ""}: ${m[2] ?? ""}`);

  const kotlin = new Map<string, number>();
  const modulesRoot = NodePath.join(REPO_ROOT, "apps/mobile/modules");
  const nativeFiles = NodeFS.readdirSync(modulesRoot, { recursive: true })
    .map((e) => e.toString().replaceAll(NodePath.sep, "/"))
    .filter((f) => (f.endsWith(".kt") && f.includes("/src/main/")) || f.endsWith(".swift"));
  for (const nf of nativeFiles) {
    const source = NodeFS.readFileSync(NodePath.join(modulesRoot, nf), "utf8");
    // 粗提取：含空格的多词英文字符串（原生直改量小，人工过一遍即可）
    const count = [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].filter((m) =>
      /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(m[1] ?? ""),
    ).length;
    if (count > 0) kotlin.set(`apps/mobile/modules/${nf}`, count);
  }
  return { infoPlist, kotlin };
}

function printWalkthrough(): number {
  print("# t3code 汉化验收走查清单");
  print(
    `\n由 \`node scripts/i18n-check.ts walkthrough\` 生成；裸串计数 = 白名单过滤后的英文候选。`,
  );

  const routes = collectWebRoutes();
  print(`\n## Web 桌面（${routes.length} 个路由文件）\n`);
  print("| 路由 | 源文件 | 裸串 |");
  print("|------|--------|------|");
  for (const r of routes) {
    print(`| \`${r.path}\` | \`${r.file}\` | ${bareCountUnder(r.file!)} |`);
  }

  const screens = collectMobileScreens();
  const featuresDir = NodePath.join(REPO_ROOT, "apps/mobile/src/features");
  const features = NodeFS.readdirSync(featuresDir).sort();
  print(`\n## Mobile（Stack.tsx 注册 ${screens.length} 屏）\n`);
  print(screens.map((s) => `- ${s}`).join("\n"));
  print(`\n### features 目录（走查按功能面覆盖，括号为目录内裸串数）\n`);
  print(
    features
      .map(
        (f) =>
          `- apps/mobile/src/features/${f}（${bareCountUnder(`apps/mobile/src/features/${f}/`)}）`,
      )
      .join("\n"),
  );

  const labels = collectDesktopMenuLabels();
  print(`\n## Desktop 桌面壳\n`);
  print(
    `- 应用菜单（apps/desktop/src/window/DesktopApplicationMenu.ts，${labels.length} label，随原生菜单渲染）`,
  );
  print(`- 主进程其余文案：apps/desktop/src 共 ${bareCountUnder("apps/desktop/src/")} 裸串`);

  const native = collectNativeStrings();
  print(`\n## 原生面（直改，不走 tr()）\n`);
  print(`### InfoPlist 权限描述（apps/mobile/app.config.ts）\n`);
  print(native.infoPlist.map((s) => `- ${s}`).join("\n"));
  print(`\n### Kotlin/Swift 模块文案（多词英文串计数）\n`);
  if (native.kotlin.size === 0) {
    print("- 无多词英文串");
  } else {
    for (const [file, count] of native.kotlin) print(`- ${file}：${count} 串`);
  }

  const byFile = new Map<string, number>();
  for (const f of bareFindings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
  print(`\n## 裸串热点文件 Top 30（初翻工作面）\n`);
  print("| 裸串 | 文件 |");
  print("|------|------|");
  for (const [file, count] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    print(`| ${count} | \`${file}\` |`);
  }
  return 0;
}

function main(): void {
  const argv = NodeProcess.argv.slice(2).filter((a) => a !== "--json");
  const asJson = NodeProcess.argv.slice(2).includes("--json");
  const walkthroughMode = argv[0] === "walkthrough";
  const explicitFiles = walkthroughMode ? [] : argv;

  const fullScan = explicitFiles.length === 0;
  const files = (
    fullScan
      ? SCAN_ROOTS.flatMap(listSourceFiles)
      : explicitFiles.map((f) =>
          NodePath.relative(REPO_ROOT, NodePath.resolve(NodeProcess.cwd(), f)),
        )
  ).filter((f) => f.length > 0);

  for (const file of files) {
    checkFile(file, NodeFS.readFileSync(NodePath.join(REPO_ROOT, file), "utf8"));
  }

  const dictIssues = checkDictionaryValues();
  const untranslated = [...trKeys].filter((k) => !(k in dictionary)).sort();
  // stale（字典 key 已无调用）只在全仓扫描下可判：per-file 模式的 trKeys 不含其他文件的调用。
  const stale = fullScan
    ? Object.keys(dictionary)
        .filter((k) => !trKeys.has(k))
        .sort()
    : [];

  if (walkthroughMode) {
    NodeProcess.exit(printWalkthrough());
  } else if (asJson) {
    NodeProcess.exit(printJson(files.length, untranslated, stale, dictIssues));
  } else {
    NodeProcess.exit(printCheck(files.length, untranslated, stale, dictIssues, fullScan));
  }
}

if (
  NodeProcess.argv[1] !== undefined &&
  import.meta.url === new NodeURL.URL(`file://${NodeProcess.argv[1]}`).href
) {
  main();
}
