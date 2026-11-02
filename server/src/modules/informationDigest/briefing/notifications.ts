import type { Queryable } from "../../routeUtils/common.js";
import { OperationalAlertService } from "../../notifications/operationalAlerts.js";
import { visibleResult } from "./authorization.js";
import type { BriefingScopeAdapter } from "./contract.js";
import type { BriefingRow } from "./repository.js";
import type { ValidatedBriefing } from "./result.js";

/**
 * Whether a just-published version tells its audience something new: a
 * delta (never a baseline) with at least one highlight the whole audience may
 * read now whose validated novelty is `new` or `update`. "Nothing new",
 * `ongoing`-only, failed or withheld versions are not news. Novelty is the
 * server-validated class (a `new` highlight must cite a new input, an
 * `update` a revised or evidenced change); a new URL that only repeats a
 * reported event is expected to be `ongoing`, which is no more than the model
 * and the validation can show — no event identity is claimed beyond it.
 */
export function isMeaningfulChange(row: Pick<BriefingRow, "comparison">, result: ValidatedBriefing, allowed: Set<string>): boolean {
  if (row.comparison !== "delta") return false;
  return visibleResult(result, allowed).highlights.some((highlight) => highlight.novelty === "new" || highlight.novelty === "update");
}

/**
 * One Inbox pointer per scope and recipient (B24A: a pointer, never content).
 * Each current audience member (the Project's readers; a personal briefing's
 * owner) gets a private notice under a stable key, so a later meaningful
 * version updates the same notice instead of adding one: at most one live
 * briefing notice per scope per person. The notice says only that the scope's
 * briefing changed — no Project name, title, label or text — and points at
 * the briefing surface, which re-authorizes everything when it is opened. A
 * person who has since lost access finds a generic pointer that opens
 * nothing. Written in the transaction that publishes the version, so a
 * settlement replay, a late attempt or a failed one never sends it.
 */
export async function notifyMeaningfulChange(db: Queryable, adapter: BriefingScopeAdapter, row: BriefingRow): Promise<number> {
  const recipients = await adapter.audience(db);
  const project = row.scope_type === "project";
  const alerts = new OperationalAlertService(db);
  for (const userId of recipients) {
    await alerts.emit({
      kind: "briefing_changes",
      title: project ? "A Project briefing has new changes" : "Your briefing has new changes",
      message: "Open the briefing to see what changed.",
      dedupeKey: `briefing:${row.scope_key}:${userId}`,
      spaceId: row.space_id,
      userId,
      // The Project stays inside the pointer, not on the notice: an Inbox reader no longer in it sees no name.
      projectId: null,
      resurface: "changed",
      payload: {
        pointer_type: "briefing_changes",
        scope_type: row.scope_type,
        project_id: row.project_id,
        briefing_id: row.id,
        version: row.version,
      },
    });
  }
  return recipients.length;
}
