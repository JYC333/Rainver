import { tokenizeSimple } from "./normalize.js";
import { DEFAULT_RANKING_SIGNALS, type RankingSignalConfig } from "./ranking.js";

/**
 * Deterministic, query-only intent classification (W3 of the context-layer
 * roadmap). the context-and-retrieval design routes a query into entity / temporal / event / general and
 * applies per-type ranking knobs; agent-space mirrors that with a rule-based
 * classifier (no LLM) whose only input is the query STRING — so it has no access
 * surface and is fully testable.
 *
 * Intent NEVER changes which arms run or which objects are eligible; it only
 * selects access-neutral ranking knobs (a RankingSignalConfig variant). So an
 * intent guess can reorder results but can never drop recall or leak anything —
 * the read gate and the recall arms are unaffected.
 */
export type RetrievalIntent = "entity" | "temporal" | "event" | "general";

// Time references → favor recency. Word-boundary matched against the lowercased query.
const TEMPORAL_PATTERNS: readonly RegExp[] = [
  /\b(today|yesterday|tomorrow|tonight|now|currently|current|recent|recently|latest|lately|upcoming)\b/,
  /\b(this|last|next|past)\s+(week|month|quarter|year|day|night|sprint)\b/,
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/,
  /\b(19|20)\d{2}\b/, // a 4-digit year
  /\b(\d+\s+(day|week|month|year)s?\s+ago|ago|since|until|when|deadline|due\s+date)\b/,
];

// Things that happened / are scheduled → favor sources + some recency.
const EVENT_PATTERNS: readonly RegExp[] = [
  /\b(meeting|standup|stand-up|sync|call|kickoff|kick-off|demo|retro|retrospective|postmortem|post-mortem)\b/,
  /\b(incident|outage|launch|release|deploy|deployment|rollout|interview|onboarding|ceremony|event|happened)\b/,
];

/**
 * Classify the query. Precedence: explicit time references (temporal) and event
 * vocabulary (event) win first; a short / name-like query is treated as an entity
 * lookup; everything else is general. Empty/blank queries are general.
 */
export function classifyIntent(query: string): RetrievalIntent {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return "general";
  if (TEMPORAL_PATTERNS.some((pattern) => pattern.test(normalized))) return "temporal";
  if (EVENT_PATTERNS.some((pattern) => pattern.test(normalized))) return "event";
  if (isEntityLike(query)) return "entity";
  return "general";
}

/**
 * A short query, or a multi-word query dominated by capitalized tokens, reads as
 * a named-thing lookup. Uses the raw query for capitalization; falls back to the
 * tokenized length for the short-query case.
 */
function isEntityLike(query: string): boolean {
  const contentTokens = tokenizeSimple(query);
  if (contentTokens.length === 0) return false;
  if (contentTokens.length <= 3) return true;
  const rawTokens = query.trim().split(/\s+/);
  const capitalized = rawTokens.filter((token) => /^[A-Z][a-zA-Z]/.test(token)).length;
  return capitalized >= 2 && contentTokens.length <= 6;
}

/**
 * Per-intent ranking knobs, expressed as overrides of the default signal config.
 * Each knob is access-neutral (it only scales boosts computed from a candidate's
 * own metadata), so swapping configs by intent stays within invariant 2.
 */
export function rankingConfigForIntent(intent: RetrievalIntent): RankingSignalConfig {
  switch (intent) {
    case "entity":
      // Name/title lookups: lean harder on exact-name and title-phrase matches.
      return { ...DEFAULT_RANKING_SIGNALS, nameMatchBoost: 1.16, titlePhraseBoost: 1.18 };
    case "temporal":
      // Time-sensitive: stronger, faster-decaying recency.
      return { ...DEFAULT_RANKING_SIGNALS, recencyHalfLifeDays: 21, recencyMaxBoost: 1.25 };
    case "event":
      // Events are often captured as sources/activity: lift the source tier and
      // give a mild recency nudge.
      return {
        ...DEFAULT_RANKING_SIGNALS,
        sourceTier: { ...DEFAULT_RANKING_SIGNALS.sourceTier, source: 1.12 },
        recencyMaxBoost: 1.15,
      };
    case "general":
      return DEFAULT_RANKING_SIGNALS;
  }
}
