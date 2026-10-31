import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject } from './support/domainSeeds.js';
import { resetTables } from './support/resetTables.js';
import { loadConfig } from '../src/config.js';
import { ReaderSourceVersions } from '../src/modules/reader/sourceVersions.js';
import { ReaderPositionStore } from '../src/modules/reader/positions.js';
import { PgReaderRepository } from '../src/modules/reader/repository.js';
import { agentReadingDocument, agentReadingMetadata, saveSourceReadingDocument } from '../src/modules/sources/materialProcessing/documents.js';
import { buildModuleServer } from './support/moduleServer.js';
import { readerModule } from '../src/modules/reader/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';

const db = useTestDatabase(import.meta.filename);
const space = randomUUID(), owner = randomUUID(), project = randomUUID(), other = randomUUID();
const who = { spaceId: space, userId: owner }, peer = { spaceId: space, userId: other };
const config = () => loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
const history = () => new ReaderSourceVersions(db.pool, config());
afterEach(() => { __setAuthIdentityForTests(null); });
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ['spaces', 'users'], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space, owner, project, spaceType: 'team' });
  await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Other','active',$2,'system',now(),now())`, [other, `${other}@test.invalid`]);
  await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, other]);
});
async function item() {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO source_items(id,space_id,owner_user_id,created_by_user_id,visibility,item_type,title,canonical_uri,source_uri,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at)
    VALUES($1,$2,$3,$3,'space_shared','external_url','Article',$4,$4,'metadata_only','metadata_only',now(),now(),now(),now())`, [id, space, owner, `https://example.test/${id}`]);
  return id;
}
async function save(id: string, text: string) {
  const content = { kind: 'article' as const, format: 'agent_summary' as const, syntax: 'markdown' as const, text, sources: ['https://example.test/article'] };
  return saveSourceReadingDocument(db.pool, { spaceId: space, itemId: id, document: agentReadingDocument(content, 'https://example.test/article'), agentProvided: true, metadata: agentReadingMetadata(content) });
}

describe('retained Source reading versions', () => {
  it('serves old Markdown and its own provenance through the routes without changing the current version or reading state', async () => {
    const id = await item(), old = await save(id, '# Earlier analysis\n\nEarlier evidence.'), current = await save(id, '# Revised analysis\n\nNew evidence.');
    await db.pool.query(`UPDATE source_snapshots SET captured_at='2026-01-01T00:00:00Z' WHERE id=$1`, [old.snapshotId]);
    __setAuthIdentityForTests({ userId: owner, spaceId: space });
    const app = buildModuleServer(config(), [readerModule]);
    try {
      const list = await app.inject({ method: 'GET', url: `/api/v1/reader/source-items/${id}/versions` });
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toEqual([{ snapshot_id: current.snapshotId, captured_at: expect.any(String), is_current: true }, { snapshot_id: old.snapshotId, captured_at: '2026-01-01T00:00:00.000Z', is_current: false }]);
      const opened = await app.inject({ method: 'GET', url: `/api/v1/reader/source-items/${id}/versions/${old.snapshotId}` });
      expect(opened.statusCode).toBe(200);
      expect(opened.json()).toMatchObject({ plain_text: expect.stringContaining('Earlier evidence.'), document_type: 'source_snapshot', document_id: old.snapshotId, can_annotate: false, reading_info: { format: 'agent_summary', syntax: 'markdown' }, image_policy: 'none', result_provenance: 'agent_provided_unverified' });
      expect(opened.json().content_json.content[0].type).toBe('heading');
      expect((await db.pool.query(`SELECT extracted_artifact_id FROM source_items WHERE id=$1`, [id])).rows[0].extracted_artifact_id).toBe(current.artifactId);
      expect((await db.pool.query(`SELECT * FROM source_item_user_states WHERE source_item_id=$1`, [id])).rows).toHaveLength(0);
      const invalid = await app.inject({ method: 'GET', url: `/api/v1/reader/source-items/${id}/versions?offset=-1` });
      expect(invalid.statusCode).toBe(422);
    } finally { await app.close(); __setAuthIdentityForTests(null); }
  });

  it('checks parent, snapshot, artifact and Space independently, and cannot substitute another item version', async () => {
    const id = await item(), old = await save(id, 'Old body'), current = await save(id, 'Current body');
    const unrelated = await save(await item(), 'Another article');
    await expect(history().get(peer, id, unrelated.snapshotId)).rejects.toMatchObject({ statusCode: 404 });
    await db.pool.query(`UPDATE source_snapshots SET visibility='private' WHERE id=$1`, [old.snapshotId]);
    expect((await history().list(peer, id, 0)).items.map(v => v.snapshot_id)).toEqual([current.snapshotId]);
    await expect(history().get(peer, id, old.snapshotId)).rejects.toMatchObject({ statusCode: 404 });
    await db.pool.query(`UPDATE source_snapshots SET visibility='space_shared' WHERE id=$1`, [old.snapshotId]);
    await db.pool.query(`UPDATE artifacts SET visibility='private' WHERE id=$1`, [old.artifactId]);
    expect((await history().list(peer, id, 0)).items.map(v => v.snapshot_id)).toEqual([current.snapshotId]);
    await expect(history().get(peer, id, old.snapshotId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(history().list({ ...who, spaceId: randomUUID() }, id, 0)).rejects.toMatchObject({ statusCode: 404 });
    await db.pool.query(`UPDATE source_items SET visibility='private' WHERE id=$1`, [id]);
    await expect(history().list(peer, id, 0)).rejects.toMatchObject({ statusCode: 404 });
    await expect(history().get(peer, id, current.snapshotId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('keeps a historical reading position separate from the latest article position', async () => {
    const id = await item(), old = await save(id, 'Earlier body');
    await save(id, 'Latest body');
    const current = (await new PgReaderRepository(db.pool, config()).getDocument(who, 'source_item', id, { recordOpen: false }))!;
    const historical = await history().get(who, id, old.snapshotId);
    const positions = new ReaderPositionStore(db.pool, config());
    const report = (doc: typeof current, progress: number) => ({ content_hash: doc.content_hash, structure_hash: doc.structure_hash,
      current: { anchor: { block_index: 0, pm_pos: 1, text_offset: 0, quote: doc.plain_text, before_context: '' }, progress },
      dwelled: true, client_at: new Date().toISOString() });
    await positions.write(who, 'source_item', id, report(current, 0.8));
    await positions.write(who, 'source_snapshot', old.snapshotId, report({ ...historical, can_annotate: true }, 0.2));
    expect((await positions.get(who, 'source_item', id))!.current.progress).toBe(0.8);
    expect((await positions.get(who, 'source_snapshot', old.snapshotId))!.current.progress).toBe(0.2);
  });

  it('does not expose history after Source consent is withdrawn', async () => {
    const id = await item(), old = await save(id, 'Earlier');
    // Reuse a valid Source connection from the canonical fixtures.
    const { seedArxivSourceChain } = await import('./support/researchSeeds.js');
    await seedArxivSourceChain(db.pool, { space, owner, connection: 'history-connection', connector: randomUUID(), channel: randomUUID(), now: new Date().toISOString() });
    await db.pool.query(`UPDATE source_items SET connection_id='history-connection' WHERE id=$1`, [id]);
    await history().get(who, id, old.snapshotId);
    await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id='history-connection'`);
    await expect(history().list(who, id, 0)).rejects.toMatchObject({ statusCode: 404 });
    await expect(history().get(who, id, old.snapshotId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('pages retained captures in stable descending order, including equal timestamps', async () => {
    const id = await item();
    for (let i = 0; i < 27; i++) await save(id, `Analysis ${i}`);
    await db.pool.query(`UPDATE source_snapshots SET captured_at='2026-01-01T00:00:00Z' WHERE source_item_id=$1`, [id]);
    const first = await history().list(who, id, 0), last = await history().list(who, id, first.next_offset!);
    expect(first.items).toHaveLength(25); expect(last.items).toHaveLength(2); expect(last.next_offset).toBeNull();
    expect(new Set([...first.items, ...last.items].map(v => v.snapshot_id)).size).toBe(27);
    expect((await new PgReaderRepository(db.pool, config()).getDocument(who, 'source_item', id))!.plain_text).toBe('Analysis 26');
  });
});
