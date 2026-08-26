import type { RetrievalObjectType } from "./types.js";

export type RelationalIntentKind = "related_to" | "connection" | "sources_for" | "projects_related";

export interface RelationalIntent {
  kind: RelationalIntentKind;
  seedPhrases: string[];
  focusPhrases: string[];
  targetObjectTypes?: RetrievalObjectType[];
}

/**
 * Small deterministic parser for relation-heavy queries. It intentionally handles
 * only high-confidence shapes; ambiguous or ordinary free-text queries fall back
 * to the standard exact/lexical/vector/graph arms.
 */
export function parseRelationalIntent(query: string): RelationalIntent | null {
  const text = query.trim().replace(/\s+/g, " ");
  if (!text) return null;

  const connected = /^how\s+(?:is|are)\s+(.+?)\s+(?:connected|related|linked)\s+(?:to|with)\s+(.+?)\??$/i.exec(text);
  if (connected) {
    const first = cleanSeedPhrase(connected[1]);
    const second = cleanSeedPhrase(connected[2]);
    if (first && second) {
      return { kind: "connection", seedPhrases: [first], focusPhrases: [second] };
    }
  }

  const sources =
    /^(?:what\s+)?sources?\s+(?:support|supporting|for|about|related\s+to)\s+(.+?)\??$/i.exec(text) ??
    /^what\s+sources?\s+(?:back|cite)\s+(.+?)\??$/i.exec(text);
  if (sources) {
    const seed = cleanSeedPhrase(sources[1]);
    if (seed) {
      return {
        kind: "sources_for",
        seedPhrases: [seed],
        focusPhrases: [],
        targetObjectTypes: ["source"],
      };
    }
  }

  const projects = /^(?:which\s+)?projects?\s+(?:related\s+to|about|for|supporting)\s+(.+?)\??$/i.exec(text);
  if (projects) {
    const seed = cleanSeedPhrase(projects[1]);
    if (seed) {
      return {
        kind: "projects_related",
        seedPhrases: [seed],
        focusPhrases: [],
        targetObjectTypes: ["project_public_summary"],
      };
    }
  }

  const related =
    /^(?:who|what)\s+(?:works?\s+with|knows|(?:is|are)\s+related\s+to|(?:is|are)\s+connected\s+to|relates?\s+to|supports?)\s+(.+?)\??$/i.exec(text) ??
    /^(?:who|what)\s+(?:is|are)\s+(?:linked|connected|related)\s+(?:to|with)\s+(.+?)\??$/i.exec(text);
  if (related) {
    const seed = cleanSeedPhrase(related[1]);
    if (seed) return { kind: "related_to", seedPhrases: [seed], focusPhrases: [] };
  }

  return null;
}

function cleanSeedPhrase(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^[`"']+|[`"'.?!]+$/g, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .trim();
}
