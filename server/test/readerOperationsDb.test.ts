import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { READER_WRITE_JOB, ReaderWriteRequestViewSchema } from '@rainver/protocol';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject, seedSpaceMember } from './support/domainSeeds.js';
import { buildModuleServer } from './support/moduleServer.js';
import { claimJobForHandler } from './support/jobClaim.js';
import { readerModule } from '../src/modules/reader/index.js';
import { jobsModule } from '../src/modules/jobs/index.js';
import { loadConfig } from '../src/config.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { JobHandlerRegistry } from '../src/modules/jobs/handlerRegistry.js';
import { PgJobQueueRepository } from '../src/modules/jobs/repository.js';
import { registerReaderWriteJob, settleReaderWrite } from '../src/modules/reader/writeJob.js';
import { ReaderFilePreparation, PgReaderRepository } from '../src/modules/reader/repository.js';
import { agentReadingDocument, agentReadingMetadata, saveSourceReadingDocument } from '../src/modules/sources/materialProcessing/documents.js';

const db = useTestDatabase(import.meta.filename);
const space = randomUUID(), owner = randomUUID(), project = randomUUID(), other = randomUUID();
const identity = { spaceId: space, userId: owner };
const storage = mkdtempSync(join(tmpdir(), 'reader-ops-'));
const config = () => loadConfig({ SERVER_DATABASE_URL: db.connectionUri, ARTIFACT_STORAGE_ROOT: storage });
let app: FastifyInstance;
const send = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, key: string | null = randomUUID()) =>
  app.inject({ method, url: `/api/v1/reader${url}`, ...(payload ? { payload } : {}), headers: key ? { 'idempotency-key': key } : {} });
const count = async (table: string) => Number((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ['spaces', 'users'], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space, owner, project, spaceType: 'team' });
  await seedSpaceMember(db.pool, { space, user: other });
  app = buildModuleServer(config(), [readerModule, jobsModule]);
  __setAuthIdentityForTests(identity);
});
afterEach(async () => { __setAuthIdentityForTests(null); await app?.close(); });

async function sourceItem(visibility = 'space_shared') {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO source_items(id,space_id,project_id,owner_user_id,created_by_user_id,visibility,item_type,title,excerpt,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at)
    VALUES($1,$2,NULL,$3,$3,$4,'external_url','Article','alpha beta gamma','metadata_only','metadata_only',now(),now(),now(),now())`, [id, space, owner, visibility]);
  return id;
}
const annotationBody = (documentId: string) => ({ document_type: 'source_item', document_id: documentId, annotation_type: 'excerpt', quote_text: 'beta',
  anchor_json: { schema_version: 1, quote_text: 'beta', text_range: { start: 6, end: 10, unit: 'utf16' }, before_context: 'alpha ', after_context: ' gamma' } });
async function annotate(visibility?: string) {
  const documentId = await sourceItem();
  const created = await send('POST', '/annotations', { ...annotationBody(documentId), ...(visibility ? { visibility } : {}) });
  expect(created.statusCode, created.body).toBe(201);
  return { documentId, annotationId: created.json().data.annotation_id as string };
}
/** A source item whose reading body lives only in an artifact file, read outside transactions. */
async function fileBackedItem() {
  const id = await sourceItem();
  const value = { kind: 'article' as const, format: 'source_text' as const, syntax: 'plain' as const, text: 'First paragraph.\n\nSecond paragraph.', sources: ['https://example.test/a'] };
  await saveSourceReadingDocument(db.pool, { spaceId: space, itemId: id, document: agentReadingDocument(value, 'https://example.test/a'), agentProvided: true, metadata: agentReadingMetadata(value) });
  const artifact = (await db.pool.query<{ id: string; content: string }>('SELECT a.id,a.content FROM source_items i JOIN artifacts a ON a.id=i.extracted_artifact_id WHERE i.id=$1', [id])).rows[0]!;
  const path = `${artifact.id}.json`;
  writeFileSync(join(storage, path), artifact.content);
  await db.pool.query('UPDATE artifacts SET content=NULL,storage_path=$2 WHERE id=$1', [artifact.id, path]);
  const doc = (await new PgReaderRepository(db.pool, config()).getDocument(identity, 'source_item', id, { recordOpen: false }))!;
  expect(doc.plain_text).toContain('Second paragraph.');
  return { id, doc, artifact: artifact.id };
}
async function settle(jobId: string) {
  const registry = new JobHandlerRegistry(); registerReaderWriteJob(registry, config());
  const result = await registry.dispatch(await claimJobForHandler(db.pool, jobId));
  await new PgJobQueueRepository(db.pool).completeJob(jobId, result, 'test');
  return result;
}

describe('Reader write adapters', () => {
  it('require a session and an explicit idempotency key on every retained write URL', async () => {
    const documentId = await sourceItem();
    __setAuthIdentityForTests(null);
    for (const [method, url] of [['POST', '/annotations'], ['PATCH', `/annotations/${randomUUID()}`], ['DELETE', `/annotations/${randomUUID()}`], ['PATCH', `/annotations/${randomUUID()}/range`], ['POST', `/annotations/${randomUUID()}/comments`], ['PATCH', `/comments/${randomUUID()}`], ['PATCH', `/comment-threads/${randomUUID()}`], ['POST', `/annotations/${randomUUID()}/evidence`], ['POST', `/annotations/${randomUUID()}/proposals`], ['PUT', `/documents/source_item/${documentId}/position`], ['PUT', '/preferences/appearance'], ['POST', `/documents/source_item/${documentId}/note`]] as const)
      expect((await send(method, url, {})).statusCode, `${method} ${url}`).toBe(401);
    __setAuthIdentityForTests(identity);
    expect((await send('POST', '/annotations', annotationBody(documentId), null)).json().error.code).toBe('idempotency_key_required');
    expect(await count('reader_annotations')).toBe(0);
  });

  it('returns identity-only receipts, replays them only under current access, and refuses a reused key', async () => {
    const documentId = await sourceItem(), key = randomUUID();
    const first = await send('POST', '/annotations', annotationBody(documentId), key);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.body).not.toContain('beta');
    expect(first.json().data).toMatchObject({ kind: 'annotation', space_id: space, document_type: 'source_item', document_id: documentId });
    const replay = await send('POST', '/annotations', annotationBody(documentId), key);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(await count('reader_annotations')).toBe(1);
    expect((await send('POST', '/annotations', { ...annotationBody(documentId), label: 'changed' }, key)).json().error.code).toBe('idempotency_key_reused');
    await db.pool.query('UPDATE source_items SET deleted_at=now() WHERE id=$1', [documentId]);
    const hidden = await send('POST', '/annotations', annotationBody(documentId), key);
    expect(hidden.statusCode, hidden.body).toBe(404);
  });

  it('caches a deterministic domain refusal without a durable write', async () => {
    const documentId = await sourceItem();
    const body = annotationBody(documentId); body.anchor_json.text_range = { start: 4, end: 4, unit: 'utf16' };
    const refused = await send('POST', '/annotations', body);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().error).toMatchObject({ code: 'operation_invalid_input', domain: 'reader' });
    expect(await count('reader_annotations')).toBe(0);
    expect((await send('POST', '/annotations', { ...annotationBody(documentId), project_id: project })).statusCode).toBe(422);
  });

  it('runs the annotation, comment, thread, Evidence and appearance writers through their canonical owners', async () => {
    const { documentId, annotationId } = await annotate();
    const updated = await send('PATCH', `/annotations/${annotationId}`, { label: 'Keep' });
    expect(updated.json().data).toMatchObject({ kind: 'annotation', id: annotationId });
    expect((await send('PATCH', `/annotations/${annotationId}`, { annotation_id: randomUUID(), label: 'x' })).statusCode).toBe(422);
    const thread = await send('POST', `/annotations/${annotationId}/comments`, { body: 'First comment' });
    expect(thread.statusCode, thread.body).toBe(201);
    expect(thread.json().data).toMatchObject({ kind: 'thread', annotation_id: annotationId });
    const comment = (await db.pool.query('SELECT id FROM reader_comments')).rows[0]!.id as string;
    expect((await send('PATCH', `/comments/${comment}`, { body: 'Edited' })).json().data).toMatchObject({ kind: 'comment', id: comment, annotation_id: annotationId });
    expect((await send('PATCH', `/comment-threads/${thread.json().data.id}`, { status: 'resolved' })).json().data).toMatchObject({ kind: 'thread' });
    const evidence = await send('POST', `/annotations/${annotationId}/evidence`, { title: 'Evidence title' });
    expect(evidence.statusCode, evidence.body).toBe(201);
    expect((await db.pool.query('SELECT status,source_object_id FROM extracted_evidence WHERE id=$1', [evidence.json().data.id])).rows[0]).toEqual({ status: 'candidate', source_object_id: annotationId });
    const appearance = await send('PUT', '/preferences/appearance', { font: 'serif' });
    expect(appearance.json().data).toMatchObject({ kind: 'appearance', id: owner, document_id: null });
    expect((await app.inject({ method: 'GET', url: '/api/v1/reader/preferences/appearance' })).json()).toMatchObject({ font: 'serif' });
    expect((await send('DELETE', `/annotations/${annotationId}`)).json().data).toMatchObject({ kind: 'annotation', id: annotationId, document_id: documentId });
    expect((await db.pool.query('SELECT status,label FROM reader_annotations WHERE id=$1', [annotationId])).rows[0]).toEqual({ status: 'archived', label: 'Keep' });
    // The Reader's Undo: the author restores their own removed annotation.
    expect((await send('PATCH', `/annotations/${annotationId}`, { status: 'active' })).statusCode).toBe(200);
    expect((await db.pool.query('SELECT status FROM reader_annotations WHERE id=$1', [annotationId])).rows[0]).toEqual({ status: 'active' });
    expect(await count('memory_entries')).toBe(0);
  });

  it("refuses another member's private annotation as not found", async () => {
    const { annotationId } = await annotate();
    __setAuthIdentityForTests({ spaceId: space, userId: other });
    for (const [method, url, body] of [['POST', `/annotations/${annotationId}/comments`, { body: 'x' }], ['POST', `/annotations/${annotationId}/evidence`, {}], ['POST', `/annotations/${annotationId}/proposals`, { proposal_type: 'memory_create' }], ['PATCH', `/annotations/${annotationId}`, { label: 'x' }]] as const)
      expect((await send(method, url, body)).statusCode, url).toBe(404);
    expect(await count('reader_comments') + await count('extracted_evidence') + await count('proposals')).toBe(0);
  });
});

describe('Reader annotation proposals', () => {
  it.each(['memory_create', 'knowledge_create'] as const)('routes %s to its own proposal operation and writes only a pending proposal', async proposalType => {
    const { annotationId, documentId } = await annotate();
    const created = await send('POST', `/annotations/${annotationId}/proposals`, { proposal_type: proposalType });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data).toMatchObject({ kind: 'proposal', annotation_id: annotationId });
    const row = (await db.pool.query('SELECT proposal_type,status,payload_json FROM proposals WHERE id=$1', [created.json().data.id])).rows[0]!;
    expect(row).toMatchObject({ proposal_type: proposalType, status: 'pending' });
    expect(JSON.stringify(row.payload_json)).toContain(documentId);
    const audit = (await db.pool.query("SELECT action FROM policy_decision_records WHERE metadata_json->>'operation_request_id' IS NOT NULL ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(audit?.action).toBe('proposal.create');
    expect(await count('memory_entries')).toBe(0);
    expect(await count('knowledge_items')).toBe(0);
  });
  it('refuses an unsupported kind or a restated annotation without a durable write', async () => {
    const { annotationId } = await annotate();
    for (const body of [{ proposal_type: 'other' }, { proposal_type: 'memory_create', annotation_id: annotationId }, { proposal_type: 'knowledge_create', extra: true }])
      expect((await send('POST', `/annotations/${annotationId}/proposals`, body)).statusCode, JSON.stringify(body)).toBe(422);
    expect(await count('proposals')).toBe(0);
  });
});

describe('Reader body-reading writers', () => {
  const mark = { anchor: { block_index: 1, pm_pos: 20, text_offset: 0, quote: 'Second', before_context: '' }, progress: 0.5 };
  it('queue a one-attempt Job, read the file body outside the transaction and release only status', async () => {
    const { id, doc } = await fileBackedItem();
    const queued = await send('PUT', `/documents/source_item/${id}/position`, { content_hash: doc.content_hash, structure_hash: doc.structure_hash, current: mark, dwelled: true, client_at: new Date().toISOString() });
    expect(queued.statusCode, queued.body).toBe(202);
    const jobId = queued.json().data.job_id as string;
    expect(queued.json().data).toMatchObject({ kind: 'job', id: jobId, document_id: id });
    expect((await db.pool.query('SELECT max_attempts FROM jobs WHERE id=$1 AND job_type=$2', [jobId, READER_WRITE_JOB])).rows[0]).toEqual({ max_attempts: 1 });
    expect(await count('reader_positions')).toBe(0);
    expect(await settle(jobId)).toEqual({ outcome: 'applied', annotation_id: null });
    expect((await db.pool.query('SELECT current_progress FROM reader_positions')).rows).toEqual([{ current_progress: 0.5 }]);
    const view = await app.inject({ method: 'GET', url: `/api/v1/reader/write-requests/${jobId}` });
    expect(view.json()).toEqual({ job_id: jobId, status: 'completed', result: { outcome: 'applied', annotation_id: null } });
    expect((await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}` })).json().result).toBeNull();
    __setAuthIdentityForTests({ spaceId: space, userId: other });
    expect((await app.inject({ method: 'GET', url: `/api/v1/reader/write-requests/${jobId}` })).statusCode).toBe(404);
    __setAuthIdentityForTests(identity);
    const stale = await send('PUT', `/documents/source_item/${id}/position`, { content_hash: 'old', structure_hash: 'old', current: mark, client_at: new Date().toISOString() });
    expect(await settle(stale.json().data.job_id)).toEqual({ outcome: 'not_accepted', annotation_id: null });
  });

  it('replaces an annotation range only on the version shown, under the current claim', async () => {
    const { id, doc } = await fileBackedItem();
    const at = doc.plain_text.indexOf('First paragraph.');
    const created = await send('POST', '/annotations', { document_type: 'source_item', document_id: id, annotation_type: 'highlight', quote_text: 'First paragraph.', anchor_json: { schema_version: 1, quote_text: 'First paragraph.', text_range: { start: at, end: at + 16, unit: 'utf16' }, before_context: '', after_context: '' } });
    const annotationId = created.json().data.annotation_id as string;
    const anchor = (quote: string, start: number) => ({ schema_version: 1, normalizer: 'plain_text_v1', quote_text: quote, text_range: { start, end: start + quote.length, unit: 'utf16' }, before_context: '', after_context: '', content_hash: doc.content_hash, structure_hash: doc.structure_hash, document_ref: { document_type: 'source_item', document_id: id } });
    const second = doc.plain_text.indexOf('Second paragraph.');
    const body = { expected_quote_text: 'First paragraph.', expected_anchor_json: (await db.pool.query('SELECT anchor_json FROM reader_annotations WHERE id=$1', [annotationId])).rows[0]!.anchor_json, content_hash: doc.content_hash, structure_hash: doc.structure_hash, quote_text: 'Second paragraph.', anchor_json: anchor('Second paragraph.', second) };
    __setAuthIdentityForTests({ spaceId: space, userId: other });
    expect((await send('PATCH', `/annotations/${annotationId}/range`, body)).statusCode).toBe(404);
    __setAuthIdentityForTests(identity);
    const lost = await send('PATCH', `/annotations/${annotationId}/range`, body);
    const lostClaim = await claimJobForHandler(db.pool, lost.json().data.job_id);
    await db.pool.query("UPDATE jobs SET status='cancelled' WHERE id=$1", [lostClaim.job_id]);
    const registry = new JobHandlerRegistry(); registerReaderWriteJob(registry, config());
    await expect(registry.dispatch(lostClaim)).rejects.toThrow('no longer owns');
    expect((await db.pool.query('SELECT quote_text FROM reader_annotations WHERE id=$1', [annotationId])).rows[0]!.quote_text).toBe('First paragraph.');
    const queued = await send('PATCH', `/annotations/${annotationId}/range`, body);
    expect(queued.statusCode, queued.body).toBe(202);
    expect(await settle(queued.json().data.job_id)).toEqual({ outcome: 'applied', annotation_id: annotationId });
    expect((await db.pool.query('SELECT quote_text FROM reader_annotations WHERE id=$1', [annotationId])).rows[0]!.quote_text).toBe('Second paragraph.');
    const again = await send('PATCH', `/annotations/${annotationId}/range`, body);
    expect(await settle(again.json().data.job_id)).toEqual({ outcome: 'conflict', annotation_id: null });
  });

  /** The canonical document writer commits a new file-backed body after the
   * worker sealed its preparation and before its settlement transaction opens. */
  function afterPreparation(id: string) {
    let produced = false;
    const produce = async () => {
      const value = { kind: 'article' as const, format: 'source_text' as const, syntax: 'plain' as const, text: 'Rewritten opening.\n\nRewritten close.', sources: ['https://example.test/a'] };
      await saveSourceReadingDocument(db.pool, { spaceId: space, itemId: id, document: agentReadingDocument(value, 'https://example.test/a'), agentProvided: true, metadata: agentReadingMetadata(value) });
      const artifact = (await db.pool.query<{ id: string; content: string }>('SELECT a.id,a.content FROM source_items i JOIN artifacts a ON a.id=i.extracted_artifact_id WHERE i.id=$1', [id])).rows[0]!;
      writeFileSync(join(storage, `${artifact.id}.json`), artifact.content);
      await db.pool.query('UPDATE artifacts SET content=NULL,storage_path=$2 WHERE id=$1', [artifact.id, `${artifact.id}.json`]);
    };
    // Plain reads go to the pool; only the settlement transaction checks out a client.
    return new Proxy(db.pool, { get(target, property) {
      if (property === 'connect') return async () => { if (!produced) { produced = true; await produce(); } return target.connect(); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }

  it('refuses a position whose body changed after preparation as not_accepted, with zero position writes, after access and claim', async () => {
    const { id, doc } = await fileBackedItem();
    const queued = await send('PUT', `/documents/source_item/${id}/position`, { content_hash: doc.content_hash, structure_hash: doc.structure_hash, current: mark, dwelled: true, client_at: new Date().toISOString() });
    const jobId = queued.json().data.job_id as string;
    const envelope = await claimJobForHandler(db.pool, jobId);
    const result = await settleReaderWrite(config(), afterPreparation(id), envelope);
    expect(result).toEqual({ outcome: 'not_accepted', annotation_id: null });
    expect(await count('reader_positions')).toBe(0);
    await new PgJobQueueRepository(db.pool).completeJob(jobId, result, 'test');
    const view = ReaderWriteRequestViewSchema.parse((await app.inject({ method: 'GET', url: `/api/v1/reader/write-requests/${jobId}` })).json());
    expect(view).toEqual({ job_id: jobId, status: 'completed', result: { outcome: 'not_accepted', annotation_id: null } });
    // A lost claim still refuses before any domain outcome.
    const again = await send('PUT', `/documents/source_item/${id}/position`, { content_hash: doc.content_hash, structure_hash: doc.structure_hash, current: mark, client_at: new Date().toISOString() });
    const lost = await claimJobForHandler(db.pool, again.json().data.job_id);
    await db.pool.query("UPDATE jobs SET status='cancelled' WHERE id=$1", [lost.job_id]);
    await expect(settleReaderWrite(config(), afterPreparation(id), lost)).rejects.toThrow('no longer owns');
    expect(await count('reader_positions')).toBe(0);
  });

  it('keeps a range replacement whose body changed after preparation a conflict', async () => {
    const { id, doc } = await fileBackedItem();
    const at = doc.plain_text.indexOf('First paragraph.');
    const created = await send('POST', '/annotations', { document_type: 'source_item', document_id: id, annotation_type: 'highlight', quote_text: 'First paragraph.', anchor_json: { schema_version: 1, quote_text: 'First paragraph.', text_range: { start: at, end: at + 16, unit: 'utf16' }, before_context: '', after_context: '' } });
    const annotationId = created.json().data.annotation_id as string;
    const second = doc.plain_text.indexOf('Second paragraph.');
    const body = { expected_quote_text: 'First paragraph.', expected_anchor_json: (await db.pool.query('SELECT anchor_json FROM reader_annotations WHERE id=$1', [annotationId])).rows[0]!.anchor_json, content_hash: doc.content_hash, structure_hash: doc.structure_hash, quote_text: 'Second paragraph.',
      anchor_json: { schema_version: 1, normalizer: 'plain_text_v1', quote_text: 'Second paragraph.', text_range: { start: second, end: second + 17, unit: 'utf16' }, before_context: '', after_context: '', content_hash: doc.content_hash, structure_hash: doc.structure_hash, document_ref: { document_type: 'source_item', document_id: id } } };
    const queued = await send('PATCH', `/annotations/${annotationId}/range`, body);
    const result = await settleReaderWrite(config(), afterPreparation(id), await claimJobForHandler(db.pool, queued.json().data.job_id));
    expect(result).toEqual({ outcome: 'conflict', annotation_id: null });
    expect((await db.pool.query('SELECT quote_text FROM reader_annotations WHERE id=$1', [annotationId])).rows[0]!.quote_text).toBe('First paragraph.');
  });

  it('never reads a new file once a preparation is sealed', async () => {
    const files = new ReaderFilePreparation();
    files.seal();
    await expect(files.read(config(), 'other.json')).rejects.toMatchObject({ statusCode: 409 });
  });
});
