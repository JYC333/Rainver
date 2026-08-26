import { sha256 } from "../sourceRepositoryMappers.js";

/**
 * Real TypeScript port of the string-processing heuristics embedded as a
 * text template in `customSourceHandlerTemplate.ts` (the `typescript_node`
 * generation mode's generated `.cjs` handler). The declarative pipeline
 * interpreter (`customSourcePipelineInterpreter.ts`) calls these directly —
 * it runs trusted, in-process code, so there is no need to serialize this
 * logic into a string executed by a spawned child process the way the
 * code-template mode must.
 *
 * Deliberately the same shallow heuristics as the code-template mode for
 * parity: one CSS class name identifies repeated list items, not a full CSS
 * selector or DOM parser. See
 * `.agent/architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md` for the Level 1/2/3
 * split.
 */

export interface CustomSourcePipelineSnapshot {
  snapshot_type: string;
  file_path: string;
  mime_type: string;
}

export interface CustomSourcePipelineEvidence {
  evidence_type: string;
  title: string;
  content_excerpt?: string | null;
  confidence?: number | null;
}

export interface CustomSourcePipelineItem {
  external_id: string;
  title: string;
  source_uri: string;
  published_at?: string | null;
  author?: string | null;
  excerpt?: string | null;
  metadata?: Record<string, unknown>;
  snapshots: CustomSourcePipelineSnapshot[];
  evidence: CustomSourcePipelineEvidence[];
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTagText(html: string, tag: string): string | null {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? stripTags(match[1]!).trim() : null;
}

export function extractHref(html: string): string | null {
  const match = html.match(/href\s*=\s*["']([^"']+)["']/i);
  return match ? match[1]! : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitBlocksByClass(html: string, className: string): string[] {
  const pattern = new RegExp(
    `<[a-zA-Z0-9]+[^>]*class\\s*=\\s*["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>`,
    "gi",
  );
  const opens = [...html.matchAll(pattern)];
  const blocks: string[] = [];
  for (let i = 0; i < opens.length; i++) {
    const start = opens[i]!.index!;
    const end = i + 1 < opens.length ? opens[i + 1]!.index! : html.length;
    blocks.push(html.slice(start, end));
  }
  return blocks;
}

export function resolveUrl(href: string | null, baseUrl: string | null): string | null {
  if (!href) return baseUrl || null;
  try {
    return new URL(href, baseUrl || undefined).toString();
  } catch {
    return baseUrl || null;
  }
}

export function bodyOnly(html: string): string {
  const match = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return match ? match[1]! : html;
}

export function buildSinglePageItem(input: {
  html: string;
  endpointUrl: string | null;
  fallbackTitle: string;
}): CustomSourcePipelineItem {
  const endpointUrl = input.endpointUrl || input.fallbackTitle;
  const title = extractTagText(input.html, "title") || input.fallbackTitle || "Untitled";
  const excerpt = input.html ? stripTags(bodyOnly(input.html)).slice(0, 4000) : null;
  return {
    external_id: sha256(endpointUrl),
    title: title.slice(0, 512),
    source_uri: endpointUrl,
    excerpt: excerpt || null,
    metadata: {},
    snapshots: [],
    evidence: excerpt
      ? [{ evidence_type: "excerpt", title: "Captured page excerpt", content_excerpt: excerpt.slice(0, 1000), confidence: 0.5 }]
      : [],
  };
}

export function buildListItems(input: {
  html: string;
  cssClass: string;
  baseUrl: string | null;
  maxItems: number;
}): CustomSourcePipelineItem[] {
  const blocks = splitBlocksByClass(input.html, input.cssClass).slice(0, Math.max(1, input.maxItems));
  return blocks.map((block, index) => {
    const href = extractHref(block);
    const link = resolveUrl(href, input.baseUrl) || input.baseUrl || `item-${index}`;
    const title =
      extractTagText(block, "a") || extractTagText(block, "h2") || extractTagText(block, "h3") || `Item ${index + 1}`;
    const excerpt = stripTags(block).slice(0, 2000) || null;
    return {
      external_id: sha256(`${link}#${index}`),
      title: title.slice(0, 512),
      source_uri: link,
      excerpt,
      metadata: {},
      snapshots: [],
      evidence: [],
    };
  });
}
