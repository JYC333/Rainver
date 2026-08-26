import type { SourceItemRow } from "../sourceRepositoryRows.js";

export const ARXIV_NEW_PAPERS_CONTENT_PROFILE = "arxiv_new_papers";

export const ARXIV_NEW_PAPERS_PROFILE_GUIDANCE = [
  "- Treat the input as newly materialized arXiv papers.",
  "- For screening runs, judge papers as Must read, Maybe, or Ignore before writing the digest.",
  "- Group papers by primary category or topic when that makes the digest easier to scan.",
  "- For notable papers, include the title, authors, arXiv id, category, research question, method, contribution, why it matters, and a concrete next action.",
  "- Use arXiv metadata fields when present; do not infer category, version, DOI, or publication dates that are not supplied.",
  "- Prefer research signal over feed mechanics; skip generic source bookkeeping unless it affects follow-up.",
];

export function arxivPostProcessingItemMetadataLines(item: SourceItemRow): string[] {
  const metadata = recordValue(item.metadata_json);
  if (!metadata) return [];
  const lines: string[] = [];
  const arxivId = stringValue(metadata.arxiv_id);
  const version = stringValue(metadata.arxiv_version);
  if (arxivId) lines.push(`arXiv: ${arxivId}${version ? ` ${version}` : ""}`);
  const primaryCategory = stringValue(metadata.primary_category);
  const categories = stringList(metadata.categories);
  if (primaryCategory || categories.length > 0) {
    const categoryLabels = [
      primaryCategory,
      ...categories.filter((category) => category !== primaryCategory),
    ].filter((category): category is string => Boolean(category));
    lines.push(`Categories: ${categoryLabels.join(", ")}`);
  }
  const publishedAt = stringValue(metadata.published_at);
  const updatedAt = stringValue(metadata.updated_at);
  if (publishedAt || updatedAt) {
    lines.push(`Published/updated: ${publishedAt ?? "unknown"} / ${updatedAt ?? "unknown"}`);
  }
  const doi = stringValue(metadata.doi);
  if (doi) lines.push(`DOI: ${doi}`);
  const comment = stringValue(metadata.comment);
  if (comment) lines.push(`Comment: ${comment.slice(0, 500)}`);
  return lines;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}
