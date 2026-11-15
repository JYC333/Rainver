import {type OperationActor,type RuntimeContextPolicyResolveRequest,type RegisteredSystemActionDefinition,type RuntimeContextOperationInput} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {Pool} from '../../db/pool.js';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {runtimeContextRefusal} from '../runtimeContext/operations.js';
import {RuntimeContextPolicyRepository,assertRuntimeContextPolicyScopeMutable} from './runtimeContextPolicyRepository.js';

const ID='runtime_context.policy.write';
const who=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});


/**
 * The next immutable Runtime Context Policy version. The repository keeps its
 * scope authority, stale-base, no-widening and preference rules and its own
 * `runtime_context_policy.change` decision record, now inside the operation
 * transaction. A replay is released only while the person may still change that scope.
 */
export function runtimeContextPolicyOperationRegistration(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {
  definition:defs.get(ID)!,
  async resolve(_db,raw,a){
   const i=raw as RuntimeContextOperationInput<typeof ID>;
   return {authority:`runtime_context_policy:${a.space_id}:${i.scope_type}:${i.scope_id}`,targets:{scope_type:i.scope_type,scope_id:i.scope_id},resourceType:'runtime_context_policy',resourceId:i.scope_id};
  },
  async authorize(){/* The repository checks and locks the scope authority first. */},
  async authorizeResult(db,raw,a){
   const out=raw as {space_id:string;scope_type:RuntimeContextOperationInput<typeof ID>['scope_type'];scope_id:string};
   if(out.space_id!==a.space_id)throw hidden();
   try{await assertRuntimeContextPolicyScopeMutable(db,who(a),out.scope_type,out.scope_id);}catch{throw hidden();}
  },
  classifyError:error=>runtimeContextRefusal(error,'runtime_context'),
  async execute(db,raw,a){
   const {scope_type,scope_id,...request}=raw as RuntimeContextOperationInput<typeof ID>;
   const version=await new RuntimeContextPolicyRepository(db as Pool).write(who(a),scope_type,scope_id,request);
   return {space_id:a.space_id,scope_type,scope_id,version_id:version.id};
  },
 };
}

/** The effective merged policy over the scopes the person can read (Project, Folder, Agent, own preferences); read-only. */
export function runtimeContextPolicyResolveRegistration(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {
  definition:defs.get('runtime_context.policy.resolve')!,readKind:'metadata',
  async resolve(_db,_raw,a){return {authority:`runtime_context_policy:${a.space_id}`,targets:{},resourceType:'runtime_context_policy',resourceId:null};},
  // Every contributing scope is checked readable by the repository's resolution.
  async authorize(){},
  async execute(db,raw,a){return new RuntimeContextPolicyRepository(db as Pool).resolve(who(a),raw as RuntimeContextPolicyResolveRequest);},
 };
}

export function registerRuntimeContextPolicyOperationRoutes(app:FastifyInstance,config:ServerConfig):void{
 registerOperationAdapters(app,config,[
  {method:'POST',url:'/api/v1/runtime-context/policies/resolve',operation:'runtime_context.policy.resolve'},
  {method:'PUT',url:'/api/v1/runtime-context/policies/:scopeType/:scopeId',operation:ID,params:{scopeType:'scope_type',scopeId:'scope_id'}},
 ]);
}
