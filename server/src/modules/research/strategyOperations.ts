import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError} from '../routeUtils/common.js';
import {markedRefusal,hidden} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {ResearchStrategyActivationService} from './discovery/strategyActivationService.js';
import {ResearchMonitorMaterializer} from './discovery/monitorMaterializer.js';
import {admitStrategy,discoverStrategyAdmission,strategyPerson} from './discovery/strategyAdmission.js';
type Input=OperationInput<'research.strategy.activate'|'research.strategy.materialize'>;
export function researchStrategyRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (['research.strategy.activate','research.strategy.materialize'] as const).map(id=>({
  definition:definitions.get(id)!,domainAuthorizationFirst:true,successStatus:id==='research.strategy.materialize'?201:200,
  async resolve(db,raw,a){const i=raw as Input,c=await discoverStrategyAdmission(db,a.space_id,i.strategy_id,strategyPerson(a).userId);return {authority:`project:${c.strategy.project_id}`,targets:{strategy_id:i.strategy_id,project_id:c.strategy.project_id},resourceType:'source_channel',resourceId:i.strategy_id};},
  async authorize(db,raw,a){const i=raw as Input;await admitStrategy(db,config,a,i.strategy_id,[],Object.values('credentials' in i?i.credentials??{}:{}));},
  async authorizeResult(db,raw,a:OperationActor){const out=raw as {strategy_id?:string;query_strategy_id?:string;channel_ids?:string[];sources?:{source_channel_id:string}[]};const strategy=out.strategy_id??out.query_strategy_id;if(!strategy)throw hidden();await admitStrategy(db,config,a,strategy,out.channel_ids??out.sources?.map(r=>r.source_channel_id)??[]);},
  async execute(db,raw,a){const i=raw as Input,identity=strategyPerson(a);if(id==='research.strategy.activate')return new ResearchStrategyActivationService(db).activate({identity,strategyId:i.strategy_id,reason:(i as OperationInput<'research.strategy.activate'>).reason});const body=i as OperationInput<'research.strategy.materialize'>;return new ResearchMonitorMaterializer(db,config).materialize(identity,i.strategy_id,{providerKeys:body.provider_keys,credentials:body.credentials});},
  classifyError(error){return error instanceof HttpError?markedRefusal(error,'research'):undefined;},
 }));
}
