import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject } from './support/domainSeeds.js';
import { resetTables } from './support/resetTables.js';
import { waitForLockWaiter } from './support/lockWait.js';
import { ReaderAppearanceSettings, ReaderPositionStore } from '../src/modules/reader/positions.js';
import { PgAnnotationRepository, PgReaderRepository } from '../src/modules/reader/repository.js';
import { loadConfig } from '../src/config.js';
import { agentReadingDocument, agentReadingMetadata, saveSourceReadingDocument } from '../src/modules/sources/materialProcessing/documents.js';

const db = useTestDatabase(import.meta.filename);
const space = randomUUID(), owner = randomUUID(), project = randomUUID(), other = randomUUID();
const identity = { spaceId: space, userId: owner };
const url = 'https://example.test/article';
const config = () => loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
// Reports name a version by label ('c1' = the document as created, others as revised);
// the wrapper puts that version's real hashes in, as a client would from its payload.
const versions = new Map<string, Record<string, { content_hash: string; structure_hash: string }>>();
async function versionOf(id: string) {
  const document = await new PgReaderRepository(db.pool, config()).getDocument(identity, 'source_item', id, { recordOpen: false });
  return { content_hash: document!.content_hash, structure_hash: document!.structure_hash };
}
const store = () => {
  const real = new ReaderPositionStore(db.pool, config());
  return {
    get: real.get.bind(real), progressForSourceItems: real.progressForSourceItems.bind(real),
    write: (who: { spaceId: string; userId: string }, type: string, id: string, body: Record<string, unknown>) =>
      real.write(who, type, id, { ...body, ...(versions.get(id)?.[body.content_hash as string] ?? {}) }),
  };
};

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ['spaces', 'users'], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space, owner, project, spaceType: 'team' });
  await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Other','active',$2,'system',now(),now())`, [other, `${other}@test.invalid`]);
  await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, other]);
});

async function item(visibility: 'space_shared' | 'private' = 'space_shared'): Promise<string> {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO source_items(id,space_id,project_id,owner_user_id,created_by_user_id,visibility,item_type,title,canonical_uri,source_uri,content_hash,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at)
    VALUES($1,$2,NULL,$3,$3,$5,'external_url','Article',$4,$4,'hash','metadata_only','metadata_only',now(),now(),now(),now())`, [id, space, owner, `${url}/${id}`, visibility]);
  const content = { kind: 'article' as const, format: 'source_text' as const, text: 'First paragraph.\n\nSecond paragraph.', sources: [url] };
  await saveSourceReadingDocument(db.pool, { spaceId: space, itemId: id, document: agentReadingDocument(content, url), agentProvided: true, metadata: agentReadingMetadata(content) });
  versions.set(id, { c1: await versionOf(id) });
  return id;
}

/** A new body for the document (reprocessing), known to reports as `label`. */
async function revise(id: string, label: string, text: string) {
  const content = { kind: 'article' as const, format: 'source_text' as const, text, sources: [url] };
  await saveSourceReadingDocument(db.pool, { spaceId: space, itemId: id, document: agentReadingDocument(content, url), agentProvided: true, metadata: agentReadingMetadata(content) });
  versions.get(id)![label] = await versionOf(id);
}

const mark = (progress: number, quote = 'Second paragraph.') => ({ anchor: { block_index: progress > 0.5 ? 1 : 0, pm_pos: progress > 0.5 ? 19 : 1, text_offset: Math.round(progress * 34), quote, before_context: '' }, progress });
const base = Date.now() - 3_600_000;
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const report = (progress: number, seconds: number, extra: Record<string, unknown> = {}) => ({ content_hash: 'c1', structure_hash: 's1', current: mark(progress), client_at: at(seconds), ...extra });

describe('reading position rules', () => {
  it('keeps the newest current position: a delayed or older-tab report cannot move it back', async () => {
    const id = await item();
    await store().write(identity, 'source_item', id, report(0.6, 20));
    const stale = await store().write(identity, 'source_item', id, report(0.1, 10));
    expect(stale.accepted).toBe(false);
    expect((await store().get(identity, 'source_item', id))?.current.progress).toBe(0.6);
  });

  it('grows the furthest position only from dwelled reports and never moves it back on rereading', async () => {
    const id = await item();
    await store().write(identity, 'source_item', id, report(0.9, 1));                  // fast scroll to the end
    expect((await store().get(identity, 'source_item', id))?.furthest).toBeNull();
    await store().write(identity, 'source_item', id, report(0.5, 2, { dwelled: true }));
    await store().write(identity, 'source_item', id, report(0.2, 3, { dwelled: true }));  // reading an earlier part again
    const position = await store().get(identity, 'source_item', id);
    expect(position?.current.progress).toBe(0.2);
    expect(position?.furthest?.progress).toBe(0.5);
  });

  it('lets an explicit reset set the furthest position to the current one, and wins over reports taken before it', async () => {
    const id = await item();
    await store().write(identity, 'source_item', id, report(0.8, 1, { dwelled: true }));
    await store().write(identity, 'source_item', id, report(0.3, 5, { reset_furthest: true }));
    expect((await store().get(identity, 'source_item', id))?.furthest?.progress).toBe(0.3);
    // A dwelled report taken before the reset (delivered late) cannot undo it.
    await store().write(identity, 'source_item', id, report(0.9, 4, { dwelled: true }));
    expect((await store().get(identity, 'source_item', id))?.furthest?.progress).toBe(0.3);
    await store().write(identity, 'source_item', id, report(0.4, 6, { dwelled: true }));
    expect((await store().get(identity, 'source_item', id))?.furthest?.progress).toBe(0.4);
  });

  it('applies only reports on the version the document has now, whatever their time', async () => {
    const id = await item();
    await store().write(identity, 'source_item', id, report(0.8, 10, { dwelled: true }))
    await revise(id, 'c2', 'A new introduction.\n\nFirst paragraph.\n\nSecond paragraph.');
    // The new version's first report replaces the old version's place, even with an earlier clock.
    const moved = await store().write(identity, 'source_item', id, { ...report(0.4, 5, { reset_furthest: true }), content_hash: 'c2' });
    expect(moved.accepted).toBe(true);
    expect(moved.position).toMatchObject({ ...versions.get(id)!.c2, furthest: { progress: 0.4 } });
    // A tab still open on the old version keeps reporting later times: none of it is applied.
    for (const late of [report(0.9, 30, { dwelled: true }), report(0.95, 40, { reset_furthest: true })]) {
      const result = await store().write(identity, 'source_item', id, late);
      expect(result.accepted).toBe(false);
    }
    // A made-up version is not applied either.
    expect((await store().write(identity, 'source_item', id, { ...report(0.1, 50), content_hash: 'forged', structure_hash: 'forged' })).accepted).toBe(false);
    const position = await store().get(identity, 'source_item', id);
    expect(position).toMatchObject({ ...versions.get(id)!.c2, current: { progress: 0.4 }, furthest: { progress: 0.4 } });
  });

  it('numbers every stored change, so replies can be ordered by the client', async () => {
    const id = await item();
    const first = await store().write(identity, 'source_item', id, report(0.2, 1));
    const second = await store().write(identity, 'source_item', id, report(0.3, 2, { dwelled: true }));
    const ignored = await store().write(identity, 'source_item', id, report(0.1, 1));
    expect([first.position?.revision, second.position?.revision, ignored.position?.revision]).toEqual([1, 2, 2]);
    expect(ignored.accepted).toBe(false);
  });

  it('keeps both of two concurrent first reports in order, under the row lock', async () => {
    const id = await item();
    const results = await Promise.all([
      store().write(identity, 'source_item', id, report(0.2, 10)),
      store().write(identity, 'source_item', id, report(0.8, 20, { dwelled: true })),
    ]);
    expect(results.every(result => result.accepted)).toBe(true);
    const position = await store().get(identity, 'source_item', id);
    expect(position).toMatchObject({ current: { progress: 0.8 }, furthest: { progress: 0.8 }, revision: 2 });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM reader_positions WHERE document_id=$1`, [id])).rows[0].n).toBe(1);
  });

  it('does not apply an old-version report whose request started before a new version and its reset were committed', async () => {
    const id = await item();
    const old = versions.get(id)!.c1;
    await store().write(identity, 'source_item', id, report(0.2, 1));
    // The old report's transaction is delayed (as by a busy pool) while the body is
    // rewritten and the new version's reset commits.
    let paused = false;
    const delayed = { query: db.pool.query.bind(db.pool), connect: async () => {
      if (!paused) {
        paused = true;
        await revise(id, 'c2', 'Completely revised document.\n\nNew final paragraph.');
        await store().write(identity, 'source_item', id, { ...report(0.4, 5, { reset_furthest: true }), content_hash: 'c2' });
      }
      return db.pool.connect();
    } };
    const result = await new ReaderPositionStore(delayed as never, config()).write(identity, 'source_item', id, { ...report(0.9, 30, { dwelled: true }), ...old });
    expect(result.accepted).toBe(false);
    expect(await store().get(identity, 'source_item', id)).toMatchObject({ ...versions.get(id)!.c2, furthest: { progress: 0.4 } });
  });

  it('waits for a body rewrite in progress and then judges the report against the new body', async () => {
    const id = await item();
    const old = versions.get(id)!.c1;
    const writer = await db.pool.connect();
    try {
      await writer.query('BEGIN');
      const content = { kind: 'article' as const, format: 'source_text' as const, text: 'Rewritten while a report waits.', sources: [url] };
      await saveSourceReadingDocument(writer, { spaceId: space, itemId: id, document: agentReadingDocument(content, url), agentProvided: true, metadata: agentReadingMetadata(content) });
      let settled = false;
      const pending = store().write(identity, 'source_item', id, { ...report(0.7, 30, { dwelled: true }), ...old }).finally(() => { settled = true });
      // The report is blocked on the rewrite's row lock (observed in pg_stat_activity), not finished.
      await waitForLockWaiter(db.pool, { settled: () => settled });
      expect(settled).toBe(false);
      await writer.query('COMMIT');
      expect((await pending).accepted).toBe(false);
    } finally { writer.release() }
    expect(await store().get(identity, 'source_item', id)).toBeNull();
  });

  it('makes a body rewrite wait while a position for the current body is being stored', async () => {
    const id = await item();
    const old = versions.get(id)!.c1;
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve });
    let locked: () => void = () => {}
    const holding = new Promise<void>(resolve => { locked = resolve });
    // Pause the position transaction right after it took the document's row.
    const paused = { query: db.pool.query.bind(db.pool), connect: async () => {
      const client = await db.pool.connect();
      const query = client.query.bind(client);
      (client as unknown as { query: unknown }).query = async (...args: Parameters<typeof query>) => {
        const result = await query(...args);
        if (typeof args[0] === 'string' && args[0].includes('FOR SHARE')) { locked(); await gate }
        return result;
      };
      return client;
    } };
    const position = new ReaderPositionStore(paused as never, config()).write(identity, 'source_item', id, { ...report(0.5, 10), ...old });
    await holding;
    let rewritten = false;
    let rewriteFailed = false;
    const rewrite = (async () => {
      const writer = await db.pool.connect();
      try {
        await writer.query('BEGIN');
        const content = { kind: 'article' as const, format: 'source_text' as const, text: 'Rewritten after the report.', sources: [url] };
        await saveSourceReadingDocument(writer, { spaceId: space, itemId: id, document: agentReadingDocument(content, url), agentProvided: true, metadata: agentReadingMetadata(content) });
        await writer.query('COMMIT');
        rewritten = true;
      } catch (error) { rewriteFailed = true; throw error } finally { writer.release() }
    })();
    // The rewrite is blocked on the position transaction's shared row lock, not finished.
    await waitForLockWaiter(db.pool, { settled: () => rewritten || rewriteFailed });
    expect(rewritten).toBe(false);
    release();
    expect((await position).accepted).toBe(true);
    await rewrite;
    // Stored for the body that was current; the next report on the new body replaces it.
    expect((await store().get(identity, 'source_item', id))?.structure_hash).toBe(old.structure_hash);
    versions.get(id)!.c3 = await versionOf(id);
    expect((await store().write(identity, 'source_item', id, { ...report(0.1, 1), content_hash: 'c3' })).accepted).toBe(true);
  });

  it('rejects malformed reports and clocks far in the future', async () => {
    const id = await item();
    await expect(store().write(identity, 'source_item', id, { ...report(0.5, 1), read_status: 'read' })).rejects.toMatchObject({ statusCode: 422 });
    await expect(store().write(identity, 'source_item', id, { ...report(0.5, 1), client_at: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('reading position privacy and side effects', () => {
  it('is private to its reader and needs the document gate on every read and write', async () => {
    const shared = await item();
    await store().write(identity, 'source_item', shared, report(0.6, 1));
    // Another member reading the same document has their own (empty) position.
    expect(await store().get({ spaceId: space, userId: other }, 'source_item', shared)).toBeNull();
    const privateItem = await item('private');
    await expect(store().get({ spaceId: space, userId: other }, 'source_item', privateItem)).rejects.toMatchObject({ statusCode: 404 });
    await expect(store().write({ spaceId: space, userId: other }, 'source_item', privateItem, report(0.5, 1))).rejects.toMatchObject({ statusCode: 404 });
    const stranger = { spaceId: space, userId: randomUUID() };
    await expect(store().get(stranger, 'source_item', shared)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('never changes read status, reading origin or opened times', async () => {
    const id = await item();
    const before = await db.pool.query(`SELECT * FROM source_item_user_states WHERE space_id=$1 AND source_item_id=$2`, [space, id]);
    await store().write(identity, 'source_item', id, report(1, 1, { dwelled: true }));
    const after = await db.pool.query(`SELECT * FROM source_item_user_states WHERE space_id=$1 AND source_item_id=$2`, [space, id]);
    expect(after.rows).toEqual(before.rows);
  });

  it('reports list progress only for the asking reader', async () => {
    const id = await item();
    await store().write(identity, 'source_item', id, report(0.6, 1, { dwelled: true }));
    expect((await store().progressForSourceItems(identity, [id])).get(id)).toEqual({ current: 0.6, furthest: 0.6 });
    expect((await store().progressForSourceItems({ spaceId: space, userId: other }, [id])).size).toBe(0);
  });
});

describe('Reader appearance settings', () => {
  it('keeps each person’s appearance in their own user settings, with defaults and validation', async () => {
    const settings = new ReaderAppearanceSettings(db.pool);
    expect(await settings.get(identity)).toEqual({ font_size: null, line_height: 'normal', width: 'medium', font: 'sans', theme: 'app' });
    await settings.set(identity, { font_size: 20, line_height: 'relaxed', width: 'wide', font: 'serif', theme: 'sepia' });
    expect(await settings.get(identity)).toMatchObject({ font_size: 20, theme: 'sepia' });
    expect(await settings.get({ spaceId: space, userId: other })).toMatchObject({ font_size: null, theme: 'app' });
    await expect(settings.set(identity, { font_size: 99 })).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('undoing an annotation removal', () => {
  const create = (who: { spaceId: string; userId: string }, id: string) => new PgAnnotationRepository(db.pool).createAnnotation(who, {
    document_type: 'source_item', document_id: id, annotation_type: 'highlight', quote_text: 'Second paragraph.',
    anchor_json: { schema_version: 1, normalizer: 'plain_text_v1', quote_text: 'Second paragraph.', text_range: { start: 17, end: 34, unit: 'utf16' }, before_context: 'First paragraph. ', after_context: '' },
  });

  it('restores the removed annotation for its author while the document is readable', async () => {
    const id = await item();
    const repo = new PgAnnotationRepository(db.pool);
    const created = await create(identity, id);
    await repo.archiveAnnotation(identity, created.id);
    expect(await repo.listAnnotations(identity, 'source_item', id)).toHaveLength(0);
    expect((await repo.updateAnnotation(identity, created.id, { status: 'active' })).status).toBe('active');
    expect((await repo.listAnnotations(identity, 'source_item', id)).map(a => a.id)).toEqual([created.id]);
  });

  it('does not bring an annotation back into a document its author can no longer read', async () => {
    const id = await item();
    const repo = new PgAnnotationRepository(db.pool);
    const reader = { spaceId: space, userId: other };
    const created = await create(reader, id);
    await repo.archiveAnnotation(reader, created.id);
    await db.pool.query(`UPDATE source_items SET visibility='private' WHERE id=$1`, [id]);
    await expect(repo.updateAnnotation(reader, created.id, { status: 'active' })).rejects.toMatchObject({ statusCode: 404 });
    const row = await db.pool.query<{ status: string }>(`SELECT status FROM reader_annotations WHERE id=$1`, [created.id]);
    expect(row.rows[0]?.status).toBe('archived');
  });
});

describe('annotation range replacement', () => {
  async function rangeFixture() {
    const id = await item();
    const repo = new PgAnnotationRepository(db.pool);
    const ann = await repo.createAnnotation(identity, { document_type: 'source_item', document_id: id, annotation_type: 'highlight', quote_text: 'First', label: 'Keep this label',
      anchor_json: { schema_version: 1, normalizer: 'plain_text_v1', quote_text: 'First', text_range: { start: 0, end: 5, unit: 'utf16' }, before_context: '', after_context: ' paragraph.' } });
    const document = (await new PgReaderRepository(db.pool, config()).getDocument(identity, 'source_item', id, { recordOpen: false }))!;
    const quote = 'Second paragraph.';
    const start = document.normalized_text.indexOf(quote);
    const body = { expected_quote_text: ann.quote_text, expected_anchor_json: ann.anchor_json, content_hash: document.content_hash, structure_hash: document.structure_hash!, quote_text: quote,
      anchor_json: { schema_version: 1, normalizer: 'plain_text_v1', quote_text: quote, text_range: { start, end: start + quote.length, unit: 'utf16' },
        before_context: 'First paragraph. ', after_context: '', content_hash: document.content_hash, structure_hash: document.structure_hash!, document_ref: { document_type: 'source_item', document_id: id } } };
    return { id, ann, body, repo };
  }
  it('replaces a range without changing identity, label or visibility and refuses a stale second edit', async ctx => {
    if (!db.available) return ctx.skip();
    const { replaceAnnotationRange } = await import('../src/modules/reader/annotationRange.js');
    const { ann, body } = await rangeFixture();
    const saved = await replaceAnnotationRange(db.pool, config(), identity, ann.id, body);
    expect(saved).toMatchObject({ id: ann.id, quote_text: 'Second paragraph.', label: 'Keep this label', visibility: 'private', anchor_state: 'unverified' });
    await expect(replaceAnnotationRange(db.pool, config(), identity, ann.id, body)).rejects.toMatchObject({ statusCode: 409 });
  });
  it('refuses a different author and a changed document without replacing the original quote', async ctx => {
    if (!db.available) return ctx.skip();
    const { replaceAnnotationRange } = await import('../src/modules/reader/annotationRange.js');
    const { id, ann, body } = await rangeFixture();
    await expect(replaceAnnotationRange(db.pool, config(), { spaceId: space, userId: other }, ann.id, body)).rejects.toMatchObject({ statusCode: 404 });
    await revise(id, 'changed-range', 'New text.');
    await expect(replaceAnnotationRange(db.pool, config(), identity, ann.id, body)).rejects.toMatchObject({ statusCode: 409 });
    expect((await db.pool.query('SELECT quote_text FROM reader_annotations WHERE id=$1', [ann.id])).rows[0].quote_text).toBe('First');
  });
  it('does not resurrect an archived annotation or accept a cross-document replacement', async ctx => {
    if (!db.available) return ctx.skip();
    const { replaceAnnotationRange } = await import('../src/modules/reader/annotationRange.js');
    const { ann, body, repo } = await rangeFixture();
    await expect(replaceAnnotationRange(db.pool, config(), identity, ann.id, { ...body, anchor_json: { ...body.anchor_json, document_ref: { document_type: 'source_item', document_id: randomUUID() } } })).rejects.toMatchObject({ statusCode: 422 });
    await repo.archiveAnnotation(identity, ann.id);
    await expect(replaceAnnotationRange(db.pool, config(), identity, ann.id, body)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('private document notes reuse canonical Notes', () => {
  const personal = randomUUID(), otherPersonal = randomUUID();
  beforeEach(async () => {
    if (!db.available) return;
    for (const [spaceId, userId] of [[personal, owner], [otherPersonal, other]]) {
      await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Personal','personal',now(),now())", [spaceId]);
      await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())", [randomUUID(), spaceId, userId]);
    }
  });
  it('does not create on GET and concurrent explicit creates resolve one private note in Personal Space', async ctx => {
    if (!db.available) return ctx.skip();
    const { ReaderDocumentNotes } = await import('../src/modules/reader/documentNotes.js');
    const service = new ReaderDocumentNotes(db.pool), id = await item();
    expect(await service.get(identity, 'source_item', id)).toEqual({ note: null });
    expect((await db.pool.query('SELECT count(*)::int AS count FROM reader_document_notes')).rows[0].count).toBe(0);
    const [a, b] = await Promise.all([service.create(identity, 'source_item', id, { title: 'My document notes' }), service.create(identity, 'source_item', id, { title: 'My document notes' })]);
    expect(a.note).toEqual(b.note);
    expect(a.note?.space_id).toBe(personal);
    const note = (await db.pool.query('SELECT so.visibility,so.primary_project_id,n.plain_text FROM notes n JOIN space_objects so ON so.id=n.object_id WHERE so.id=$1', [a.note!.id])).rows[0];
    expect(note).toMatchObject({ visibility: 'private', primary_project_id: null, plain_text: null });
    expect((await db.pool.query('SELECT count(*)::int AS count FROM reader_document_notes')).rows[0].count).toBe(1);
  });
  it('keeps different readers independent and gates the association by current document access', async ctx => {
    if (!db.available) return ctx.skip();
    const { ReaderDocumentNotes } = await import('../src/modules/reader/documentNotes.js');
    const service = new ReaderDocumentNotes(db.pool), id = await item();
    const a = await service.create(identity, 'source_item', id);
    const otherIdentity = { spaceId: space, userId: other };
    const b = await service.create(otherIdentity, 'source_item', id);
    expect(a.note!.id).not.toBe(b.note!.id);
    expect(b.note!.space_id).toBe(otherPersonal);
    await db.pool.query("UPDATE source_items SET visibility='private' WHERE id=$1", [id]);
    await expect(service.get(otherIdentity, 'source_item', id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await service.get(identity, 'source_item', id)).note!.id).toBe(a.note!.id);
  });
  it('keeps the association across rename and preserves the personal note if the document is removed', async ctx => {
    if (!db.available) return ctx.skip();
    const { ReaderDocumentNotes } = await import('../src/modules/reader/documentNotes.js');
    const { PgKnowledgeRepository } = await import('../src/modules/knowledge/repository.js');
    const service = new ReaderDocumentNotes(db.pool), id = await item();
    const created = await service.create(identity, 'source_item', id);
    const notes = new PgKnowledgeRepository(db.pool), noteIdentity = { spaceId: personal, userId: owner };
    await notes.updateNote(noteIdentity, created.note!.id, { title: 'Completely renamed' });
    expect((await service.get(identity, 'source_item', id)).note!.id).toBe(created.note!.id);
    await db.pool.query('DELETE FROM source_snapshots WHERE source_item_id=$1', [id]);
    await db.pool.query('DELETE FROM source_items WHERE id=$1', [id]);
    await expect(service.get(identity, 'source_item', id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await notes.getNote(noteIdentity, created.note!.id)).toMatchObject({ title: 'Completely renamed' });
  });
});
