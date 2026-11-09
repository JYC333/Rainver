import {it,expect} from 'vitest';
import {RESEARCH_WORKSPACE_SCHEMAS,RESEARCH_EXECUTION_SCHEMAS,SYSTEM_ACTION_REGISTRY,ResearchAdhocInputSchema,ResearchAdhocReceiptSchema} from '../src/index.js';
it('keeps snapshot intents strict and receipts free of Research content',()=>{
 const command=RESEARCH_EXECUTION_SCHEMAS['research.report.snapshot'];expect(command.input.parse({project_id:'project'})).toEqual({project_id:'project'});expect(command.input.safeParse({project_id:'project',workflow_id:'forged'}).success).toBe(false);expect(command.output.safeParse({id:'operation',space_id:'space',project_id:'project',report:'PRIVATE'}).success).toBe(false);
 const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='research.report.snapshot')!;expect(definition.allowed_actor_types).toEqual(['user']);expect(definition.grantable).toBe(false);expect(definition.execution).toEqual({kind:'command',tx:'core_owned'});
});
it('bounds ad-hoc queued intents, hides prompt bodies from receipts and retains its human-only contract',()=>{
 expect(ResearchAdhocInputSchema.parse({project_id:'p',prompt:'  Compare  '})).toEqual({project_id:'p',prompt:'Compare',section_key:'understanding',source_item_ids:[],execution:{}});
 expect(ResearchAdhocInputSchema.safeParse({project_id:'p',prompt:'Compare',source_item_ids:Array(21).fill('s')}).success).toBe(false);
 expect(ResearchAdhocInputSchema.safeParse({project_id:'p',prompt:'Compare',execution:{api_key:'secret'}}).success).toBe(false);
 expect(ResearchAdhocReceiptSchema.safeParse({run_id:'r',job_id:'j',note_id:'n',space_id:'s',project_id:'p',status:'queued',daily_limit:20,daily_used:1,prompt:'private'}).success).toBe(false);
 const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='research.ask_ai')!;expect(definition.allowed_actor_types).toEqual(['user']);expect(definition.grantable).toBe(false);expect(definition.execution).toEqual({kind:'command',tx:'core_owned'});
});
it('normalizes the bounded legacy editor fields, default nulls and rejects privileged or extra inputs',()=>{
 expect(RESEARCH_WORKSPACE_SCHEMAS['research.checklist.create'].input.parse({project_id:'p',text:'  todo  '})).toEqual({project_id:'p',text:'todo'});
 expect(RESEARCH_WORKSPACE_SCHEMAS['research.evidence_card.update'].input.parse({project_id:'p',source_item_id:'s'})).toEqual({project_id:'p',source_item_id:'s',why_md:'',how_md:'',what_md:''});
 expect(RESEARCH_WORKSPACE_SCHEMAS['research.screening.configure'].input.parse({project_id:'p'})).toMatchObject({date_range_start:null,date_range_end:null,domain_criteria:{}});
 for(const name of Object.keys(RESEARCH_WORKSPACE_SCHEMAS) as (keyof typeof RESEARCH_WORKSPACE_SCHEMAS)[]){const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id===name)!;expect(definition.allowed_actor_types).toEqual(['user']);expect(definition.grantable).toBe(false);expect(definition.visibility.has('agent_tool')).toBe(false);expect(definition.execution).toEqual({kind:'command',tx:'core_owned'});expect(RESEARCH_WORKSPACE_SCHEMAS[name].input.safeParse({project_id:'p',actor_id:'forged'}).success).toBe(false);}
});
it('retains bounded intake draft source references and partial refinement without accepting caller authority',()=>{
 const schema=RESEARCH_WORKSPACE_SCHEMAS['research.intake.draft'].input;
 const body={project_id:'p',thread_id:'thread',research_question:'Question',report_depth:'quick',question_refine_skipped:true,source_channel_ids:['channel'],question_refinement:{recommended_question:'Partial draft'}};
 expect(schema.parse(body)).toMatchObject({source_channel_ids:['channel'],question_refinement:{recommended_question:'Partial draft'},max_items:10000,workflow_id:null});
 expect(schema.safeParse({...body,run_id:'forged'}).success).toBe(false);
 expect(schema.safeParse({...body,question_refinement:{text:'x'.repeat(20001)}}).success).toBe(false);
});
