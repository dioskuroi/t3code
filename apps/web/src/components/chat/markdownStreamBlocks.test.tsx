import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import { isMarkdownBlockClosed, splitMarkdownBlocks } from "./markdownStreamBlocks";

// Whitespace between top-level blocks collapses in the rendered message.
const html = (source: string) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
    >
      {source}
    </ReactMarkdown>,
  )
    .replace(/>\s+</g, "><")
    .trim();

describe("splitMarkdownBlocks", () => {
  it.each([
    "# Title\n\nFirst paragraph with `code` and **bold**.\n\nSecond [link](https://example.com).",
    "- one\n- two\n\n- loose three\n\n  continued\n\nAfter the list.",
    "1. first\n\n2. second\n\nText\n\n3) restarted",
    "```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nafter\n\n~~~\nx\n\n~~~~\n\ny\n~~~\n\nend",
    "> quote\n\n> another quote\n\n> [!NOTE]\n> alert",
    "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.",
    "para\n\n    indented code\n\nnext",
    "Setext\n===\n\nnext\n---\n\n- [ ] task\n- [x] done",
    "- a\n\n  ```\n  x\n\n```\n\nb",
    "- a\n\n  ```\n  x\n\ny\n\n  ```\n\nb",
  ])("renders each block as the whole text renders it, at every streamed prefix: %j", (text) => {
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      const blocks = splitMarkdownBlocks(source);
      expect(blocks?.join("")).toBe(source);
      expect(blocks!.map(html).join("")).toBe(html(source));
    }
  });

  it("splits only between closed blocks", () => {
    expect(splitMarkdownBlocks("a\n\n```\nb\n\nc\n```\n\n- d\n\n- e\n\nf")).toEqual([
      "a\n\n",
      "```\nb\n\nc\n```\n\n- d\n\n- e\n\n",
      "f",
    ]);
  });

  it.each([
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "<details>\n\nbody\n\n</details>",
    ":::note\n\ncontent\n\n:::",
    "$$\na\n\nb\n$$",
    "a\r\n\r\nb",
  ])("keeps text with document-wide syntax whole: %j", (text) => {
    expect(splitMarkdownBlocks(text)).toBeNull();
  });
});

describe("isMarkdownBlockClosed", () => {
  it.each([
    ["a\n\n", true],
    ["First paragraph.\n\nSecond one.\n\n", true],
    ["```\ncode\n```\n\n", true],
    ["inline `code`\n\n```\nfence\n```\n\n", true],
    ["a\n  \n", true],
    ["- item\n\n  ```\n  nested\n\n  ```\n\nlist continues\n\n", true],
    ["", false],
    ["a", false],
    ["a\n", false],
    // The trailing split artifact (after the final newline) is not a blank line, so "a\n\nb"
    // keeps growing inside the last paragraph.
    ["a\n\nb", false],
    ["word0 word1 ", false],
    ["  \n  \n", false],
    ["```\ncode", false],
    ["```\ncode\n\n", false],
    ["```\ncode\n```\n", false],
    // A line left of an indented fence may end the list item holding it, which isn't tracked,
    // so even a dedented closing fence makes the splitter give up and keeps the block open.
    ["- a\n\n  ```\n  x\n\n```\n\n", false],
    ["a[^footnote]\n\n", false],
    ["a\r\n\r\n", false],
  ])("answers %j -> %j", (source, closed) => {
    expect(isMarkdownBlockClosed(source)).toBe(closed);
  });

  // The verdict and the splitter share their fence and blank-line rules by hand; this pins the
  // invariant they must agree on: a closed block survives appending a new non-continuation block.
  it("only closes text that splitting would cut off unchanged", () => {
    const samples = [
      "a\n\n",
      "First paragraph.\n\nSecond one.\n\n",
      "```\ncode\n```\n\n",
      "inline `code`\n\n```\nfence\n```\n\n",
      "a\n  \n",
      "- item\n\n  ```\n  nested\n\n  ```\n\nlist continues\n\n",
    ];
    for (const text of samples) {
      expect(isMarkdownBlockClosed(text)).toBe(true);
      const appended = splitMarkdownBlocks(`${text}Next block`);
      expect(appended?.slice(0, -1).join("")).toBe(text);
    }
  });
});
