import { extractText, getDocumentProxy } from "unpdf";
import type { ReaderPmDoc, ReaderPmNode, StructuredReaderContent } from "./contentParsing.js";

export async function extractPdfReaderContent(
  bytes: Uint8Array,
  sourceUri: string | null,
): Promise<StructuredReaderContent> {
  const pdf = await getDocumentProxy(bytes);
  const result = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(result.text) ? result.text : [result.text];
  const plainText = normalizePdfText(pages.join("\n\n"));
  const contentJson = pdfTextToPmDoc(pages);
  return {
    schema_version: 1,
    kind: "reader_document",
    extraction_method: "pdf_text_v1",
    image_policy: "none",
    title: null,
    source_uri: sourceUri,
    plain_text: plainText,
    content_json: contentJson,
    image_count: 0,
  };
}

function pdfTextToPmDoc(pages: readonly string[]): ReaderPmDoc {
  const content: ReaderPmNode[] = [];
  for (const page of pages) {
    for (const block of splitPdfBlocks(page)) {
      content.push(blockToNode(block));
    }
  }
  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  };
}

function blockToNode(block: string): ReaderPmNode {
  if (looksLikeHeading(block)) {
    return {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: block }],
    };
  }
  return {
    type: "paragraph",
    content: [{ type: "text", text: block }],
  };
}

function splitPdfBlocks(text: string): string[] {
  const normalized = normalizePdfText(text);
  if (!normalized) return [];
  const separated = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (separated.length > 1) return separated;
  return normalized
    .split(/\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizePdfText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeHeading(block: string): boolean {
  if (block.length > 120) return false;
  if (/[.!?。！？]$/.test(block)) return false;
  const words = block.split(/\s+/).filter(Boolean);
  if (words.length > 14) return false;
  return words.length <= 8 || /^[A-Z0-9][A-Z0-9\s:;,.()[\]\-/]+$/.test(block);
}
