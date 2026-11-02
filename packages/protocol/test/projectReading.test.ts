import {expect,it} from 'vitest';
import {ProjectThemeAnalysisConsentSchema,ProjectThemeRetrySchema,ProjectThemeRoundsResponseSchema,SourceGoalFollowRequestSchema,BriefingModelOutputSchema} from '../src/index.js';
it('analysis consent is explicit, exact-purpose-bound and requires an execution; old collection payload stays compatible',()=>{
 expect(ProjectThemeAnalysisConsentSchema.safeParse({enabled:true,expected_version_id:'v'}).success).toBe(false);
 expect(ProjectThemeAnalysisConsentSchema.parse({enabled:true,expected_version_id:'v',agent_id:'a',runtime_profile_id:'p'}).enabled).toBe(true);
 expect(ProjectThemeAnalysisConsentSchema.safeParse({enabled:false,expected_version_id:'v',approve_source:true}).success).toBe(false);
 expect(SourceGoalFollowRequestSchema.safeParse({idempotency_key:'k'}).success).toBe(true);
 expect(SourceGoalFollowRequestSchema.safeParse({idempotency_key:'k',version_id:'v',theme_analysis:{enabled:true,agent_id:'a',runtime_profile_id:'p'}}).success).toBe(true);
});
it('retry cannot supply arbitrary execution, raw input or a different scope',()=>{
 expect(ProjectThemeRetrySchema.parse({round_id:'r'})).toEqual({round_id:'r'});
 expect(ProjectThemeRetrySchema.safeParse({round_id:'r',agent_id:'a'}).success).toBe(false);
});
it('empty metadata is readable without a model; theme summaries and coverage remain bounded',()=>{
 expect(ProjectThemeRoundsResponseSchema.parse({analysis:null,latest:null,rounds:[]})).toEqual({analysis:null,latest:null,rounds:[]});
 const value={schema:'information_briefing.v1',overview:{text:'Evidence synthesis',refs:['S1']},highlights:[],open_questions:[],topic:{quick_line:'Short line',summary:'Short summary',stop_reason:'Only retained evidence.'}};
 expect(BriefingModelOutputSchema.safeParse(value).success).toBe(true);
 expect(BriefingModelOutputSchema.safeParse({...value,overview:{...value.overview,refs:Array.from({length:54},(_,i)=>`S${i+1}`)}}).success).toBe(true);
 expect(BriefingModelOutputSchema.safeParse({...value,topic:{...value.topic,quick_line:'x'.repeat(241)}}).success).toBe(false);
});

it('analysis-admission diagnostics are bounded safe metadata, not raw error text',()=>{
 const value={analysis:null,latest:null,rounds:[],analysis_admission:{status:'blocked',version_id:'v',code:'theme_method_invalid',checked_at:'2026-11-01T12:00:00Z'}};
 expect(ProjectThemeRoundsResponseSchema.safeParse(value).success).toBe(true);
 expect(ProjectThemeRoundsResponseSchema.safeParse({...value,analysis_admission:{...value.analysis_admission,code:'/private/path raw error'}}).success).toBe(false);
});

it('composition protocol keeps exact referenced versions, bounded sections and an explicit absence of cross-theme claims',async()=>{
 const {ProjectReadingResponseSchema}=await import('../src/projectReading.js');
 expect(ProjectReadingResponseSchema.parse({latest:null,history:[],rounds:[],cross_theme_status:'not_generated'})).toMatchObject({latest:null});
 expect(ProjectReadingResponseSchema.safeParse({latest:null,history:[],rounds:[],cross_theme_status:'passed'}).success).toBe(false);
});
it('accepts bounded advertised execution selections without granting a new Source or context override',()=>{
 const base={expected_version_id:'v',enabled:true,agent_id:'a',runtime_profile_id:'p'};
 expect(ProjectThemeAnalysisConsentSchema.parse({...base,session_config:[{id:'model',type:'select',category:'model',value:'offered-model'}]}).session_config).toHaveLength(1);
 expect(ProjectThemeAnalysisConsentSchema.safeParse({...base,session_config:[{id:'model',type:'select',category:'model',value:'offered-model',permissions:'write'}]}).success).toBe(false);
});
