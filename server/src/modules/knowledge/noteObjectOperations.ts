import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import type { Queryable, SpaceUserIdentity } from '../routeUtils/common.js';
import {NoteObjectError} from './noteObjectErrors.js';
import { assertWritableSpaceObject } from './knowledgeWriteAccess.js';
import { NOTE_OBJECT_SCHEMAS, type OperationActor, type RegisteredSystemActionDefinition } from '@rainver/protocol';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { hidden, OperationError } from '../systemActions/operations/errors.js';
import { PgKnowledgeRepository } from './repository.js';
import { admitNoteMutation, discoverNoteCreationParent, discoverNoteMutation } from './noteObjectAdmission.js';
import { assertProjectReadable, assertProjectWriterForMutation } from '../projects/access.js';
import { noteObjectFailure } from './noteObjectErrors.js';
import { parseNotesTreeReorder, persistNotesTreeReorder } from './notesTreeReorder.js';
const person = (a: OperationActor) => ({
  spaceId: a.space_id,
  userId: a.on_behalf_of_user_id!
});
// Discovered blockers are current decision help, never durable failure receipts.
// Keep the same safe metadata for visible Notes; do not expose even a count if
// any blocker candidate is unreadable. Plain OperationError forces full rollback.
async function throwCurrentBlocker(db: Queryable, p: SpaceUserIdentity, error: unknown, notes: readonly string[]): Promise<never> {
  if (error instanceof NoteObjectError && (error.responseBody as {code?: string})?.code === 'note_owning_entry_required') {
    for (const note of notes) if (await contentDecisionFromDb(db, p, 'space_object', note, {includeOversight: false}) === 'deny') throw hidden();
    const refusal = noteObjectFailure(error)!;
    const fresh = new OperationError(refusal.code, refusal.httpStatus, false, 'knowledge');
    fresh.body = refusal.body.bind(refusal);
    throw fresh;
  }
  throw error;
}
export function noteObjectRegistrations(defs: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration[] {
  return Object.keys(NOTE_OBJECT_SCHEMAS).map(id => ({
    definition: defs.get(id)!,
    ...(id === 'knowledge.note.create' ? {
      userContentCreation: true as const
    } : {}),
    successStatus: id.endsWith('.create') || id.endsWith('.add') ? 201 : 200,
    async resolve(db, raw, actor) {
      const input = raw as Record<string, any>;
      let project: string | null = null;
      if (id === 'knowledge.note.create') project = input.collection_id ? await discoverNoteCreationParent(db, person(actor), input.collection_id) : input.primary_project_id ?? null;
      return {
        authority: id === 'knowledge.note.create' ? project ? `project:${project}` : `space:${actor.space_id}` : input.note_id ? `note:${input.note_id}` : `note_collections:${actor.space_id}`,
        targets: id === 'knowledge.note.create' ? {
          project_id: project,
          collection_id: input.collection_id ?? null
        } : {
          note_id: input.note_id ?? null,
          collection_id: input.collection_id ?? null
        },
        resourceType: 'note',
        resourceId: input.note_id ?? null,
        project,
        admission: await discoverNoteMutation(db, person(actor), id, input)
      };
    },
    normalizeInput(raw, scope) {
      const input = raw as Record<string, any>;
      if (id === 'knowledge.note.create') return {
        ...input,
        collection_id:input.collection_id??null,created_from_activity_id:input.created_from_activity_id??null,primary_project_id: (scope as typeof scope & {
          project: string | null;
        }).project,
        visibility: (scope as typeof scope & {
          project: string | null;
        }).project ? 'space_shared' : 'private'
      };
      if (id === 'knowledge.collection.create') return {
        ...input,
        parent_id: input.parent_id ?? null,
        sort_order: input.sort_order ?? null
      };
      if (id === 'knowledge.note.update' && Object.hasOwn(input.changes, 'content_json')) return {
        ...input,
        changes: {
          ...input.changes,
          expect_version: input.changes.expect_version ?? null
        }
      };
      return input;
    },
    async authorize(db, raw, actor, scope) {
      const input = raw as Record<string, any>;
      if (id === 'knowledge.collection.ensure_project' && (await db.query('SELECT id FROM note_collections WHERE space_id=$1 AND project_id=$2', [actor.space_id, input.project_id])).rows.length) {
        await assertProjectReadable(db, actor.space_id, input.project_id, actor.on_behalf_of_user_id!);
        return;
      }
      if (id === 'knowledge.note.create' && input.collection_id && (await discoverNoteCreationParent(db, person(actor), input.collection_id)) !== input.primary_project_id) throw new OperationError('operation_conflict', 409);
      await admitNoteMutation(db, person(actor), id, input, (scope as typeof scope & {
        admission: unknown;
      }).admission);
    },
    async authorizeResult(db, raw, actor) {
      const output = raw as {
        id?: string;
        space_id?: string;
        project_ids?: string[];
      };
      if (!output.id) return;
      if (output.space_id !== actor.space_id) throw hidden();
      for (const project of output.project_ids ?? []) await (id === 'knowledge.collection.ensure_project' ? assertProjectReadable : assertProjectWriterForMutation)(db, actor.space_id, project, actor.on_behalf_of_user_id!);
      if (id.startsWith('knowledge.note.') && !id.endsWith('reorder')) {
        await assertWritableSpaceObject(db, person(actor), output.id, 'Note not found');
      }
    },
    async execute(db, raw, actor) {
      const input = raw as Record<string, any>,
        p = person(actor),
        repo = new PgKnowledgeRepository(db);
      if (id === 'knowledge.note.tree.reorder') {
        try { return await persistNotesTreeReorder(db, p, parseNotesTreeReorder(input)); }
        catch (error) { return throwCurrentBlocker(db, p, error, input.kind === 'notes' ? input.updates.map((row: {note_id: string}) => row.note_id) : []); }
      }
      let out: Record<string, unknown>;
      switch (id) {
        case 'knowledge.note.create':
          out = await repo.createNote(p, input);
          break;
        case 'knowledge.note.update':
          out = await repo.updateNote(p, input.note_id, input.changes);
          break;
        case 'knowledge.note.placement.add':
          out = await repo.addNotePlacement(p, input.note_id, input.collection_id, input.share_with_project);
          break;
        case 'knowledge.note.placement.remove':
          out = await repo.removeNotePlacement(p, input.note_id, input.collection_id);
          break;
        case 'knowledge.note.share.revoke':
          out = await repo.revokeNoteProjectShare(p, input.note_id, input.project_id);
          break;
        case 'knowledge.collection.create':
          out = await repo.createNoteCollection(p, input);
          break;
        case 'knowledge.collection.update':
          out = await repo.updateNoteCollection(p, input.collection_id, input.changes);
          break;
        case 'knowledge.collection.ensure_project':
          out = await repo.ensureProjectNotesCollection(p, input.project_id);
          break;
        case 'knowledge.collection.delete':
          {
            const scope = await import('./noteObjectAdmission.js').then(m => m.discoverNoteMutation(db, p, id, input));
            try {await repo.deleteNoteCollection(p, input.collection_id);}
            catch(error){ await throwCurrentBlocker(db, p, error, scope.notes); }
            return {
              id: input.collection_id,
              space_id: p.spaceId,
              project_ids: scope.projects,
              deleted: true
            };
          }
        default:
          throw new OperationError('operation_internal_error', 500);
      }
      return {
        id: out.id,
        space_id: out.space_id,
        project_ids: id.startsWith('knowledge.collection.') && out.project_id ? [out.project_id] : [],
        ...(id.startsWith('knowledge.collection.') ? {
          deleted: false
        } : {
          version: out.version
        })
      };
    },
    classifyError(error){
      const pg=error as {code?:string;constraint?:string};
      if(id==='knowledge.collection.create'&&pg?.code==='23505'&&pg.constraint==='note_collections_pkey')return noteObjectFailure(new NoteObjectError(409,'Collection id already exists'));
      return noteObjectFailure(error);
    }
  }));
}
