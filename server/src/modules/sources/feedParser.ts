import { XMLParser } from "fast-xml-parser";
import { excerpt } from "./contentParsing.js";

export interface ParsedFeedItem {
  title: string;
  url: string | null;
  externalId: string | null;
  author: string | null;
  occurredAt: string | null;
  excerpt: string | null;
  metadata: Record<string, unknown>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

export function parseFeed(xml: string, connectorKey: "rss" | "atom" | string): ParsedFeedItem[] {
  const root = record(parser.parse(xml));
  if (connectorKey === "atom" || root.feed) {
    return parseAtom(root.feed);
  }
  return parseRss(root.rss ?? root["rdf:RDF"] ?? root);
}

function parseRss(rootValue: unknown): ParsedFeedItem[] {
  const root = record(rootValue);
  const channel = first(root.channel) ?? root;
  const items = asArray(record(channel).item ?? root.item);
  return items.map((itemValue) => {
    const item = record(itemValue);
    const title = text(item.title) ?? text(item.link) ?? text(item.guid) ?? "Untitled feed item";
    const url = pdfEnclosureUrl(item.enclosure) ?? text(item.link);
    const externalId = text(item.guid) ?? url ?? title;
    const body = text(item["content:encoded"]) ?? text(item.description) ?? text(item.summary);
    return {
      title,
      url,
      externalId,
      author: text(item.author) ?? text(item["dc:creator"]),
      occurredAt: dateIso(text(item.pubDate) ?? text(item.published) ?? text(item["dc:date"])),
      excerpt: body ? excerpt(body) : null,
      metadata: {
        feed_type: "rss",
        categories: asArray(item.category).map(text).filter((value): value is string => Boolean(value)),
      },
    };
  });
}

function parseAtom(rootValue: unknown): ParsedFeedItem[] {
  const feed = record(rootValue);
  return asArray(feed.entry).map((entryValue) => {
    const entry = record(entryValue);
    const url = atomLink(entry.link);
    const title = text(entry.title) ?? url ?? text(entry.id) ?? "Untitled feed item";
    const body = text(entry.summary) ?? text(entry.content);
    return {
      title,
      url,
      externalId: text(entry.id) ?? url ?? title,
      author: atomAuthor(entry.author),
      occurredAt: dateIso(text(entry.published) ?? text(entry.updated)),
      excerpt: body ? excerpt(body) : null,
      metadata: {
        feed_type: "atom",
        updated_at: dateIso(text(entry.updated)),
      },
    };
  });
}

function atomLink(value: unknown): string | null {
  const links = asArray(value);
  const pdfEnclosure = links.find((item) => {
    const row = record(item);
    return text(row["@rel"]) === "enclosure" && isPdfLink(text(row["@href"]), text(row["@type"]));
  });
  if (pdfEnclosure) return text(record(pdfEnclosure)["@href"]) ?? text(pdfEnclosure);
  const preferred =
    links.find((item) => {
      const row = record(item);
      const rel = text(row["@rel"]);
      return !rel || rel === "alternate";
    }) ?? links[0];
  const row = record(preferred);
  return text(row["@href"]) ?? text(preferred);
}

function pdfEnclosureUrl(value: unknown): string | null {
  for (const item of asArray(value)) {
    const row = record(item);
    const url = text(row["@url"]) ?? text(row.url) ?? text(item);
    if (isPdfLink(url, text(row["@type"]) ?? text(row.type))) return url;
  }
  return null;
}

function isPdfLink(url: string | null, mimeType: string | null): url is string {
  if (!url) return false;
  if (mimeType?.toLowerCase().split(";")[0]?.trim() === "application/pdf") return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return url.split("?")[0]?.toLowerCase().endsWith(".pdf") ?? false;
  }
}

function atomAuthor(value: unknown): string | null {
  const author = first(value);
  const row = record(author);
  return text(row.name) ?? text(author);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function first(value: unknown): unknown {
  return asArray(value)[0];
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const out = String(value).trim();
    return out || null;
  }
  const row = record(value);
  return text(row["#text"]) ?? text(row["#cdata"]);
}

function dateIso(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
