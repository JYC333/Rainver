import {describe,it,expect} from 'vitest';
import {ReadingMethodDraftSchema,ReadingMethodTrialSchema,ReadingMethodSampleSchema,ReadingMethodJudgeSchema,ReadingMethodGenerationSchema,ReadingMethodGeneratedOutputSchema} from '../src/readingMethod.js';
describe('Bounded Reading method inputs',()=>{
 it('description generation accepts no logs, raw context or permission knobs and validates bounded model output',()=>{
 const input={source_kind:'description',item_id:'i',parent_version_id:'p',parent_content_hash:'a'.repeat(64),description:'Inspect relevant documentation',agent_id:'a',runtime_profile_id:'p'};
 expect(ReadingMethodGenerationSchema.safeParse(input).success).toBe(true);expect(ReadingMethodGenerationSchema.safeParse({...input,description:'更深入'}).success).toBe(true);expect(ReadingMethodGenerationSchema.safeParse({...input,description:'   '}).success).toBe(false);
 for(const field of ['log_ids','raw_log','context','permissions'])expect(ReadingMethodGenerationSchema.safeParse({...input,[field]:'private'}).success).toBe(false);
 const output={schema:'reading_method_revision.v1',method:'Inspect actual documentation, mechanisms, evidence and unknowns.',summary:'Adds concrete evidence',changes:['Read examples']};
 expect(ReadingMethodGeneratedOutputSchema.safeParse(output).success).toBe(true);
 expect(ReadingMethodGeneratedOutputSchema.safeParse({...output,method:'short'}).success).toBe(false);
 expect(ReadingMethodGeneratedOutputSchema.safeParse({...output,method:'x'.repeat(12001)}).success).toBe(false);
 expect(ReadingMethodGeneratedOutputSchema.safeParse({...output,permissions:['source.write']}).success).toBe(false);
 });
 it('requires a reason, parent and readable bounded method; no authority knobs',()=>{const v={item_id:'item',parent_version_id:'version',reason:'Homepage only',method:'Read primary docs and identify mechanisms and integration tradeoffs.'};expect(ReadingMethodDraftSchema.safeParse(v).success).toBe(true);expect(ReadingMethodDraftSchema.safeParse({...v,permissions:['browse']}).success).toBe(false);expect(ReadingMethodDraftSchema.safeParse({...v,method:'x'.repeat(12001)}).success).toBe(false)});
 it('requires explicit case, candidate, Agent and Profile and accepts an explicit bounded retry',()=>{const v={item_id:'i',candidate_version_id:'v',candidate_content_hash:'a'.repeat(64),case_id:'c',agent_id:'a',runtime_profile_id:'p',retry_of:'failed'};expect(ReadingMethodTrialSchema.safeParse(v).success).toBe(true);expect(ReadingMethodTrialSchema.safeParse({...v,runtime_profile_id:undefined}).success).toBe(false);expect(ReadingMethodTrialSchema.safeParse({...v,passed:true}).success).toBe(false)});
 it('does not accept a homepage-only sample or a score masquerading as a human judgment',()=>{expect(ReadingMethodSampleSchema.safeParse({name:'sample',pages:[{url:'https://example.org',text:'Homepage only'}]}).success).toBe(false);expect(ReadingMethodJudgeSchema.safeParse({judgment:'passed',reason:'Valid structure'}).success).toBe(false);expect(ReadingMethodJudgeSchema.safeParse({judgment:'unknown',reason:'No semantic model run authorized'}).success).toBe(true)});
});
it('accepts default API without a persona and only the two bounded method targets',()=>{
 const input={source_kind:'description',item_id:'i',parent_version_id:'p',parent_content_hash:'a'.repeat(64),description:'Keep constraints explicit'};expect(ReadingMethodGenerationSchema.safeParse(input).success).toBe(true);expect(ReadingMethodGenerationSchema.safeParse({...input,target_key:'prompt.revision.method',provider_id:'provider',model:'chat'}).success).toBe(true);expect(ReadingMethodGenerationSchema.safeParse({...input,target_key:'arbitrary.asset'}).success).toBe(false);expect(ReadingMethodGenerationSchema.safeParse({...input,agent_id:'a'}).success).toBe(false);expect(ReadingMethodGenerationSchema.safeParse({...input,agent_id:'a',runtime_profile_id:'r',provider_id:'provider'}).success).toBe(false);
});
it('allows a controlled API pair without Agent/Profile while rejecting ambiguous legacy configuration',()=>{
 const input={item_id:'i',candidate_version_id:'v',candidate_content_hash:'a'.repeat(64),case_id:'c',target_key:'prompt.revision.method'};expect(ReadingMethodTrialSchema.safeParse(input).success).toBe(true);expect(ReadingMethodTrialSchema.safeParse({...input,runtime_profile_id:'profile'}).success).toBe(false);
});

it('CLI supports both method targets but never mixes API and CLI fields',()=>{
 for(const target_key of ['reading.project_investigation','prompt.revision.method']){
 const generation={source_kind:'description',target_key,item_id:'i',parent_version_id:'v',parent_content_hash:'a'.repeat(64),description:'Preserve constraints',agent_id:'a',runtime_profile_id:'r'};
 expect(ReadingMethodGenerationSchema.safeParse(generation).success).toBe(true);
 expect(ReadingMethodGenerationSchema.safeParse({...generation,model:'chat'}).success).toBe(false);
 expect(ReadingMethodTrialSchema.safeParse({target_key,item_id:'i',candidate_version_id:'v',candidate_content_hash:'a'.repeat(64),case_id:'c',agent_id:'a',runtime_profile_id:'r'}).success).toBe(true);
 }
});
it('scope-only maintenance accepts omitted/null material but real comparisons still require an article',()=>{
 const generation={source_kind:'description',parent_version_id:'parent',parent_content_hash:'a'.repeat(64),description:'Improve the shared evidence strategy'};
 expect(ReadingMethodGenerationSchema.parse(generation).item_id).toBeNull();
 expect(ReadingMethodGenerationSchema.parse({...generation,item_id:null}).item_id).toBeNull();
 expect(ReadingMethodGenerationSchema.safeParse({...generation,item_id:''}).success).toBe(false);
 expect(ReadingMethodGenerationSchema.safeParse({...generation,scope_only:true}).success).toBe(false);
 expect(ReadingMethodDraftSchema.parse({parent_version_id:'p',reason:'Shared feedback',method:'Use primary documentation and examples; distinguish unknowns.'}).item_id).toBeNull();
 expect(ReadingMethodTrialSchema.safeParse({project_id:null,candidate_version_id:'c',candidate_content_hash:'a'.repeat(64),case_id:'case'}).success).toBe(false);
});
