import { describe, expect, it } from "vitest";
import { markdownToReaderDocument, normalizeReaderDocument, readerNodeText, type ReaderNode } from "../src/index.js";

const types = (nodes: ReaderNode[] | undefined) => (nodes ?? []).map(node => node.type);

describe("markdownToReaderDocument", () => {
  it("keeps headings at every level, emphasis, strike, inline code and links", () => {
    const doc = markdownToReaderDocument([
      "# 标题一", "## Two", "### Three", "#### Four", "##### Five", "###### Six", "",
      "**粗体** *斜体* ~~删除~~ `code()` [链接](https://example.test/a) 🙂",
    ].join("\n"));
    expect(doc.content.slice(0, 6).map(node => node.attrs?.level)).toEqual([1, 2, 3, 4, 5, 6]);
    const inline = doc.content[6]!.content!;
    expect(inline.find(node => node.text === "粗体")!.marks).toEqual([{ type: "bold" }]);
    expect(inline.find(node => node.text === "斜体")!.marks).toEqual([{ type: "italic" }]);
    expect(inline.find(node => node.text === "删除")!.marks).toEqual([{ type: "strike" }]);
    expect(inline.find(node => node.text === "code()")!.marks).toEqual([{ type: "code" }]);
    expect(inline.find(node => node.text === "链接")!.marks).toEqual([{ type: "link", attrs: { href: "https://example.test/a" } }]);
    expect(readerNodeText(doc.content[6])).toContain("🙂");
  });

  it("keeps code character for character, including the first line's indentation and blank lines", () => {
    const code = "    def f(x):\n        if x:\n\n            return '中文 🙂'\n\t# tab";
    const doc = markdownToReaderDocument("```python\n" + code + "\n```");
    expect(doc.content[0]).toEqual({ type: "codeBlock", attrs: { language: "python" }, content: [{ type: "text", text: code }] });
    const indented = markdownToReaderDocument("Intro\n\n        indented code\n          deeper");
    expect(indented.content[1]).toEqual({ type: "codeBlock", content: [{ type: "text", text: "    indented code\n      deeper" }] });
  });

  it("keeps three-level nested lists and an ordered list's start", () => {
    const doc = markdownToReaderDocument(["3. three", "4. four", "", "- a", "  - b", "    - c", "- d"].join("\n"));
    expect(doc.content[0]).toMatchObject({ type: "orderedList", attrs: { start: 3 } });
    const bullet = doc.content[1]!;
    const levelTwo = bullet.content![0]!.content![1]!;
    const levelThree = levelTwo.content![0]!.content![1]!;
    expect(types([bullet, levelTwo, levelThree])).toEqual(["bulletList", "bulletList", "bulletList"]);
    expect(readerNodeText(levelThree)).toBe("c");
  });

  it("keeps tables with header and body cells and inline marks inside them", () => {
    const doc = markdownToReaderDocument("| 名称 | **值** |\n|---|---|\n| a | `b` |");
    const table = doc.content[0]!;
    expect(table.type).toBe("table");
    expect(types(table.content![0]!.content)).toEqual(["tableHeader", "tableHeader"]);
    expect(types(table.content![1]!.content)).toEqual(["tableCell", "tableCell"]);
    expect(table.content![1]!.content![1]!.content![0]!.content![0]).toEqual({ type: "text", text: "b", marks: [{ type: "code" }] });
  });

  it("lifts images out of paragraphs as blocks and drops an image without a source", () => {
    const doc = markdownToReaderDocument("before ![chart](https://example.test/c.png \"Title\") after\n\n![broken]()");
    expect(types(doc.content)).toEqual(["paragraph", "image", "paragraph"]);
    expect(doc.content[1]!.attrs).toEqual({ src: "https://example.test/c.png", alt: "chart", title: "Title" });
  });

  it("does not interpret raw HTML or treat plain asterisks inside words as emphasis", () => {
    const doc = markdownToReaderDocument("<script>alert(1)</script>\n\n2*3*4 and a_b_c");
    expect(readerNodeText(doc)).toContain("<script>alert(1)</script>");
    expect(JSON.stringify(doc)).not.toContain('"type":"html');
  });

  it("gives an empty input a single empty paragraph", () => {
    expect(markdownToReaderDocument("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});

describe("normalizeReaderDocument", () => {
  it("degrades an unsupported node to its text instead of rejecting the document", () => {
    const doc = normalizeReaderDocument({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "kept" }] },
      { type: "mathBlock", content: [{ type: "text", text: "E = mc^2" }] },
      { type: "paragraph", content: [{ type: "mention", content: [{ type: "text", text: "@ada" }] }, { type: "text", text: "", marks: [] }] },
    ] });
    expect(doc.content.map(readerNodeText)).toEqual(["kept", "E = mc^2", "@ada"]);
  });

  it("drops unknown marks, links without a target and other marks on inline code", () => {
    const doc = normalizeReaderDocument({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "x", marks: [{ type: "highlight" }, { type: "bold" }, { type: "bold" }] },
      { type: "text", text: "y", marks: [{ type: "link", attrs: {} }] },
      { type: "text", text: "z", marks: [{ type: "code" }, { type: "italic" }] },
    ] }] });
    expect(doc.content[0]!.content).toEqual([
      { type: "text", text: "x", marks: [{ type: "bold" }] },
      { type: "text", text: "y" },
      { type: "text", text: "z", marks: [{ type: "code" }] },
    ]);
  });

  it("repairs structure: inline at block level, non-items in lists, non-rows in tables, out-of-range heading levels", () => {
    const doc = normalizeReaderDocument({ type: "doc", content: [
      { type: "text", text: "loose" },
      { type: "bulletList", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] },
      { type: "table", content: [{ type: "paragraph", content: [{ type: "text", text: "cell" }] }] },
      { type: "heading", attrs: { level: 9 }, content: [{ type: "text", text: "h" }] },
      { type: "listItem" },
    ] });
    expect(types(doc.content)).toEqual(["paragraph", "bulletList", "table", "heading"]);
    expect(doc.content[1]!.content![0]!.type).toBe("listItem");
    expect(doc.content[2]!.content![0]!.content![0]!.type).toBe("tableCell");
    expect(doc.content[3]!.attrs).toEqual({ level: 6 });
  });

  it("keeps bounded table cell spans", () => {
    const doc = normalizeReaderDocument({ type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [
      { type: "tableHeader", attrs: { colspan: 2 }, content: [{ type: "paragraph", content: [{ type: "text", text: "wide" }] }] },
      { type: "tableCell", attrs: { rowspan: 99, colspan: "x" }, content: [] },
    ] }] }] });
    const cells = doc.content[0]!.content![0]!.content!;
    expect(cells[0]!.attrs).toEqual({ colspan: 2 });
    expect(cells[1]!.attrs).toEqual({ rowspan: 20 });
    expect(cells[1]!.content).toEqual([{ type: "paragraph" }]);
  });
});
