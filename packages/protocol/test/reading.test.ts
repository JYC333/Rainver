import { describe, expect, it } from 'vitest';
import { ReadingPreferenceSchema, ReadingQuerySchema, ReadingStateRequestSchema, ReadingPageSchema } from '../src/reading.js';
describe('reading contracts', () => {
  it('defaults to pending and bounds pages without silently accepting arbitrary filters', () => {
    expect(ReadingQuerySchema.parse({})).toEqual({ view:'pending',limit:30 });
    expect(ReadingQuerySchema.parse({limit:'100'}).limit).toBe(100);
    for (const input of [{limit:0},{limit:101},{view:'relevant'},{user_id:'other'},{cursor:'x'.repeat(4097)}]) expect(ReadingQuerySchema.safeParse(input).success).toBe(false);
  });
  it('keeps preference and reading state distinct from relevance or interest feedback', () => {
    expect(ReadingPreferenceSchema.parse({show_in_my_reading:false})).toEqual({show_in_my_reading:false});
    for (const input of [{},{read_status:'relevant'},{source_item_ids:['a']},{feedback:'not_interested'}]) expect(ReadingStateRequestSchema.safeParse(input).success).toBe(false);
    expect(ReadingStateRequestSchema.parse({read_status:'unread',dismissed:false})).toEqual({read_status:'unread',dismissed:false});
    expect(ReadingPageSchema.parse({items:[],total:0,next_cursor:null})).toEqual({items:[],total:0,next_cursor:null});
  });
});
