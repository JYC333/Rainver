import {it,expect} from 'vitest';
import {SourceGoalBeginRequestSchema,SourceGoalMessageRequestSchema,SourceGoalLegacyRequestSchema,SourceGoalCompatibilityRollbackSchema,SourceGoalPlanSchema} from '../src/index.js';
it('accepts natural-language Personal or Project setup without provider parameters',()=>{expect(SourceGoalBeginRequestSchema.parse({intent:'Follow robotics',project_id:'project',idempotency_key:'one'})).toMatchObject({project_id:'project'});expect(SourceGoalBeginRequestSchema.safeParse({intent:'Follow robotics',api_key:'forbidden'}).success).toBe(false)});
it('requires explicit bounded identities for messages and compatibility operations',()=>{expect(SourceGoalMessageRequestSchema.safeParse({goal_id:'goal',content:'Follow robotics',idempotency_key:''}).success).toBe(false);expect(SourceGoalLegacyRequestSchema.parse({channel_id:'channel',dry_run:true})).toEqual({channel_id:'channel',dry_run:true});expect(SourceGoalCompatibilityRollbackSchema.safeParse({goal_id:'goal',force:true}).success).toBe(false)});
it('allows one source while bounding user-facing cadence and content preferences',()=>{const plan={summary:'Robotics plan',sources:[{source_connection_id:'source',source_channel_id:'channel',reason:'Research evidence',supports_history:false,implementation:{kind:'connector'}}],limitations:[],filters:{includes:['robotics'],excludes:[],excluded_origins:['https://example.test']},interval_seconds:86400};expect(SourceGoalPlanSchema.parse(plan).sources).toHaveLength(1);expect(SourceGoalPlanSchema.safeParse({...plan,interval_seconds:1}).success).toBe(false);expect(SourceGoalPlanSchema.safeParse({...plan,filters:{...plan.filters,excludes:Array(17).fill('spam')}}).success).toBe(false)});

it('keeps Agent and profile selection paired at setup and message boundaries',()=>{for(const schema of [SourceGoalBeginRequestSchema,SourceGoalMessageRequestSchema]){const body=schema===SourceGoalBeginRequestSchema?{intent:'Follow robotics'}:{goal_id:'goal',content:'Follow robotics',idempotency_key:'one'};expect(schema.safeParse({...body,agent_id:'agent'}).success).toBe(false);expect(schema.safeParse({...body,agent_id:'agent',runtime_profile_id:'profile'}).success).toBe(true)}});
it('accepts a native search proposal without provider IDs and rejects unbounded queries',async()=>{
 const {SourceGoalVersionWriteSchema}=await import('../src/index.js');const input={goal_id:'goal',expected_revision:0,plan:{summary:'Native search',sources:[{reason:'Selected Agent',implementation:{kind:'agent_search',query:'robotics research'},supports_history:false}],limitations:[]}};expect(SourceGoalVersionWriteSchema.safeParse(input).success).toBe(true);expect(SourceGoalVersionWriteSchema.safeParse({...input,plan:{...input.plan,sources:[{...input.plan.sources[0],implementation:{kind:'agent_search',query:'x'.repeat(1001)}}]}}).success).toBe(false);
});

it('requires strict Agent result provenance fields and distinguishes zero results from failure',async()=>{
 const {SourceMaterialSubmissionSchema}=await import('../src/index.js');const base={processing_id:'c',status:'succeeded',items:[],failure:null,coverage:{truncated:false,exhaustive:false,limitations:[]}};expect(SourceMaterialSubmissionSchema.safeParse(base).success).toBe(true);expect(SourceMaterialSubmissionSchema.safeParse({...base,status:'failed'}).success).toBe(false);expect(SourceMaterialSubmissionSchema.safeParse({...base,status:'failed',failure:{code:'unavailable',message:'No tool'}}).success).toBe(true);for(const extra of [{verified:true},{run_id:'forged'},{account:'other'}])expect(SourceMaterialSubmissionSchema.safeParse({...base,...extra}).success).toBe(false);
});
it('rejects fabricated defaults, invalid URL credentials and unbounded Agent submissions',async()=>{
 const {SourceMaterialSubmissionSchema}=await import('../src/index.js');const item={url:'https://example.test/a',title:'An observed link',summary:null,observed_at:new Date().toISOString()};const base={processing_id:'c',status:'succeeded',items:[item],failure:null,coverage:{truncated:false,exhaustive:false,limitations:[]}};expect(SourceMaterialSubmissionSchema.safeParse(base).success).toBe(true);for(const url of ['javascript:alert(1)','file:///etc/passwd','https://user:pass@example.test'])expect(SourceMaterialSubmissionSchema.safeParse({...base,items:[{...item,url}]}).success).toBe(false);expect(SourceMaterialSubmissionSchema.safeParse({...base,items:[{url:item.url}]}).success).toBe(false);expect(SourceMaterialSubmissionSchema.safeParse({...base,items:Array(101).fill(item)}).success).toBe(false);expect(SourceMaterialSubmissionSchema.safeParse({...base,coverage:{...base.coverage,exhaustive:true}}).success).toBe(false);
});
it('permits bounded Agent reading content while leaving Source retention checks to the server',async()=>{
 const {SourceMaterialSubmissionSchema}=await import('../src/index.js');const item={url:'https://example.test',title:'Observed title',summary:null,observed_at:new Date().toISOString()};const input={processing_id:'c',status:'succeeded',items:[item],failure:null,coverage:{truncated:false,exhaustive:false,limitations:[]}};expect(SourceMaterialSubmissionSchema.safeParse(input).success).toBe(true);expect(SourceMaterialSubmissionSchema.safeParse({...input,items:[{...item,summary:'An attributed summary',content:{kind:'repository',format:'agent_summary',text:'Based on the README',sources:['https://example.test/README']}}]}).success).toBe(true);
});

it('preserves search citation redirects in a partial unverified submission without requiring URL resolution',async()=>{
 const {SourceMaterialSubmissionSchema}=await import('../src/index.js');
 const url='https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-citation';
 const result=SourceMaterialSubmissionSchema.parse({processing_id:'c',status:'succeeded',items:[{url,title:'Observed search result',summary:null,observed_at:'2026-10-28T00:00:00Z'}],failure:null,coverage:{truncated:true,exhaustive:false,limitations:['Only the first search result set was collected']}});
 expect(result.items).toHaveLength(1);expect(result.items[0].url).toBe(url);expect(result.coverage.exhaustive).toBe(false);
});
it('topic signals: stated publication, cited change and judgment are optional and bounded; feedback only tightens',async()=>{
 const {SourceMaterialSubmissionSchema,SourceGoalFeedbackRequestSchema,ReadingTopicLinkSchema}=await import('../src/index.js');
 const base={processing_id:'c',status:'succeeded',failure:null,coverage:{truncated:false,exhaustive:false,limitations:[]}};
 const item={url:'https://example.test/a',title:'A',summary:null,observed_at:'2026-10-28T00:00:00Z'};
 expect(SourceMaterialSubmissionSchema.parse({...base,items:[item]}).items[0].published_at).toBeUndefined();
 expect(SourceMaterialSubmissionSchema.safeParse({...base,items:[{...item,published_at:'2026-10-27T00:00:00Z',change:{kind:'release',evidence_url:'https://example.test/notes'},topic_judgment:{importance:'important',reason:'Core'}}],judgment_failure:null}).success).toBe(true);
 expect(SourceMaterialSubmissionSchema.safeParse({...base,items:[{...item,change:{kind:'release'}}]}).success).toBe(false);
 expect(SourceMaterialSubmissionSchema.safeParse({...base,items:[{...item,topic_judgment:{importance:'maybe',reason:'x'}}]}).success).toBe(false);
 expect(SourceMaterialSubmissionSchema.safeParse({...base,items:[{...item,published_at:'yesterday'}]}).success).toBe(false);
 for(const ok of [{kind:'exclude_origin',idempotency_key:'k',origin:'https://example.test'},{kind:'exclude_term',idempotency_key:'k',term:'ads'},{kind:'not_relevant',idempotency_key:'k',source_item_id:'i'},{kind:'slow_down',idempotency_key:'k',interval_seconds:7200}])expect(SourceGoalFeedbackRequestSchema.safeParse(ok).success).toBe(true);
 for(const bad of [{kind:'speed_up',idempotency_key:'k'},{kind:'slow_down',idempotency_key:'k',interval_seconds:60},{kind:'add_source',idempotency_key:'k'}])expect(SourceGoalFeedbackRequestSchema.safeParse(bad).success).toBe(false);
 expect(ReadingTopicLinkSchema.parse({goal_id:'g',selection_status:'unjudged',selection_reason:null})).toEqual({goal_id:'g',project_id:null,title:'',selection_status:'unjudged',selection_reason:null,judged_by:null,delivery_kind:'unknown_freshness',change_evidence_url:null});
});
it('change history entries are typed per topic and evidence',async()=>{
 const {SourceGoalItemChangeSchema,SourceGoalFollowStateSchema}=await import('../src/index.js');
 const c={id:'c',source_item_id:'i',change_kind:'update',evidence_url:'https://example.test/notes',delivery_kind:'evidenced_change',selection_status:'important',selection_reason:'Major',judged_by:'collection_agent',goal_run_id:'r',agent_run_id:null,detected_at:'2026-10-28T00:00:00Z'};
 expect(SourceGoalItemChangeSchema.safeParse(c).success).toBe(true);
 expect(SourceGoalItemChangeSchema.safeParse({...c,change_kind:'new_publication'}).success).toBe(false);
 expect(SourceGoalFollowStateSchema.shape.results.parse({items_total:0,important_total:0,unjudged_total:0,last_outcome:'never',last_new_items:null,last_checked_at:null,last_success_at:null,next_check_at:null}).changes_total).toBe(0);
});
it('topic journey contracts: manual save is preview-bound and never continuous; follow state reports the actual collection queue',async()=>{
 const {SourceGoalSaveSampleSchema,SourceGoalFollowStateSchema}=await import('../src/index.js');
 expect(SourceGoalSaveSampleSchema.parse({version_id:'v',preview_id:'p',idempotency_key:'k'})).toEqual({version_id:'v',preview_id:'p',idempotency_key:'k'});
 expect(SourceGoalSaveSampleSchema.safeParse({version_id:'v',idempotency_key:'k'}).success).toBe(false);
 expect(SourceGoalSaveSampleSchema.safeParse({version_id:'v',preview_id:'p',idempotency_key:'k',execution_mode:'continuous'}).success).toBe(false);
 const state={intent:'following',pending_adjustment:false,phase:'scheduled',blocked_reason:null,health:'ok',sources:[],results:{items_total:0,important_total:0,unjudged_total:0,last_outcome:'never',last_new_items:null,last_checked_at:null,last_success_at:null,next_check_at:null}};
 expect(SourceGoalFollowStateSchema.parse(state).collections).toEqual({queued:0,running:0});
 expect(SourceGoalFollowStateSchema.safeParse({...state,collections:{queued:-1,running:0}}).success).toBe(false);
});
it('creation carries its one follow confirmation and explicit model/mode only with a key and an explicit Profile; redacted bindings parse',async()=>{
 const {SourceGoalBeginRequestSchema,SourceGoalDetailSchema}=await import('../src/index.js');
 const follow={interval_seconds:604800,requests_per_run:4,items_per_source:10};const mode=[{id:'mode',type:'select' as const,category:'mode',value:'plan'}];
 expect(SourceGoalBeginRequestSchema.safeParse({intent:'Robotics',idempotency_key:'k',follow}).success).toBe(true);
 expect(SourceGoalBeginRequestSchema.safeParse({intent:'Robotics',follow}).success).toBe(false);
 expect(SourceGoalBeginRequestSchema.safeParse({intent:'Robotics',idempotency_key:'k',session_config:mode}).success).toBe(false);
 expect(SourceGoalBeginRequestSchema.safeParse({intent:'Robotics',idempotency_key:'k',agent_id:'a',runtime_profile_id:'p',session_config:mode,follow}).success).toBe(true);
 expect(SourceGoalBeginRequestSchema.safeParse({intent:'Robotics',idempotency_key:'k',follow:{...follow,requests_per_run:21}}).success).toBe(false);
 const goal={id:'g',space_id:'s',owner_user_id:'u',project_id:null,intent_json:{},budget_json:{requests_per_run:8,items_per_source:20,agent_attempts:2,repair_attempts:2,interval_seconds:86400},status:'running',revision:1,current_version_id:null,active_version_id:null};
 const detail=SourceGoalDetailSchema.parse({goal,versions:[],previews:[],agent_runs:[],repairs:[],runs:[],bindings:[{id:'b',goal_id:'g',source_connection_id:'c',status:'paused',revision:2,unavailable:true,collection_error:'source_unavailable'}]});
 expect(detail.bindings[0]).not.toHaveProperty('spec_json');
 expect(SourceGoalDetailSchema.safeParse({goal,versions:[],previews:[],agent_runs:[],repairs:[],runs:[],bindings:[{id:'b',goal_id:'g',source_connection_id:'c',status:'paused',revision:2,unavailable:true,collection_error:'source_unavailable',spec_json:{}}]}).success).toBe(false);
});

it('manual checking requires the exact shown version and accepts null only as the legacy reference',async()=>{
 const {SourceGoalCheckRequestSchema}=await import('../src/index.js');
 expect(SourceGoalCheckRequestSchema.parse({expected_version_id:'plan-v1'})).toEqual({expected_version_id:'plan-v1'});
 expect(SourceGoalCheckRequestSchema.parse({expected_version_id:null})).toEqual({expected_version_id:null});
 for(const input of [{},{expected_version_id:''},{expected_version_id:'v',ignore_budget:true}])expect(SourceGoalCheckRequestSchema.safeParse(input).success).toBe(false);
});

it('accepts bounded downstream analysis briefs for API and Agent plans without requiring them on old plans',async()=>{
 const {SourceGoalVersionWriteSchema}=await import('../src/index.js');
 const plan={summary:'Comparison purpose is visible here',analysis_brief:'Compare system mechanisms using actual architecture and code evidence.',sources:[{source_connection_id:'s',source_channel_id:'c',reason:'Evidence',supports_history:false,implementation:{kind:'connector'}}],limitations:[]};
 expect(SourceGoalPlanSchema.parse(plan).analysis_brief).toBe(plan.analysis_brief);
 expect(SourceGoalVersionWriteSchema.safeParse({goal_id:'g',expected_revision:0,plan:{...plan,sources:[{reason:'Evidence',supports_history:false,implementation:{kind:'agent_search',query:'system architecture'}}]}}).success).toBe(true);
 expect(SourceGoalPlanSchema.safeParse({...plan,analysis_brief:'x'.repeat(4001)}).success).toBe(false);
 expect(SourceGoalPlanSchema.safeParse({...plan,analysis_brief:' '}).success).toBe(false);
 expect(SourceGoalPlanSchema.safeParse({...plan,analysis_brief:undefined}).success).toBe(true);
});
