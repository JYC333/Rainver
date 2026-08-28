import { type Queryable, type SpaceUserIdentity, withQueryableTransaction } from "../routeUtils/common.js";
import { InquirySignalService } from "../inquiry/signalService.js";
import { KnowledgePromotionCandidateService } from "../knowledgePromotion/candidateService.js";

/**
 * Composes one bounded human checkpoint without taking ownership of either
 * domain's Candidate or packet lifecycle. Decisions continue through the
 * Inquiry and Knowledge APIs referenced in each section.
 */
export class ProjectReviewSessionService {
  constructor(private readonly db: Queryable) {}

  async open(identity: SpaceUserIdentity, projectId: string, limit = 5): Promise<Record<string, unknown>> {
    const boundedLimit = Math.max(1, Math.min(limit, 20));
    return withQueryableTransaction(this.db, async (db) => {
      const inquiry = await new InquirySignalService(db).openReviewPacket(identity, projectId, boundedLimit);
      const knowledge = await new KnowledgePromotionCandidateService(db).openReviewPacket(identity, projectId, boundedLimit);
      const inquiryCandidates = candidatesFrom(inquiry);
      const knowledgeCandidates = candidatesFrom(knowledge);
      return {
        project_id: projectId,
        created_at: new Date().toISOString(),
        summary: inquiryCandidates.length + knowledgeCandidates.length === 0
          ? "No material Inquiry or Knowledge changes need review."
          : `${inquiryCandidates.length} Inquiry change${inquiryCandidates.length === 1 ? "" : "s"} and ${knowledgeCandidates.length} Knowledge change${knowledgeCandidates.length === 1 ? "" : "s"} need review.`,
        sections: {
          inquiry: {
            packet: inquiry,
            decision_href: `/projects/${projectId}/inquiry`,
          },
          knowledge: {
            packet: knowledge,
            decision_href: `/projects/${projectId}/inquiry?view=review&tab=candidates`,
          },
        },
      };
    });
  }
}

function candidatesFrom(packet: Record<string, unknown>): unknown[] {
  return Array.isArray(packet.candidates) ? packet.candidates : [];
}
