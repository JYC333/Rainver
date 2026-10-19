import type { Queryable } from "../routeUtils/common.js";
import { withQueryableTransaction } from "../routeUtils/common.js";
import { profileMaturity, type ProfileMaturity } from "../interestProfile/maturity.js";
import { InterestProfileService } from "../interestProfile/service.js";
import { topicKeyFor } from "../interestProfile/topicKey.js";
import {
  PgInformationDigestRepository,
  type DigestCandidate,
  type DigestGenerationKind,
  type DigestPeriod,
  type PersistedDigest,
} from "./repository.js";
import { digestPeriod, digestTimezone, isCompleteDigestDay, latestCompleteDigestDate } from "./digestPeriod.js";
import { PgSerendipityRepository } from "./serendipityRepository.js";
import { selectSerendipity } from "./serendipitySelection.js";
import { canWriteProject } from "../projects/access.js";

const DEFAULT_PROJECT_SLOTS = 8;

interface RankedCandidate {
  candidate: DigestCandidate;
  matchedTopicId: string | null;
  matchedTopicLabel: string | null;
  score: number;
  components: Record<string, number>;
}

/** What the history read answers for a day: the snapshot, or why there is none. */
export type DigestLookup =
  | { status: "available"; digest: PersistedDigest }
  | {
      status: "missing";
      digest_date: string;
      timezone: string;
      period_start_utc: string;
      period_end_utc: string;
      reason: "day_not_complete" | "not_generated";
      /** Whether this viewer may request a backfill for this day now. */
      backfill_available: boolean;
    };

const BACKFILL_HISTORY_NOTE =
  "Rebuilt later from the material retained now. It has no outside-your-usual-view section, and it cannot reproduce a ranking that was never saved for this day.";

export class InformationDigestBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InformationDigestBackfillError";
  }
}

export class InformationDigestService {
  constructor(private readonly db: Queryable) {}

  /**
   * The snapshot for one day, read-only: no generation, no write, no
   * standby-pool movement. A day with no snapshot is answered as missing, with
   * whether a backfill may be requested for it.
   */
  async lookup(
    spaceId: string,
    scope: { type: "personal"; userId: string } | { type: "project"; projectId: string; readerUserId: string },
    requestedDate: string | null,
  ): Promise<DigestLookup> {
    const timezone = await digestTimezone(this.db, spaceId, scope.type === "personal"
      ? { type: "personal", userId: scope.userId }
      : { type: "project", projectId: scope.projectId });
    const date = requestedDate ?? latestCompleteDigestDate(timezone);
    assertDate(date);
    const repo = new PgInformationDigestRepository(this.db);
    const scopeKey = scope.type === "personal" ? scope.userId : scope.projectId;
    const readerUserId = scope.type === "personal" ? scope.userId : scope.readerUserId;
    const existing = await repo.findByScope(spaceId, scope.type, scopeKey, date);
    if (existing) return { status: "available", digest: (await repo.get(spaceId, existing.id, readerUserId))! };
    const period = digestPeriod(date, timezone);
    const complete = isCompleteDigestDay(date, timezone);
    // A Project's digest is backfilled by someone who may write to the
    // Project; a reader is told the day is missing, not offered a 403.
    const mayBackfill = scope.type === "personal"
      || await canWriteProject(this.db, spaceId, scope.projectId, scope.readerUserId);
    return {
      status: "missing",
      digest_date: date,
      timezone,
      period_start_utc: period.startUtc,
      period_end_utc: period.endUtc,
      reason: complete ? "not_generated" : "day_not_complete",
      backfill_available: complete && mayBackfill,
    };
  }

  /**
   * The scheduled pass for one day. Write-once and idempotent: a fire that
   * finds the day's snapshot — an earlier fire of the same slot after a
   * restart, or a backfill — returns it and changes nothing.
   */
  async scheduledPersonal(spaceId: string, userId: string, period: DigestPeriod, automationRunId: string | null): Promise<{ digest: PersistedDigest; created: boolean }> {
    return this.generatePersonal(spaceId, userId, period, "scheduled", automationRunId);
  }

  async scheduledProject(spaceId: string, projectId: string, readerUserId: string, period: DigestPeriod, automationRunId: string | null): Promise<{ digest: PersistedDigest; created: boolean }> {
    return this.generateProject(spaceId, projectId, readerUserId, period, "scheduled", automationRunId);
  }

  /**
   * An explicit request to build a missing day after the fact. Only a
   * complete day of the scope's timezone; never over an existing snapshot;
   * from the material retained now; without the serendipity section, which
   * would spend today's standby pool on a day that is over.
   */
  async backfillPersonal(spaceId: string, userId: string, date: string): Promise<{ digest: PersistedDigest; created: boolean }> {
    const period = await this.backfillPeriod(spaceId, { type: "personal", userId }, date);
    return this.generatePersonal(spaceId, userId, period, "backfill", null);
  }

  async backfillProject(spaceId: string, projectId: string, readerUserId: string, date: string): Promise<{ digest: PersistedDigest; created: boolean }> {
    const period = await this.backfillPeriod(spaceId, { type: "project", projectId }, date);
    return this.generateProject(spaceId, projectId, readerUserId, period, "backfill", null);
  }

  private async backfillPeriod(
    spaceId: string,
    scope: { type: "personal"; userId: string } | { type: "project"; projectId: string },
    date: string,
  ): Promise<DigestPeriod> {
    assertDate(date);
    const timezone = await digestTimezone(this.db, spaceId, scope);
    if (!isCompleteDigestDay(date, timezone)) {
      throw new InformationDigestBackfillError(`${date} has not ended in ${timezone}; only a complete day can be backfilled`);
    }
    return digestPeriod(date, timezone);
  }

  private async generatePersonal(
    spaceId: string,
    userId: string,
    period: DigestPeriod,
    kind: DigestGenerationKind,
    automationRunId: string | null,
  ): Promise<{ digest: PersistedDigest; created: boolean }> {
    assertDate(period.date);
    return withQueryableTransaction(this.db, async (tx) => {
      const repo = new PgInformationDigestRepository(tx);
      await repo.lockScope(spaceId, "personal", userId, period.date);
      const existing = await repo.findByScope(spaceId, "personal", userId, period.date);
      if (existing) return { digest: (await repo.get(spaceId, existing.id, userId))!, created: false };
      const profileService = new InterestProfileService(tx);
      await profileService.runFactLayer(spaceId, userId);
      const profileSettings = await profileService.settings(spaceId, userId);
      const inputs = await repo.maturityInputs(spaceId, userId);
      const maturity = profileMaturity(inputs, profileSettings);
      const candidates = await repo.personalCandidates(spaceId, userId, period);
      // Cold maturity keeps deterministic profile facts and does not use
      // fine-grained topics as a ranking signal.
      const topics = maturity === "cold" ? [] : await repo.activeTopics(spaceId, userId);
      const ranked = rankPersonal(candidates, topics, period, maturity);
      const selected = diversify(ranked, profileSettings.interest_slots);
      const serendipityRepo = new PgSerendipityRepository(tx);
      // A backfill never touches the standby pool: those items are today's to
      // deliver, and the day being rebuilt is over.
      const serendipity = kind === "backfill" ? [] : selectSerendipity(
        await serendipityRepo.listStandby(spaceId, userId, period.endUtc),
        await serendipityRepo.readingShape(spaceId, userId),
        maturity,
        profileSettings.serendipity_slots,
        new Date(period.endUtc),
      );
      const digestId = await repo.create({
        spaceId, type: "personal", ownerUserId: userId, period, generationKind: kind, maturity, automationRunId,
        settings: {
          interest_slots: profileSettings.interest_slots,
          serendipity_slots: kind === "backfill" ? 0 : profileSettings.serendipity_slots,
          ranking: maturity === "cold" ? "recency_source_diversity" : "topic_recency_source_diversity",
          ...(kind === "backfill" ? { history_note: BACKFILL_HISTORY_NOTE } : {}),
        },
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
      await serendipityRepo.markConsumed(serendipity.map((item) => item.candidate.pool_id), period.endUtc);
      return { digest: (await repo.get(spaceId, digestId, userId))!, created: true };
    });
  }

  private async generateProject(
    spaceId: string,
    projectId: string,
    readerUserId: string,
    period: DigestPeriod,
    kind: DigestGenerationKind,
    automationRunId: string | null,
  ): Promise<{ digest: PersistedDigest; created: boolean }> {
    assertDate(period.date);
    return withQueryableTransaction(this.db, async (tx) => {
      const repo = new PgInformationDigestRepository(tx);
      await repo.lockScope(spaceId, "project", projectId, period.date);
      const existing = await repo.findByScope(spaceId, "project", projectId, period.date);
      if (existing) return { digest: (await repo.get(spaceId, existing.id, readerUserId))!, created: false };
      const candidates = await repo.projectCandidates(spaceId, projectId, period);
      const selected = diversify(rankProject(candidates, period), DEFAULT_PROJECT_SLOTS);
      const digestId = await repo.create({
        spaceId, type: "project", projectId, period, generationKind: kind, maturity: null, automationRunId,
        settings: {
          interest_slots: DEFAULT_PROJECT_SLOTS,
          ranking: "project_triage_recency_source_diversity",
          serendipity: false,
          ...(kind === "backfill" ? { history_note: BACKFILL_HISTORY_NOTE } : {}),
        },
        items: selected.map((item, position) => ({
          candidate: item.candidate,
          section: "interest",
          position,
          quotaSlot: `project:${position + 1}`,
          matchedTopicId: null,
          score: item.score,
          componentScores: item.components,
          rationale: "Selected from the day's Project Corpus using triage, confidence, recency, and source diversity.",
        })),
      });
      return { digest: (await repo.get(spaceId, digestId, readerUserId))!, created: true };
    });
  }
}

function rankPersonal(
  candidates: DigestCandidate[],
  topics: Array<{ id: string; topic_key: string; aliases: string[]; weight: number }>,
  period: DigestPeriod,
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
    const recency = recencyScore(candidate, period);
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

function rankProject(candidates: DigestCandidate[], period: DigestPeriod): RankedCandidate[] {
  return candidates.map((candidate) => {
    const recency = recencyScore(candidate, period);
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

function recencyScore(candidate: DigestCandidate, period: DigestPeriod): number {
  const at = Date.parse(candidate.occurred_at ?? candidate.first_seen_at);
  const end = Date.parse(period.endUtc);
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
