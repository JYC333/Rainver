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
 expect(ProjectReadingResponseSchema.parse({date:'2026-11-02',timezone:'UTC',today:'2026-11-02',latest:null,history:[],rounds:[],cross_theme_status:'not_generated'})).toMatchObject({latest:null});
 expect(ProjectReadingResponseSchema.safeParse({date:'2026-11-02',timezone:'UTC',today:'2026-11-02',latest:null,history:[],rounds:[],cross_theme_status:'passed'}).success).toBe(false);
});
it('accepts bounded advertised execution selections without granting a new Source or context override',()=>{
 const base={expected_version_id:'v',enabled:true,agent_id:'a',runtime_profile_id:'p'};
 expect(ProjectThemeAnalysisConsentSchema.parse({...base,session_config:[{id:'model',type:'select',category:'model',value:'offered-model'}]}).session_config).toHaveLength(1);
 expect(ProjectThemeAnalysisConsentSchema.safeParse({...base,session_config:[{id:'model',type:'select',category:'model',value:'offered-model',permissions:'write'}]}).success).toBe(false);
});
it('exposes only bounded composition progress alongside existing theme state',async()=>{
 const {ProjectReadingResponseSchema}=await import('../src/index.js');const body={date:'2026-11-02',timezone:'UTC',today:'2026-11-02',latest:null,history:[],rounds:[],cross_theme_status:'not_generated'};
 expect(ProjectReadingResponseSchema.safeParse(body).success).toBe(true);
 for(const composition_status of ['idle','waiting_for_analysis','queued','running','complete','failed'])expect(ProjectReadingResponseSchema.parse({...body,composition_status})).toHaveProperty('composition_status',composition_status);
 expect(ProjectReadingResponseSchema.safeParse({...body,composition_status:'arbitrary-job-error'}).success).toBe(false)
});
it('published content versions do not accept daily-progress or withdrawal snapshots',async()=>{
 const {ProjectReadingCompositionSchema}=await import('../src/index.js');
 const version={id:'edition',revision:1,previous_id:null,created_at:'2026-11-03T01:22:00Z',reason:'theme_terminal',edition_date:'2026-11-03',timezone:'UTC',day_revision:1,sections:[]};
 expect(ProjectReadingCompositionSchema.safeParse(version).success).toBe(true);
 for(const reason of ['daily','theme_withdrawn','collecting'])expect(ProjectReadingCompositionSchema.safeParse({...version,reason}).success).toBe(false);
});
it('accepts awaiting-analysis metadata without fabricating a failed or published result',()=>{
 expect(ProjectThemeRoundsResponseSchema.parse({analysis:null,latest:null,rounds:[{id:'r',sequence:1,version_id:'v',status:'awaiting_analysis',coverage:{complete:true},error_code:null,briefing:null,topic:null}]}).rounds[0]).toMatchObject({status:'awaiting_analysis',error_code:null,briefing:null});
});

it('daily history is paged, bounded and lists dated editions and topic analyses',async()=>{
 const {ProjectReadingHistorySchema,ProjectReadingHistoryQuerySchema}=await import('../src/index.js');
 const entry={kind:'edition',id:'day',date:'2026-11-01',created_at:'2026-11-01T00:00:00Z',revision:1};
 expect(ProjectReadingHistorySchema.parse({items:[entry],next_cursor:'cursor'}).items[0].date).toBe('2026-11-01');
 expect(ProjectReadingHistorySchema.safeParse({items:Array(21).fill(entry),next_cursor:null}).success).toBe(false);
 expect(ProjectReadingHistoryQuerySchema.safeParse({cursor:'x'.repeat(501)}).success).toBe(false);
 expect(ProjectReadingHistoryQuerySchema.safeParse({date:'2026-11-02',raw_sql:'anything'}).success).toBe(false);
});
