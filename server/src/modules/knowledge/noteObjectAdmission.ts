import type { Queryable, SpaceUserIdentity } from '../routeUtils/common.js';
import { projectOwningCollection } from './noteProjectFolders.js';
import { ProjectArchivedMutationError,assertProjectWriter, assertProjectWriterForMutation } from '../projects/access.js';
import { assertWritableSpaceObject } from './knowledgeWriteAccess.js';
import { OperationError, hidden } from '../systemActions/operations/errors.js';
import { canonical } from '../systemActions/operations/repository.js';
// A bounded closure of the explicitly addressed folders/notes, never all Space rows.
export async function discoverNoteMutation(db: Queryable, person: SpaceUserIdentity, id: string, input: Record<string, any>) {
  const changes = input.changes ?? input,
    folders = new Set<string>(),
    notes = new Set<string>(),
    projects = new Set<string>();
  if (input.note_id) notes.add(input.note_id);
  if (input.collection_id) folders.add(input.collection_id);
  if (changes.collection_id) folders.add(changes.collection_id);
  if (changes.parent_id) folders.add(changes.parent_id);
  if (id === 'knowledge.collection.update' || id === 'knowledge.collection.delete') folders.add(input.collection_id);
  if (changes.primary_project_id) projects.add(changes.primary_project_id);
  if (input.project_id) projects.add(input.project_id);
  for (const row of input.updates ?? []) {
    if (row.note_id) notes.add(row.note_id);
    for (const key of ['from_collection_id', 'collection_id', 'id', 'parent_id']) if (row[key]) folders.add(row[key]);
  }
  // Pin every ancestor that determines Project reach. DELETE also moves direct children.
  if (id === 'knowledge.collection.delete') for (const row of (await db.query<{
    id: string;
  }>('SELECT id FROM note_collections WHERE space_id=$1 AND parent_id=$2', [person.spaceId, input.collection_id])).rows) folders.add(row.id);
  if(id==='knowledge.note.share.revoke')for(const row of (await db.query<{id:string}>(`WITH RECURSIVE f AS (SELECT id FROM note_collections WHERE space_id=$1 AND project_id=$2 UNION SELECT c.id FROM note_collections c JOIN f ON c.parent_id=f.id WHERE c.space_id=$1) SELECT id FROM f ORDER BY id`,[person.spaceId,input.project_id])).rows)folders.add(row.id);
  const folderRows = folders.size ? (await db.query(`WITH RECURSIVE f AS (SELECT id,parent_id,project_id FROM note_collections WHERE space_id=$1 AND id=ANY($2::varchar[]) UNION SELECT p.id,p.parent_id,p.project_id FROM note_collections p JOIN f ON f.parent_id=p.id WHERE p.space_id=$1) SELECT * FROM f ORDER BY id`, [person.spaceId, [...folders]])).rows as {
    id: string;
    parent_id: string | null;
    project_id: string | null;
  }[] : [];
  for (const f of folderRows) {
    folders.add(f.id);
    if (f.project_id && !['knowledge.collection.update', 'knowledge.collection.delete'].includes(id) && !(id === 'knowledge.note.tree.reorder' && input.kind === 'collections')) projects.add(f.project_id);
  }
  const owningProject = (folder: string): string | null => {
    const seen = new Set<string>();
    let current = folderRows.find(row => row.id === folder);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.project_id) return current.project_id;
      current = folderRows.find(row => row.id === current!.parent_id);
    }
    return null;
  };
  // Match the canonical folder writer: deleting/updating a folder controls its
  // own Project, not every Project whose Note has an entry there. A same-parent
  // collection reorder only changes order; the existing writer has no Project
  // mutation gate for that case. Reparenting checks the moved folder's Project.
  if (['knowledge.collection.update', 'knowledge.collection.delete'].includes(id)) {
    const project = owningProject(input.collection_id);
    if (project) projects.add(project);
  }
  if (id === 'knowledge.note.tree.reorder' && input.kind === 'collections') {
    for (const update of input.updates) {
      const current = folderRows.find(row => row.id === update.id);
      if (current && current.parent_id !== update.parent_id) {
        const project = owningProject(update.id);
        if (project) projects.add(project);
      }
    }
  }
  if (id === 'knowledge.collection.delete') for (const row of (await db.query<{
    note_id: string;
  }>('SELECT note_id FROM note_collection_items WHERE space_id=$1 AND collection_id=$2', [person.spaceId, input.collection_id])).rows) notes.add(row.note_id);
  const noteRows = notes.size ? (await db.query<{
    id: string;
    primary_project_id: string | null;
  }>('SELECT id,primary_project_id FROM space_objects WHERE space_id=$1 AND object_type=\'note\' AND id=ANY($2::varchar[]) ORDER BY id', [person.spaceId, [...notes]])).rows : [];
  for (const n of noteRows) if (n.primary_project_id && id !== 'knowledge.collection.delete') projects.add(n.primary_project_id);
  if (changes.project_role) {
    for(const row of (await db.query<{object_id:string}>("SELECT object_id FROM notes WHERE space_id=$1 AND project_role=$2 AND role_project_id=ANY($3::varchar[])",[person.spaceId,changes.project_role,[...projects]])).rows)notes.add(row.object_id);
  }
  const completeNotes=notes.size?(await db.query<{id:string;primary_project_id:string|null}>("SELECT id,primary_project_id FROM space_objects WHERE space_id=$1 AND object_type='note' AND id=ANY($2::varchar[]) ORDER BY id",[person.spaceId,[...notes]])).rows:[];
  // Role holders and folder blockers are locked for invariants, not granted
  // new content authority or made an extra Project-writer requirement.
  // Revoking an existing share is controlled by its owning Project, not by
  // continued writer membership in the destination whose reach is withdrawn.
  if(id==='knowledge.note.share.revoke'&&noteRows[0]?.primary_project_id&&input.project_id!==noteRows[0].primary_project_id)projects.delete(input.project_id);
  return {
    folders: [...folders].sort(),
    notes: [...notes].sort(),
    projects: [...projects].sort(),
    folderRows,
    noteRows:completeNotes
  };
}
export async function admitNoteMutation(db: Queryable, person: SpaceUserIdentity, id: string, input: Record<string, any>, expected?: unknown) {
  const before = await discoverNoteMutation(db, person, id, input);
  if (expected && canonical(before) !== canonical(expected)) throw new OperationError('operation_conflict', 409);
  // Metadata collection writes have no separate owner: existing Project writer rules apply.
  const addressedNotes = input.note_id ? [input.note_id] : id === 'knowledge.note.tree.reorder' && input.kind === 'notes' ? [...new Set<string>(input.updates.map((row: {note_id: string}) => row.note_id))].sort() : [];
  for (const note of addressedNotes) await assertWritableSpaceObject(db, person, note, 'Note not found');

  // Any append-order gate is taken before folder/Note rows, including the legacy writer's gate.
  if (id === 'knowledge.collection.create') {
    const lock = (await db.query<{
      locked: boolean;
    }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [`note-collection-order:${person.spaceId}:${input.parent_id ?? 'root'}`])).rows[0];
    if (!lock?.locked) throw new OperationError('idempotency_in_progress', 409, true);
  }
  for (const project of before.projects) await assertProjectWriterForMutation(db, person.spaceId, project, person.userId);
  if (before.folders.length) await db.query('SELECT id FROM note_collections WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR UPDATE', [person.spaceId, before.folders]);
  if (before.notes.length) await db.query('SELECT id FROM space_objects WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR UPDATE', [person.spaceId, before.notes]);
  if (canonical(await discoverNoteMutation(db, person, id, input)) !== canonical(before)) throw new OperationError('operation_conflict', 409);
  for (const note of addressedNotes) await assertWritableSpaceObject(db, person, note, 'Note not found');
  return before;
}
/** Child creation stays in the authenticated parent Space; roots use the access owner. */
export async function discoverNoteCreationParent(db: Queryable, person: SpaceUserIdentity, collection: string) {
  const row = (await db.query('SELECT id FROM note_collections WHERE space_id=$1 AND id=$2', [person.spaceId, collection])).rows[0];
  if (!row) throw hidden();
  const project = await projectOwningCollection(db, person.spaceId, collection);
  if(project)try{await assertProjectWriter(db,person.spaceId,project,person.userId);}catch(error){if(error instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409);throw error;}
  return project;
}
