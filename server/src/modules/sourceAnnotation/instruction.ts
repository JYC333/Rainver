import { domainDefinitions } from "./domainSkeleton";
import {
  ANNOTATION_DEPTH_HINTS,
  ANNOTATION_GENRE_HINTS,
  MAX_TOPIC_CANDIDATES,
} from "./vocabulary";
import { SOURCE_ANNOTATION_SCHEMA_ID } from "./resultParser";

export interface AnnotationPromptItem {
  id: string;
  title: string;
  excerpt: string | null;
  author: string | null;
  source_domain: string | null;
  occurred_at: string | null;
}

const MAX_EXCERPT_CHARS = 900;

/**
 * The annotation prompt.
 *
 * It asks only for what the item *is* — never whether it is interesting.
 * Relevance is the cross-source layer's job and depends on a reader the
 * annotation pass has no business knowing about: annotation is written once per
 * item and shared by every reader in the space, so a judgement made here would
 * leak one reader's taste into everyone else's ranking.
 */
export function renderAnnotationInstruction(items: readonly AnnotationPromptItem[]): string {
  const lines: string[] = [];
  lines.push("Classify each source item below. Describe what each item *is*, not whether it is interesting or relevant to anyone.");
  lines.push("");
  lines.push("## Domains");
  lines.push("Assign exactly one domain per item. Pick the closest one; every item gets a domain.");
  for (const domain of domainDefinitions()) {
    lines.push(`- \`${domain.key}\` — ${domain.label}: ${domain.hint}`);
  }
  lines.push("");
  lines.push("## Depth");
  lines.push("How far past the surface the item goes.");
  for (const [depth, hint] of Object.entries(ANNOTATION_DEPTH_HINTS)) {
    lines.push(`- \`${depth}\` — ${hint}`);
  }
  lines.push("");
  lines.push("## Genre");
  lines.push("What kind of writing it is.");
  for (const [genre, hint] of Object.entries(ANNOTATION_GENRE_HINTS)) {
    lines.push(`- \`${genre}\` — ${hint}`);
  }
  lines.push("");
  lines.push("## Topic candidates");
  lines.push(
    `Up to ${MAX_TOPIC_CANDIDATES} short noun phrases naming the specific subject matter (for example "retrieval-augmented generation", "EU battery regulation").`,
  );
  lines.push("Use the most standard name for the subject; prefer the full form over an abbreviation. Do not restate the domain.");
  lines.push("");
  lines.push("## Summary");
  lines.push("One or two sentences stating what the item says. No evaluation, no recommendation, no second person.");
  lines.push("");
  lines.push("## Stance");
  lines.push("If the item reaches a conclusion about a claim or policy, name the shortest standard noun phrase for that claim in `stance_target` and classify the conclusion as `supports` or `opposes`.");
  lines.push("Use the same target phrase for arguments on opposite sides. Use `mixed` or `neutral` with a null target when no clean opposing conclusion exists. Give confidence from 0 to 100.");
  lines.push("");
  lines.push("## Items");
  for (const item of items) {
    lines.push("");
    lines.push(`### ${item.id}`);
    lines.push(`- title: ${item.title}`);
    if (item.author) lines.push(`- author: ${item.author}`);
    if (item.source_domain) lines.push(`- published on: ${item.source_domain}`);
    if (item.occurred_at) lines.push(`- date: ${item.occurred_at}`);
    if (item.excerpt) {
      lines.push("- excerpt:");
      lines.push(truncate(item.excerpt, MAX_EXCERPT_CHARS));
    }
  }
  lines.push("");
  lines.push(
    `Return exactly one JSON object matching schema ${SOURCE_ANNOTATION_SCHEMA_ID}, with one entry per item id above and no others.`,
  );
  return lines.join("\n");
}

function truncate(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}
