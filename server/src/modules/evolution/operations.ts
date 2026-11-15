import {EVOLUTION_OPERATION_SCHEMAS,type EvolutionOperationId,type EvolutionOperationInput,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationRefusal,hidden} from '../systemActions/operations/errors.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {EvolutionCommandError,EvolutionRepository} from './repository.js';

const IDS=Object.keys(EVOLUTION_OPERATION_SCHEMAS) as EvolutionOperationId[];
const identity=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});

/**
 * Evolution target/signal commands. The executor's locked active-person check
 * is the authority the legacy routes applied (any active member of the Space);
 * each writer then locks its own row. Receipts carry ids only, and a replay is
 * released only while this Space can still read the target or signal.
 */
export function evolutionOperationRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return IDS.map(id=>({
  definition:defs.get(id)!,
  successStatus:id.endsWith('.create')?201:200,
  async resolve(_db,raw,a){
   const i=raw as {target_id?:string;signal_id?:string};
   if(id==='evolution.signal.triage')return {authority:`evolution_signal:${i.signal_id}`,targets:{signal_id:i.signal_id},resourceType:'evolution_signal',resourceId:i.signal_id!};
   if(id==='evolution.target.create')return {authority:`space:${a.space_id}`,targets:{space_id:a.space_id},resourceType:'evolution_target',resourceId:null};
   return {authority:`evolution_target:${i.target_id}`,targets:{target_id:i.target_id},resourceType:id==='evolution.signal.create'?'evolution_signal':'evolution_target',resourceId:id==='evolution.signal.create'?null:i.target_id!};
  },
  // The writers lock and recheck their rows; no other standing is required.
  async authorize(){},
  async authorizeResult(db,raw,a){
   const out=raw as {space_id:string;target_id:string;signal_id?:string};
   if(out.space_id!==a.space_id)throw hidden();
   const repo=new EvolutionRepository(db);
   if(out.signal_id?!(await repo.signalReadable(identity(a),out.signal_id)):!(await repo.targetReadable(identity(a),out.target_id)))throw hidden();
  },
  classifyError(error){
   return error instanceof EvolutionCommandError?new OperationRefusal(error.statusCode,'evolution',error.message):undefined;
  },
  async execute(db,raw,a){
   const repo=new EvolutionRepository(db),who=identity(a);
   switch(id){
    case 'evolution.target.create':return repo.createTarget(who,raw as EvolutionOperationInput<'evolution.target.create'>);
    case 'evolution.target.update':{const {target_id,...patch}=raw as EvolutionOperationInput<'evolution.target.update'>;return repo.updateTarget(who,target_id,patch);}
    case 'evolution.signal.create':{const {target_id,...body}=raw as EvolutionOperationInput<'evolution.signal.create'>;return repo.createSignal(who,target_id,body);}
    case 'evolution.signal.triage':{const {signal_id,...body}=raw as EvolutionOperationInput<'evolution.signal.triage'>;return repo.updateSignalTriage(who,signal_id,body);}
    default:throw hidden();
   }
  },
 }));
}

/** Retained Evolution target/signal URLs; the dismiss URL pins the dismissed triage state. */
export function registerEvolutionOperationRoutes(app:FastifyInstance,config:ServerConfig):void{
 registerOperationAdapters(app,config,[
  {method:'POST',url:'/api/v1/evolution/targets',operation:'evolution.target.create'},
  {method:'PATCH',url:'/api/v1/evolution/targets/:targetId',operation:'evolution.target.update',params:{targetId:'target_id'}},
  {method:'POST',url:'/api/v1/evolution/targets/:targetId/signals',operation:'evolution.signal.create',params:{targetId:'target_id'}},
  {method:'PATCH',url:'/api/v1/evolution/signals/:signalId',operation:'evolution.signal.triage',params:{signalId:'signal_id'}},
  {method:'POST',url:'/api/v1/evolution/signals/:signalId/dismiss',operation:'evolution.signal.triage',params:{signalId:'signal_id'},fixed:{triage_status:'dismissed'}},
 ]);
}
