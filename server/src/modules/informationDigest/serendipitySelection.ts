import { adjacentDomainKeys, distantDomainKeys, getDomain } from "../sourceAnnotation";
import type { ProfileMaturity } from "../interestProfile/maturity";
import type { ReadingShape, StandbyCandidate } from "./serendipityRepository";

export interface SelectedSerendipity {
  candidate: StandbyCandidate;
  quotaSlot: string;
  score: number;
  components: Record<string, number>;
  rationale: string;
}

/** Separate quotas: a distant item is selected before adjacent/exploration. */
export function selectSerendipity(
  candidates: readonly StandbyCandidate[],
  shape: ReadingShape,
  maturity: ProfileMaturity,
  limit = 2,
  at = new Date(),
): SelectedSerendipity[] {
  if (limit < 1 || candidates.length === 0) return [];
  const adjacent = new Set(adjacentDomainKeys(shape.coveredDomains));
  const distant = new Set(distantDomainKeys(shape.coveredDomains));
  // With no coverage every domain is legitimately unknown. Treat the first as
  // the guaranteed distant slot and the remainder as exploration; pretending
  // adjacency exists would invent a relationship the cold profile does not know.
  const ranked = candidates
    .map((candidate) => rank(candidate, shape, at))
    .sort((left, right) => right.score - left.score
      || left.candidate.target_domain_key.localeCompare(right.candidate.target_domain_key)
      || left.candidate.source_item_id.localeCompare(right.candidate.source_item_id));
  const selected: SelectedSerendipity[] = [];
  const used = new Set<string>();
  const distantPool = ranked.filter((item) => maturity === "cold" || distant.has(item.candidate.target_domain_key));
  // For an established reading shape the first slot is genuinely reserved:
  // adjacent material cannot silently occupy it when the standby pool lacks a
  // distant candidate. Cold readers have no meaningful adjacency yet.
  const first = distantPool[0];
  if (first) {
    selected.push(withSlot(first, "serendipity:distant:1", "distant"));
    used.add(first.candidate.pool_id);
  }
  const remainingSlots = Math.max(0, limit - 1);
  for (let index = 0; index < remainingSlots; index += 1) {
    const oppositionChoice = ranked.find((item) => !used.has(item.candidate.pool_id) && isOpposing(item.candidate, shape));
    const adjacentChoice = ranked.find((item) => !used.has(item.candidate.pool_id) && adjacent.has(item.candidate.target_domain_key));
    const fallback = ranked.find((item) => !used.has(item.candidate.pool_id));
    const choice = oppositionChoice ?? adjacentChoice ?? fallback;
    if (!choice) break;
    const kind = oppositionChoice ? "opposition" : adjacentChoice ? "adjacent" : "exploration";
    selected.push(withSlot(choice, `serendipity:${kind}:${index + 1}`, kind));
    used.add(choice.candidate.pool_id);
  }
  return selected;
}

function rank(candidate: StandbyCandidate, shape: ReadingShape, at: Date): SelectedSerendipity {
  const depthInversion = inversionScore(candidate.depth, shape.depthCounts);
  const genreInversion = inversionScore(candidate.genre, shape.genreCounts);
  const atMs = at.getTime();
  const rotation = candidate.last_surfaced_at ? Math.min(1, Math.max(0, (atMs - Date.parse(candidate.last_surfaced_at)) / (30 * 86_400_000))) : 1;
  const recencyAt = Date.parse(candidate.occurred_at ?? candidate.first_seen_at);
  const recency = Number.isFinite(recencyAt) ? Math.max(0, Math.min(1, 1 - (atMs - recencyAt) / (90 * 86_400_000))) : 0;
  const stanceOpposition = isOpposing(candidate, shape) ? 1 : 0;
  const score = round(rotation * 0.35 + depthInversion * 0.15 + genreInversion * 0.15 + recency * 0.15 + stanceOpposition * 0.2);
  return {
    candidate,
    quotaSlot: "",
    score,
    components: { rotation, depth_inversion: depthInversion, genre_inversion: genreInversion, recency, stance_opposition: stanceOpposition },
    rationale: "",
  };
}

function withSlot(item: SelectedSerendipity, quotaSlot: string, kind: string): SelectedSerendipity {
  const domain = getDomain(item.candidate.target_domain_key);
  const label = domain?.label ?? item.candidate.target_domain_key;
  const origin = item.candidate.discovery_origin === "source_recommendation"
    ? "from a source outside your subscriptions"
    : "from this week's bounded outside-source probe";
  const oppositionSuffix = item.components.stance_opposition === 1
    ? ` It also reaches the opposite conclusion on ${item.candidate.stance_target}, a topic you have read.`
    : "";
  return {
    ...item,
    quotaSlot,
    rationale: kind === "distant"
      ? `Why you are seeing this: ${label} is distant from your current coverage and was found ${origin}.${oppositionSuffix}`
      : kind === "adjacent"
        ? `Why you are seeing this: ${label} borders domains you read, with depth/genre chosen to vary your usual mix.`
        : kind === "opposition"
          ? `Why you are seeing this: it reaches the opposite conclusion on ${item.candidate.stance_target}, a topic you have read.`
        : `Why you are seeing this: ${label} is an exploration direction ${origin}.`,
  };
}

function isOpposing(candidate: StandbyCandidate, shape: ReadingShape): boolean {
  if (!candidate.stance_target_key || candidate.stance_confidence < 60) return false;
  const observed = shape.stanceByTarget[candidate.stance_target_key];
  return (observed === "supports" && candidate.stance_polarity === "opposes")
    || (observed === "opposes" && candidate.stance_polarity === "supports");
}

function inversionScore(value: string, counts: Record<string, number>): number {
  const max = Math.max(0, ...Object.values(counts));
  if (max === 0) return 1;
  return round(1 - (counts[value] ?? 0) / max);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
