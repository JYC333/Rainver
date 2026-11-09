import {it,expect} from 'vitest';
import {PROJECT_MANAGEMENT_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
it('keeps Project creation distinct from mutations of existing Project authority',()=>{
 expect(PROJECT_MANAGEMENT_SCHEMAS['project.create'].input.parse({name:' New ',settings_json:null})).toMatchObject({name:'New',settings_json:{}});
 for(const extra of [{space_id:'s'},{user_id:'u'},{status:'archived'},{type:'research'}])expect(PROJECT_MANAGEMENT_SCHEMAS['project.create'].input.safeParse({name:'New',...extra}).success).toBe(false);
 expect(PROJECT_MANAGEMENT_SCHEMAS['project.member.add'].input.parse({project_id:'p',user_id:'u'})).toEqual({project_id:'p',user_id:'u',role:'member'});
});
it('does not accept publication status through draft writes or arbitrary attention state',()=>{
 expect(PROJECT_MANAGEMENT_SCHEMAS['project.brief.create'].input.safeParse({project_id:'p',status:'published'}).success).toBe(false);
 expect(PROJECT_MANAGEMENT_SCHEMAS['project.instruction.create'].input.safeParse({project_id:'p',title:'Instruction',instruction_text:'text',published_by_user_id:'u'}).success).toBe(false);
 expect(PROJECT_MANAGEMENT_SCHEMAS['project.attention.set_state'].input.safeParse({project_id:'p',source_type:'inquiry',source_id:'i',user_id:'other'}).success).toBe(false);
 expect(PROJECT_MANAGEMENT_SCHEMAS['decision.option.score'].input.safeParse({project_id:'p',case_id:'c',option_id:'o',criterion_id:'k',score:6}).success).toBe(false);
});
it('exposes each concrete command only to users without grants or production approval mappings',()=>{
 for(const id of Object.keys(PROJECT_MANAGEMENT_SCHEMAS) as (keyof typeof PROJECT_MANAGEMENT_SCHEMAS)[]){
  const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
  expect(definition.allowed_actor_types).toEqual(['user']);expect(definition.visibility.has('agent_tool')).toBe(false);expect(definition.grantable).toBe(false);expect(definition.proposal_type).toBeNull();expect(definition.execution).toEqual({kind:'command',tx:'core_owned'});
  expect(PROJECT_MANAGEMENT_SCHEMAS[id].output.safeParse({id:'i',project_id:'p',space_id:'s',title:'Private'}).success).toBe(false);
 }
});
it('bounds notebook context and keeps generated/review content out of their typed receipts',()=>{
 const chat=PROJECT_MANAGEMENT_SCHEMAS['project.notebook.chat'];
 expect(chat.input.parse({project_id:'p',message:'  question  ',source_item_ids:Array.from({length:25},(_,i)=>String(i))})).toMatchObject({message:'question',session_id:null,source_item_ids:Array.from({length:20},(_,i)=>String(i)),execution:{}});
 expect(chat.output.safeParse({id:'r',space_id:'s',project_id:'p',session_id:'c',run_id:'r',job_id:'j',daily_limit:20,daily_used:1,reply:'Private answer'}).success).toBe(false);
 expect(PROJECT_MANAGEMENT_SCHEMAS['project.review_session.open'].output.safeParse({id:'k',space_id:'s',project_id:'p',knowledge_packet_id:'k',inquiry_packet_id:null,created_at:'2026-01-01T00:00:00Z',candidates:['Private']}).success).toBe(false);
 expect(PROJECT_MANAGEMENT_SCHEMAS['project.update.report'].input.safeParse({project_id:'p',summary:'x'.repeat(8000)}).success).toBe(true);
});
it('keeps public-summary drafts separate from owner-reviewed publication and preserves bounded normalization',()=>{
 const draft=PROJECT_MANAGEMENT_SCHEMAS['project.public_summary.save'].input;
 expect(draft.parse({project_id:'p',summary_text:'  Public words  ',topics:[' Research ','research',''],source_refs:[{source_type:' note ',source_id:'n'}]})).toMatchObject({summary_text:'Public words',topics:['Research'],highlights:[],redaction_version:'project_public_summary.v1',generated_by_run_id:null,source_refs:[{source_type:'note',source_id:'n'}]});
 for(const extra of [{draft_version:1},{published_by_user_id:'u'},{source_refs:[{source_type:'note',source_id:'n',body:'Private'}]}])expect(draft.safeParse({project_id:'p',summary_text:'Public',...extra}).success).toBe(false);
 const publish=PROJECT_MANAGEMENT_SCHEMAS['project.public_summary.publish'].input;
 expect(publish.safeParse({project_id:'p',draft_version:0}).success).toBe(false);expect(publish.safeParse({project_id:'p',draft_version:1,summary_text:'Unreviewed'}).success).toBe(false);
});
