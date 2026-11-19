import { describe, expect, it } from "vitest";
import { markdownToReaderDocument, normalizeReaderDocument, normalizeReaderDocumentBounded, READER_MAX_NODES, readerNodeText, type ReaderNode } from "../src/index.js";

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

  it("keeps positive bounded image dimensions without accepting style or invalid sizes", () => {
    const doc = normalizeReaderDocument({ type: "doc", content: [
      { type: "image", attrs: { src: "https://e.test/chart.png", width: 1200, height: 800, style: "width:999999px" } },
      { type: "image", attrs: { src: "https://e.test/icon.svg", width: 20, height: 20 } },
      ...[0, -1, 1.5, 100001, "100%"].map(value => ({ type: "image", attrs: { src: "https://e.test/x.png", width: value, height: value } })),
    ] });
    expect(doc.content[0]!.attrs).toEqual({ src: "https://e.test/chart.png", alt: "", title: null, width: 1200, height: 800 });
    expect(doc.content[1]!.attrs).toMatchObject({ width: 20, height: 20 });
    for (const node of doc.content.slice(2)) {
      expect(node.attrs).not.toHaveProperty("width");
      expect(node.attrs).not.toHaveProperty("height");
    }
    expect(normalizeReaderDocument(doc)).toEqual(doc);
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

  it("degrades nesting deeper than its budget to text instead of exhausting the stack", () => {
    let quote: Record<string, unknown> = { type: "paragraph", content: [{ type: "text", text: "deep words" }] };
    let unknown: Record<string, unknown> = { type: "text", text: "inline words" };
    for (let i = 0; i < 20_000; i += 1) {
      quote = { type: "blockquote", content: [quote] };
      unknown = { type: "mystery", content: [unknown] };
    }
    const doc = normalizeReaderDocument({ type: "doc", content: [quote, { type: "paragraph", content: [unknown] }] });
    expect(readerNodeText(doc)).toContain("deep words");
    expect(readerNodeText(doc)).toContain("inline words");
    expect(readerNodeText({ type: "doc", content: [unknown] })).toBe("inline words");

    let shallow: Record<string, unknown> = { type: "paragraph", content: [{ type: "text", text: "kept" }] };
    for (let i = 0; i < 5; i += 1) shallow = { type: "blockquote", content: [shallow] };
    expect(JSON.stringify(normalizeReaderDocument({ type: "doc", content: [shallow] })).match(/blockquote/g)).toHaveLength(5);
  });
});

describe("Reader document node budget", () => {
  it("leaves an ordinary document untruncated", () => {
    const result = normalizeReaderDocumentBounded({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] });
    expect(result.truncated).toBe(false);
    expect(result.document.content).toHaveLength(1);
  });

  it("stops reading a wider-than-budget document and says so", () => {
    const paragraph = { type: "paragraph", content: [{ type: "text", text: "x" }] };
    const result = normalizeReaderDocumentBounded({ type: "doc", content: Array.from({ length: READER_MAX_NODES }, () => paragraph) });
    expect(result.truncated).toBe(true);
    expect(result.document.content.length).toBeLessThan(READER_MAX_NODES);
    expect(result.document.content.length).toBeGreaterThan(0);
  });

  it("counts degraded subtrees against the same budget, each call afresh", () => {
    // One unsupported node whose text is read by the degraded path.
    const unsupported = { type: "callout", content: Array.from({ length: READER_MAX_NODES + 10 }, () => ({ type: "text", text: "y" })) };
    const result = normalizeReaderDocumentBounded({ type: "doc", content: [unsupported] });
    expect(result.truncated).toBe(true);
    expect(readerNodeText(unsupported).length).toBeLessThan(READER_MAX_NODES);
    expect(normalizeReaderDocumentBounded({ type: "doc", content: [{ type: "paragraph" }] }).truncated).toBe(false);
  });

  // An input array that counts how many of its items are read.
  function countedArray(length: number, item: () => unknown): { items: unknown[]; reads: () => number } {
    let reads = 0;
    const items = new Proxy(new Array(length), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) { reads += 1; return item(); }
        return Reflect.get(target, key, receiver);
      },
    });
    return { items, reads: () => reads };
  }

  it("stops scanning every wide child list once the budget is spent", () => {
    const length = READER_MAX_NODES * 3;
    const text = () => ({ type: "text", text: "z" });
    const cases: [string, (items: unknown[]) => unknown][] = [
      ["paragraph inlines", items => ({ type: "doc", content: [{ type: "paragraph", content: items }] })],
      ["list items", items => ({ type: "doc", content: [{ type: "bulletList", content: items }] })],
      ["table rows", items => ({ type: "doc", content: [{ type: "table", content: items }] })],
      ["code block", items => ({ type: "doc", content: [{ type: "codeBlock", content: items }] })],
      ["unsupported node", items => ({ type: "doc", content: [{ type: "callout", content: items }] })],
    ];
    for (const [name, wrap] of cases) {
      const counted = countedArray(length, text);
      expect(normalizeReaderDocumentBounded(wrap(counted.items)).truncated, name).toBe(true);
      expect(counted.reads(), name).toBeLessThanOrEqual(READER_MAX_NODES + 1);
    }
  });

  it("reads a wide node past the nesting depth lazily instead of stacking all its children", () => {
    const counted = countedArray(READER_MAX_NODES * 3, () => ({ type: "text", text: "w" }));
    let deep: Record<string, unknown> = { type: "mystery", content: counted.items };
    for (let i = 0; i < 100; i += 1) deep = { type: "mystery", content: [deep] };
    const text = readerNodeText(deep);
    expect(counted.reads()).toBeLessThanOrEqual(READER_MAX_NODES + 1);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(READER_MAX_NODES);

    // Within the budget the degraded text keeps document order.
    let ordered: Record<string, unknown> = { type: "mystery", content: [{ type: "text", text: "a" }, { type: "mystery", content: [{ type: "text", text: "b" }, { type: "hardBreak" }] }, { type: "text", text: "c" }] };
    for (let i = 0; i < 100; i += 1) ordered = { type: "mystery", content: [ordered] };
    expect(readerNodeText(ordered)).toBe("ab\nc");
  });

  it("keeps the cells a row was charged for when the budget runs out mid-table", () => {
    const row = { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] }] };
    const result = normalizeReaderDocumentBounded({ type: "doc", content: [{ type: "table", content: Array.from({ length: READER_MAX_NODES }, () => row) }] });
    expect(result.truncated).toBe(true);
    const rows = result.document.content[0]!.content!;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.content!.length === 1)).toBe(true);
  });
});
