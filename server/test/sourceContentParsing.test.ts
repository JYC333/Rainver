import { describe, expect, it } from "vitest";
import {
  extractStructuredReaderContent,
  parseStructuredReaderContent,
} from "../src/modules/sources/contentParsing.js";

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
