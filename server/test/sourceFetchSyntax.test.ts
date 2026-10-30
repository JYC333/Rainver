import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchSource } from "../src/modules/sources/sourceFetch.js";
import { readerContentFromFetchedText } from "../src/modules/sources/contentParsing.js";
import { startMockUpstream, type MockUpstream } from "./support/mockUpstream.js";
import { fixtureServerGuard } from "./support/outboundGuard.js";

// The real fetch entry (through the outbound guard, pinned at a loopback
// fixture) feeding the real syntax routing — the same two steps the
// extraction worker runs.
const markdown = "# Title\n\n**bold** and `code`";
let upstream: MockUpstream;

beforeAll(async () => {
  upstream = await startMockUpstream((req, res) => {
    const types: Record<string, string | undefined> = {
      "/none/readme.md": undefined,
      "/octet/readme.markdown": "application/octet-stream",
      "/plain/readme.md": "text/plain; charset=utf-8",
      "/markdown/readme": "text/markdown",
      "/html/page.md": "text/html",
    };
    const type = types[req.url];
    res.writeHead(200, type ? { "content-type": type } : {});
    res.end(req.url === "/html/page.md" ? "<article><h1>Html title</h1><p>Html body.</p></article>" : markdown);
  });
});
afterAll(async () => { await upstream?.close(); });

async function read(path: string) {
  const url = `${upstream.baseUrl}${path}`;
  const response = await fetchSource(url, { maxDownloadBytes: 1_000_000, guard: fixtureServerGuard });
  expect(response.isText).toBe(true);
  return readerContentFromFetchedText(response.text!, response.contentType, url);
}

describe("fetched text by declared syntax", () => {
  it.each([
    ["no media type, .md", "/none/readme.md"],
    ["octet-stream, .markdown", "/octet/readme.markdown"],
    ["text/markdown", "/markdown/readme"],
  ])("parses Markdown: %s", async (_case, path) => {
    const content = await read(path);
    expect(content.extraction_method).toBe("markdown_v1");
    expect(content.content_json.content[0]).toMatchObject({ type: "heading", attrs: { level: 1 } });
  });

  it("keeps an explicitly plain response literal even with a .md name", async () => {
    const content = await read("/plain/readme.md");
    expect(content.extraction_method).toBe("plain_text_v1");
    expect(content.plain_text).toContain("**bold**");
  });

  it("reads an explicitly HTML response as HTML even with a .md name", async () => {
    const content = await read("/html/page.md");
    expect(content.extraction_method).toBe("structured_html_v1");
    expect(content.plain_text).toContain("Html body.");
  });
});
