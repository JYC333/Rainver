import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {HttpError,type Queryable,type Pool} from '../../routeUtils/common.js';
import {assertProjectReadable,assertProjectWriterForMutation} from '../../projects/access.js';
import {PgTaskRepository} from '../../tasks/repository.js';
import {hidden,markedRefusal} from '../../systemActions/operations/errors.js';
import type {OperationRegistration,OperationReadAuditPort} from '../../systemActions/operations/types.js';
import {personalBriefingScope} from './personalScope.js';
import {projectBriefingScope} from './projectScope.js';
import {authorizedHighlight} from './highlight.js';
import {prepareFollowUp} from './followUp.js';
import {previewAdoption,confirmAdoption} from './adoption.js';
import {lockHighlightAdoption} from './highlightAuthority.js';

const ids=['briefing.personal.follow_up','briefing.project.follow_up','briefing.personal.adoption.preview','briefing.project.adoption.preview','briefing.personal.adoption.confirm','briefing.project.adoption.confirm'] as const;
type Input=OperationInput<typeof ids[number]>;
const auditRefs=Symbol('briefing highlight read audit');
type Audited={ [auditRefs]:{items:string[];tasks:string[]} };
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const scope=(i:Input,a:OperationActor)=>'project_id' in i?projectBriefingScope(a.space_id,i.project_id):personalBriefingScope(a.space_id,a.on_behalf_of_user_id!);
async function readAudit(audit:OperationReadAuditPort,_input:unknown,_output:unknown,_actor:OperationActor,raw?:unknown){
 const refs=(raw as Audited|undefined)?.[auditRefs];
 if(!refs)throw new Error('Briefing content read has no audit closure');
 await audit.recordReads('source_item',refs.items);
 await audit.recordReads('task',refs.tasks);
}
export function briefingHighlightRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return ids.map(id=>{
  const command=id.endsWith('.confirm');
  return {
   definition:defs.get(id)!,
   ...(command?{successStatus:(out:unknown)=>(out as {created:boolean}).created?201 as const:200 as const}:{readKind:'content' as const,readAudit}),
   async resolve(_db,raw,a){const i=raw as Input;return {authority:`briefing:${a.space_id}:${i.briefing_id}`,targets:i,resourceType:'space',resourceId:a.space_id};},
   async authorize(db,raw,a){
    const i=raw as Input;if(i.space_id!==a.space_id||!a.on_behalf_of_user_id)throw hidden();
    const adapter=scope(i,a),index=Number(i.index);
    if(command){await lockHighlightAdoption(db,person(a),adapter,i.briefing_id,index);if('project_id' in i)await assertProjectWriterForMutation(db,a.space_id,i.project_id,a.on_behalf_of_user_id);}
    else {if('project_id' in i)await assertProjectReadable(db,a.space_id,i.project_id,a.on_behalf_of_user_id);await authorizedHighlight(db,adapter,i.briefing_id,index,a.on_behalf_of_user_id);}
   },
   ...(command?{async authorizeResult(db:Queryable,raw:unknown,a:OperationActor){
    const out=raw as {task:{id:string;project_id:string|null}};
    const task=await new PgTaskRepository(db as Pool).findReadableTask(person(a),out.task.id,db);
    if(!task||task.project_id!==out.task.project_id)throw hidden();
   }}:{}),
   async execute(db,raw,a){
    const i=raw as Input,adapter=scope(i,a),index=Number(i.index);
    if(command)return confirmAdoption(db,adapter,person(a),i.briefing_id,index,(i as OperationInput<'briefing.personal.adoption.confirm'>).preview_hash);
    const result=id.endsWith('.follow_up')?await prepareFollowUp(db,adapter,a.on_behalf_of_user_id!,i.briefing_id,index):await previewAdoption(db,adapter,person(a),i.briefing_id,index);
    const target=await authorizedHighlight(db,adapter,i.briefing_id,index,a.on_behalf_of_user_id!);
    Object.defineProperty(result,auditRefs,{value:{items:target.evidence.map(e=>e.source_item_id),tasks:target.context.filter(c=>c.source.type==='task').map(c=>c.source.id)}});
    return result;
   },
   classifyError:error=>error instanceof HttpError?markedRefusal(error,'information_digest'):undefined,
  };
 });
}
