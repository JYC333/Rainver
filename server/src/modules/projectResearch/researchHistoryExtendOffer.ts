import type { Queryable } from "../routeUtils/common.js";
import { objectValue, optionalString, stringArray } from "../routeUtils/common.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import { ARXIV_HISTORY_FLOOR } from "../sources/sourceBackfillStrategy.js";

/**
 * Offers the earlier history a bounded baseline left unread.
 *
 * The acquisition buys the newest N matches and stops, which is the half that
 * keeps a Room turn from silently spending hours and a million tokens. This
 * is the other half: the remainder is offered once, as a decision, at the
 * moment it can actually be acted on — the baseline is finished, its coverage
 * is recorded, and `startHistoricalBackfill` will accept the range. Offering
 * it at the start would have meant either blocking on an answer or queuing an
 * intent nothing could execute yet.
 *
 * Silent when there is nothing left: coverage already reaching the floor, no
 * recorded coverage, or a workflow that never bounded itself.
 */
export async function offerEarlierHistoryExtension(
  db: Queryable,
  input: {
    spaceId: string;
    projectId: string;
    workflowId: string;
    userId: string | null;
    operationProgress: Record<string, unknown>;
  },
): Promise<string | null> {
  const coverage = stringArray(
    (Array.isArray(objectValue(input.operationProgress).coverage_ranges)
      ? (objectValue(input.operationProgress).coverage_ranges as unknown[])
      : []
    ).flatMap((range) => {
      const from = optionalString(objectValue(range).from);
      return from ? [from] : [];
    }),
  );
  const history = objectValue(input.operationProgress).history;
  const earliestCovered = [...coverage, optionalString(objectValue(history).from) ?? ""]
    .filter((value) => value.length > 0)
    .sort()[0];
  if (!earliestCovered) return null;
  if (Date.parse(earliestCovered) <= Date.parse(ARXIV_HISTORY_FLOOR)) return null;

  const maxItems = Number(objectValue(history).max_items ?? 0);
  if (!Number.isInteger(maxItems) || maxItems < 1) return null;

  // One standing offer per range: a second identical proposal would be a
  // second card asking the same question about the same history.
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM proposals
      WHERE space_id = $1 AND project_id = $2 AND proposal_type = 'research_history_extend'
        AND status = 'pending' AND payload_json->>'workflow_id' = $3
      LIMIT 1`,
    [input.spaceId, input.projectId, input.workflowId],
  );
  if (existing.rows[0]) return null;

  const covered = new Date(earliestCovered).toISOString().slice(0, 10);
  const row = await insertProposalRow(db, {
    spaceId: input.spaceId,
    projectId: input.projectId,
    proposalType: "research_history_extend",
    title: `Read research history earlier than ${covered}`,
    summary: `This search read the ${maxItems} most recent matches, back to ${covered}. Accepting reads the same query's earlier history in a second pass.`,
    payload: {
      proposal_type: "research_history_extend",
      project_id: input.projectId,
      workflow_id: input.workflowId,
      from: ARXIV_HISTORY_FLOOR,
      to: earliestCovered,
      max_items: maxItems,
    },
    rationale: "The acquisition was bounded to keep its cost visible; the earlier history is a separate decision.",
    createdByUserId: input.userId,
    visibility: "space_shared",
    riskLevel: "low",
  });
  return String(row.id);
}
