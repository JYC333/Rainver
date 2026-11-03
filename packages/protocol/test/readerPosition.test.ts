import { describe, expect, it } from 'vitest';
import { ProjectReadingRecordsSchema, ReaderAnnotationRangeUpdateSchema, ReaderDocumentNoteCreateSchema, ReaderAppearanceSchema, ReaderPositionWriteSchema } from '../src/index.js';

const mark = { anchor: { block_index: 3, pm_pos: 120, text_offset: 400, quote: 'Paragraph start', before_context: 'previous words ' }, progress: 0.4 };

describe('Reader position contract', () => {
  it('accepts a bounded position report with defaults for dwell and reset', () => {
    expect(ReaderPositionWriteSchema.parse({ content_hash: 'c', structure_hash: 's', current: mark, client_at: '2026-10-29T10:00:00.000Z' }))
      .toMatchObject({ dwelled: false, reset_furthest: false });
  });

  it('rejects unknown fields, out-of-range progress and oversized quotes', () => {
    const base = { content_hash: 'c', structure_hash: 's', current: mark, client_at: '2026-10-29T10:00:00.000Z' };
    for (const input of [
      { ...base, read_status: 'read' },
      { ...base, current: { ...mark, progress: 1.5 } },
      { ...base, current: { ...mark, anchor: { ...mark.anchor, quote: 'x'.repeat(201) } } },
      { ...base, client_at: 'yesterday' },
    ]) expect(ReaderPositionWriteSchema.safeParse(input).success).toBe(false);
  });

  it('gives appearance defaults and refuses unknown values', () => {
    expect(ReaderAppearanceSchema.parse({})).toEqual({ font_size: null, line_height: 'normal', width: 'full', font: 'sans', theme: 'app' });
    expect(ReaderAppearanceSchema.parse({ width: 'full' }).width).toBe('full');
    expect(ReaderAppearanceSchema.safeParse({ font_size: 40 }).success).toBe(false);
    expect(ReaderAppearanceSchema.safeParse({ theme: 'neon' }).success).toBe(false);
  });
});


describe('Reader range and independent note contracts', () => {
  const anchor = { schema_version: 1, normalizer: 'plain_text_v1', quote_text: 'New', text_range: { start: 0, end: 3, unit: 'utf16' }, before_context: '', after_context: '', content_hash: 'c', structure_hash: 's', document_ref: { document_type: 'source_item', document_id: 'item' } }
  const update = { expected_quote_text: 'Old', expected_anchor_json: {}, content_hash: 'c', structure_hash: 's', quote_text: 'New', anchor_json: anchor }
  it('requires a coherent quote/version and rejects unexpected authority fields', () => {
    expect(ReaderAnnotationRangeUpdateSchema.safeParse(update).success).toBe(true)
    expect(ReaderAnnotationRangeUpdateSchema.safeParse({ ...update, quote_text: 'Different' }).success).toBe(false)
    expect(ReaderAnnotationRangeUpdateSchema.safeParse({ ...update, content_hash: 'older' }).success).toBe(false)
    expect(ReaderAnnotationRangeUpdateSchema.safeParse({ ...update, visibility: 'space_shared' }).success).toBe(false)
    expect(ReaderAnnotationRangeUpdateSchema.safeParse({ ...update, anchor_json: { ...anchor, tiptap_range: { from: 5, to: 1 } } }).success).toBe(false)
  })
  it('accepts only a note title, never client-selected Space/visibility/body', () => {
    expect(ReaderDocumentNoteCreateSchema.safeParse({ title: 'My observations' }).success).toBe(true)
    expect(ReaderDocumentNoteCreateSchema.safeParse({ title: 'My observations', visibility: 'space_shared' }).success).toBe(false)
  })
})

it('keeps Project originals and analyses explicit and bounds records pagination',()=>{
 const record={snapshot_id:'s',artifact_id:'a',captured_at:'2026-11-01T00:00:00Z',role:'analysis',format:'source_text',origin_run_id:null,original_snapshot_id:null};
 const payload={original:null,original_availability:'not_retained',items:[record],next_offset:null,truncated:false};
 expect(ProjectReadingRecordsSchema.parse(payload).items[0].role).toBe('analysis');
 expect(ProjectReadingRecordsSchema.safeParse({...payload,items:Array(26).fill(record)}).success).toBe(false);
 expect(ProjectReadingRecordsSchema.safeParse({...payload,next_offset:10025}).success).toBe(false);
});
