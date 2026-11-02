import {expect,it} from 'vitest';
import {ProjectDeepReadRequestSchema,ProjectFavoriteRequestSchema,ProjectDeepReadListSchema,PROJECT_DEEP_READING_LIMITS} from '../src/projectDeepReading.js';
it('keeps favorite and execution separate and rejects authority/log/schema overrides',()=>{
 expect(ProjectFavoriteRequestSchema.parse({favorite:true})).toEqual({favorite:true});expect(ProjectFavoriteRequestSchema.safeParse({favorite:true,investigation:true}).success).toBe(false);
 expect(ProjectDeepReadRequestSchema.parse({})).toEqual({});expect(ProjectDeepReadRequestSchema.safeParse({agent_id:'agent'}).success).toBe(false);expect(ProjectDeepReadRequestSchema.safeParse({project_id:'other',original:{}}).success).toBe(false);expect(ProjectDeepReadRequestSchema.safeParse({logs:['private']}).success).toBe(false);expect(ProjectDeepReadRequestSchema.safeParse({rerun_of:'one',retry_of:'two'}).success).toBe(false);
});
it('bounds owner-private operation lists without claiming costs or semantic quality',()=>{
 expect(ProjectDeepReadListSchema.parse({items:[],next_offset:null,limits:PROJECT_DEEP_READING_LIMITS}).items).toEqual([]);expect(ProjectDeepReadListSchema.safeParse({items:[],next_offset:null,limits:{...PROJECT_DEEP_READING_LIMITS,tokenCap:0}}).success).toBe(false);
});
it('bounds selectable material purposes and retains the exact collecting connection for retries',async()=>{
 const {ProjectDeepReadPurposesSchema,ProjectDeepReadOperationSchema}=await import('../src/projectDeepReading.js');
 const choice={goal_id:'g',version_id:'v',connection_id:'c',label:'Mechanisms'};
 expect(ProjectDeepReadPurposesSchema.parse({choices:[choice],truncated:false}).choices[0]).toEqual(choice);
 expect(ProjectDeepReadPurposesSchema.safeParse({choices:[{...choice,label:'x'.repeat(201)}],truncated:false}).success).toBe(false);
 expect(ProjectDeepReadOperationSchema.shape.purpose_label.safeParse('x'.repeat(201)).success).toBe(false);
 expect(ProjectDeepReadOperationSchema.shape.following.parse({goal_id:'g',version_id:'v',connection_id:'c'})).toEqual({goal_id:'g',version_id:'v',connection_id:'c'});
 expect(ProjectDeepReadOperationSchema.shape.execution.safeParse({agent_id:'a',runtime_profile_id:'p',credential:'secret'}).success).toBe(false);
});
