import { HttpError, type Queryable } from "../../routeUtils/common.js";
import { visibleMessagePathSql } from "../../sessions/messagePath.js";
import type { RetrievalEgressDestination } from "../../retrieval/egress/egressPolicy.js";
import { comparisonClosure, inputDeps, type ComparisonEntry } from "./authorization.js";
import type { BriefingDeps, BriefingSignalDep } from "./contract.js";
import { lockProjectAudience } from "../../projects/access.js";
import { lockReadingPreferencesShared, ReadingPreferences } from "../readingPreferences.js";
import { authorizedHighlight } from "./highlight.js";
import { PgBriefingRepository, type BriefingRow } from "./repository.js";
import { highlightDependencies, type ValidatedBriefing } from "./result.js";
import { adapterForRow } from "./settlement.js";

/** A `briefing_highlight` reference message of a Room conversation, as stored at attach time. */
export interface BriefingReferenceMessage {
  id: string;
  content: string;
  metadata_json: unknown;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const isBriefingReference = (message: { metadata_json?: unknown }) =>
  record(record(message.metadata_json).reference).kind === "briefing_highlight";

/**
 * The briefing references attached for this Agent's next turn: those on the
 * conversation's visible path before the current message and after the
 * Agent's own last reply — the same window a resumed vendor session is sent
 * (`agentGroups/service.ts`, `listRoomMessagesSinceAgentTurn`). A fresh
 * session receives them as their own Delivery items, since nothing of the
 * transcript is replayed into it.
 */
export async function pendingBriefingReferences(
  db: Queryable,
  input: { spaceId: string; sessionId: string; currentMessageId: string; agentId: string },
): Promise<BriefingReferenceMessage[]> {
  const path = (alias: string) => visibleMessagePathSql({ alias, spaceParam: "$1", sessionParam: "$2" });
  return (await db.query<BriefingReferenceMessage>(
    `WITH current_message AS (
       SELECT path_depth, id FROM messages WHERE space_id = $1 AND session_id = $2 AND id = $3
     ), last_agent_message AS (
       SELECT message.path_depth, message.id
         FROM messages message JOIN current_message current ON true
        WHERE message.space_id = $1 AND message.session_id = $2
          AND message.sender_agent_id = $4 AND message.role = 'assistant'
          AND ${path("message")}
          AND (message.path_depth, message.id) < (current.path_depth, current.id)
        ORDER BY message.path_depth DESC, message.id DESC
        LIMIT 1
     )
     SELECT message.id, message.content, message.metadata_json
       FROM messages message
       JOIN current_message current ON true
       LEFT JOIN last_agent_message last_agent ON true
      WHERE message.space_id = $1 AND message.session_id = $2
        AND message.role = 'system'
        AND message.metadata_json->'reference'->>'kind' = 'briefing_highlight'
        AND ${path("message")}
        AND (message.path_depth, message.id) < (current.path_depth, current.id)
        AND (last_agent.id IS NULL OR (message.path_depth, message.id) > (last_agent.path_depth, last_agent.id))
      ORDER BY message.path_depth ASC, message.id ASC`,
    [input.spaceId, input.sessionId, input.currentMessageId, input.agentId],
  )).rows;
}

/** What a briefing reference names: its briefing, highlight and attacher, or a refusal when it cannot be verified. */
function referenceOf(message: { metadata_json?: unknown }): { briefingId: string; index: number; attacher: string } {
  const provenance = record(record(message.metadata_json).reference);
  const briefingId = typeof provenance.source_id === "string" ? provenance.source_id : null;
  const index = provenance.highlight;
  const attacher = typeof provenance.attached_by_user_id === "string" ? provenance.attached_by_user_id : null;
  if (!briefingId || !attacher || typeof index !== "number" || !Number.isInteger(index)) {
    throw new HttpError(409, "A briefing reference without its highlight cannot be verified", { code: "briefing_reference_unverifiable" });
  }
  return { briefingId, index, attacher };
}

/**
 * The authorization closure of the briefing references a Delivery carries,
 * locked (`FOR SHARE`, or the shared side of an advisory lock) for the
 * Delivery transaction before it re-verifies them, and held until the
 * Delivery commits: a revocation through any canonical writer either commits
 * first and is refused on re-verification, or waits for this Delivery.
 *
 * It is what `authorizedHighlight` reads for the copy — the overview (a
 * withheld overview withholds the briefing), the highlight's own refs and the
 * comparison closure of earlier versions — in this order:
 * 1. the briefing rows;
 * 2. the audience: a Project briefing's whole Project audience
 *    (`lockProjectAudience`, whose membership writers take the conflicting
 *    lock); a personal briefing's owner — their Reading opt-ins
 *    (`lockReadingPreferencesShared`), their `users` and Space membership
 *    rows and their standing in each opted-in Project;
 * 3. context roots: Tasks, personal Following Goals (a Brief's version is the
 *    Project row, already held);
 * 4. scope signals: Following goal items with their binding and Goal,
 *    monitoring decisions with their Project link, Corpus entries, channel
 *    item links with their channel;
 * 5. content grants on those Tasks, Source items and Source connections, and
 *    every user's subscription to those connections.
 * The Source items and connections themselves are returned, sorted, for the
 * caller to lock through the Delivery's canonical Source locks.
 */
export async function lockBriefingReferenceClosure(
  db: Queryable,
  spaceId: string,
  messages: ReadonlyArray<{ id: string; metadata_json?: unknown }>,
): Promise<{ attachers: string[]; itemIds: string[]; connectionIds: string[] }> {
  return lockBriefingClosure(db, spaceId, messages.filter(isBriefingReference).map(referenceOf).map((reference) => ({
    briefingId: reference.briefingId,
    viewer: reference.attacher,
    refs: (row: BriefingRow) => {
      const result = row.result_json as ValidatedBriefing | null;
      const highlight = row.status === "ready" ? result?.highlights[reference.index] : undefined;
      return result && highlight ? new Set([...result.overview.refs, ...highlightDependencies(highlight)]) : null;
    },
  })));
}

/**
 * The same closure for a whole version a Run is generating: everything
 * `authorizeVersion` reads for it — every included input and context entry,
 * and the comparison closure — for its requester. Locked by the Delivery of
 * that Run (`runtimeContext/gateway.ts`) before it re-authorizes the version.
 */
export async function lockBriefingVersionClosure(
  db: Queryable,
  spaceId: string,
  briefingId: string,
  requester: string,
): Promise<{ attachers: string[]; itemIds: string[]; connectionIds: string[] }> {
  const repository = new PgBriefingRepository(db);
  const inputs = await repository.inputs(briefingId);
  return lockBriefingClosure(db, spaceId, [{
    briefingId,
    viewer: requester,
    refs: (row: BriefingRow) => new Set([
      ...inputs.filter((input) => input.ref_kind === "source_item" && input.ref_key && input.status === "included").map((input) => input.ref_key!),
      ...row.context_json.map((entry) => entry.key),
    ]),
  }]);
}

async function lockBriefingClosure(
  db: Queryable,
  spaceId: string,
  targets: ReadonlyArray<{ briefingId: string; viewer: string; refs: (row: BriefingRow) => Set<string> | null }>,
): Promise<{ attachers: string[]; itemIds: string[]; connectionIds: string[] }> {
  const references = targets;
  const repository = new PgBriefingRepository(db);
  const items = new Set<string>();
  const connections = new Set<string>();
  const signals: BriefingSignalDep[] = [];
  const tasks = new Set<string>();
  const goals = new Set<string>();
  const projects = new Set<string>();
  const owners = new Set<string>();
  for (const briefingId of [...new Set(references.map((reference) => reference.briefingId))].sort()) {
    await db.query(`SELECT id FROM information_briefings WHERE space_id = $1 AND id = $2 FOR SHARE`, [spaceId, briefingId]);
  }
  for (const reference of references) {
    const row = await repository.get(spaceId, reference.briefingId);
    const refs = row ? reference.refs(row) : null;
    if (!row || !refs) continue; // re-verification refuses it
    if (row.scope_type === "project" && row.project_id) projects.add(row.project_id);
    if (row.scope_type === "personal" && row.owner_user_id) owners.add(row.owner_user_id);
    const closure = comparisonClosure((row.comparison_json ?? []) as ComparisonEntry[]);
    const deps: BriefingDeps[] = (await repository.inputs(row.id))
      .filter((input) => input.ref_kind === "source_item" && input.ref_key && refs.has(input.ref_key))
      .map(inputDeps);
    deps.push(closure.deps);
    for (const entry of deps) {
      for (const item of entry.items) { items.add(item.id); if (item.connection_id) connections.add(item.connection_id); }
      for (const dep of [...entry.annotations, ...entry.signals]) if (dep.connection_id) connections.add(dep.connection_id);
      signals.push(...entry.signals);
    }
    const context = [...row.context_json.filter((entry) => refs.has(entry.key)).map((entry) => entry.source), ...closure.context];
    for (const source of context) {
      if (source.type === "task") tasks.add(source.id);
      if (source.type === "goal") goals.add(source.id);
    }
  }
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
  // 2. Audience.
  const ownerList = sorted(owners);
  for (const owner of ownerList) {
    await lockReadingPreferencesShared(db, { spaceId, userId: owner });
    for (const projectId of await new ReadingPreferences(db).enabled({ spaceId, userId: owner })) projects.add(projectId);
  }
  for (const projectId of sorted(projects)) await lockProjectAudience(db, spaceId, projectId);
  if (ownerList.length) {
    await db.query(`SELECT id FROM users WHERE id = ANY($1::varchar[]) ORDER BY id FOR SHARE`, [ownerList]);
    await db.query(`SELECT id FROM space_memberships WHERE space_id = $1 AND user_id = ANY($2::varchar[]) ORDER BY id FOR SHARE`, [spaceId, ownerList]);
  }
  // 3. Context roots.
  const share = async (sql: string, ids: string[]) => { if (ids.length) await db.query(sql, [spaceId, ids]); };
  await share(`SELECT id FROM tasks WHERE space_id = $1 AND id = ANY($2::varchar[]) ORDER BY id FOR SHARE`, sorted(tasks));
  await share(`SELECT id FROM source_goals WHERE space_id = $1 AND id = ANY($2::varchar[]) ORDER BY id FOR SHARE`, sorted(goals));
  // 4. Scope signals.
  const ids = (kind: BriefingSignalDep["kind"]) => sorted(signals.filter((dep) => dep.kind === kind).map((dep) => dep.id));
  await share(
    `SELECT gi.id FROM source_goal_items gi
       JOIN source_goals g ON g.id = gi.goal_id AND g.space_id = gi.space_id
      WHERE gi.space_id = $1 AND gi.id = ANY($2::varchar[]) ORDER BY gi.id FOR SHARE OF gi, g`,
    ids("goal_item"),
  );
  await share(
    `SELECT b.id FROM source_goal_bindings b
      WHERE b.space_id = $1 AND b.id IN (SELECT binding_id FROM source_goal_items WHERE space_id = $1 AND id = ANY($2::varchar[]))
      ORDER BY b.id FOR SHARE`,
    ids("goal_item"),
  );
  await share(`SELECT id FROM source_post_processing_item_decisions WHERE space_id = $1 AND id = ANY($2::varchar[]) ORDER BY id FOR SHARE`, ids("decision"));
  await share(
    `SELECT pl.id FROM project_source_item_links pl
      WHERE pl.space_id = $1 AND pl.source_item_id IN (SELECT source_item_id FROM source_post_processing_item_decisions WHERE space_id = $1 AND id = ANY($2::varchar[]))
      ORDER BY pl.id FOR SHARE`,
    ids("decision"),
  );
  await share(`SELECT id FROM project_corpus_items WHERE space_id = $1 AND id = ANY($2::varchar[]) ORDER BY id FOR SHARE`, ids("corpus_item"));
  await share(
    `SELECT l.id FROM source_channel_item_links l
       JOIN source_channels ch ON ch.id = l.source_channel_id AND ch.space_id = l.space_id
      WHERE l.space_id = $1 AND l.id = ANY($2::varchar[]) ORDER BY l.id FOR SHARE OF l, ch`,
    ids("subscription"),
  );
  // 5. Grants and subscriptions of the whole audience.
  const resources = [...sorted(tasks).map((id) => ["task", id]), ...sorted(items).map((id) => ["source_item", id]), ...sorted(connections).map((id) => ["source_connection", id])];
  if (resources.length) {
    await db.query(
      `SELECT grant_row.id FROM content_access_grants grant_row
         JOIN unnest($2::varchar[], $3::varchar[]) AS resource(type, id)
           ON grant_row.resource_type = resource.type AND grant_row.resource_id = resource.id
        WHERE grant_row.space_id = $1 ORDER BY grant_row.id FOR SHARE OF grant_row`,
      [spaceId, resources.map(([type]) => type), resources.map(([, id]) => id)],
    );
  }
  await share(
    `SELECT subscription.id FROM source_channel_user_subscriptions subscription
       JOIN source_channels channel ON channel.id = subscription.source_channel_id AND channel.space_id = subscription.space_id
      WHERE subscription.space_id = $1 AND channel.source_connection_id = ANY($2::varchar[])
      ORDER BY subscription.id FOR SHARE OF subscription, channel`,
    sorted(connections),
  );
  const attachers = sorted(references.map((reference) => reference.viewer));
  return { attachers, itemIds: sorted(items), connectionIds: sorted(connections) };
}

/**
 * The model-egress gate of a briefing reference, at the moment its text would
 * reach a model: the copy was the person's to make at attach time, but where
 * it goes is fixed only by the Run — the destination its Delivery is
 * authorized for (`runtimeContext/runDestination.ts`: the Run's own adapter
 * and ModelProvider, never the live runtime Profile, which may have been
 * edited, enabled or switched since). For every briefing reference the
 * Delivery carries, the highlight is re-authorized as its attacher reads it
 * (the whole briefing still standing for its audience, every dependency
 * still readable) and its Sources must consent to that destination through
 * the one Source egress gate. Refusals throw: nothing is planned or
 * delivered. Inside a Delivery, lock `lockBriefingReferenceClosure` first.
 */
export async function assertBriefingReferencesDeliverable(
  db: Queryable,
  spaceId: string,
  messages: ReadonlyArray<{ id: string; metadata_json?: unknown }>,
  destination: RetrievalEgressDestination | null,
): Promise<void> {
  const references = messages.filter(isBriefingReference).map(referenceOf);
  if (!references.length) return;
  if (!destination) {
    throw new HttpError(409, "A briefing reference can only reach a turn whose model destination is known", { code: "briefing_reference_execution_unresolved" });
  }
  const repository = new PgBriefingRepository(db);
  for (const reference of references) {
    const row = await repository.get(spaceId, reference.briefingId);
    if (!row) throw new HttpError(409, "The briefing a reference points at is not available", { code: "reference_source_unavailable" });
    await authorizedHighlight(db, adapterForRow(row), row.id, reference.index, reference.attacher, { egress: [{ destination }] });
  }
}
