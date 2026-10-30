import { describe, expect, it } from "vitest";
import {
  agentReaderContentJson,
  extractStructuredReaderContent,
  fetchedTextSyntax,
  parseStructuredReaderContent,
  readerContentFromFetchedText,
  type ReaderPmNode,
} from "../src/modules/sources/contentParsing.js";

const textOf = (node: ReaderPmNode | undefined): string => node?.text ?? (node?.content ?? []).map(textOf).join("");

describe("extractStructuredReaderContent", () => {
  it("extracts readable article blocks with remote image references", () => {
    const result = extractStructuredReaderContent(
      `<html>
        <head><title>Page title</title></head>
        <body>
          <nav>Navigation chrome</nav>
          <article>
            <h1>Article heading</h1>
            <p>First paragraph with <a href="/links/ref">a link</a>.</p>
            <figure>
              <img src="/images/chart.png" alt="Chart" title="Remote chart">
            </figure>
            <ul>
              <li>One</li>
              <li>Two</li>
            </ul>
          </article>
        </body>
      </html>`,
      "https://example.test/posts/one",
    );

    expect(result.kind).toBe("reader_document");
    expect(result.image_policy).toBe("remote_reference");
    expect(result.title).toBe("Page title");
    expect(result.plain_text).toContain("Article heading");
    expect(result.plain_text).toContain("First paragraph with a link.");
    expect(result.plain_text).toContain("One\nTwo");
    expect(result.plain_text).not.toContain("Navigation chrome");
    expect(result.image_count).toBe(1);

    const heading = result.content_json.content.find((node) => node.type === "heading");
    expect(heading?.attrs?.level).toBe(1);

    const paragraph = result.content_json.content.find((node) => node.type === "paragraph");
    const linkedText = paragraph?.content?.find((node) => node.type === "text" && node.text === "a link");
    expect(linkedText?.marks?.[0]).toMatchObject({
      type: "link",
      attrs: { href: "https://example.test/links/ref" },
    });

    const image = result.content_json.content.find((node) => node.type === "image");
    expect(image?.attrs).toMatchObject({
      src: "https://example.test/images/chart.png",
      alt: "Chart",
      title: "Remote chart",
    });
  });

  it("reads a numeric entity outside Unicode as the replacement character instead of failing the page", () => {
    const result = extractStructuredReaderContent(
      `<html><body><article>
        <h1>Heading &#x110000; here</h1>
        <p>Body &#99999999; text &#x41;&#66; and &amp; more.</p>
      </article></body></html>`,
      "https://example.test/posts/entities",
    );
    expect(result.kind).toBe("reader_document");
    expect(result.plain_text).toContain("Heading \uFFFD here");
    expect(result.plain_text).toContain("Body \uFFFD text AB and & more.");
  });

  it("round-trips structured reader JSON", () => {
    const result = extractStructuredReaderContent(
      "<article><p>Readable text.</p></article>",
      "https://example.test/read",
    );

    expect(parseStructuredReaderContent(JSON.stringify(result))).toEqual(result);
  });

  it("accepts PDF reader document JSON", () => {
    const result = parseStructuredReaderContent(JSON.stringify({
      schema_version: 1,
      kind: "reader_document",
      extraction_method: "pdf_text_v1",
      image_policy: "none",
      title: null,
      source_uri: "https://example.test/paper.pdf",
      plain_text: "PDF text.",
      content_json: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "PDF text." }] }],
      },
      image_count: 0,
    }));

    expect(result?.extraction_method).toBe("pdf_text_v1");
    expect(result?.plain_text).toBe("PDF text.");
  });

  it("rejects structured reader JSON with an unsupported schema marker", () => {
    const result = extractStructuredReaderContent(
      "<article><p>Readable text.</p></article>",
      "https://example.test/read",
    );

    expect(parseStructuredReaderContent(JSON.stringify({
      ...result,
      image_policy: "downloaded_copy",
    }))).toBeNull();
  });

  it("keeps list item content valid when source markup nests paragraphs in li elements", () => {
    const result = extractStructuredReaderContent(
      "<article><ul><li><p>First item</p></li><li><p>Second item</p></li></ul></article>",
      "https://example.test/read",
    );

    const list = result.content_json.content.find((node) => node.type === "bulletList");
    const firstItem = list?.content?.[0];
    expect(firstItem).toMatchObject({
      type: "listItem",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "First item" }],
      }],
    });
  });

  it("does not prefer the full html document over the readable body", () => {
    const result = extractStructuredReaderContent(
      `<html>
        <head>
          <title>Browser title that should not become reader text</title>
        </head>
        <body>
          <main>
            <h1>Reader heading</h1>
            <p>Main paragraph.</p>
          </main>
        </body>
      </html>`,
      "https://example.test/read",
    );

    expect(result.title).toBe("Browser title that should not become reader text");
    expect(result.plain_text).toContain("Reader heading");
    expect(result.plain_text).toContain("Main paragraph.");
    expect(result.plain_text).not.toContain("Browser title that should not become reader text");
  });

  it("filters navigation, promotional chrome, and footer content around the article body", () => {
    const result = extractStructuredReaderContent(
      `<html>
        <body>
          <header class="site-navbar">
            <a href="/matrix">Matrix</a>
            <a href="/prime">PRIME</a>
            <a href="/pi-store">Pi Store</a>
          </header>
          <section class="promotion-card">
            <p>无需申请，自由写作</p>
            <a href="/about">了解更多</a>
          </section>
          <div class="article-content">
            <h1>在格鲁吉亚的大地上：徒步篇</h1>
            <p>第一段正文，介绍徒步路线和当天的天气。</p>
            <p>第二段正文，描述山口、村庄和补给点。</p>
          </div>
          <footer>
            <a href="/matrix">共创</a>
            <a href="/prime">PRIME</a>
            <a href="/columns">栏目</a>
          </footer>
        </body>
      </html>`,
      "https://sspai.example/post/1",
    );

    expect(result.plain_text).toContain("在格鲁吉亚的大地上：徒步篇");
    expect(result.plain_text).toContain("第一段正文，介绍徒步路线和当天的天气。");
    expect(result.plain_text).toContain("第二段正文，描述山口、村庄和补给点。");
    expect(result.plain_text).not.toContain("PRIME");
    expect(result.plain_text).not.toContain("Pi Store");
    expect(result.plain_text).not.toContain("无需申请");
    expect(result.plain_text).not.toContain("了解更多");
    expect(result.plain_text).not.toContain("共创");
  });

  it("preserves readable table structure for the reader document", () => {
    const result = extractStructuredReaderContent(
      `<article>
        <h1>Trip plan</h1>
        <table>
          <thead>
            <tr><th>No.</th><th>行程概览</th></tr>
          </thead>
          <tbody>
            <tr><td>Day 1</td><td>飞机：北京大兴→乌鲁木齐</td></tr>
            <tr>
              <td>Day 2</td>
              <td><p>小巴：Tbilisi→Kazbegi</p><p>徒步：Gergeti Trinity Church</p></td>
            </tr>
          </tbody>
        </table>
      </article>`,
      "https://example.test/table",
    );

    const table = result.content_json.content.find((node) => node.type === "table");
    expect(table).toBeTruthy();
    expect(table?.content?.[0]).toMatchObject({
      type: "tableRow",
      content: [
        { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "No." }] }] },
        { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "行程概览" }] }] },
      ],
    });
    expect(result.plain_text).toContain("No. | 行程概览");
    expect(result.plain_text).toContain("Day 2 | 小巴：Tbilisi→Kazbegi 徒步：Gergeti Trinity Church");
  });
});

describe("HTML structure fidelity", () => {
  const extract = (body: string) => extractStructuredReaderContent(`<article>${body}</article>`, "https://example.test/a").content_json.content;

  it("keeps bold, italic, strike, inline code and links, including nested emphasis inside a link", () => {
    const [paragraph] = extract('<p><strong>粗体</strong> <em>斜体</em> <del>删除</del> <code>f(x)</code> <a href="/doc"><b>强调链接</b></a></p>');
    const byText = (text: string) => paragraph!.content!.find(node => node.text === text);
    expect(byText("粗体")!.marks).toEqual([{ type: "bold" }]);
    expect(byText("斜体")!.marks).toEqual([{ type: "italic" }]);
    expect(byText("删除")!.marks).toEqual([{ type: "strike" }]);
    expect(byText("f(x)")!.marks).toEqual([{ type: "code" }]);
    expect(byText("强调链接")!.marks).toEqual([{ type: "link", attrs: { href: "https://example.test/doc" } }, { type: "bold" }]);
  });

  it("keeps heading levels h1–h6", () => {
    const nodes = extract("<h1>1</h1><h2>2</h2><h3>3</h3><h4>4</h4><h5>5</h5><h6>6</h6>");
    expect(nodes.map(node => node.attrs?.level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps code blocks character for character, including the first line's indentation", () => {
    const code = "    def f(x):\n        return '中文 🙂'\n\n\t# tab";
    const [block] = extract(`<pre><code class="language-python">\n${code.replace(/</g, "&lt;")}\n</code></pre>`);
    expect(block).toEqual({ type: "codeBlock", content: [{ type: "text", text: code }] });
  });

  it("keeps three-level nested lists and an ordered list start instead of flattening them", () => {
    const [list, ordered] = extract('<ul><li><p>a</p><ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul><ol start="3"><li>three</li></ol>');
    expect(list!.type).toBe("bulletList");
    expect(list!.content!.map(textOf)).toEqual(["abc", "d"]);
    const levelTwo = list!.content![0]!.content![1]!;
    const levelThree = levelTwo.content![0]!.content![1]!;
    expect([levelTwo.type, levelThree.type]).toEqual(["bulletList", "bulletList"]);
    expect(textOf(levelThree)).toBe("c");
    expect(ordered).toMatchObject({ type: "orderedList", attrs: { start: 3 } });
  });
});

describe("stored documents with unsupported content", () => {
  it("degrades an unknown node to its text instead of hiding the whole document", () => {
    const parsed = parseStructuredReaderContent(JSON.stringify({
      schema_version: 1, kind: "reader_document", extraction_method: "structured_html_v1", image_policy: "remote_reference",
      title: null, source_uri: null, plain_text: "Kept. E=mc^2", image_count: 0,
      content_json: { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "Kept.", marks: [{ type: "highlight" }] }] },
        { type: "mathBlock", content: [{ type: "text", text: "E=mc^2" }] },
      ] },
    }));
    expect(parsed?.content_json.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Kept." }] },
      { type: "paragraph", content: [{ type: "text", text: "E=mc^2" }] },
    ]);
  });
});

describe("declared syntax", () => {
  it("routes fetched text by its media type, never by its contents", () => {
    expect(fetchedTextSyntax("text/markdown; charset=utf-8", "https://example.test/a")).toBe("markdown");
    expect(fetchedTextSyntax("text/plain", "https://example.test/README.md")).toBe("plain");
    expect(fetchedTextSyntax(null, "https://example.test/README.md")).toBe("markdown");
    expect(fetchedTextSyntax("text/html", "https://example.test/a.md")).toBe("html");
    expect(fetchedTextSyntax("application/json", "https://example.test/a")).toBe("plain");
  });

  it("parses fetched Markdown with markdown-it and shows plain text literally", () => {
    const markdown = readerContentFromFetchedText("# Title\n\n**bold** and `code`", "text/markdown", "https://example.test/a.md");
    expect(markdown.extraction_method).toBe("markdown_v1");
    expect(markdown.content_json.content[0]).toMatchObject({ type: "heading", attrs: { level: 1 } });
    expect(markdown.plain_text).toBe("Title\n\nbold and code");
    const plain = readerContentFromFetchedText("# Not a heading\n\n**literal**", "text/plain", "https://example.test/a.txt");
    expect(plain.extraction_method).toBe("plain_text_v1");
    expect(plain.content_json.content.map(textOf)).toEqual(["# Not a heading", "**literal**"]);
  });

  it("converts Agent text only when the Agent declared Markdown", () => {
    const text = "## Heading\n\n- item with *emphasis*";
    expect(agentReaderContentJson(text, "markdown").content.map(node => node.type)).toEqual(["heading", "bulletList"]);
    expect(agentReaderContentJson(text, undefined).content.map(textOf)).toEqual(["## Heading", "- item with *emphasis*"]);
    expect(agentReaderContentJson(text, "plain").content.map(textOf)).toEqual(["## Heading", "- item with *emphasis*"]);
  });
});

describe("content selection", () => {
  it("keeps a marked article body that shares a layout wrapper with a link-heavy nav", () => {
    const nav = Array.from({ length: 30 }, (_, i) => `<li><a href="/docs/${i}">Docs page ${i}</a></li>`).join("");
    const result = extractStructuredReaderContent(
      `<html><body><div class="layout"><nav class="docs-nav"><ul>${nav}</ul></nav><div class="content markdown"><h1>Configuration</h1><p>Set the reading measure.</p></div></div></body></html>`,
      "https://example.test/docs",
    );
    expect(result.plain_text).toContain("Set the reading measure.");
    expect(result.plain_text).not.toContain("Docs page 17");
  });
});

describe("stored HTML trees are in the shared normalized form", () => {
  it("drops a link on inline code, opens list items with a paragraph, and is a normalizer fixed point", async () => {
    const { normalizeReaderDocument } = await import("@rainver/reader-document");
    const result = extractStructuredReaderContent(
      '<article><p>See <a href="/api"><code>call()</code></a> now.</p><ul><li><h2>Heading item</h2><p>body</p></li><li><img src="https://example.test/i.png"></li></ul></article>',
      "https://example.test/a",
    );
    const code = result.content_json.content[0]!.content!.find(node => node.text === "call()");
    expect(code!.marks).toEqual([{ type: "code" }]);
    const items = result.content_json.content[1]!.content!;
    expect(items.map(item => item.content![0]!.type)).toEqual(["paragraph", "paragraph"]);
    expect(normalizeReaderDocument(result.content_json)).toEqual(result.content_json);
  });
});
