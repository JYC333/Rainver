import type { BriefingAdoptionPreview, BriefingAdoptionResult } from "@rainver/protocol";
import { HttpError, withQueryableTransaction, type Pool, type Queryable, type SpaceUserIdentity } from "../../routeUtils/common.js";
import { assertProjectWriterForMutation, lockActiveProjectForMutation } from "../../projects/access.js";
import { PgTaskRepository } from "../../tasks/repository.js";
import { sha256, type BriefingScopeAdapter } from "./contract.js";
import { authorizedHighlight, renderHighlight, scopeLabelOf, scopedBriefing, type AuthorizedHighlight } from "./highlight.js";

const PRIORITY = { high: "high", medium: "normal", low: "low" } as const;

/** One adoption per highlight of a version: the business key repeated clicks, retries and races share. */
const adoptionKey = (briefingId: string, index: number) => `briefing-adoption:${briefingId}:${index}`;

interface Draft { title: string; description: string; project_id: string | null; visibility: "space_shared" | "private" }

/**
 * The Task a highlight becomes, in the briefing's own scope only: a Project
 * briefing's highlight becomes a shared Task of that Project (a writer's
 * act); a personal briefing's becomes its owner's private Task — never a
 * shared one, so nothing private is copied into a Project.
 */
async function draftOf(db: Queryable, target: AuthorizedHighlight): Promise<Draft> {
  const project = target.row.scope_type === "project";
  return {
    title: target.highlight.title.slice(0, 200),
    description: renderHighlight(target, await scopeLabelOf(db, target.row)),
    project_id: project ? target.row.project_id : null,
    visibility: project ? "space_shared" : "private",
  };
}

const hashOf = (target: AuthorizedHighlight, draft: Draft) => sha256([target.row.id, target.index, draft.title, draft.description, draft.project_id, draft.visibility]);

/**
 * The Task this highlight already became, only as the caller may read it
 * through the canonical Task read gate. A Task under the key that the caller
 * cannot read is neither returned nor duplicated.
 */
async function existingAdoption(db: Queryable, identity: SpaceUserIdentity, key: string): Promise<
  { readable: true; task: BriefingAdoptionResult["task"] } | { readable: false } | null
> {
  const ids = (await db.query<{ id: string }>(
    `SELECT id FROM tasks
      WHERE space_id = $1 AND deleted_at IS NULL AND metadata_json->'briefing_adoption'->>'key' = $2
      ORDER BY created_at, id`,
    [identity.spaceId, key],
  )).rows;
  if (!ids.length) return null;
  const tasks = new PgTaskRepository(db as Pool);
  for (const { id } of ids) {
    const task = await tasks.findReadableTask(identity, id, db);
    if (task) return { readable: true, task: { id: task.id as string, title: task.title as string, project_id: (task.project_id as string | null) ?? null } };
  }
  return { readable: false };
}

async function assertMayAdopt(db: Queryable, adapter: BriefingScopeAdapter, userId: string): Promise<void> {
  if (!(await adapter.canGenerate(db, userId))) {
    throw new HttpError(403, "Adopting a highlight as a Task requires write access", { code: "briefing_writer_required" });
  }
}

/** What confirming would create, from the highlight as it stands now. Read-only. */
export async function previewAdoption(
  db: Queryable,
  adapter: BriefingScopeAdapter,
  identity: SpaceUserIdentity,
  briefingId: string,
  index: number,
): Promise<BriefingAdoptionPreview> {
  await assertMayAdopt(db, adapter, identity.userId);
  const target = await authorizedHighlight(db, adapter, briefingId, index, identity.userId);
  const draft = await draftOf(db, target);
  const existing = await existingAdoption(db, identity, adoptionKey(target.row.id, index));
  return {
    briefing_id: target.row.id,
    highlight: index,
    ...draft,
    preview_hash: hashOf(target, draft),
    existing_task_id: existing?.readable ? existing.task.id : null,
  };
}

/**
 * Creates the previewed Task through the canonical Task writer (its
 * `task.created` event included), under a per-highlight lock: a repeated
 * click, a retried request or a concurrent one returns the Task the first
 * created. The highlight is re-authorized and re-drafted in the same
 * transaction; if anything it rests on or says changed since the preview,
 * the confirmation is refused and a new preview is needed. The Task keeps
 * its provenance (briefing, version, highlight, refs, evidence and context
 * sources); afterwards it follows the ordinary Task sharing rules. No Memory
 * or Knowledge is written.
 */
export async function confirmAdoption(
  pool: Pool,
  adapter: BriefingScopeAdapter,
  identity: SpaceUserIdentity,
  briefingId: string,
  index: number,
  previewHash: string,
): Promise<BriefingAdoptionResult> {
  return withQueryableTransaction(pool, async (tx) => {
    // Scope and authority first: nothing is looked up by this briefing's id
    // for a caller who may not act on that briefing in this scope.
    await assertMayAdopt(tx, adapter, identity.userId);
    const row = await scopedBriefing(tx, adapter, briefingId, identity.userId);
    if (adapter.scope.projectId) {
      await lockActiveProjectForMutation(tx, identity.spaceId, adapter.scope.projectId);
      await assertProjectWriterForMutation(tx, identity.spaceId, adapter.scope.projectId, identity.userId);
    }
    const key = adoptionKey(row.id, index);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${identity.spaceId}:${key}`]);
    const existing = await existingAdoption(tx, identity, key);
    if (existing?.readable) return { created: false, task: existing.task };
    if (existing) throw new HttpError(409, "This highlight was already adopted as a Task you cannot open", { code: "briefing_adoption_exists" });
    const target = await authorizedHighlight(tx, adapter, briefingId, index, identity.userId);
    const draft = await draftOf(tx, target);
    if (hashOf(target, draft) !== previewHash) {
      throw new HttpError(409, "This highlight changed since it was previewed; preview it again", { code: "briefing_adoption_changed" });
    }
    const task = await new PgTaskRepository(pool).createTask({ spaceId: identity.spaceId, userId: identity.userId }, {
      title: draft.title,
      description: draft.description,
      visibility: draft.visibility,
      project_id: draft.project_id,
      priority: PRIORITY[target.highlight.importance],
      metadata_json: {
        source: "information_briefing",
        briefing_adoption: {
          key,
          briefing_id: target.row.id,
          version: target.row.version,
          scope_key: target.row.scope_key,
          highlight: index,
          highlight_title: target.highlight.title,
          refs: [...new Set([...target.highlight.refs, ...target.highlight.impact.context_refs, ...target.highlight.statements.flatMap((statement) => statement.refs)])],
          evidence_item_ids: target.evidence.map((entry) => entry.source_item_id),
          context_sources: target.context.map((entry) => entry.source),
        },
      },
    }, tx);
    return { created: true, task: { id: task.id as string, title: task.title as string, project_id: (task.project_id as string | null) ?? null } };
  });
}
