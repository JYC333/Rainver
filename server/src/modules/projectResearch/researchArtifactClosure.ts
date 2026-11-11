import type { Queryable } from "../routeUtils/common.js";
import { researchArtifactOriginSql } from "./researchArtifactAccess.js";

/**
 * The rows `researchArtifactReadableSql` reads for a research-call output
 * Artifact: each producing research Operation (any Project in the Space), the
 * Thread and requesting Run its call names, and every Source item, channel and
 * connection it read. The Thread's read scope includes every Project it is
 * currently shared into (`space_object_project_shares`), and the requesting
 * Run's (`runInheritedReadSql` → the Run's content scope) includes its own
 * Project and the Project owning its Folder; both are recorded here so a
 * second discovery that differs (a new share, a moved Run) refuses. A caller that must hold that gate still discovers this
 * closure, share-locks it, and discovers it again: a different second answer
 * means the closure grew or moved while it waited, and the frozen request has
 * to be rebuilt rather than half-locked.
 */
export interface ResearchArtifactClosure {
  operations: Array<{ id: string; project_id: string; thread_id: string | null; run_id: string | null; artifact_ids: string[]; item_ids: string[]; channel_ids: string[] }>;
  threads: Array<{ id: string; project_id: string | null; folder_id: string | null; share_project_ids: string[] }>;
  runs: Array<{ id: string; project_id: string | null; folder_id: string | null }>;
  items: Array<{ id: string; project_id: string | null; connection_id: string | null }>;
  channels: Array<{ id: string; connection_id: string }>;
  connections: Array<{ id: string; project_id: string | null }>;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** Unlocked read of the closure; callers lock it and then call this again. */
export async function discoverResearchArtifactClosure(
  db: Queryable,
  spaceId: string,
  artifactIds: readonly string[],
): Promise<ResearchArtifactClosure> {
  const empty: ResearchArtifactClosure = { operations: [], threads: [], runs: [], items: [], channels: [], connections: [] };
  if (!artifactIds.length) return empty;
  const rows = (await db.query<{ artifact_id: string; id: string; project_id: string; research_call_json: Record<string, unknown> | null; progress_json: Record<string, unknown> | null }>(
    `SELECT a.id AS artifact_id, o.id, o.project_id, o.research_call_json, o.progress_json
       FROM artifacts a
       JOIN project_operations o ON o.research_call_json IS NOT NULL AND ${researchArtifactOriginSql("a", "o")}
      WHERE a.space_id = $1 AND a.id = ANY($2::varchar[])
      ORDER BY o.id, a.id`,
    [spaceId, [...artifactIds]],
  )).rows;
  const byOperation = new Map<string, ResearchArtifactClosure["operations"][number]>();
  for (const row of rows) {
    const call = row.research_call_json ?? {}, progress = row.progress_json ?? {};
    const scope = (call.scope && typeof call.scope === "object" ? call.scope : {}) as Record<string, unknown>;
    const entry = byOperation.get(row.id) ?? {
      id: row.id,
      project_id: row.project_id,
      thread_id: typeof call.thread_id === "string" ? call.thread_id : null,
      run_id: typeof call.requested_by_run_id === "string" ? call.requested_by_run_id : null,
      artifact_ids: [],
      item_ids: sorted(strings(progress.source_item_ids)),
      channel_ids: sorted([...strings(scope.source_channel_ids), ...strings(progress.channel_ids)]),
    };
    entry.artifact_ids = sorted([...entry.artifact_ids, row.artifact_id]);
    byOperation.set(row.id, entry);
  }
  const operations = [...byOperation.values()];
  if (!operations.length) return empty;
  const threadIds = sorted(operations.flatMap(o => (o.thread_id ? [o.thread_id] : [])));
  const itemIds = sorted(operations.flatMap(o => o.item_ids));
  const channelIds = sorted(operations.flatMap(o => o.channel_ids));
  const runIds = sorted(operations.flatMap(o => (o.run_id ? [o.run_id] : [])));
  const threads = threadIds.length ? (await db.query<ResearchArtifactClosure["threads"][number]>(
    `SELECT so.id, so.primary_project_id AS project_id, so.project_folder_id AS folder_id,
            COALESCE((SELECT array_agg(share.project_id ORDER BY share.project_id) FROM space_object_project_shares share
                       WHERE share.space_id = so.space_id AND share.object_id = so.id AND share.revoked_at IS NULL), '{}'::varchar[]) AS share_project_ids
       FROM space_objects so
      WHERE so.space_id = $1 AND so.id = ANY($2::varchar[]) ORDER BY so.id`, [spaceId, threadIds])).rows : [];
  const runs = runIds.length ? (await db.query<ResearchArtifactClosure["runs"][number]>(
    `SELECT id, project_id, project_folder_id AS folder_id FROM runs WHERE space_id = $1 AND id = ANY($2::varchar[]) ORDER BY id`,
    [spaceId, runIds])).rows : [];
  const items = itemIds.length ? (await db.query<ResearchArtifactClosure["items"][number]>(
    `SELECT id, project_id, connection_id FROM source_items WHERE space_id = $1 AND id = ANY($2::varchar[]) ORDER BY id`,
    [spaceId, itemIds])).rows : [];
  const channels = channelIds.length ? (await db.query<ResearchArtifactClosure["channels"][number]>(
    `SELECT id, source_connection_id AS connection_id FROM source_channels WHERE space_id = $1 AND id = ANY($2::varchar[]) ORDER BY id`,
    [spaceId, channelIds])).rows : [];
  const connectionIds = sorted([...items.flatMap(i => (i.connection_id ? [i.connection_id] : [])), ...channels.map(c => c.connection_id)]);
  const connections = connectionIds.length ? (await db.query<ResearchArtifactClosure["connections"][number]>(
    `SELECT id, project_id FROM source_connections WHERE space_id = $1 AND id = ANY($2::varchar[]) ORDER BY id`,
    [spaceId, connectionIds])).rows : [];
  return { operations, threads, runs, items, channels, connections };
}

/**
 * Projects whose audience the closure's read gate consults directly, besides
 * the caller's own. The Projects owning the Threads' and Runs' Folders are the
 * caller's to resolve (`closureFolderIds`), with its other Folders.
 */
export function researchClosureProjects(closure: ResearchArtifactClosure): string[] {
  return sorted([
    ...closure.operations.map(o => o.project_id),
    ...closure.threads.flatMap(t => [...(t.project_id ? [t.project_id] : []), ...t.share_project_ids]),
    ...closure.runs.flatMap(r => (r.project_id ? [r.project_id] : [])),
    ...closure.items.flatMap(i => (i.project_id ? [i.project_id] : [])),
    ...closure.connections.flatMap(c => (c.project_id ? [c.project_id] : [])),
  ]);
}

/** Folders whose owning Project the closure's Thread and requesting-Run scope reads. */
export function closureFolderIds(closure: ResearchArtifactClosure): string[] {
  return sorted([
    ...closure.threads.flatMap(t => (t.folder_id ? [t.folder_id] : [])),
    ...closure.runs.flatMap(r => (r.folder_id ? [r.folder_id] : [])),
  ]);
}

/**
 * Share-locks a Source read closure for one reader in the order Notebook chat
 * admission established: connections → their channels → the reader's
 * subscriptions → subscription windows → Source items. Content grants are the
 * caller's to lock in its own grant phase.
 */
export async function lockSourceReadClosure(
  db: Queryable,
  spaceId: string,
  userId: string,
  connectionIds: readonly string[],
  itemIds: readonly string[],
): Promise<void> {
  const connections = sorted(connectionIds);
  await db.query("SELECT id FROM source_connections WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE", [spaceId, connections]);
  const channels = (await db.query<{ id: string }>(
    "SELECT id FROM source_channels WHERE space_id=$1 AND source_connection_id=ANY($2::varchar[]) ORDER BY id FOR SHARE",
    [spaceId, connections])).rows.map(r => r.id);
  for (const table of ["source_channel_user_subscriptions", "source_channel_subscription_windows"]) {
    await db.query(`SELECT id FROM ${table} WHERE space_id=$1 AND source_channel_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE`, [spaceId, channels, userId]);
  }
  await db.query("SELECT id FROM source_items WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE", [spaceId, sorted(itemIds)]);
}
