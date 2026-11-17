// Definitions, footnotes, raw HTML, container directives and display math can tie blocks together.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)|\[\^/m;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text. Returns null when the text uses syntax that spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  if (text.includes("\r") || DOCUMENT_WIDE_SYNTAX.test(text)) return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  for (const line of text.split("\n")) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) break;
      if (
        opener &&
        opener[0] === fence[0] &&
        opener.length >= fence.length &&
        line.trim() === opener
      ) {
        fence = null;
      }
    } else if (line.trim() === "") {
      afterBlankLine = true;
    } else {
      if (afterBlankLine && lineStart > blockStart && !CONTINUATION_PATTERN.test(line)) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      afterBlankLine = false;
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}

/**
 * Whether appending more streamed text can no longer change how this text renders, so its parse
 * can enter the shared cache without filling it with streamed prefixes. Uses the same fence and
 * blank-line rules as {@link splitMarkdownBlocks}, and answers false for texts the splitter
 * refuses (CR or document-wide syntax), so verdicts stay consistent with splitting.
 */
export function isMarkdownBlockClosed(source: string): boolean {
  if (source.includes("\r") || DOCUMENT_WIDE_SYNTAX.test(source)) return false;
  const lines = source.split("\n");
  // A blank line needs a newline terminator; the trailing split artifact (after the final
  // newline) is not one. "a\n" is a paragraph still growing, "a\n\n" is closed.
  if (lines.at(-2)?.trim() !== "" || lines.at(-1)?.trim() !== "") {
    return false;
  }
  let fence: string | null = null;
  let fenceIndent = 0;
  let hasContent = false;
  for (const line of lines) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) return false;
      if (
        opener &&
        opener[0] === fence[0] &&
        opener.length >= fence.length &&
        line.trim() === opener
      ) {
        fence = null;
      }
    } else if (line.trim() !== "") {
      hasContent = true;
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
    }
  }
  return hasContent && fence === null;
}
