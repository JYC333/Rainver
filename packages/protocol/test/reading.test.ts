import { describe, expect, it } from 'vitest';
import { ReadingPreferenceSchema, ReadingQuerySchema, ReadingStateRequestSchema, ReadingPageSchema } from '../src/reading.js';
describe('reading contracts', () => {
  it('defaults to pending and bounds pages without silently accepting arbitrary filters', () => {
    expect(ReadingQuerySchema.parse({})).toEqual({ view:'pending',limit:30,topic_selection:'all',sort:'newest' });
    expect(ReadingQuerySchema.safeParse({sort:'random'}).success).toBe(false);
    expect(ReadingQuerySchema.parse({topic:'goal-1',topic_selection:'important'})).toMatchObject({topic:'goal-1',topic_selection:'important'});
    expect(ReadingQuerySchema.safeParse({topic_selection:'important'}).success).toBe(false);
    expect(ReadingQuerySchema.safeParse({topic:'goal-1',topic_selection:'unjudged'}).success).toBe(false);
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

it('bounds the exact topic change acknowledgement separately from material state',()=>{
 expect(ReadingStateRequestSchema.parse({topic_change_id:'change-v2',read_status:'read'})).toEqual({topic_change_id:'change-v2',read_status:'read'});
 expect(ReadingStateRequestSchema.safeParse({topic_change_id:'change-v2'}).success).toBe(false);
 expect(ReadingStateRequestSchema.safeParse({topic_change_id:'',read_status:'read'}).success).toBe(false);
 expect(ReadingStateRequestSchema.safeParse({topic_change_id:'change-v2',user_id:'other',read_status:'read'}).success).toBe(false);
});

it('keeps collection arrival separate from publication freshness and compatible with older topic payloads',async()=>{
 const {ReadingTopicLinkSchema}=await import('../src/reading.js');const base={goal_id:'g',selection_status:'unjudged',selection_reason:null,delivery_kind:'unknown_freshness'};
 expect(ReadingTopicLinkSchema.parse(base).new_in_latest_collection).toBeUndefined();
 expect(ReadingTopicLinkSchema.parse({...base,new_in_latest_collection:true})).toMatchObject({delivery_kind:'unknown_freshness',new_in_latest_collection:true});
 expect(ReadingTopicLinkSchema.safeParse({...base,new_in_latest_collection:'new'}).success).toBe(false);
});
