import type { Queryable } from "../routeUtils/common";
import { domainDefinitions, isKnownDomain } from "../sourceAnnotation";
import {
  PgInterestProfileRepository,
  type CoverageEntry,
  type InterestTopicRow,
  type TopicCandidateRow,
} from "./repository";
import { profileMaturity, explorationShare, gapsAreMeaningful, skeletonSize, type ProfileMaturity } from "./maturity";
import { topicKeyFor } from "./topicKey";
import {
  mergeInterestProfileSettings,
  resolveInterestProfileSettings,
  type InterestProfileSettings,
} from "./settings";

/** Items the fact layer accounts for in one pass. */
export const FACT_LAYER_BATCH_SIZE = 200;

export interface ProfileSnapshot {
  profile_id: string;
  maturity: ProfileMaturity;
  read_item_count: number;
  covered_domain_count: number;
  skeleton_size: number;
  exploration_share: number;
  gaps_are_meaningful: boolean;
  coverage: CoverageEntry[];
  topics: InterestTopicRow[];
  ready_candidates: TopicCandidateRow[];
  settings: InterestProfileSettings;
}

export interface FactLayerResult {
  observed_items: number;
  topic_hits: number;
  candidate_phrases: number;
}

/**
 * The interest profile's deterministic half.
 *
 * Everything here is arithmetic over events that already happened: what the
 * reader read, which domains it fell in, which phrases recurred. No approval,
 * no model call. The semantic half — deciding that a recurring phrase *means*
 * a new interest — is confirmation-gated and lives with the owner, because
 * "what happened" and "what it means" have very different error costs.
 */
export class InterestProfileService {
  private readonly repo: PgInterestProfileRepository;

  constructor(db: Queryable) {
    this.repo = new PgInterestProfileRepository(db);
  }

  /**
   * Reads the profile as consumers see it.
   *
   * Always returns a usable snapshot, including for a reader who has done
   * nothing at all — that is the `cold` case, and it is a normal state rather
   * than an absent one.
   */
  async snapshot(spaceId: string, userId: string): Promise<ProfileSnapshot> {
    const profile = await this.repo.ensureProfile(spaceId, userId);
    const settings = resolveInterestProfileSettings(profile.settings_json);
    const [inputs, coverage, topics, candidates] = await Promise.all([
      this.repo.maturityInputs(spaceId, userId),
      this.repo.coverageByDomain(spaceId, userId, settings.coverage_half_life_days),
      this.repo.listTopics(profile.id),
      this.repo.listReadyCandidates(profile.id),
    ]);
    const maturity = profileMaturity(inputs, settings);
    return {
      profile_id: profile.id,
      maturity,
      read_item_count: inputs.readItemCount,
      covered_domain_count: inputs.coveredDomainCount,
      skeleton_size: skeletonSize(),
      exploration_share: explorationShare(maturity),
      gaps_are_meaningful: gapsAreMeaningful(maturity),
      coverage,
      topics,
      ready_candidates: candidates,
      settings,
    };
  }

  /**
   * Accounts for annotated items this profile has not seen yet.
   *
   * Resolves each annotation's topic phrases against the reader's topics, and
   * accumulates the rest as candidates. Idempotent through the observation
   * ledger, so it is safe to run on any schedule or re-run over a window.
   */
  async runFactLayer(
    spaceId: string,
    userId: string,
    limit = FACT_LAYER_BATCH_SIZE,
  ): Promise<FactLayerResult> {
    const profile = await this.repo.ensureProfile(spaceId, userId);
    const settings = resolveInterestProfileSettings(profile.settings_json);
    const pending = await this.repo.loadPendingAnnotations(spaceId, userId, profile.id, limit);
    if (pending.length === 0) return { observed_items: 0, topic_hits: 0, candidate_phrases: 0 };

    const topics = await this.repo.listTopics(profile.id);
    const byKey = new Map<string, InterestTopicRow>();
    for (const topic of topics) {
      byKey.set(topic.topic_key, topic);
      for (const alias of topic.aliases) byKey.set(alias, topic);
    }

    let topicHits = 0;
    const unresolved: {
      phraseKey: string;
      display: string;
      domainKey: string;
      wasRead: boolean;
      occurrenceIsNew: boolean;
    }[] = [];
    for (const item of pending) {
      if (item.was_ignored) continue;
      for (const phrase of item.topic_candidates) {
        const key = topicKeyFor(phrase);
        if (!key) continue;
        if (byKey.has(key)) {
          topicHits += 1;
          continue;
        }
        // A phrase only counts toward a new topic when its item's domain is one
        // the skeleton knows; otherwise the eventual topic could not be placed
        // on the coverage axis at all.
        if (!isKnownDomain(item.domain_key)) continue;
        unresolved.push({
          phraseKey: key,
          display: phrase.slice(0, 128),
          domainKey: item.domain_key,
          wasRead: item.was_read,
          // An item revisited because it has since been read already had its
          // occurrence counted; counting it again would let one item drive the
          // occurrence threshold on its own.
          occurrenceIsNew: !item.already_observed,
        });
      }
    }

    await this.repo.accumulateCandidates({
      spaceId,
      userId,
      profileId: profile.id,
      phrases: unresolved,
      settings,
    });
    await this.repo.markObserved(
      spaceId,
      profile.id,
      pending.map((item) => ({ sourceItemId: item.source_item_id, countedAsRead: item.was_read })),
    );

    return {
      observed_items: pending.length,
      topic_hits: topicHits,
      candidate_phrases: unresolved.length,
    };
  }

  /**
   * Turns a candidate the owner accepted into a topic.
   *
   * This is the confirmation boundary: nothing else in the fact layer may
   * create a topic. The candidate is removed rather than left behind, so the
   * same phrase does not keep being offered after it became a real topic.
   */
  async acceptCandidate(
    spaceId: string,
    userId: string,
    phraseKey: string,
    overrides: { label?: string; domainKey?: string } = {},
  ): Promise<InterestTopicRow> {
    const profile = await this.repo.ensureProfile(spaceId, userId);
    const candidate = await this.repo.getCandidate(profile.id, phraseKey);
    if (!candidate) throw new Error(`no topic candidate ${JSON.stringify(phraseKey)}`);
    const domainKey = overrides.domainKey ?? candidate.domain_key;
    if (!domainKey || !isKnownDomain(domainKey)) {
      throw new Error("a topic needs a known domain to sit on the coverage axis");
    }
    const topic = await this.repo.upsertTopic({
      spaceId,
      userId,
      profileId: profile.id,
      label: overrides.label ?? candidate.display_phrase,
      domainKey,
      origin: "user",
      aliases: [candidate.phrase_key],
    });
    await this.repo.clearCandidate(profile.id, phraseKey);
    return topic;
  }

  async dismissCandidate(spaceId: string, userId: string, phraseKey: string): Promise<boolean> {
    const profile = await this.repo.ensureProfile(spaceId, userId);
    return this.repo.dismissCandidate(profile.id, phraseKey);
  }

  async settings(spaceId: string, userId: string): Promise<InterestProfileSettings> {
    const profile = await this.repo.getProfile(spaceId, userId);
    return resolveInterestProfileSettings(profile?.settings_json);
  }

  async updateSettings(
    spaceId: string,
    userId: string,
    patch: Partial<InterestProfileSettings>,
  ): Promise<InterestProfileSettings> {
    const profile = await this.repo.ensureProfile(spaceId, userId);
    const settings = mergeInterestProfileSettings(profile.settings_json, patch);
    await this.repo.updateSettings(profile.id, settings);
    return settings;
  }

  async createTopic(
    spaceId: string,
    userId: string,
    input: { label: string; domainKey: string; weight?: number },
  ): Promise<InterestTopicRow> {
    const profile = await this.repo.ensureProfile(spaceId, userId);
    return this.repo.upsertTopic({
      spaceId, userId, profileId: profile.id, label: input.label,
      domainKey: input.domainKey, weight: input.weight, origin: "user",
    });
  }

  async updateTopic(
    spaceId: string,
    userId: string,
    topicKey: string,
    input: { label: string; domainKey: string; weight: number },
  ): Promise<InterestTopicRow | null> {
    const profile = await this.repo.ensureProfile(spaceId, userId);
    return this.repo.updateTopic(profile.id, topicKey, input);
  }

  async archiveTopic(spaceId: string, userId: string, topicKey: string): Promise<boolean> {
    const profile = await this.repo.ensureProfile(spaceId, userId);
    return this.repo.archiveTopic(profile.id, topicKey);
  }

  /**
   * Domains carrying no weighted coverage — the raw gap set.
   *
   * Returned regardless of maturity, with `gaps_are_meaningful` on the snapshot
   * saying whether a caller should treat them as real. A cold profile reports
   * nearly the whole skeleton here, which is correct: it is what makes
   * serendipity computable on day one instead of being a special case.
   */
  async uncoveredDomains(spaceId: string, userId: string): Promise<string[]> {
    const settings = await this.settings(spaceId, userId);
    const coverage = await this.repo.coverageByDomain(spaceId, userId, settings.coverage_half_life_days);
    const covered = new Set(coverage.filter((entry) => entry.weighted_count > 0).map((entry) => entry.domain_key));
    return domainDefinitions()
      .map((domain) => domain.key)
      .filter((key) => !covered.has(key));
  }
}
