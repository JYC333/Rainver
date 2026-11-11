import type { Queryable } from "../routeUtils/common.js";
import { HttpError } from "../routeUtils/common.js";
import { lockActiveProjectForMutation } from "./access.js";
import type { ContentAccessLevel } from "../access/contentAccessTypes.js";
import {
  closureFolderIds,
  discoverResearchArtifactClosure,
  lockSourceReadClosure,
  researchClosureProjects,
  type ResearchArtifactClosure,
} from "../projectResearch/researchArtifactClosure.js";
import { sourceKey, type PublicSummarySourceRef } from "./publicSummaryPrompt.js";

/**
 * The access level each frozen source needs for what the frozen prompt
 * actually carries from it, keyed by `sourceKey`. `full` when its body
 * (Memory/Activity excerpt, Proposal rationale) is in the prompt; `summary`
 * when only its title and type are.
 */
export type FrozenSourceAccess = Record<string, ContentAccessLevel>;

/** Body-carrying source types: a draft frozen without levels requires full for these. */
const BODY_TYPES = new Set(["memory", "activity", "proposal"]);

export function requiredSourceLevel(access: FrozenSourceAccess | undefined, ref: PublicSummarySourceRef): ContentAccessLevel {
  const frozen = access?.[sourceKey(ref.source_type, ref.source_id)];
  if (frozen === "full" || frozen === "summary") return frozen;
  return BODY_TYPES.has(ref.source_type) ? "full" : "summary";
}

const TABLES = [
  { type: "memory", table: "memory_entries", folder: null, run: null },
  { type: "activity", table: "activity_records", folder: "project_folder_id", run: null },
  { type: "artifact", table: "artifacts", folder: "project_folder_id", run: "run_id" },
  { type: "proposal", table: "proposals", folder: "project_folder_id", run: "created_by_run_id" },
] as const;

const GREW = "The research sources behind an Artifact frozen into this draft request changed; request a new draft";
const sortedIds = (values: Iterable<string>) => [...new Set(values)].sort();
const refIds = (refs: readonly PublicSummarySourceRef[], type: string) =>
  sortedIds(refs.filter(ref => ref.source_type === type).map(ref => ref.source_id));

/**
 * Every Project a frozen draft's closure names, read without locks: the
 * draft's own Project, the Projects a research-call Artifact's chain belongs
 * to (Operations, Thread and the Projects it is shared into, requesting Run,
 * Source items, connections), and the Projects that own the Folders (the
 * sources', the Thread's, the requesting Run's) and Rooms (every source Run's
 * and requesting Run's) they sit in.
 *
 * Which Run columns matter follows the gate each source passes: an ordinary
 * Artifact or Proposal inherits only its Run's Room (`roomRunReadAccessSql`),
 * while a research call's requesting Run must itself be readable
 * (`runInheritedReadSql` → `runReadSql`: the Run's own Project and Folder
 * scope, visibility, grants and Room).
 */
async function discoverClosureProjects(
  db: Queryable,
  spaceId: string,
  projectId: string,
  refs: readonly PublicSummarySourceRef[],
): Promise<string[]> {
  const projects = new Set<string>([projectId]);
  const artifacts = refIds(refs, "artifact");
  const research = artifacts.length ? await discoverResearchArtifactClosure(db, spaceId, artifacts) : null;
  if (research) for (const id of researchClosureProjects(research)) projects.add(id);
  const folders = new Set<string>(research ? closureFolderIds(research) : []);
  const runs = new Set<string>(research?.operations.flatMap(o => (o.run_id ? [o.run_id] : [])) ?? []);
  for (const spec of TABLES) {
    const wanted = refIds(refs, spec.type);
    if (!wanted.length || (!spec.folder && !spec.run)) continue;
    for (const row of (await db.query<{ folder_id: string | null; run_id: string | null }>(
      `SELECT ${spec.folder ?? "NULL::varchar"} AS folder_id, ${spec.run ?? "NULL::varchar"} AS run_id
         FROM ${spec.table} WHERE space_id=$1 AND id=ANY($2::varchar[])`, [spaceId, wanted])).rows) {
      if (row.folder_id) folders.add(row.folder_id);
      if (row.run_id) runs.add(row.run_id);
    }
  }
  if (folders.size) {
    for (const row of (await db.query<{ project_id: string | null }>(
      `SELECT project_id FROM project_folders WHERE space_id=$1 AND id=ANY($2::varchar[])`, [spaceId, [...folders]])).rows) {
      if (row.project_id) projects.add(row.project_id);
    }
  }
  if (runs.size) {
    for (const row of (await db.query<{ project_id: string | null }>(
      `SELECT room.project_id FROM runs run
         LEFT JOIN agent_run_groups grp ON grp.id = run.run_group_id AND grp.space_id = run.space_id
         LEFT JOIN sessions session ON session.id = run.session_id AND session.space_id = run.space_id
         JOIN rooms room ON room.space_id = run.space_id AND room.id IN (grp.room_id, session.room_id)
        WHERE run.space_id=$1 AND run.id=ANY($2::varchar[])`, [spaceId, [...runs]])).rows) {
      if (row.project_id) projects.add(row.project_id);
    }
  }
  return sortedIds(projects);
}

/**
 * Admits the whole Project set of a frozen draft's closure before any of it is
 * locked: discovered unlocked, then locked in one global id order — the
 * draft's own Project `FOR UPDATE` (active, as a mutation requires), every
 * other one `FOR SHARE`. Two drafts whose closures name each other's Projects
 * (A's research read a B Source, B's read an A Source) therefore queue on the
 * lower id instead of each holding its own Project and waiting for the
 * other's. `lockPublicSummarySourceClosure` never waits for a Project outside
 * this set: if the closure reaches one after these waits, it refuses with 409.
 */
export async function lockPublicSummaryProjects(
  db: Queryable,
  spaceId: string,
  projectId: string,
  refs: readonly PublicSummarySourceRef[],
): Promise<ReadonlySet<string>> {
  const projects = await discoverClosureProjects(db, spaceId, projectId, refs);
  for (const id of projects) {
    if (id === projectId) await lockActiveProjectForMutation(db, spaceId, projectId);
    else await db.query(`SELECT id FROM projects WHERE space_id=$1 AND id=$2 FOR SHARE`, [spaceId, id]);
  }
  return new Set(projects);
}

/**
 * Share-locks the whole authorization closure of the sources frozen into a
 * draft, for `userId`, so that no revocation can commit between the re-check
 * that follows and the commit of the attempt or draft that rests on it. Every
 * revoking writer updates or deletes one of these rows (content policy locks
 * the resource row then its grants; Room roster changes lock the Room then its
 * member rows; membership writers lock the Project), so each either commits
 * first and is seen by the re-check, or waits for this transaction.
 *
 * The caller already holds every Project row of the closure, admitted by
 * `lockPublicSummaryProjects` in id order. Order follows the existing global
 * order: Projects → their audience (the viewer's memberships) → research Operations
 * → Source connections → channels → the viewer's subscriptions → windows →
 * Source items (Notebook admission's order) → research Threads → their
 * Project shares → content roots → content grants → Folder scope (the
 * sources', the Threads', the requesting Runs') → Run → the research Runs'
 * grants → session/group → Room → Room member. Every row comes before its grants, as
 * the policy writer takes them. Locks are taken before the re-check reads,
 * never inside it, so the re-check is a fresh statement over committed state.
 *
 * A research closure is discovered before locking and again after: if it grew
 * or moved while this transaction waited (a new Source on the Operation, a
 * different producing Operation, a new Thread share, a requesting Run moved to
 * another Folder or Project), or it now reaches a Project outside the
 * admitted set, the request is refused with 409 and must be rebuilt, rather
 * than resting on rows it never locked or waiting for a Project out of order.
 */
export async function lockPublicSummarySourceClosure(
  db: Queryable,
  spaceId: string,
  projectId: string,
  userId: string,
  refs: readonly PublicSummarySourceRef[],
  admittedProjects: ReadonlySet<string>,
): Promise<void> {
  const ids = (type: string) => refIds(refs, type);
  const admitted = (projects: Iterable<string>) => {
    for (const id of projects) if (!admittedProjects.has(id)) throw new HttpError(409, GREW);
  };
  if (!admittedProjects.has(projectId)) throw new HttpError(409, GREW);
  await db.query(`SELECT id FROM spaces WHERE id=$1 FOR SHARE`, [spaceId]);
  await lockViewerInProjects(db, spaceId, sortedIds(admittedProjects), userId);
  await db.query(`SELECT id FROM space_memberships WHERE space_id=$1 AND user_id=$2 ORDER BY id FOR SHARE`, [spaceId, userId]);
  // A research-call output Artifact is readable only while its producing
  // Operations' Thread, requesting Run and every Source they read are fully
  // readable (`researchArtifactReadableSql`, inside the Artifact read gate).
  // Discover that closure unlocked, lock it with the rest, and discover it
  // again at the end: a different answer means it moved while we waited.
  const artifacts = ids("artifact");
  const research = artifacts.length ? await discoverResearchArtifactClosure(db, spaceId, artifacts) : null;
  if (research) admitted(researchClosureProjects(research));
  if (research) {
    await db.query(
      `SELECT id FROM project_operations
        WHERE space_id=$1 AND ((project_id=$2 AND research_call_json IS NOT NULL) OR id=ANY($3::varchar[]))
        ORDER BY id FOR SHARE`,
      [spaceId, projectId, research.operations.map(operation => operation.id)],
    );
  }
  if (research?.operations.length) {
    await lockSourceReadClosure(db, spaceId, userId, research.connections.map(c => c.id), research.items.map(i => i.id));
    const threadIds = research.threads.map(t => t.id);
    await db.query(`SELECT id FROM space_objects WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,
      [spaceId, threadIds]);
    // A Thread's Project shares widen its scope half (`projectShareReadAccessSql`):
    // the object row first, then its shares, as the share revoker takes them.
    await db.query(`SELECT id FROM space_object_project_shares
        WHERE space_id=$1 AND object_id=ANY($2::varchar[]) AND revoked_at IS NULL ORDER BY id FOR SHARE`,
      [spaceId, threadIds]);
  }
  const folders = new Set<string>(), runs = new Set<string>(), grantKeys: Array<[string, string[]]> = [];
  for (const spec of TABLES) {
    const wanted = ids(spec.type);
    if (!wanted.length) continue;
    const rows = (await db.query<{ id: string; folder_id: string | null; run_id: string | null }>(
      `SELECT id, ${spec.folder ?? "NULL::varchar"} AS folder_id, ${spec.run ?? "NULL::varchar"} AS run_id
         FROM ${spec.table} WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,
      [spaceId, wanted],
    )).rows;
    for (const row of rows) {
      if (row.folder_id) folders.add(row.folder_id);
      if (row.run_id) runs.add(row.run_id);
    }
    grantKeys.push([spec.type, wanted]);
  }
  const researchRuns = research ? [...new Set(research.operations.flatMap(o => (o.run_id ? [o.run_id] : [])))].sort() : [];
  if (research?.operations.length) {
    grantKeys.push(["source_connection", research.connections.map(c => c.id)], ["source_item", research.items.map(i => i.id)],
      ["space_object", research.threads.map(t => t.id)]);
    // The Thread's Folder and the requesting Run's Folder: the Run row is
    // locked below, after Folder scope; the closing re-discovery refuses if
    // its Folder or Project moved before that lock.
    for (const folder of closureFolderIds(research)) folders.add(folder);
    for (const run of researchRuns) runs.add(run);
  }
  for (const [type, wanted] of grantKeys) {
    if (!wanted.length) continue;
    await db.query(
      `SELECT id FROM content_access_grants
        WHERE space_id=$1 AND resource_type=$2 AND resource_id=ANY($3::varchar[]) AND grantee_user_id=$4 AND revoked_at IS NULL
        ORDER BY id FOR SHARE`,
      [spaceId, type, wanted, userId],
    );
  }
  const scopeProjects = new Set<string>();
  if (folders.size) {
    const rows = (await db.query<{ project_id: string | null }>(
      `SELECT project_id FROM project_folders WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,
      [spaceId, [...folders].sort()],
    )).rows;
    for (const row of rows) if (row.project_id) scopeProjects.add(row.project_id);
  }
  if (runs.size) {
    const rows = (await db.query<{ run_group_id: string | null; session_id: string | null }>(
      `SELECT run_group_id, session_id FROM runs WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,
      [spaceId, [...runs].sort()],
    )).rows;
    // A run's grants follow its row, as the run policy writer takes them.
    if (researchRuns.length) {
      await db.query(
        `SELECT id FROM content_access_grants
          WHERE space_id=$1 AND resource_type='run' AND resource_id=ANY($2::varchar[]) AND grantee_user_id=$3 AND revoked_at IS NULL
          ORDER BY id FOR SHARE`,
        [spaceId, researchRuns, userId],
      );
    }
    const groups = [...new Set(rows.map(row => row.run_group_id).filter((id): id is string => Boolean(id)))].sort();
    const sessions = [...new Set(rows.map(row => row.session_id).filter((id): id is string => Boolean(id)))].sort();
    const rooms = new Set<string>();
    if (groups.length) {
      for (const row of (await db.query<{ room_id: string | null }>(
        `SELECT room_id FROM agent_run_groups WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`, [spaceId, groups])).rows) {
        if (row.room_id) rooms.add(row.room_id);
      }
    }
    if (sessions.length) {
      for (const row of (await db.query<{ room_id: string | null }>(
        `SELECT room_id FROM sessions WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`, [spaceId, sessions])).rows) {
        if (row.room_id) rooms.add(row.room_id);
      }
    }
    if (rooms.size) {
      const roomIds = [...rooms].sort();
      for (const row of (await db.query<{ project_id: string | null }>(
        `SELECT project_id FROM rooms WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`, [spaceId, roomIds])).rows) {
        if (row.project_id) scopeProjects.add(row.project_id);
      }
      await db.query(
        `SELECT id FROM room_user_members WHERE space_id=$1 AND room_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE`,
        [spaceId, roomIds, userId],
      );
    }
  }
  admitted(scopeProjects);
  if (research && !sameClosure(research, await discoverResearchArtifactClosure(db, spaceId, artifacts))) {
    throw new HttpError(409, GREW);
  }
}

const sameClosure = (a: ResearchArtifactClosure, b: ResearchArtifactClosure) => JSON.stringify(a) === JSON.stringify(b);

async function lockViewerInProjects(db: Queryable, spaceId: string, projectIds: readonly string[], userId: string): Promise<void> {
  await db.query(`SELECT id FROM projects WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`, [spaceId, projectIds]);
  await db.query(
    `SELECT id FROM project_members WHERE space_id=$1 AND project_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE`,
    [spaceId, projectIds, userId],
  );
}
