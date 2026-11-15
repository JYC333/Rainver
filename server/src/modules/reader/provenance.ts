import { ResearchCallSchema } from '@rainver/protocol';
import { researchArtifactOriginSql } from '../projectResearch/researchArtifactAccess.js';
import { lockSourceRetrievalRelease } from '../sources/retrievalReleaseLocks.js';
import { HttpError, objectValue, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';

/** Types the shared Source release lock pins (rows, grants, Project audience, folders, channels). */
export type ReaderReleaseRef = { object_type: 'source_item'|'source_snapshot'|'source_connection'|'space_object'|'artifact'; object_id: string };
interface Closure {
  release: ReaderReleaseRef[];
  reports: string[];
  operations: string[];
  runs: string[];
  tasks: string[];
  channels: string[];
  projects: string[];
}
const MAX_NODES = 200;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const tooLarge = () => new HttpError(409, 'Reader document authority exceeds its bounded read closure');

/**
 * The dependency closure the Reader document gate actually consults, discovered
 * level by level without authority: a document's retained bodies; a research
 * report's operation and its research call (Thread, requesting Run, typed input
 * references, Source items and channel connections); and, for every Artifact in
 * the closure, the research operations that produced it, whose calls join the
 * same walk. Bounded and cycle-safe by typed identity. Reference provenance that
 * no gate consults (a report's cited references resolve to `unavailable`
 * independently) is not part of it.
 */
async function discover(db: Queryable, spaceId: string, roots: readonly ReaderReleaseRef[], reportIds: readonly string[]): Promise<Closure> {
  const release = new Map<string, ReaderReleaseRef>();
  const reports = new Set<string>(), operations = new Set<string>(), runs = new Set<string>(), tasks = new Set<string>(), channels = new Set<string>(), projects = new Set<string>();
  const artifacts: string[] = [], pending: string[] = [];
  const size = () => release.size + operations.size + reports.size;
  const add = (ref: ReaderReleaseRef) => {
    const key = `${ref.object_type}:${ref.object_id}`;
    if (release.has(key)) return;
    if (size() >= MAX_NODES) throw tooLarge();
    release.set(key, ref);
    if (ref.object_type === 'artifact') artifacts.push(ref.object_id);
  };
  for (const ref of roots) add(ref);
  for (const id of reportIds) {
    const report = (await db.query<{ project_id: string; operation_id: string }>('SELECT project_id,operation_id FROM project_research_reports WHERE space_id=$1 AND id=$2', [spaceId, id])).rows[0];
    if (!report) throw new HttpError(404, 'Document not found');
    reports.add(id); projects.add(report.project_id); pending.push(report.operation_id);
  }
  let artifactIndex = 0;
  while (pending.length || artifactIndex < artifacts.length) {
    while (artifactIndex < artifacts.length) {
      const artifact = artifacts[artifactIndex++]!;
      const origins = (await db.query<{ id: string }>(`SELECT op.id FROM artifacts a JOIN project_operations op ON ${researchArtifactOriginSql('a', 'op')} WHERE a.space_id=$1 AND a.id=$2 AND op.research_call_json IS NOT NULL ORDER BY op.id`, [spaceId, artifact])).rows;
      for (const origin of origins) pending.push(origin.id);
    }
    const id = pending.shift();
    if (id === undefined || operations.has(id)) continue;
    if (size() >= MAX_NODES) throw tooLarge();
    operations.add(id);
    const row = (await db.query<{ project_id: string; research_call_json: unknown; progress_json: unknown }>('SELECT project_id,research_call_json,progress_json FROM project_operations WHERE space_id=$1 AND id=$2', [spaceId, id])).rows[0];
    if (!row) throw new HttpError(404, 'Document not found');
    projects.add(row.project_id);
    if (row.research_call_json == null) continue;
    const call = ResearchCallSchema.safeParse(row.research_call_json);
    if (!call.success) throw new HttpError(409, 'Research call binding requires reconciliation');
    add({ object_type: 'space_object', object_id: call.data.thread_id });
    if (call.data.requested_by_run_id) runs.add(call.data.requested_by_run_id);
    for (const ref of call.data.input_refs) {
      if (ref.type === 'task') tasks.add(ref.id);
      else add({ object_type: ref.type === 'artifact' ? 'artifact' : 'space_object', object_id: ref.id });
    }
    const progress = objectValue(row.progress_json);
    for (const item of Array.isArray(progress.source_item_ids) ? progress.source_item_ids : []) if (typeof item === 'string') add({ object_type: 'source_item', object_id: item });
    const scope = call.data.scope.source_channel_ids;
    for (const channel of [...(Array.isArray(scope) ? scope : []), ...(Array.isArray(progress.channel_ids) ? progress.channel_ids : [])]) if (typeof channel === 'string') channels.add(channel);
  }
  // An Artifact input reference may be readable through its owning Task.
  const artifactIds = [...release.values()].filter(r => r.object_type === 'artifact').map(r => r.object_id);
  if (artifactIds.length) for (const row of (await db.query<{ task_id: string }>('SELECT task_id FROM task_artifacts WHERE space_id=$1 AND artifact_id=ANY($2::varchar[]) ORDER BY task_id', [spaceId, artifactIds])).rows) tasks.add(row.task_id);
  if (channels.size) for (const row of (await db.query<{ source_connection_id: string }>('SELECT source_connection_id FROM source_channels WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id', [spaceId, [...channels]])).rows) add({ object_type: 'source_connection', object_id: row.source_connection_id });
  if (tasks.size) for (const row of (await db.query<{ project_id: string | null }>('SELECT project_id FROM tasks WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id', [spaceId, [...tasks]])).rows) if (row.project_id) projects.add(row.project_id);
  return {
    release: [...release.values()].sort((a, b) => `${a.object_type}:${a.object_id}`.localeCompare(`${b.object_type}:${b.object_id}`)),
    reports: sorted(reports), operations: sorted(operations), runs: sorted(runs), tasks: sorted(tasks), channels: sorted(channels), projects: sorted(projects),
  };
}

/**
 * Writer-side half of the Reader read gate: pin, in stable order, every row the
 * document gate consults, then rediscover. A changed closure after waiting is a
 * conflict, never permission to follow another root. The caller then runs the
 * ordinary gate (`assertDocumentReadable`) inside the same transaction, so each
 * nested dependency is rechecked against its own canonical rule while held.
 */
export async function lockReaderDocumentClosure(db: Queryable, identity: SpaceUserIdentity, roots: readonly ReaderReleaseRef[], reportIds: readonly string[] = []): Promise<void> {
  const before = await discover(db, identity.spaceId, roots, reportIds);
  await lockSourceRetrievalRelease(db, identity.spaceId, identity.userId, before.release, before.projects);
  if (before.reports.length) await db.query('SELECT id FROM project_research_reports WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE', [identity.spaceId, before.reports]);
  if (before.operations.length) await db.query('SELECT id FROM project_operations WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE', [identity.spaceId, before.operations]);
  if (before.runs.length) {
    await db.query('SELECT id FROM runs WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE', [identity.spaceId, before.runs]);
    await db.query("SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_type='run' AND resource_id=ANY($2::varchar[]) AND grantee_user_id=$3 ORDER BY id FOR SHARE", [identity.spaceId, before.runs, identity.userId]);
  }
  if (before.tasks.length) {
    await db.query('SELECT id FROM tasks WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE', [identity.spaceId, before.tasks]);
    await db.query("SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_type='task' AND resource_id=ANY($2::varchar[]) AND grantee_user_id=$3 ORDER BY id FOR SHARE", [identity.spaceId, before.tasks, identity.userId]);
  }
  if (before.channels.length) await db.query('SELECT id FROM source_channels WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE', [identity.spaceId, before.channels]);
  if (JSON.stringify(before) !== JSON.stringify(await discover(db, identity.spaceId, roots, reportIds))) throw new HttpError(409, 'Reader document authority changed; read again');
}
