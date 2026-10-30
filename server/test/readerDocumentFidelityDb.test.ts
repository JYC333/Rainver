import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject } from './support/domainSeeds.js';
import { resetTables } from './support/resetTables.js';
import { loadConfig } from '../src/config.js';
import { PgAnnotationRepository, PgReaderRepository } from '../src/modules/reader/repository.js';
import { agentReadingDocument, agentReadingMetadata, saveSourceReadingDocument } from '../src/modules/sources/materialProcessing/documents.js';

const db = useTestDatabase(import.meta.filename);
const space = randomUUID(), owner = randomUUID(), project = randomUUID();
const identity = { spaceId: space, userId: owner };
const url = 'https://example.test/article';
const reader = () => new PgReaderRepository(db.pool, loadConfig({ SERVER_DATABASE_URL: db.connectionUri }));
const markdown = '# 标题 Title\n\n**粗体** and `code` 🙂\n\n```\n    indented\n```\n\n- a\n  - b';

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ['spaces', 'users'], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space, owner, project, spaceType: 'team' });
});

async function item(): Promise<string> {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO source_items(id,space_id,project_id,owner_user_id,created_by_user_id,visibility,item_type,title,canonical_uri,source_uri,content_hash,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at)
    VALUES($1,$2,NULL,$3,$3,'space_shared','external_url','Article',$4,$4,'hash','metadata_only','metadata_only',now(),now(),now(),now())`, [id, space, owner, `${url}/${id}`]);
  return id;
}

const content = (syntax?: 'plain' | 'markdown', text = markdown) => ({ kind: 'article' as const, format: 'source_text' as const, ...(syntax ? { syntax } : {}), text, sources: [url] });
const save = (itemId: string, value: ReturnType<typeof content>, expectedHash?: string | null) => saveSourceReadingDocument(db.pool, {
  spaceId: space, itemId, document: agentReadingDocument(value, url), agentProvided: true, metadata: agentReadingMetadata(value), ...(expectedHash !== undefined ? { expectedHash } : {}),
});

describe('declared reading syntax through the canonical writer', () => {
  it('stores Agent Markdown as structure, keeps code verbatim and never loads its images inline', async () => {
    const id = await item();
    await save(id, content('markdown'));
    const doc = (await reader().getDocument(identity, 'source_item', id))!;
    expect(doc.content_json.content.map(node => node.type)).toEqual(['heading', 'paragraph', 'codeBlock', 'bulletList']);
    expect(doc.content_json.content[2]).toEqual({ type: 'codeBlock', content: [{ type: 'text', text: '    indented' }] });
    expect(doc.plain_text).not.toContain('**');
    expect(doc.plain_text).toContain('🙂');
    expect(doc.image_policy).toBe('none');
    expect(doc.structure_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.reading_info).toMatchObject({ format: 'source_text', syntax: 'markdown', method: 'agent' });
  });

  it('shows undeclared text literally and does not claim a syntax for it', async () => {
    const id = await item();
    await save(id, content(undefined));
    const doc = (await reader().getDocument(identity, 'source_item', id))!;
    expect(doc.content_json.content.every(node => node.type === 'paragraph')).toBe(true);
    expect(doc.plain_text).toContain('# 标题 Title');
    expect(doc.reading_info && 'syntax' in doc.reading_info).toBe(false);
  });
});

describe('document versions and existing annotations', () => {
  it('gives a re-parsed body a new structure version, keeps the old version and leaves annotations intact', async () => {
    const id = await item();
    await save(id, content(undefined, 'alpha beta gamma\n\ndelta'));
    const first = (await reader().getDocument(identity, 'source_item', id))!;
    const annotation = await new PgAnnotationRepository(db.pool).createAnnotation(identity, {
      document_type: 'source_item', document_id: id, annotation_type: 'highlight', quote_text: 'beta',
      anchor_json: { schema_version: 1, normalizer: 'plain_text_v1', quote_text: 'beta', text_range: { start: 6, end: 10, unit: 'utf16' },
        before_context: 'alpha ', after_context: ' gamma', tiptap_range: { from: 7, to: 11 }, content_hash: first.content_hash, structure_hash: first.structure_hash },
    });
    expect(annotation.anchor_state).toBe('verified');

    await save(id, content('markdown', '# Heading\n\nalpha beta gamma\n\ndelta'));
    const second = (await reader().getDocument(identity, 'source_item', id))!;
    expect(second.structure_hash).not.toBe(first.structure_hash);
    expect(second.artifact_id).not.toBe(first.artifact_id);
    // The earlier version stays stored and attributable; nothing was overwritten in place.
    const versions = await db.pool.query(`SELECT artifact_id FROM source_snapshots WHERE space_id=$1 AND source_item_id=$2 ORDER BY captured_at`, [space, id]);
    expect(versions.rows.map(row => row.artifact_id)).toEqual(expect.arrayContaining([first.artifact_id, second.artifact_id]));
    // The annotation and its stored anchor are untouched; placing it is the Reader's job.
    const listed = await new PgAnnotationRepository(db.pool).listAnnotations(identity, 'source_item', id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: annotation.id, quote_text: 'beta' });
    expect(listed[0]!.anchor_json).toMatchObject({ structure_hash: first.structure_hash, tiptap_range: { from: 7, to: 11 } });
  });

  it('refuses a write made against a stale body and keeps the readable one', async () => {
    const id = await item();
    await save(id, content(undefined, 'current readable body'));
    const before = (await reader().getDocument(identity, 'source_item', id))!;
    await expect(save(id, content('markdown', '# replacement'), 'not-the-current-hash')).rejects.toMatchObject({ statusCode: 409 });
    const after = (await reader().getDocument(identity, 'source_item', id))!;
    expect(after.plain_text).toBe('current readable body');
    expect(after.structure_hash).toBe(before.structure_hash);
  });
});

describe('document access', () => {
  it('gives someone outside the Space neither the text nor its version or image policy', async () => {
    const id = await item();
    await save(id, content('markdown'));
    const stranger = { spaceId: space, userId: randomUUID() };
    const outcome = await reader().getDocument(stranger, 'source_item', id).then(doc => doc, error => error);
    expect(outcome === null || (outcome instanceof Error && 'statusCode' in outcome && [403, 404].includes((outcome as { statusCode: number }).statusCode))).toBe(true);
  });
});

describe('showing literal Agent text as Markdown, on request, for the version shown', () => {
  const config = () => loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
  const screenshot = '# Penchan\n\n## 1. 核心定位\n\n- **非线性排名**：按信号而不是时间排序\n- **可解释**：每条结果给出原因';
  const show = async (who: { spaceId: string; userId: string }, id: string, shown: { artifact_id: string; source_snapshot_id: string | null }) => {
    const { showAgentTextAsMarkdown } = await import('../src/modules/sources/materialProcessing/syntax.js');
    return showAgentTextAsMarkdown(db.pool, config(), who, id, shown);
  };
  const shownOf = (doc: { artifact_id: string | null; source_snapshot_id: string | null }) => ({ artifact_id: doc.artifact_id!, source_snapshot_id: doc.source_snapshot_id });

  it('turns an undeclared literal Agent text into its Markdown structure as a new version, keeping the old one and the annotations', async () => {
    const id = await item();
    await save(id, content(undefined, screenshot));
    const before = (await reader().getDocument(identity, 'source_item', id))!;
    expect(before.content_json.content?.[0]).toMatchObject({ type: 'paragraph', content: [{ text: '# Penchan' }] });
    expect(before.agent_text_syntax).toBe('undeclared');
    const annotation = await new PgAnnotationRepository(db.pool).createAnnotation(identity, {
      document_type: 'source_item', document_id: id, annotation_type: 'highlight', quote_text: '核心定位',
      anchor_json: { schema_version: 1, normalizer: 'plain_text_v1', quote_text: '核心定位', text_range: { start: 15, end: 19, unit: 'utf16' }, before_context: '', after_context: '' },
    });

    await show(identity, id, shownOf(before));

    const after = (await reader().getDocument(identity, 'source_item', id))!;
    expect(after.content_json.content?.map(node => node.type)).toEqual(['heading', 'heading', 'bulletList']);
    expect(after.content_json.content?.[0]).toMatchObject({ attrs: { level: 1 }, content: [{ text: 'Penchan' }] });
    expect(JSON.stringify(after.content_json)).toContain('"type":"bold"');
    expect(after.agent_text_syntax).toBe('markdown');
    expect(after.reading_info).toMatchObject({ syntax: 'markdown', method: 'agent', format: 'source_text' });
    expect(after.result_provenance).toBe('agent_provided_unverified');
    expect((await db.pool.query('SELECT 1 FROM artifacts WHERE id=$1', [before.artifact_id])).rowCount).toBe(1);
    expect((await new PgAnnotationRepository(db.pool).listAnnotations(identity, 'source_item', id)).map(a => a.id)).toEqual([annotation.id]);
    // A Markdown version is not converted again.
    await expect(show(identity, id, shownOf(after))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('converts a version the Agent declared plain only on explicit request, and never changes it by itself', async () => {
    const id = await item();
    await save(id, content('plain', screenshot));
    const before = (await reader().getDocument(identity, 'source_item', id))!;
    expect(before.agent_text_syntax).toBe('plain');
    expect(before.content_json.content?.[0]).toMatchObject({ type: 'paragraph', content: [{ text: '# Penchan' }] });
    // Reading it again changes nothing: plain stays literal until someone asks.
    expect((await reader().getDocument(identity, 'source_item', id))!.content_json).toEqual(before.content_json);
    await show(identity, id, shownOf(before));
    const after = (await reader().getDocument(identity, 'source_item', id))!;
    expect(after.content_json.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(after.agent_text_syntax).toBe('markdown');
  });

  it('refuses when the text shown is no longer the current version, and leaves the newer version as it is', async () => {
    const id = await item();
    await save(id, content(undefined, '# Visible A'));
    const seen = (await reader().getDocument(identity, 'source_item', id))!;
    // Another Run delivers B while the person is looking at A.
    await save(id, content(undefined, '# Arrived B'));
    await expect(show(identity, id, shownOf(seen))).rejects.toMatchObject({ statusCode: 409, responseBody: { code: 'reading_version_changed' } });
    const now = (await reader().getDocument(identity, 'source_item', id))!;
    expect(now.content_json.content?.[0]).toMatchObject({ type: 'paragraph', content: [{ text: '# Arrived B' }] });
    expect(now.agent_text_syntax).toBe('undeclared');
    // Looking at B again, the person can convert B.
    await show(identity, id, shownOf(now));
    expect((await reader().getDocument(identity, 'source_item', id))!.content_json.content?.[0]).toMatchObject({ type: 'heading', content: [{ text: 'Arrived B' }] });
  });

  it('works on the snapshot the Reader falls back to, with that version\'s own kind, format and sources', async () => {
    const id = await item();
    const snapshotContent = { kind: 'repository' as const, format: 'agent_summary' as const, text: '# Snapshot A\n\n- one\n- two', sources: ['https://example.test/readme'] };
    await saveSourceReadingDocument(db.pool, { spaceId: space, itemId: id, document: agentReadingDocument(snapshotContent, url), agentProvided: true, metadata: agentReadingMetadata(snapshotContent) });
    // The item's pointer is gone (older record); its item metadata says something else than the version.
    await db.pool.query(`UPDATE source_items SET extracted_artifact_id=NULL, metadata_json=metadata_json||'{"reading_content_kind":"article","reading_content_format":"source_text","reading_sources":["https://example.test/other"]}'::jsonb WHERE id=$1`, [id]);
    const fallback = (await reader().getDocument(identity, 'source_item', id))!;
    expect(fallback.source_snapshot_id).not.toBeNull();
    expect(fallback.agent_text_syntax).toBe('undeclared');
    expect(fallback.content_json.content?.[0]).toMatchObject({ type: 'paragraph', content: [{ text: '# Snapshot A' }] });
    // A client cannot name some other artifact as "shown".
    await expect(show(identity, id, { artifact_id: fallback.artifact_id!, source_snapshot_id: null })).rejects.toMatchObject({ statusCode: 409 });
    await show(identity, id, shownOf(fallback));
    const after = (await reader().getDocument(identity, 'source_item', id))!;
    expect(after.content_json.content?.map(node => node.type)).toEqual(['heading', 'bulletList']);
    expect(after.reading_info).toMatchObject({ kind: 'repository', format: 'agent_summary', sources: ['https://example.test/readme'], syntax: 'markdown' });
  });

  it('refuses people who may not write the material, and leaves the version as it is', async () => {
    const id = await item();
    await save(id, content(undefined, screenshot));
    const seen = (await reader().getDocument(identity, 'source_item', id))!;
    const reader2 = randomUUID();
    await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Reader','active',$2,'system',now(),now())`, [reader2, `${reader2}@test.invalid`]);
    await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, reader2]);
    await expect(show({ spaceId: space, userId: reader2 }, id, shownOf(seen))).rejects.toMatchObject({ statusCode: 403 });
    expect((await reader().getDocument(identity, 'source_item', id))!.agent_text_syntax).toBe('undeclared');
  });
});
