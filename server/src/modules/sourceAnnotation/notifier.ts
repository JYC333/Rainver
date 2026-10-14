import type { Queryable } from "../routeUtils/common.js";
import { OperationalAlertService } from "../notifications/operationalAlerts.js";
import { PgSourceAnnotationRepository, type AnnotationEpisodeSummary } from "./repository.js";
import { ANNOTATION_MAX_ATTEMPTS_PER_EPISODE, type AnnotationWaitReason } from "./retryPolicy.js";

/**
 * One Inbox notification per failure episode and responsible person.
 *
 * The notification is a pointer (B24A): the reason, how many of *this
 * person's* items it holds, when the next automatic retry is scheduled —
 * only when one is, a condition wait shows the condition instead of a
 * countdown — and where to retry by hand. It is upserted under a stable key
 * as the episode moves and retired when the episode clears, so a person sees
 * one evolving notice rather than one per sweep. A private item of another
 * member never appears in it, and neither does its count.
 */
export class SourceAnnotationRecoveryNotifier {
  constructor(private readonly db: Queryable) {}

  async sync(spaceId: string): Promise<void> {
    const alerts = new OperationalAlertService(this.db);
    const summaries = await new PgSourceAnnotationRepository(this.db).episodeSummaries(spaceId);
    const live = new Set<string>();
    for (const summary of summaries) {
      if (!summary.responsible_user_id) continue;
      const key = dedupeKey(summary);
      live.add(key);
      await alerts.emit({
        kind: "source_annotation_recovery",
        title: title(summary.wait_reason),
        message: message(summary),
        dedupeKey: key,
        spaceId,
        userId: summary.responsible_user_id,
        payload: {
          episode_id: summary.episode_id,
          reason: summary.wait_reason,
          affected_count: summary.affected_count,
          next_retry_at: summary.next_retry_at,
          connection_ids: summary.connection_ids,
          retry_available: true,
          pointer: { surface: "library", path: "/library" },
        },
      });
    }
    for (const key of await alerts.liveDedupeKeys(spaceId, "source_annotation:")) {
      if (!live.has(key)) await alerts.clear(spaceId, key);
    }
  }
}

/**
 * The alert row already carries its Space, so the key names only the person
 * and the episode — short enough that the stored aggregate key is never cut,
 * which is what lets a later sync recognize its own live notices.
 */
function dedupeKey(summary: AnnotationEpisodeSummary): string {
  return `source_annotation:${summary.responsible_user_id}:${summary.episode_id}`;
}

function title(reason: AnnotationWaitReason): string {
  switch (reason) {
    case "retry_scheduled":
      return "Source annotation will retry";
    case "budget_exhausted":
      return "Source annotation paused";
    case "provider_unavailable":
      return "Source annotation is waiting for a model Provider";
    case "egress_denied":
      return "Source annotation is waiting for egress permission";
    case "consent_missing":
      return "Source annotation is waiting for Source consent";
  }
}

function message(summary: AnnotationEpisodeSummary): string {
  const count = `${summary.affected_count} of your items`;
  switch (summary.wait_reason) {
    case "retry_scheduled":
      return `${count} failed to annotate; the next automatic retry is scheduled for ${summary.next_retry_at ?? "the next sweep"}. You can also retry from Library.`;
    case "budget_exhausted":
      return `${count} failed ${ANNOTATION_MAX_ATTEMPTS_PER_EPISODE} times and are paused. Retry from Library when the cause is fixed.`;
    case "provider_unavailable":
      return `${count} are waiting until this Space has an annotation Provider. No retry is scheduled until one is configured.`;
    case "egress_denied":
      return `${count} are waiting until their Source may be sent to the annotation Provider. No retry is scheduled until egress is allowed.`;
    case "consent_missing":
      return `${count} are waiting until their Source grants consent. No retry is scheduled until it does.`;
  }
}
