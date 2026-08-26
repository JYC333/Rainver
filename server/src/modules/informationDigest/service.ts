import type { Queryable } from "../routeUtils/common.js";
import { withQueryableTransaction } from "../routeUtils/common.js";
import { profileMaturity, type ProfileMaturity } from "../interestProfile/maturity.js";
import { InterestProfileService } from "../interestProfile/service.js";
import { topicKeyFor } from "../interestProfile/topicKey.js";
import { PgInformationDigestRepository, type DigestCandidate, type PersistedDigest } from "./repository.js";
import { PgSerendipityRepository } from "./serendipityRepository.js";
import { selectSerendipity } from "./serendipitySelection.js";

export const DEFAULT_INTEREST_SLOTS = 6;
export const DEFAULT_PROJECT_SLOTS = 8;
export const DEFAULT_SERENDIPITY_SLOTS = 2;

interface RankedCandidate {
  candidate: DigestCandidate;
  matchedTopicId: string | null;
  matchedTopicLabel: string | null;
  score: number;
  components: Record<string, number>;
}

export class InformationDigestService {
  constructor(private readonly db: Queryable) {}

  async personal(spaceId: string, userId: string, date: string, runId?: string | null): Promise<PersistedDigest> {
    assertDate(date);
    const existing = await new PgInformationDigestRepository(this.db).findByScope(spaceId, "personal", userId, date);
    // A read may materialize an early empty snapshot. The scheduled Run is the
    // authoritative once-daily pass and must replace that snapshot rather than
    // treating its existence as completed work.
    if (existing && (!runId || existing.generated_by_run_id)) {
      return (await new PgInformationDigestRepository(this.db).get(spaceId, existing.id, userId))!;
    }
    return withQueryableTransaction(this.db, async (tx) => {
      const repo = new PgInformationDigestRepository(tx);
      await repo.lockScope(spaceId, "personal", userId, date);
      const lockedExisting = await repo.findByScope(spaceId, "personal", userId, date);
      if (lockedExisting && (!runId || lockedExisting.generated_by_run_id)) {
        return (await repo.get(spaceId, lockedExisting.id, userId))!;
      }
      const profileService = new InterestProfileService(tx);
      await profileService.runFactLayer(spaceId, userId);
      const profileSettings = await profileService.settings(spaceId, userId);
      const inputs = await repo.maturityInputs(spaceId, userId);
      const maturity = profileMaturity(inputs, profileSettings);
      const candidates = await repo.personalCandidates(spaceId, userId, date);
      // Cold still maintains deterministic profile facts, but does not use
      // fine-grained topics as a ranking signal yet.
      const topics = maturity === "cold" ? [] : await repo.activeTopics(spaceId, userId);
      const ranked = rankPersonal(candidates, topics, date, maturity);
      const selected = diversify(ranked, profileSettings.interest_slots);
      const serendipityRepo = new PgSerendipityRepository(tx);
      const readingShape = await serendipityRepo.readingShape(spaceId, userId);
      const digestCutoff = new Date(`${date}T23:59:59.999Z`);
      const serendipity = selectSerendipity(
        await serendipityRepo.listStandby(spaceId, userId, digestCutoff.toISOString()),
        readingShape,
        maturity,
        profileSettings.serendipity_slots,
        digestCutoff,
      );
      const digestId = await repo.replace({
        spaceId, type: "personal", ownerUserId: userId, date, maturity, runId,
        settings: { interest_slots: profileSettings.interest_slots, serendipity_slots: profileSettings.serendipity_slots, ranking: maturity === "cold" ? "recency_source_diversity" : "topic_recency_source_diversity" },
        items: [
          ...selected.map((item, position) => ({
          candidate: item.candidate,
          section: "interest" as const,
          position,
          quotaSlot: `interest:${position + 1}`,
          matchedTopicId: item.matchedTopicId,
          score: item.score,
          componentScores: item.components,
          rationale: item.matchedTopicLabel
            ? `Matches ${item.matchedTopicLabel}; balanced for recency and source diversity.`
            : "Selected for recency and source diversity while the interest profile develops.",
          })),
          ...serendipity.map((item, index) => ({
            candidate: item.candidate,
            section: "serendipity" as const,
            position: selected.length + index,
            quotaSlot: item.quotaSlot,
            matchedTopicId: null,
            serendipityPoolItemId: item.candidate.pool_id,
            score: item.score,
            componentScores: item.components,
            rationale: item.rationale,
          })),
        ],
      });
      await serendipityRepo.markConsumed(serendipity.map((item) => item.candidate.pool_id), digestCutoff.toISOString());
      return (await repo.get(spaceId, digestId, userId))!;
    });
  }

  async project(spaceId: string, projectId: string, readerUserId: string, date: string, runId?: string | null): Promise<PersistedDigest> {
    assertDate(date);
    const existing = await new PgInformationDigestRepository(this.db).findByScope(spaceId, "project", projectId, date);
    if (existing && (!runId || existing.generated_by_run_id)) {
      return (await new PgInformationDigestRepository(this.db).get(spaceId, existing.id, readerUserId))!;
    }
    return withQueryableTransaction(this.db, async (tx) => {
      const repo = new PgInformationDigestRepository(tx);
      await repo.lockScope(spaceId, "project", projectId, date);
      const lockedExisting = await repo.findByScope(spaceId, "project", projectId, date);
      if (lockedExisting && (!runId || lockedExisting.generated_by_run_id)) {
        return (await repo.get(spaceId, lockedExisting.id, readerUserId))!;
      }
      const candidates = await repo.projectCandidates(spaceId, projectId, date);
      const selected = diversify(rankProject(candidates, date), DEFAULT_PROJECT_SLOTS);
      const digestId = await repo.replace({
        spaceId, type: "project", projectId, date, maturity: null, runId,
        settings: { interest_slots: DEFAULT_PROJECT_SLOTS, ranking: "project_triage_recency_source_diversity", serendipity: false },
        items: selected.map((item, position) => ({
          candidate: item.candidate,
          section: "interest",
          position,
          quotaSlot: `project:${position + 1}`,
          matchedTopicId: null,
          score: item.score,
          componentScores: item.components,
          rationale: "Selected from today's Project Corpus using triage, confidence, recency, and source diversity.",
        })),
      });
      return (await repo.get(spaceId, digestId, readerUserId))!;
    });
  }
}

function rankPersonal(
  candidates: DigestCandidate[],
  topics: Array<{ id: string; topic_key: string; aliases: string[]; weight: number }>,
  date: string,
  maturity: ProfileMaturity,
): RankedCandidate[] {
  const topicLookup = new Map<string, { id: string; label: string; weight: number }>();
  for (const topic of topics) {
    topicLookup.set(topic.topic_key, { id: topic.id, label: topic.topic_key, weight: topic.weight });
    for (const alias of topic.aliases) topicLookup.set(alias, { id: topic.id, label: topic.topic_key, weight: topic.weight });
  }
  return candidates.map((candidate) => {
    const matches = candidate.topic_candidates
      .map((phrase) => topicLookup.get(topicKeyFor(phrase)))
      .filter((topic): topic is { id: string; label: string; weight: number } => Boolean(topic))
      .sort((a, b) => b.weight - a.weight);
    const matched = matches[0] ?? null;
    const recency = recencyScore(candidate, date);
    const topic = maturity === "cold" ? 0 : Math.min(1, (matched?.weight ?? 0) / 2);
    return {
      candidate,
      matchedTopicId: matched?.id ?? null,
      matchedTopicLabel: matched?.label ?? null,
      score: round(recency * (maturity === "cold" ? 1 : 0.55) + topic * (maturity === "cold" ? 0 : 0.45)),
      components: { recency, topic_match: topic },
    };
  }).sort(compareRanked);
}

function rankProject(candidates: DigestCandidate[], date: string): RankedCandidate[] {
  return candidates.map((candidate) => {
    const recency = recencyScore(candidate, date);
    const triage = candidate.project_relevance === "relevant" ? 1 : candidate.project_relevance === "maybe" ? 0.6 : 0.35;
    const confidence = candidate.project_confidence ?? 0.5;
    return {
      candidate, matchedTopicId: null, matchedTopicLabel: null,
      score: round(triage * 0.45 + confidence * 0.35 + recency * 0.2),
      components: { project_triage: triage, project_confidence: confidence, recency },
    };
  }).sort(compareRanked);
}

/** First pass caps any connection at two slots; remaining capacity then fills by score. */
function diversify(ranked: RankedCandidate[], limit: number): RankedCandidate[] {
  const selected: RankedCandidate[] = [];
  const deferred: RankedCandidate[] = [];
  const bySource = new Map<string, number>();
  for (const item of ranked) {
    const key = item.candidate.connection_id ?? `item:${item.candidate.source_item_id}`;
    if ((bySource.get(key) ?? 0) >= 2) deferred.push(item);
    else {
      selected.push(item);
      bySource.set(key, (bySource.get(key) ?? 0) + 1);
    }
    if (selected.length === limit) return selected;
  }
  for (const item of deferred) {
    selected.push(item);
    if (selected.length === limit) break;
  }
  return selected;
}

function recencyScore(candidate: DigestCandidate, date: string): number {
  const at = Date.parse(candidate.occurred_at ?? candidate.first_seen_at);
  const end = Date.parse(`${date}T23:59:59.999Z`);
  if (!Number.isFinite(at)) return 0;
  return round(Math.max(0, Math.min(1, 1 - (end - at) / 86_400_000)));
}

function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  return b.score - a.score || a.candidate.source_item_id.localeCompare(b.candidate.source_item_id);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function assertDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!match || year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!) {
    throw new Error(`Invalid digest date ${JSON.stringify(value)}`);
  }
}
