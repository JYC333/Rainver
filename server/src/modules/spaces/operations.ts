import {SPACE_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition,type SpaceOperationId} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationRefusal,hidden} from '../systemActions/operations/errors.js';
import {keyedSecretFingerprint} from '../systemCommands/operationSupport.js';
import {isSpaceOwnerOrAdmin} from '../access/roles.js';
import type {Queryable} from '../routeUtils/common.js';
import {SpaceCommandError,acceptInvitation,createInvitation,createSpace,lockSpaceRole,updateContentEgress,updateRetrievalSettings,updateSnapshotDefaults} from './writers.js';

type Input=Record<string,any>;
const SPACE_IDS=Object.keys(SPACE_OPERATION_SCHEMAS).filter(id=>id.startsWith('space.')) as SpaceOperationId[];
/** Commands bound to the Space the URL names, which the adapter made the actor's Space. */
const SPACE_BOUND=new Set<SpaceOperationId>(['space.invitation.create','space.snapshot_defaults.update','space.content_egress.update','space.retrieval_settings.update']);
const person=(a:OperationActor)=>a.on_behalf_of_user_id!;

/** Live owner/admin standing in the actor's Space, held until commit; anyone else sees nothing. */
async function assertManager(db:Queryable,a:OperationActor):Promise<void>{
  let role:string;
  try{role=await lockSpaceRole(db,a.space_id,person(a));}catch{throw hidden();}
  if(!isSpaceOwnerOrAdmin(role))throw hidden();
}

export function spaceOperationRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  return SPACE_IDS.map(id=>({
    definition:defs.get(id)!,
    successStatus:id==='space.create'||id==='space.invitation.create'?201:200,
    ...(id.startsWith('space.invitation.')?{fingerprintInput:(input:unknown)=>keyedSecretFingerprint(config,input,['token'])}:{}),
    async resolve(_db,raw,a){
      const i=raw as Input;
      if(SPACE_BOUND.has(id)){
        if(i.space_id!==a.space_id)throw hidden();
        return {authority:`space:${a.space_id}`,targets:{space_id:a.space_id},resourceType:'space',resourceId:a.space_id};
      }
      // Creation and invitation claim act for the person; neither names an existing Space they hold.
      return {authority:`user:${person(a)}`,targets:{user_id:person(a)},resourceType:'space',resourceId:null};
    },
    async authorize(db,_raw,a){
      // Invitation creation keeps its own role-ladder and personal-Space refusals in the writer; every bound command needs a live manager.
      if(SPACE_BOUND.has(id))await assertManager(db,a);
    },
    async authorizeResult(db,raw,a){
      const out=raw as {space_id:string|null};
      if(SPACE_BOUND.has(id)){if(out.space_id!==a.space_id)throw hidden();await assertManager(db,a);return;}
      // A replayed creation or claim is released only while the person is still an active member there.
      if(out.space_id){try{await lockSpaceRole(db,out.space_id,person(a));}catch{throw hidden();}}
    },
    classifyError(error){
      if(error instanceof SpaceCommandError&&(error.statusCode===409||error.statusCode===422))return new OperationRefusal(error.statusCode,'spaces',error.message);
      if(error instanceof Error&&error.name==='SpaceRetrievalSettingsError'&&(error as Error&{statusCode?:number}).statusCode===422)return new OperationRefusal(422,'spaces',error.message);
      return undefined;
    },
    async execute(db,raw,a){
      const i=raw as Input,user=person(a);
      switch(id){
        case 'space.create':return createSpace(db,user,{name:i.name,type:i.type,oversight_mode:i.oversight_mode});
        case 'space.invitation.create':return createInvitation(db,user,a.space_id,{email:i.email,role:i.role,token:i.token});
        case 'space.invitation.accept':return acceptInvitation(db,user,i.token);
        case 'space.snapshot_defaults.update':return updateSnapshotDefaults(db,user,a.space_id,{snapshot_retention_days_default:i.snapshot_retention_days_default,snapshot_max_count_default:i.snapshot_max_count_default});
        case 'space.content_egress.update':return updateContentEgress(db,user,a.space_id,i.member_copy_out_enabled);
        case 'space.retrieval_settings.update':{const {space_id:_s,...patch}=i;return {space_id:(await updateRetrievalSettings(db,user,a.space_id,patch)).space_id};}
        default:throw hidden();
      }
    },
  }));
}
