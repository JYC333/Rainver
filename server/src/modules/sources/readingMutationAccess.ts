import { HttpError, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { sourceRetrievalReleaseProjects, lockSourceRetrievalRelease } from './retrievalReleaseLocks.js';
import { projectReaderIds, assertProjectReadable } from '../projects/access.js';
import { lockReadingPreferencesShared } from '../informationDigest/readingPreferences.js';
import { canonical } from '../systemActions/operations/repository.js';

type Row = { id: string; project_id?: string | null; source_connection_id?: string | null; [key: string]: unknown };
/** Authority-free discovery. Include every equivalent revision and every
 * membership that can admit it, including a change's collecting Source. */
async function discover(db: Queryable, identity: SpaceUserIdentity, itemId: string) {
  const space = identity.spaceId;
  const items = (await db.query<Row>(`SELECT id,project_id,connection_id,canonical_uri,reading_initial_hash FROM source_items
    WHERE space_id=$1 AND (id=$2 OR canonical_uri=(SELECT canonical_uri FROM source_items WHERE space_id=$1 AND id=$2)) ORDER BY id`, [space, itemId])).rows;
  const ids = items.map(i => i.id);
  const rows = async (table: string, predicate: string, params: unknown[] = [space, ids]) => (await db.query<Row>(`SELECT * FROM ${table} WHERE space_id=$1 AND ${predicate} ORDER BY id`, params)).rows;
  const goals = await rows('source_goals', 'id IN (SELECT goal_id FROM source_goal_items WHERE space_id=$1 AND source_item_id=ANY($2::varchar[]) UNION SELECT goal_id FROM source_goal_item_changes WHERE space_id=$1 AND source_item_id=ANY($2::varchar[]))');
  const bindings = await rows('source_goal_bindings', 'goal_id=ANY($2::varchar[])', [space, goals.map(g => g.id)]);
  const memberships = await rows('source_goal_items', 'source_item_id=ANY($2::varchar[])');
  const changes = await rows('source_goal_item_changes', 'source_item_id=ANY($2::varchar[])');
  const links = await rows('project_source_item_links', 'source_item_id=ANY($2::varchar[])');
  const projectBindings = await rows('project_source_bindings', 'id=ANY($2::varchar[])', [space, links.map(l => l.project_source_binding_id)]);
  const bridges = await rows('project_corpus_item_sources', 'source_item_id=ANY($2::varchar[])');
  const corpus = await rows('project_corpus_items', 'source_item_id=ANY($2::varchar[]) OR id=ANY($3::varchar[])', [space, ids, bridges.map(b => b.corpus_item_id)]);
  const deliveries = await rows('information_digest_items', 'source_item_id=ANY($2::varchar[])');
  const digests = await rows('information_digests', 'id=ANY($2::varchar[])', [space, deliveries.map(d => d.digest_id)]);
  const snapshots = await rows('source_snapshots', 'source_item_id=ANY($2::varchar[])');
  const operations = await rows('project_operations', "progress_json->'recommendation_ids' ?| $2::text[]");
  return { items, goals, bindings, memberships, changes, links, projectBindings, corpus, bridges, digests, deliveries, operations, snapshots };
}
const tables = {
  snapshots: 'source_snapshots', goals: 'source_goals', bindings: 'source_goal_bindings', memberships: 'source_goal_items', changes: 'source_goal_item_changes',
  projectBindings: 'project_source_bindings', links: 'project_source_item_links', corpus: 'project_corpus_items', bridges: 'project_corpus_item_sources',
  digests: 'information_digests', deliveries: 'information_digest_items', operations: 'project_operations',
} as const;
/** Project audiences -> people -> Source roots/grants/consent -> membership
 * owners, held to commit. Re-discovery refuses changed lineage rather than
 * extending the lock set out of order. The canonical owner then reauthorizes
 * the exact requested effect; discovery itself grants nothing. */
export async function lockReadingMutation(db: Queryable, identity: SpaceUserIdentity, itemId: string, projectId?: string, exclusiveItem=false) {
  return lockReadingMutations(db, identity, [itemId], projectId ? [projectId] : [],[],[],exclusiveItem?[itemId]:[]);
}
/** Multi-item owners discover the complete set before taking any Source lock;
 * iterating the single-item lock would violate the shared root order.
 * lockOnlyProjects pins optional discovery scopes without asserting read access;
 * the owner must reselect its readable subset after locking. Actual dependencies
 * and explicit projectIds retain their canonical authorization gates. */
export async function lockReadingMutations(db: Queryable, identity: SpaceUserIdentity, itemIds: readonly string[], projectIds: readonly string[] = [], extraRefs: Parameters<typeof lockSourceRetrievalRelease>[3] = [], additionalPeople:readonly string[] = [], exclusiveItems:readonly string[] = [], writtenProjects:readonly string[] = [], lockOnlyProjects:readonly string[] = []) {
  const anchors = [...new Set(itemIds)].sort();
  const read = async () => {
    const all = [];
    for(const id of anchors)all.push(await discover(db,identity,id));
    const merged = {} as Awaited<ReturnType<typeof discover>>;
    for (const key of Object.keys(tables).concat('items') as (keyof typeof merged)[]) {
      const rows = new Map<string, Row>();
      for (const group of all) for (const row of group[key]) rows.set(row.id, row);
      merged[key] = [...rows.values()].sort((a,b) => a.id.localeCompare(b.id));
    }
    return merged;
  };
  const before = await read();
  const baseProjects = [...new Set([...projectIds, ...lockOnlyProjects, ...Object.values(before).flatMap(rows => rows.flatMap(r => typeof r.project_id === 'string' ? [r.project_id] : []))])].sort();
  const refs = [
    ...extraRefs,
    ...before.snapshots.map(s => ({object_type:'source_snapshot' as const,object_id:s.id})),
    ...before.snapshots.flatMap(s => typeof s.artifact_id==='string' ? [{object_type:'artifact' as const,object_id:s.artifact_id}] : []),
    ...before.items.map(i => ({ object_type: 'source_item' as const, object_id: i.id })),
    ...[...before.bindings, ...before.projectBindings, ...before.corpus].flatMap(b => typeof b.source_connection_id === 'string' ? [{ object_type: 'source_connection' as const, object_id: b.source_connection_id }] : []),
  ];
  const projects = await sourceRetrievalReleaseProjects(db, identity.spaceId, refs, baseProjects);
  const readAudience=async()=>{const people:string[]=[...additionalPeople];for(const project of projects)people.push(...await projectReaderIds(db,identity.spaceId,project));return [...new Set(people)].sort();};
  const audience = await readAudience();
  await lockSourceRetrievalRelease(db, identity.spaceId, identity.userId, refs, projects, undefined, [], audience,exclusiveItems.map(id=>({object_type:'source_item',object_id:id})),writtenProjects);
  const currentAudience = await readAudience();
  if (canonical(audience) !== canonical(currentAudience)) throw new HttpError(409, 'Reading audience changed; reload before updating');
  for (const [key, table] of Object.entries(tables)) {
    const ids = before[key as keyof typeof tables].map(r => r.id);
    if (ids.length) await db.query(`SELECT id FROM ${table} WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`, [identity.spaceId, ids]);
  }
  await lockReadingPreferencesShared(db, identity);
  if (JSON.stringify(before) !== JSON.stringify(await read())) throw new HttpError(409, 'Reading membership changed; reload before updating');
  for (const projectId of [...new Set(projectIds)].sort()) await assertProjectReadable(db, identity.spaceId, projectId, identity.userId);
  return before.items.map(item => item.id);
}
