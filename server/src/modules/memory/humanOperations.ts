import {type OperationActor,type RegisteredSystemActionDefinition,MEMORY_OPERATION_SCHEMAS} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationRefusal,hidden} from '../systemActions/operations/errors.js';
import {lockActivePerson} from '../access/activePerson.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import type {Queryable} from '../routeUtils/common.js';
import {MemoryProposalValidationError,PgMemoryProposalRepository} from './proposalRepository.js';
import {MemoryApplyError,MemoryAudienceError,MemoryOperatorEditRequiredError,PgMemoryApplyRepository} from './memoryApplyRepository.js';
type Input=Record<string,any>;
type Id=keyof typeof MEMORY_OPERATION_SCHEMAS;
const user=(a:OperationActor)=>a.on_behalf_of_user_id!;
/** The Memory domain keeps its own contextual proposal.create check (target
 * scope/visibility/sensitivity); its decision record joins this transaction. */
const proposals=(db:Queryable,config:ServerConfig)=>new PgMemoryProposalRepository(db,{...config,auditTransaction:db} as ServerConfig);
const owns=async(db:Queryable,a:OperationActor,id:string)=>(await db.query('SELECT id FROM memory_entries WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 AND deleted_at IS NULL',[id,a.space_id,user(a)])).rows.length>0;
const proposalVisible=async(db:Queryable,a:OperationActor,id:string)=>(await contentDecisionFromDb(db,{spaceId:a.space_id,userId:user(a)},'proposal',id,{includeOversight:false}))==='full';
/** A person's own Memory commands (ADR 0003 §1–§3, B10). Creating and changing
 * what an entry says stay proposals decided through the canonical applier;
 * archive/restore/undo of the person's own entry apply directly as new versions
 * through that same applier; someone else's entry is a proposal. */
export function memoryHumanRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 const reg=(id:Id,parts:Omit<OperationRegistration,'definition'|'classifyError'|'resolve'>&{target:(i:Input)=>string|null}):OperationRegistration=>({
  definition:defs.get(id)!,
  async resolve(_db,raw,a){const t=parts.target(raw as Input);return {authority:t?`memory:${t}`:`memory_space:${a.space_id}`,targets:t?{target:t}:{},resourceType:id==='memory.proposal.revise'?'proposal':'memory_entry',resourceId:t};},
  classifyError(error){
   if(error instanceof MemoryProposalValidationError)return new OperationRefusal(422,'memory',error.message);
   if(error instanceof MemoryApplyError||error instanceof MemoryOperatorEditRequiredError||error instanceof MemoryAudienceError)return new OperationRefusal(409,'memory',error.message);
   return undefined;
  },
  ...parts,
 });
 return [
  reg('memory.propose_create',{successStatus:202,userContentCreation:true,target:()=>null,
   async authorize(db,raw,a){const i=raw as Input;if(i.project_id)await assertProjectWriterForMutation(db,a.space_id,i.project_id,user(a));await lockActivePerson(db,a.space_id,user(a));},
   async authorizeResult(db,raw,a){const o=raw as {id:string;space_id:string};if(o.space_id!==a.space_id||!await proposalVisible(db,a,o.id))throw hidden();},
   async execute(db,raw,a){const i=raw as Input,project=i.project_id??null;
    const out=await proposals(db,config).createMemoryProposal(a.space_id,user(a),{...i,operation:'create',scope:project?'project':'user',visibility:project?'space_shared':'private',namespace:i.namespace??'user.default',access_level:i.access_level??'full',sensitivity_level:i.sensitivity_level??'normal',confidence:i.confidence??1,importance:i.importance??0.5,provenance_entries:[]} as never);
    return {id:String(out.id),space_id:a.space_id};}}),
  reg('memory.propose_update',{successStatus:202,target:i=>i.memory_id,
   async authorize(db,raw,a){await lockActivePerson(db,a.space_id,user(a));if(!(await db.query('SELECT id FROM memory_entries WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR SHARE',[(raw as Input).memory_id,a.space_id])).rows.length)throw hidden();},
   async authorizeResult(db,raw,a){const o=raw as {id:string;space_id:string};if(o.space_id!==a.space_id||!await proposalVisible(db,a,o.id))throw hidden();},
   async execute(db,raw,a){const {memory_id:memory,...i}=raw as Input;
    const out=await proposals(db,config).updateMemoryProposal(a.space_id,user(a),memory,{...i,operation:'update',target_memory_id:memory,provenance_entries:[]} as never);
    return {id:String(out.id),space_id:a.space_id};}}),
  reg('memory.archive',{target:i=>i.memory_id,
   async authorize(db,raw,a){await lockActivePerson(db,a.space_id,user(a));const m=(raw as Input).memory_id;if(!(await db.query('SELECT id FROM memory_entries WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR SHARE',[m,a.space_id])).rows.length)throw hidden();},
   async authorizeResult(db,raw,a){const o=raw as {id:string;space_id:string;outcome:string};if(o.space_id!==a.space_id||!(o.outcome==='archived'?await owns(db,a,o.id):await proposalVisible(db,a,o.id)))throw hidden();},
   async execute(db,raw,a){const m=(raw as Input).memory_id;
    // Only the owner archives directly; ownerless and other people's entries are proposals.
    if(await new PgMemoryApplyRepository(db).setOwnStatus(a.space_id,user(a),m,'archived'))return {id:m,space_id:a.space_id,outcome:'archived' as const};
    const out=await proposals(db,config).archiveMemoryProposal(a.space_id,user(a),m,{operation:'archive',target_memory_id:m,provenance_entries:[]} as never);
    return {id:String(out.id),space_id:a.space_id,outcome:'proposed' as const};}}),
  ...(['memory.restore','memory.revert'] as const).map(id=>reg(id,{target:i=>i.memory_id,
   async authorize(db,raw,a){await lockActivePerson(db,a.space_id,user(a));if(!await new PgMemoryApplyRepository(db).authorizeOwnVersion(a.space_id,user(a),(raw as Input).memory_id))throw hidden();},
   async authorizeResult(db,raw,a){const o=raw as {id:string;space_id:string};if(o.space_id!==a.space_id||!await owns(db,a,o.id))throw hidden();},
   async execute(db,raw,a){const m=(raw as Input).memory_id,repo=new PgMemoryApplyRepository(db);
    const row=id==='memory.restore'?await repo.setOwnStatus(a.space_id,user(a),m,'active'):await repo.revertToPreviousVersion(a.space_id,user(a),m);
    if(!row)throw hidden();return {id:String(row.id),space_id:a.space_id};}})),
  reg('memory.proposal.revise',{target:i=>i.proposal_id,
   async authorize(db,_raw,a){await lockActivePerson(db,a.space_id,user(a));},
   async authorizeResult(db,raw,a){const o=raw as {id:string;space_id:string};if(o.space_id!==a.space_id||!await proposalVisible(db,a,o.id))throw hidden();},
   async execute(db,raw,a){const {proposal_id:p,...revision}=raw as Input;
    const out=await proposals(db,config).reviseOperatorEditProposal(a.space_id,user(a),p,revision as never);
    return {id:String(out.id),space_id:a.space_id};}}),
 ];
}
