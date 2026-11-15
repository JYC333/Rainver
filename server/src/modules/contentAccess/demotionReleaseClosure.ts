import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { closureFolderIds, discoverResearchArtifactClosure, researchClosureProjects } from "../projectResearch/researchArtifactClosure.js";
import { proposalReportDependencies } from "../retrieval/proposalReportDependencies.js";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { lockSourceRetrievalRelease, sourceRetrievalReleaseProjects } from "../sources/retrievalReleaseLocks.js";
import { canonical } from "../systemActions/operations/repository.js";

/** The objects one demotion disclosure names, plus the demoted resource. */
export interface DisclosedObjects {
  resource: { type: string; id: string };
  runIds: readonly string[];
  /** Owning caller scopes in addition to content-root Projects. */
  additionalProjectIds?: readonly string[];
  artifactIds: readonly string[];
  proposalIds: readonly string[];
  /** Research `input_refs` the Artifacts' full content gate also reads. */
  spaceObjectIds?: readonly string[];
  /** Tasks the gate reads: explicit `task` refs and the Tasks owning a
   * Project-less dependency Artifact through `taskArtifactLinkIds`. */
  taskIds?: readonly string[];
  taskArtifactLinkIds?: readonly string[];
}

/** Rooms a caller already share-locked, in id order, ahead of locks it holds
 * that a Room writer takes after the Room (a Delivery reader's Run). */
export interface HeldRooms {
  heldRoomIds: readonly string[];
}

type Ref = Parameters<typeof lockSourceRetrievalRelease>[3][number];
type Lineage = {
  refs: Ref[];
  projects: string[];
  operations: string[];
  goals: string[];
  goalVersions: string[];
  runGroups: string[];
  sessions: string[];
  rooms: string[];
  tasks: string[];
  taskFolders: string[];
  taskArtifactLinks: string[];
};

/** Resource types `lockSourceRetrievalRelease` locks with their shares and grants. */
const CLOSURE_TYPES = new Set(["source_item", "source_snapshot", "source_connection", "space_object", "memory", "activity", "artifact", "proposal", "run", "agent"]);
const CHANGED = "Exposure changed; review demotion again";

const sorted = (values: Iterable<string | null | undefined>) =>
  [...new Set([...values].filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/**
 * Every row the disclosure's title decisions read, discovered without locks:
 * the Runs (content row, grants, Project and Folder scope, session/group →
 * Room → Room member); each output Artifact and Proposal with its producing
 * Run's Room; an Artifact's Source-derived lineage (the snapshots and items
 * that carry it, `reading_history_refs` items/snapshots/Artifacts, the deep
 * read original, Following goal/version/connection and Project) and its
 * research-call chain; a report-derived Proposal's report Artifacts.
 * The Source closure discovers each item's and snapshot's connection itself.
 */
async function discoverLineage(db: Queryable, spaceId: string, objects: DisclosedObjects): Promise<Lineage> {
  const proposals = objects.proposalIds.length ? (await db.query<{ id: string; created_by_run_id: string | null; proposal_type: string; payload_json: unknown }>(
    `SELECT id, created_by_run_id, proposal_type, payload_json FROM proposals WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id`,
    [spaceId, [...objects.proposalIds]])).rows : [];
  const reportArtifacts = proposals.flatMap((p) => proposalReportDependencies(p.proposal_type, p.payload_json)?.artifactIds ?? []);
  const artifactIds = sorted([...objects.artifactIds, ...reportArtifacts]);
  const artifacts = artifactIds.length ? (await db.query<{ id: string; run_id: string | null; metadata_json: unknown }>(
    `SELECT id, run_id, metadata_json FROM artifacts WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id`,
    [spaceId, artifactIds])).rows : [];
  const items: Array<string | null> = [], snapshots: Array<string | null> = [], lineageArtifacts: Array<string | null> = [];
  const connections: Array<string | null> = [], goals: Array<string | null> = [], goalVersions: Array<string | null> = [], projects: Array<string | null> = [...(objects.additionalProjectIds ?? [])];
  for (const artifact of artifacts) {
    const metadata = record(artifact.metadata_json);
    for (const ref of Array.isArray(metadata.reading_history_refs) ? metadata.reading_history_refs : []) {
      const r = record(ref);
      items.push(text(r.item_id)); snapshots.push(text(r.snapshot_id)); lineageArtifacts.push(text(r.artifact_id));
    }
    const deep = record(metadata.deep_read), original = record(deep.original), following = record(deep.following);
    projects.push(text(deep.project_id));
    snapshots.push(text(original.snapshot_id)); lineageArtifacts.push(text(original.artifact_id));
    connections.push(text(following.connection_id)); goals.push(text(following.goal_id)); goalVersions.push(text(following.version_id));
  }
  if (artifactIds.length) {
    for (const row of (await db.query<{ id: string }>(
      `SELECT id FROM source_snapshots WHERE space_id=$1 AND artifact_id=ANY($2::varchar[]) ORDER BY id`, [spaceId, artifactIds])).rows) snapshots.push(row.id);
    for (const row of (await db.query<{ id: string }>(
      `SELECT id FROM source_items WHERE space_id=$1 AND (raw_artifact_id=ANY($2::varchar[]) OR extracted_artifact_id=ANY($2::varchar[])) ORDER BY id`, [spaceId, artifactIds])).rows) items.push(row.id);
  }
  const lineageRuns = sorted(lineageArtifacts).length ? (await db.query<{ run_id: string | null }>(
    `SELECT run_id FROM artifacts WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id`, [spaceId, sorted(lineageArtifacts)])).rows.map((r) => r.run_id) : [];
  const goalRows = sorted(goals).length ? (await db.query<{ project_id: string | null }>(
    `SELECT project_id FROM source_goals WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id`, [spaceId, sorted(goals)])).rows : [];
  projects.push(...goalRows.map((g) => g.project_id));
  const research = artifactIds.length ? await discoverResearchArtifactClosure(db, spaceId, artifactIds) : null;
  const researchFolders = research ? closureFolderIds(research) : [];
  if (research) {
    projects.push(...researchClosureProjects(research));
    items.push(...research.items.map((i) => i.id));
    connections.push(...research.connections.map((c) => c.id));
  }
  if (researchFolders.length) {
    for (const row of (await db.query<{ project_id: string | null }>(
      `SELECT project_id FROM project_folders WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id`, [spaceId, researchFolders])).rows) projects.push(row.project_id);
  }
  const researchRuns = research ? research.operations.map((o) => o.run_id) : [];
  const runs = sorted([...objects.runIds, ...artifacts.map((a) => a.run_id), ...proposals.map((p) => p.created_by_run_id), ...lineageRuns, ...researchRuns]);
  const rooms = runs.length ? (await db.query<{ run_group_id: string | null; session_id: string | null; room_id: string | null; project_id: string | null }>(
    `SELECT run.run_group_id, run.session_id, room.id AS room_id, room.project_id
       FROM runs run
       LEFT JOIN agent_run_groups grp ON grp.id = run.run_group_id AND grp.space_id = run.space_id
       LEFT JOIN sessions session ON session.id = run.session_id AND session.space_id = run.space_id
       LEFT JOIN rooms room ON room.space_id = run.space_id AND room.id = COALESCE(grp.room_id, session.room_id)
      WHERE run.space_id=$1 AND run.id=ANY($2::varchar[]) ORDER BY run.id`, [spaceId, runs])).rows : [];
  projects.push(...rooms.map((r) => r.project_id));
  const taskIds = sorted(objects.taskIds ?? []);
  const tasks = taskIds.length ? (await db.query<{ id: string; project_id: string | null; project_folder_id: string | null }>(
    `SELECT id, project_id, project_folder_id FROM tasks WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id`, [spaceId, taskIds])).rows : [];
  projects.push(...tasks.map((t) => t.project_id));
  const refs: Ref[] = [
    ...(CLOSURE_TYPES.has(objects.resource.type) ? [{ object_type: objects.resource.type as Ref["object_type"], object_id: objects.resource.id }] : []),
    ...runs.map((id) => ({ object_type: "run" as const, object_id: id })),
    ...sorted([...artifactIds, ...lineageArtifacts]).map((id) => ({ object_type: "artifact" as const, object_id: id })),
    ...proposals.map((p) => ({ object_type: "proposal" as const, object_id: p.id })),
    ...sorted(items).map((id) => ({ object_type: "source_item" as const, object_id: id })),
    ...sorted(snapshots).map((id) => ({ object_type: "source_snapshot" as const, object_id: id })),
    ...sorted(connections).map((id) => ({ object_type: "source_connection" as const, object_id: id })),
    ...sorted([...(research?.threads.map((t) => t.id) ?? []), ...(objects.spaceObjectIds ?? [])]).map((id) => ({ object_type: "space_object" as const, object_id: id })),
  ];
  return {
    refs,
    projects: sorted(projects),
    operations: sorted(research?.operations.map((o) => o.id) ?? []),
    goals: sorted(goals),
    goalVersions: sorted(goalVersions),
    runGroups: sorted(rooms.map((r) => r.run_group_id)),
    sessions: sorted(rooms.map((r) => r.session_id)),
    rooms: sorted(rooms.map((r) => r.room_id)),
    tasks: tasks.map((t) => t.id),
    // A Task's Folder is part of its read gate, as its Project is.
    taskFolders: sorted(tasks.map((t) => t.project_folder_id)),
    taskArtifactLinks: sorted(objects.taskArtifactLinkIds ?? []),
  };
}

/**
 * Share-locks, for `identity`, everything the disclosure's title decisions
 * read, so no revocation of any of it can commit between those decisions and
 * the commit of the transaction that builds the response from them. One
 * global order, every lock `FOR SHARE`:
 *
 *  1. The Source closure (`lockSourceRetrievalRelease`): Project audiences
 *     (each Run's, output's, Folder's, Room's, research chain's, deep read's
 *     and Following goal's Project) → person and Space membership → Space →
 *     Folders (the content rows' and the named Tasks') → (2.) → every content row (demoted resource, Runs, Artifacts,
 *     Proposals, Source items/snapshots/connections, research Threads), each
 *     followed by its Project shares and this person's grants → Source
 *     channels → subscriptions → windows. Each content row precedes its
 *     grants, as the content-policy writer takes them.
 *  2. Rooms → this person's Room member rows, inside the Source closure after
 *     Folders and before any Run. Every transaction that locks a Room
 *     exclusively takes it before its members, groups, conversations and
 *     Runs: the roster writer (Room → members), the Room context reset and
 *     summary restart (Room → member → `host_threads` joined `FOR UPDATE`
 *     with its session → the conversation append lock), and "Continue
 *     anyway" (`room.quota.continue`: Room → conversation queue → every held
 *     Run of the conversation `FOR UPDATE`, recovery holds included, before it
 *     filters them). A Run, group or session share taken before the Room is
 *     held while such a writer, holding the Room, waits on it — a real
 *     deadlock, not a conflict to map to 409. A Run held for quota recovery
 *     keeps its accepted Invocation Snapshot (the requeue reuses the Run), so
 *     it is one of the consuming Runs a disclosure names.
 *  3. A demoted resource of another type, then its grants; then named
 *     Tasks, each followed by this person's grants (the content-policy
 *     writer takes the Task `FOR UPDATE`, then its grants); then the
 *     `task_artifacts` links through which a Task owns a Project-less
 *     dependency Artifact.
 *  4. Research Operations, then Following goals and goal versions.
 *  5. Run groups → sessions, after the Runs: the Run status writers (the
 *     supervisor's requeue and quota hold, the hold notice) update the Run
 *     and only then append to its conversation.
 *
 * A caller that holds a lock some Room writer takes after the Room (the
 * Delivery gate holds its Run) locks its Rooms first and passes them as
 * `held`; a Room outside that set is refused before anything is locked.
 *
 * Discovery is authority-free. A lineage that changed while waiting is a
 * 409, never a second, unsorted closure. The nested release closures of
 * report Artifacts beyond the ones named here are pinned by their own gate
 * (`lockRetrievalReleaseClosure`) when it runs inside this transaction.
 */
async function prepareDemotionReleaseClosure(db: Queryable, identity: SpaceUserIdentity, objects: DisclosedObjects, held?: HeldRooms) {
  const { spaceId, userId } = identity;
  const before = await discoverLineage(db, spaceId, objects);
  // A caller already holding a Room writer's later lock (a Run) took every
  // Room first; a Room it did not take is drift, refused before any lock.
  if (held && before.rooms.some((room) => !held.heldRoomIds.includes(room))) {
    throw new HttpError(409, "Room authority changed; read again", { code: "release_room_changed" });
  }
  const share = async (table: string, ids: string[]) => {
    if (ids.length) await db.query(`SELECT id FROM ${table} WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`, [spaceId, ids]);
  };
  return {
    refs:before.refs, projects:before.projects, folders:before.taskFolders,
    beforeContent:async () => {
      await share("rooms", before.rooms);
      if (before.rooms.length) {
        await db.query(`SELECT id FROM room_user_members WHERE space_id=$1 AND room_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE`,
          [spaceId, before.rooms, userId]);
      }
    },
    afterContent:async () => {
      if (!CLOSURE_TYPES.has(objects.resource.type)) {
        const definition = contentResourceDefinition(objects.resource.type);
        if (!definition) throw new HttpError(404, "Content type not found");
        await db.query(`SELECT id FROM ${definition.tableName} WHERE space_id=$1 AND id=$2 FOR SHARE`, [spaceId, objects.resource.id]);
        await db.query(`SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_type=$2 AND resource_id=$3 AND grantee_user_id=$4 ORDER BY id FOR SHARE`,
          [spaceId, objects.resource.type, objects.resource.id, userId]);
      }
      for (const id of before.tasks) {
        await db.query(`SELECT id FROM tasks WHERE space_id=$1 AND id=$2 FOR SHARE`, [spaceId, id]);
        await db.query(`SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_type='task' AND resource_id=$2 AND grantee_user_id=$3 ORDER BY id FOR SHARE`, [spaceId, id, userId]);
      }
      await share("task_artifacts", before.taskArtifactLinks);
      await share("project_operations", before.operations);
      await share("source_goals", before.goals);
      await share("source_goal_versions", before.goalVersions);
      await share("agent_run_groups", before.runGroups);
      await share("sessions", before.sessions);
      if (canonical(before) !== canonical(await discoverLineage(db, spaceId, objects))) {
        throw new HttpError(409, CHANGED, { code: "demotion_exposure_changed" });
      }
    },
  };
}
export async function lockDemotionReleaseClosure(db: Queryable, identity: SpaceUserIdentity, objects: DisclosedObjects, held?: HeldRooms): Promise<void> {
  const plan = await prepareDemotionReleaseClosure(db,identity,objects,held);
  await lockSourceRetrievalRelease(db,identity.spaceId,identity.userId,plan.refs,plan.projects,plan.beforeContent,plan.folders);
  await plan.afterContent();
}

/**
 * Share-locks, for `identity`, everything the ordinary Artifact detail gate
 * reads to release these Artifacts' bodies (`artifactBodyReleased`): the
 * same closure and global order as a demotion disclosure, with the full
 * research dependency set (`discoverResearchArtifactDependencies`: recursive
 * `input_refs` Artifacts, their producing Operations, Threads, Runs, Source
 * items/channels/connections, the Notes, Threads and Tasks the calls
 * reference, and every `task_artifacts` link of a dependency Artifact with
 * its owning Task, that Task's Folder, Project and this person's grants —
 * the Task-ownership branch of `referenceReadableSql`). The dependency set,
 * links included, is discovered again under the locks; a
 * different answer, or one past the 200-Artifact bound, is a 409 and the
 * caller withholds.
 *
 * Authority-free plan for composition with a larger retrieval/report lock set.
 * The owner still supplies Room-before-Run and post-root locks and rechecks. */
export async function prepareArtifactReleaseClosure(db: Queryable, identity: SpaceUserIdentity, roots: readonly string[], held?: HeldRooms, batch = false) {
  if (batch && roots.length > 2000) throw new HttpError(409, "Artifact release batch is too large");
  const before = await discoverArtifactRelease(db, identity.spaceId, roots, batch);
  if (before.overflow || !roots.length) throw new HttpError(409, "Research artifact dependencies require reconciliation");
  const plan=await prepareDemotionReleaseClosure(db,identity,artifactReleaseObjects(roots,before),held);
  return {...plan,afterContent:async()=>{
    await plan.afterContent();
    if(canonical(before)!==canonical(await discoverArtifactRelease(db,identity.spaceId,roots,batch)))throw new HttpError(409,"Research artifact dependencies changed; read again");
  }};
}
export async function lockArtifactReleaseClosure(db: Queryable, identity: SpaceUserIdentity, roots: readonly string[], held?: HeldRooms): Promise<void> {
  const plan=await prepareArtifactReleaseClosure(db,identity,roots,held);
  await lockSourceRetrievalRelease(db,identity.spaceId,identity.userId,plan.refs,plan.projects,plan.beforeContent,plan.folders);
  await plan.afterContent();
}

/**
 * The Rooms `lockArtifactReleaseClosure` would lock for these roots,
 * discovered without locks, for a caller that must take them before a lock
 * it already holds (`HeldRooms`).
 */
export async function artifactReleaseRooms(db: Queryable, spaceId: string, roots: readonly string[]): Promise<string[]> {
  return (await artifactReleaseAuthority(db, spaceId, roots)).rooms;
}

/**
 * The Rooms and Projects `lockArtifactReleaseClosure` would lock for these
 * roots — its lineage Projects and its Source closure's (content rows' own
 * Projects, their Project shares and their Folders' Projects) — discovered
 * without locks, for a caller that takes both before its Run (`HeldRooms`,
 * `holdProjects`). An overflowing closure is refused by the lock itself.
 */
export async function artifactReleaseAuthority(db: Queryable, spaceId: string, roots: readonly string[]): Promise<{ rooms: string[]; projects: string[] }> {
  const dependencies = await discoverArtifactRelease(db, spaceId, roots);
  if (dependencies.overflow || !roots.length) return { rooms: [], projects: [] };
  const lineage = await discoverLineage(db, spaceId, artifactReleaseObjects(roots, dependencies));
  return {
    rooms: lineage.rooms,
    projects: await sourceRetrievalReleaseProjects(db, spaceId, lineage.refs, lineage.projects, lineage.taskFolders),
  };
}

async function discoverArtifactRelease(db: Queryable, spaceId: string, roots: readonly string[], batch = false) {
  const { discoverResearchArtifactDependencies } = await import("../projectResearch/researchArtifactClosure.js");
  return discoverResearchArtifactDependencies(db, spaceId, roots, batch);
}

function artifactReleaseObjects(
  roots: readonly string[],
  dependencies: Awaited<ReturnType<typeof discoverArtifactRelease>>,
): DisclosedObjects {
  return {
    resource: { type: "artifact", id: [...roots].sort()[0]! },
    runIds: [], proposalIds: [],
    artifactIds: dependencies.artifactIds, spaceObjectIds: dependencies.spaceObjectIds,
    taskIds: dependencies.taskIds, taskArtifactLinkIds: dependencies.taskArtifactLinks.map((link) => link.id),
  };
}
