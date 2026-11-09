import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject, seedSpaceMember, seedRun, seedProjectMainlineRoom } from './support/domainSeeds.js';
import { waitForLockWaiter } from './support/lockWait.js';
import { buildModuleServer } from './support/moduleServer.js';
import { knowledgeModule } from '../src/modules/knowledge/index.js';
import { systemActionsModule } from '../src/modules/systemActions/index.js';
import { PgKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { loadConfig } from '../src/config.js';
const db = useTestDatabase(import.meta.filename);
let space: string, personal: string, owner: string, project: string, note: string, folder: string, app: ReturnType<typeof buildModuleServer>, repo: PgKnowledgeRepository;
const doc = (text: string) => ({
  type: 'doc',
  content: [{
    type: 'paragraph',
    attrs: {
      id: 'stable-block'
    },
    content: [{
      type: 'text',
      text
    }]
  }]
});
const call = (id: string, input: object, key = randomUUID()) => app.inject({
  method: 'POST',
  url: '/api/v1/actions/' + id,
  payload: input,
  headers: {
    'idempotency-key': key
  }
});
const rest = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, key = randomUUID()) => app.inject({
  method,
  url,
  payload,
  headers: {
    'idempotency-key': key
  }
});
const counts = async () => Object.fromEntries(await Promise.all(['space_objects', 'notes', 'note_revisions', 'note_collection_items', 'note_collections', 'domain_change_outbox', 'operation_idempotency'].map(async t => [t, (await db.pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n])));
beforeEach(async () => {
  await resetTables(db.pool, ['spaces', 'users'], {
    cascade: true
  });
  space = randomUUID();
  personal = randomUUID();
  owner = randomUUID();
  project = randomUUID();
  await seedSpaceOwnerProject(db.pool, {
    space,
    owner,
    project,
    spaceType: 'team'
  });
  await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Personal','personal',now(),now())", [personal]);
  await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())", [randomUUID(), personal, owner]);
  repo = new PgKnowledgeRepository(db.pool);
  folder = String((await repo.createNoteCollection({
    spaceId: space,
    userId: owner
  }, {
    name: 'Work'
  })).id);
  note = String((await repo.createNote({
    spaceId: space,
    userId: owner
  }, {
    title: 'Working',
    collection_id: folder,
    visibility: 'private',
    content_json: doc('Before')
  })).id);
  app = buildModuleServer(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri
  }), [knowledgeModule, systemActionsModule]);
  __setAuthIdentityForTests({
    spaceId: space,
    userId: owner
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  __setAuthIdentityForTests(null);
  await app?.close();
});
it('creates roots in Personal, Project drafts shared, and existing parent children in request Space; cross-transport replay has no body', async () => {
  for (const body of [{
    title: 'Root',
    content_json: doc('Secret')
  }, {
    title: 'Project',
    primary_project_id: project
  }, {
    title: 'Child',
    collection_id: folder
  }]) {
    const key = randomUUID(),
      r = await rest('POST', '/api/v1/knowledge/notes', body, key);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.body).not.toContain('Secret');
    const data = r.json().data;
    expect(data.space_id).toBe('collection_id' in body || 'primary_project_id' in body ? space : personal);
    const saved = await counts();
    expect((await call('knowledge.note.create', body, key)).json()).toEqual(r.json());
    expect(await counts()).toEqual(saved);
    const row = (await db.pool.query('SELECT owner_user_id,visibility,primary_project_id FROM space_objects WHERE id=$1', [data.id])).rows[0];
    expect(row.owner_user_id).toBe(owner);
    expect(row.visibility).toBe('primary_project_id' in body ? 'space_shared' : 'private');
    expect((await call('knowledge.note.create', {
      ...body,
      title: 'Changed'
    }, key)).json().error.code).toBe('idempotency_key_reused');
  }
});
it('preserves editor content/version and old receipt while fetching only current body', async () => {
  const key = randomUUID(),
    changes = {
      title: 'Edited',
      content_format: 'prosemirror_json',
      content_json: doc('After'),
      expect_version: 1
    };
  const r = await rest('PATCH', `/api/v1/knowledge/notes/${note}`, changes, key);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().data.version).toBe(2);
  expect(r.body).not.toContain('After');
  const before = await counts();
  expect((await call('knowledge.note.update', {
    note_id: note,
    changes
  }, key)).json()).toEqual(r.json());
  expect(await counts()).toEqual(before);
  const next = await call('knowledge.note.update', {
    note_id: note,
    changes: {
      content_json: doc('Latest'),
      expect_version: 2
    }
  });
  expect(next.statusCode, next.body).toBe(200);
  expect((await rest('PATCH', `/api/v1/knowledge/notes/${note}`, changes, key)).json()).toEqual(r.json());
  expect((await app.inject({
    method: 'GET',
    url: `/api/v1/knowledge/notes/${note}`
  })).json().version).toBe(3);
});
it('handles collection create/update/delete/Project ensure and placement/reorder/revoke through one core', async () => {
  const key = randomUUID(),
    made = await rest('POST', '/api/v1/notes/collections', {
      name: 'Extra'
    }, key);
  expect(made.statusCode, made.body).toBe(201);
  const second = made.json().data.id;
  expect((await call('knowledge.collection.create', {
    name: 'Extra'
  }, key)).json()).toEqual(made.json());
  expect((await rest('PATCH', `/api/v1/notes/collections/${second}`, {
    name: 'Renamed',
    is_hidden: true
  })).statusCode).toBe(200);
  expect((await rest('POST', `/api/v1/knowledge/notes/${note}/placements`, {
    collection_id: second
  })).statusCode).toBe(201);
  const moved = await rest('PATCH', '/api/v1/knowledge/notes/tree/reorder', {
    kind: 'notes',
    updates: [{
      note_id: note,
      from_collection_id: second,
      collection_id: second,
      sort_order: 10
    }]
  });
  expect(moved.statusCode, moved.body).toBe(200);
  expect((await rest('DELETE', `/api/v1/knowledge/notes/${note}/placements/${second}`)).statusCode).toBe(200);
  const delkey = randomUUID(),
    deleted = await rest('DELETE', `/api/v1/notes/collections/${second}`, undefined, delkey);
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect((await call('knowledge.collection.delete', {
    collection_id: second
  }, delkey)).json()).toEqual(deleted.json());
  const ensured = await rest('POST', `/api/v1/notes/collections/project/${project}`, {});
  expect(ensured.statusCode, ensured.body).toBe(200);
  const peer = randomUUID();
  await seedSpaceMember(db.pool, {
    space,
    user: peer
  });
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())", [randomUUID(), space, project, peer]);
  __setAuthIdentityForTests({
    spaceId: space,
    userId: peer
  });
  expect((await rest('POST', `/api/v1/notes/collections/project/${project}`, {})).statusCode).toBe(200);
});
it.each(['notes', 'note_revisions', 'domain_change_outbox', 'operation_idempotency', 'policy_decision_records'])('rolls editor root/content/revision/outbox/request back if %s fails', async table => {
  const before = await counts(),
    old = (await repo.getNote({
      spaceId: space,
      userId: owner
    }, note))!;
  await db.pool.query("CREATE FUNCTION refuse_note_object() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE storage'; END $$");
  await db.pool.query(`CREATE TRIGGER refuse_note_object BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_note_object()`);
  try {
    const r = await call('knowledge.note.update', {
      note_id: note,
      changes: {
        title: 'No partial',
        content_json: doc('No partial'),
        expect_version: 1
      }
    });
    expect(r.statusCode, r.body).toBe(table === 'policy_decision_records' ? 503 : 500);
    expect(r.body).not.toContain('PRIVATE');
    expect(await counts()).toEqual(before);
    expect(await repo.getNote({
      spaceId: space,
      userId: owner
    }, note)).toEqual(old);
  } finally {
    await db.pool.query(`DROP TRIGGER refuse_note_object ON ${table}`);
    await db.pool.query('DROP FUNCTION refuse_note_object()');
  }
});
it('serializes different edit keys on versioned content, with one conflict and no overwrite', async () => {
  const responses = await Promise.all(['First', 'Second'].map(text => call('knowledge.note.update', {
    note_id: note,
    changes: {
      content_json: doc(text),
      expect_version: 1
    }
  })));
  expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
  expect((await repo.getNote({
    spaceId: space,
    userId: owner
  }, note))!.version).toBe(2);
});
it('has no unknown-422 business whitelist and reuses a key after an internal failure', async () => {
  const {
    HttpError
  } = await import('../src/modules/routeUtils/common.js');
  const key = randomUUID(),
    before = await counts();
  const spy = vi.spyOn(PgKnowledgeRepository.prototype, 'updateNote').mockRejectedValueOnce(new HttpError(422, 'PRIVATE unknown'));
  try {
    const r = await call('knowledge.note.update', {
      note_id: note,
      changes: {
        title: 'New'
      }
    }, key);
    expect(r.statusCode, r.body).toBe(500);
    expect(r.body).not.toContain('PRIVATE');
    expect(await counts()).toEqual(before);
  } finally {
    spy.mockRestore();
  }
  expect((await call('knowledge.note.update', {
    note_id: note,
    changes: {
      title: 'New'
    }
  }, key)).statusCode).toBe(200);
});
it('keeps private/summary/oversight and cross-Space Notes hidden, including replay after ownership withdrawal', async () => {
  const key = randomUUID(),
    input = {
      note_id: note,
      changes: {
        title: 'Updated'
      }
    };
  expect((await call('knowledge.note.update', input, key)).statusCode).toBe(200);
  const peer = randomUUID();
  await seedSpaceMember(db.pool, {
    space,
    user: peer,
    role: 'admin'
  });
  __setAuthIdentityForTests({
    spaceId: space,
    userId: peer
  });
  expect((await call('knowledge.note.update', input)).statusCode).toBe(404);
  __setAuthIdentityForTests({
    spaceId: personal,
    userId: owner
  });
  expect((await call('knowledge.note.update', input)).statusCode).toBe(404);
  __setAuthIdentityForTests({
    spaceId: space,
    userId: owner
  });
  await db.pool.query('UPDATE space_objects SET owner_user_id=$2 WHERE id=$1', [note, peer]);
  expect((await call('knowledge.note.update', input, key)).statusCode).toBe(404);
});
it('does not widen the human creation port or allow a real granted Agent Run', async () => {
  const {
    runActor,
    assertCurrentActor
  } = await import('../src/modules/systemActions/operations/actor.js');
  const {
    operationRuntime
  } = await import('../src/modules/systemActions/operations/runtime.js');
  const agent = randomUUID(),
    version = randomUUID(),
    run = randomUUID();
  await seedRun(db.pool, {
    id: run,
    space,
    owner,
    agent,
    version
  });
  await db.pool.query("UPDATE runs SET status='running',instructed_by_user_id=$2,permission_snapshot_json=$3::jsonb WHERE id=$1", [run, owner, JSON.stringify({
    tool_grants: [{
      action_id: 'knowledge.note.create'
    }]
  })]);
  const row = (await db.pool.query<import('../src/modules/runs/repository.js').RunRecord>('SELECT * FROM runs WHERE id=$1', [run])).rows[0]!;
  const actor = await runActor(db.pool, row);
  await assertCurrentActor(db.pool, actor);
  const before = await counts();
  const runtime = await operationRuntime(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri
  }));
  const result = await runtime.execute('knowledge.note.create', {
    title: 'Unauthorized'
  }, actor, randomUUID(), randomUUID());
  expect(result.http_status).toBe(404);
  expect(await counts()).toEqual(before);
});
it('holds one key before a Note row wait; a different-key restore and placement keep both canonical effects', async () => {
  const second = String((await repo.createNoteCollection({
    spaceId: space,
    userId: owner
  }, {
    name: 'Other'
  })).id);
  const holder = await db.pool.connect();
  let placement: ReturnType<typeof call> | undefined, restore: ReturnType<typeof call> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM space_objects WHERE id=$1 FOR UPDATE', [note]);
    const key = randomUUID();
    placement = call('knowledge.note.placement.add', {
      note_id: note,
      collection_id: second
    }, key);
    await waitForLockWaiter(db.pool);
    expect((await call('knowledge.note.placement.add', {
      note_id: note,
      collection_id: second
    }, key)).json().error.code).toBe('idempotency_in_progress');
    restore = call('knowledge.note.rollback', {
      note_id: note,
      to_version: 1,
      expect_version: 1
    });
    await holder.query('COMMIT');
    expect((await placement).statusCode).toBe(201);
    expect((await restore).statusCode).toBe(200);
    const current = (await repo.getNote({
      spaceId: space,
      userId: owner
    }, note))!;
    expect(current.version).toBe(2);
    expect(current.placements as unknown[]).toHaveLength(2);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await placement;
    await restore;
  }
});
it('rejects folder ancestor/set growth while waiting, rather than deleting new placements', async () => {
  const holder = await db.pool.connect();
  let deletion: ReturnType<typeof call> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM note_collections WHERE id=$1 FOR UPDATE', [folder]);
    deletion = call('knowledge.collection.delete', {
      collection_id: folder
    });
    await waitForLockWaiter(db.pool);
    const newNote = await new PgKnowledgeRepository(holder).createNote({
      spaceId: space,
      userId: owner
    }, {
      title: 'Arrived while waiting',
      collection_id: folder
    });
    await holder.query('COMMIT');
    const before = await counts();
    const r = await deletion;
    expect(r.statusCode, r.body).toBe(409);
    expect(await counts()).toEqual(before);
    expect(await repo.getNote({
      spaceId: space,
      userId: owner
    }, String(newNote.id))).not.toBeNull();
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await deletion;
  }
});
it('rechecks Project writer after waiting on a real membership row and preserves all edit state', async () => {
  const projectNote = String((await repo.createNote({
      spaceId: space,
      userId: owner
    }, {
      title: 'Project work',
      primary_project_id: project
    })).id),
    peer = randomUUID();
  await seedSpaceMember(db.pool, {
    space,
    user: peer
  });
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())", [randomUUID(), space, project, peer]);
  __setAuthIdentityForTests({
    spaceId: space,
    userId: peer
  });
  const holder = await db.pool.connect();
  let pending: ReturnType<typeof call> | undefined;
  const before = await counts();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE', [project, peer]);
    pending = call('knowledge.note.update', {
      note_id: projectNote,
      changes: {
        title: 'No permission'
      }
    });
    await waitForLockWaiter(db.pool);
    await holder.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project, peer]);
    await holder.query('COMMIT');
    const r = await pending;
    expect(r.statusCode, r.body).toBe(404);
    expect(await counts()).toEqual(before);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await pending;
  }
});
it('withholds shared edited body and rolls all writes back when required B11 storage fails', async () => {
  const peer = randomUUID();
  await seedSpaceMember(db.pool, {
    space,
    user: peer
  });
  await db.pool.query("UPDATE space_objects SET visibility='space_shared' WHERE id=$1", [note]);
  __setAuthIdentityForTests({
    spaceId: space,
    userId: peer
  });
  const before = await counts();
  await db.pool.query("CREATE FUNCTION refuse_note_b11() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'B11 unavailable'; END $$");
  await db.pool.query('CREATE TRIGGER refuse_note_b11 BEFORE INSERT ON content_access_logs FOR EACH ROW EXECUTE FUNCTION refuse_note_b11()');
  try {
    const r = await call('knowledge.note.update', {
      note_id: note,
      changes: {
        content_json: doc('Unreleased'),
        expect_version: 1
      }
    });
    expect(r.statusCode, r.body).toBe(500);
    expect(r.body).not.toContain('Unreleased');
    expect(await counts()).toEqual(before);
  } finally {
    await db.pool.query('DROP TRIGGER refuse_note_b11 ON content_access_logs');
    await db.pool.query('DROP FUNCTION refuse_note_b11()');
  }
});
it('contains a derived projection failure without poisoning a core editor commit', async () => {
  await db.pool.query("CREATE FUNCTION refuse_object_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'derived unavailable'; END $$");
  await db.pool.query('CREATE TRIGGER refuse_object_projection BEFORE INSERT OR UPDATE ON retrieval_objects FOR EACH ROW EXECUTE FUNCTION refuse_object_projection()');
  try {
    const r = await call('knowledge.note.update', {
      note_id: note,
      changes: {
        content_json: doc('Canonical survives'),
        expect_version: 1
      }
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data.version).toBe(2);
  } finally {
    await db.pool.query('DROP TRIGGER refuse_object_projection ON retrieval_objects');
    await db.pool.query('DROP FUNCTION refuse_object_projection()');
  }
});
it('retains the explicit cross-Project sharing confirmation and owning-entry metadata', async () => {
  const ensured = await repo.ensureProjectNotesCollection({
    spaceId: space,
    userId: owner
  }, project);
  const projectNote = String((await repo.createNote({
    spaceId: space,
    userId: owner
  }, {
    title: 'Owned Project work',
    primary_project_id: project
  })).id);
  const other = randomUUID();
  await db.pool.query("INSERT INTO projects(id,space_id,name,owner_user_id,status,created_at,updated_at) VALUES($1,$2,'Other',$3,'active',now(),now())", [other, space, owner]);
  await seedProjectMainlineRoom(db.pool, {
    space,
    project: other,
    owner
  });
  const otherFolder = await repo.ensureProjectNotesCollection({
    spaceId: space,
    userId: owner
  }, other);
  const r = await call('knowledge.note.placement.add', {
    note_id: projectNote,
    collection_id: otherFolder.id
  });
  expect(r.statusCode, r.body).toBe(409);
  expect(r.json().error.metadata.code).toBe('note_cross_project_share_required');
  expect((await call('knowledge.note.placement.add', {
    note_id: projectNote,
    collection_id: otherFolder.id,
    share_with_project: true
  })).statusCode).toBe(201);
  const remove = await call('knowledge.note.placement.remove', {
    note_id: projectNote,
    collection_id: ensured.id
  });
  expect(remove.statusCode, remove.body).toBe(422);
  expect(remove.json().error.metadata).toMatchObject({
    code: 'note_owning_entry_required',
    note_id: projectNote
  });
});
it('hides an unreadable Note blocking collection deletion without caching its title or identity',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});const privateNote=await repo.createNote({spaceId:space,userId:peer},{title:'PRIVATE blocker',collection_id:folder,visibility:'private'});const before=await counts();
 const result=await call('knowledge.collection.delete',{collection_id:folder});expect(result.statusCode,result.body).toBe(404);expect(result.body).not.toContain('PRIVATE');expect(result.body).not.toContain(String(privateNote.id));expect(await counts()).toEqual(before);
});
it('rebinds a Note and moves an occupied Project role with the complete old/new Note set admitted',async()=>{
 const other=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,name,owner_user_id,status,created_at,updated_at) VALUES($1,$2,'Other',$3,'active',now(),now())",[other,space,owner]);await seedProjectMainlineRoom(db.pool,{space,project:other,owner});const collection=await repo.ensureProjectNotesCollection({spaceId:space,userId:owner},other);
 const previous=await repo.createNote({spaceId:space,userId:owner},{title:'Existing role',primary_project_id:other});await repo.updateNote({spaceId:space,userId:owner},String(previous.id),{project_role:'ideas'});
 const r=await call('knowledge.note.update',{note_id:note,changes:{primary_project_id:other,collection_id:collection.id,project_role:'ideas'}});expect(r.statusCode,r.body).toBe(200);
 expect((await db.pool.query("SELECT object_id FROM notes WHERE role_project_id=$1 AND project_role='ideas'",[other])).rows).toEqual([{object_id:note}]);
});
it('retains domain collection id uniqueness across different transport keys without a duplicate row',async()=>{
 const id=randomUUID(),input={id,name:'Explicit optimistic id'};expect((await call('knowledge.collection.create',input)).statusCode).toBe(201);const before=await counts();const r=await call('knowledge.collection.create',input);expect(r.statusCode,r.body).toBe(409);const after=await counts();expect(after.note_collections).toBe(before.note_collections);expect(after.operation_idempotency).toBe(before.operation_idempotency+1);
});
it('keeps legitimate internal Agent ops root-first while a different-key editor waits, without deadlock or lost ops',async()=>{
 const {withNoteWrites}=await import('../src/modules/knowledge/noteWriter.js');const run=randomUUID();await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 const holder=await db.pool.connect();let internal:ReturnType<typeof withNoteWrites>|undefined,edit:ReturnType<typeof call>|undefined;
 try{await holder.query('BEGIN');await holder.query('SELECT id FROM space_objects WHERE id=$1 FOR UPDATE',[note]);internal=withNoteWrites(db.pool,scope=>scope.applyOps({spaceId:space,noteId:note,baseVersion:1,rawOps:[{op:'append',markdown:'Internal Agent addition'}],source:'ai_adhoc',runId:run,refs:[]}));
 await waitForLockWaiter(db.pool);
 const waiters=(await db.pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows;
 expect(waiters.some(r=>String(r.query).includes('space_objects'))).toBe(true);
 edit=call('knowledge.note.update',{note_id:note,changes:{content_json:doc('Editor change'),expect_version:1}});await holder.query('COMMIT');const outcomes=await Promise.all([internal,edit]);expect(outcomes[0]).not.toBeNull();expect([200,409]).toContain((outcomes[1] as Awaited<ReturnType<typeof call>>).statusCode);
 const current=await repo.getNote({spaceId:space,userId:owner},note);expect(current?.plain_text).toContain('Internal Agent addition');
 }finally{await holder.query('ROLLBACK');holder.release();await internal;await edit;}
});
it('withdraws an existing cross-Project share through REST/generic replay without changing version or copying reach',async()=>{
 const other=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,name,owner_user_id,status,created_at,updated_at) VALUES($1,$2,'Other',$3,'active',now(),now())",[other,space,owner]);await seedProjectMainlineRoom(db.pool,{space,project:other,owner});const otherFolder=await repo.ensureProjectNotesCollection({spaceId:space,userId:owner},other);
 const owned=await repo.createNote({spaceId:space,userId:owner},{title:'Owned',primary_project_id:project});expect((await call('knowledge.note.placement.add',{note_id:owned.id,collection_id:otherFolder.id,share_with_project:true})).statusCode).toBe(201);
 const key=randomUUID(),r=await rest('DELETE',`/api/v1/knowledge/notes/${owned.id}/shares/${other}`,undefined,key);expect(r.statusCode,r.body).toBe(200);expect(r.json().data.version).toBe(1);const before=await counts();expect((await call('knowledge.note.share.revoke',{note_id:owned.id,project_id:other},key)).json()).toEqual(r.json());expect(await counts()).toEqual(before);
 expect((await db.pool.query('SELECT revoked_at FROM space_object_project_shares WHERE object_id=$1 AND project_id=$2',[owned.id,other])).rows[0].revoked_at).not.toBeNull();
});
it('preserves archived-Project existing Note edits/controls while classifying only known active-Project refusals',async()=>{
 const owning=await repo.ensureProjectNotesCollection({spaceId:space,userId:owner},project),owned=await repo.createNote({spaceId:space,userId:owner},{title:'Archive work',primary_project_id:project});await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);
 const edit=await call('knowledge.note.update',{note_id:owned.id,changes:{title:'Still editable'}});expect(edit.statusCode,edit.body).toBe(200);
 const collection=await call('knowledge.collection.create',{name:'Not active',parent_id:owning.id});expect(collection.statusCode,collection.body).toBe(409);expect(collection.json().error.code).toBe('operation_conflict');
 const child=await call('knowledge.note.create',{title:'Not active child',collection_id:owning.id});expect(child.statusCode,child.body).toBe(409);
});
it.each(['domain_change_outbox','operation_idempotency','policy_decision_records','note_collection_items'])('rolls new root/extension/placement/revision back if %s storage fails',async table=>{
 const before=await counts();await db.pool.query("CREATE FUNCTION refuse_note_create() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE create'; END $$");await db.pool.query(`CREATE TRIGGER refuse_note_create BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_note_create()`);
 try{const r=await call('knowledge.note.create',{title:'No partial draft',collection_id:folder,content_json:doc('No partial content')});expect(r.statusCode,r.body).toBe(table==='policy_decision_records'?503:500);expect(r.body).not.toContain('PRIVATE');expect(await counts()).toEqual(before);}finally{await db.pool.query(`DROP TRIGGER refuse_note_create ON ${table}`);await db.pool.query('DROP FUNCTION refuse_note_create()');}
});

it('does not cache owning-entry reorder help and rechecks each addressed Note on formal/generic replay after privatization', async () => {
  const peer = randomUUID();
  await seedSpaceMember(db.pool, {space, user: peer});
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())", [randomUUID(), space, project, peer]);
  const owning = await repo.ensureProjectNotesCollection({spaceId: space, userId: owner}, project);
  const n = await repo.createNote({spaceId: space, userId: owner}, {title: 'Sensitive owning title', primary_project_id: project});
  const input = {kind: 'notes', updates: [{note_id: n.id, from_collection_id: owning.id, collection_id: folder, sort_order: 7}]};
  const key = randomUUID(), before = await counts();
  const placements = (await db.pool.query('SELECT * FROM note_collection_items WHERE note_id=$1 ORDER BY id', [n.id])).rows;
  __setAuthIdentityForTests({spaceId: space, userId: peer});
  const refused = await rest('PATCH', '/api/v1/knowledge/notes/tree/reorder', input, key);
  expect(refused.statusCode, refused.body).toBe(422);
  expect(refused.json().error.metadata).toMatchObject({code: 'note_owning_entry_required', note_id: n.id, note_title: 'Sensitive owning title'});
  expect(refused.json().error.message).toContain('move it within that workspace');
  expect(await counts()).toEqual(before);
  expect((await db.pool.query("SELECT metadata_json FROM policy_decision_records WHERE metadata_json->>'operation_request_id'=$1", [refused.json().error.request_id])).rows).toEqual([expect.objectContaining({metadata_json: expect.objectContaining({operation_outcome: 'failed'})})]);
  await db.pool.query("UPDATE space_objects SET visibility='private' WHERE id=$1", [n.id]);
  for (const response of [await rest('PATCH', '/api/v1/knowledge/notes/tree/reorder', input, key), await call('knowledge.note.tree.reorder', input, key), await call('knowledge.note.tree.reorder', input)]) {
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().error.metadata).toEqual({});
    expect(response.body).not.toContain(String(n.id));
    expect(response.body).not.toContain('Sensitive owning title');
    expect(response.body).not.toContain('affected_note_count');
  }
  expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toEqual([]);
  expect((await db.pool.query('SELECT * FROM note_collection_items WHERE note_id=$1 ORDER BY id', [n.id])).rows).toEqual(placements);
  expect(await counts()).toEqual(before);
  expect((await db.pool.query('SELECT role,status FROM project_members WHERE project_id=$1 AND user_id=$2', [project, peer])).rows).toEqual([{role: 'member', status: 'active'}]);
});

it('rechecks reorder Note authority after a real root-row wait without leaking a newly private blocker', async () => {
  const peer = randomUUID();
  await seedSpaceMember(db.pool, {space, user: peer});
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())", [randomUUID(), space, project, peer]);
  const owning = await repo.ensureProjectNotesCollection({spaceId: space, userId: owner}, project);
  const n = await repo.createNote({spaceId: space, userId: owner}, {title: 'Waited private title', primary_project_id: project});
  const holder = await db.pool.connect();
  let pending: ReturnType<typeof call> | undefined;
  const before = await counts();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM space_objects WHERE id=$1 FOR UPDATE', [n.id]);
    __setAuthIdentityForTests({spaceId: space, userId: peer});
    pending = call('knowledge.note.tree.reorder', {kind: 'notes', updates: [{note_id: n.id, from_collection_id: owning.id, collection_id: folder, sort_order: 4}]});
    await waitForLockWaiter(db.pool);
    await holder.query("UPDATE space_objects SET visibility='private' WHERE id=$1", [n.id]);
    await holder.query('COMMIT');
    const result = await pending;
    expect(result.statusCode, result.body).toBe(404);
    expect(result.body).not.toContain('Waited private title');
    expect(result.body).not.toContain(String(n.id));
    expect(await counts()).toEqual(before);
  } finally { await holder.query('ROLLBACK'); holder.release(); await pending; }
});

it('preserves folder deletion for a destination writer without requiring writer authority over a shared Note owning Project', async () => {
  const other = randomUUID(), peer = randomUUID();
  await seedSpaceMember(db.pool, {space, user: peer});
  await db.pool.query("INSERT INTO projects(id,space_id,name,owner_user_id,status,created_at,updated_at) VALUES($1,$2,'Destination',$3,'active',now(),now())", [other, space, owner]);
  await seedProjectMainlineRoom(db.pool, {space, project: other, owner});
  for (const [id, role] of [[project, 'viewer'], [other, 'member']]) await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',now(),now())", [randomUUID(), space, id, peer, role]);
  const target = await repo.ensureProjectNotesCollection({spaceId: space, userId: owner}, other);
  const child = await repo.createNoteCollection({spaceId: space, userId: owner}, {name: 'Shared entry', parent_id: target.id});
  const n = await repo.createNote({spaceId: space, userId: owner}, {title: 'Shared owning Note', primary_project_id: project});
  await repo.addNotePlacement({spaceId: space, userId: owner}, String(n.id), String(child.id), true);
  __setAuthIdentityForTests({spaceId: space, userId: peer});
  const result = await call('knowledge.collection.delete', {collection_id: child.id});
  expect(result.statusCode, result.body).toBe(200);
  expect((await db.pool.query('SELECT primary_project_id FROM space_objects WHERE id=$1', [n.id])).rows).toEqual([{primary_project_id: project}]);
  expect((await db.pool.query('SELECT collection_id FROM note_collection_items WHERE note_id=$1', [n.id])).rows).toHaveLength(1);
});

it('preserves the canonical collection same-parent ordering permission without granting reparent authority', async () => {
  const peer = randomUUID();
  await seedSpaceMember(db.pool, {space, user: peer});
  const owning = await repo.ensureProjectNotesCollection({spaceId: space, userId: owner}, project);
  const child = await repo.createNoteCollection({spaceId: space, userId: owner}, {name: 'Order only', parent_id: owning.id});
  const sibling = await repo.createNoteCollection({spaceId: space, userId: owner}, {name: 'Other', parent_id: owning.id});
  __setAuthIdentityForTests({spaceId: space, userId: peer});
  const input = {kind: 'collections', updates: [{id: child.id, parent_id: owning.id, sort_order: 13}]}, key = randomUUID();
  const result = await call('knowledge.note.tree.reorder', input, key);
  expect(result.statusCode, result.body).toBe(200);
  expect((await rest('PATCH', '/api/v1/knowledge/notes/tree/reorder', input, key)).json()).toEqual(result.json());
  const reparent = await call('knowledge.note.tree.reorder', {kind: 'collections', updates: [{id: child.id, parent_id: sibling.id, sort_order: 14}]});
  expect(reparent.statusCode, reparent.body).toBe(404);
  expect((await db.pool.query('SELECT parent_id,sort_order FROM note_collections WHERE id=$1', [child.id])).rows).toEqual([{parent_id: owning.id, sort_order: 13}]);
});
