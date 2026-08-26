import type { Queryable } from "../routeUtils/common.js";
import { InterestProfileService } from "../interestProfile/service.js";
import { topicKeyFor } from "../interestProfile/topicKey.js";
import { PgSerendipityRepository } from "./serendipityRepository.js";

export const INTEREST_STARTER_PACKS = [
  { key: "technology", label: "Technology", topics: [
    { label: "Artificial intelligence", domainKey: "artificial_intelligence" },
    { label: "Software engineering", domainKey: "software_engineering" },
    { label: "Security and privacy", domainKey: "security_privacy" },
  ] },
  { key: "science", label: "Science", topics: [
    { label: "Biology", domainKey: "biology" },
    { label: "Physics", domainKey: "physics" },
    { label: "Research practice", domainKey: "research_practice" },
  ] },
  { key: "world", label: "World and society", topics: [
    { label: "Economics", domainKey: "economics" },
    { label: "Politics and governance", domainKey: "politics_governance" },
    { label: "History", domainKey: "history" },
  ] },
] as const;

export class InterestStarterPackService {
  constructor(private readonly db: Queryable) {}

  async apply(spaceId: string, userId: string, key: string, at = new Date()): Promise<{ topics: number; source_recommendations: number }> {
    const pack = INTEREST_STARTER_PACKS.find((candidate) => candidate.key === key);
    if (!pack) throw new Error("Unknown interest starter pack");
    const profiles = new InterestProfileService(this.db);
    const existing = new Set((await profiles.snapshot(spaceId, userId)).topics.map((topic) => topic.topic_key));
    let created = 0;
    for (const topic of pack.topics) {
      const topicKey = topicKeyFor(topic.label);
      if (existing.has(topicKey)) continue;
      await profiles.createTopic(spaceId, userId, topic);
      created += 1;
    }
    const sourceRecommendations = await new PgSerendipityRepository(this.db).recommendExistingSources(
      spaceId, userId, pack.topics.map((topic) => topic.domainKey), at.toISOString().slice(0, 10), pack.topics.length,
    );
    return { topics: created, source_recommendations: sourceRecommendations };
  }
}
