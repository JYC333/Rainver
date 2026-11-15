import type {OperationActor, OperationInput, RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError, type Queryable} from '../../routeUtils/common.js';
import {hidden, markedRefusal} from '../../systemActions/operations/errors.js';
import type {OperationRegistration} from '../../systemActions/operations/types.js';
import {InformationBriefingService} from './service.js';
import {personalBriefingScope} from './personalScope.js';
import {PERSONAL_BRIEFING_LABEL} from './routes.js';
import {selectExecution} from './execution.js';
import {authorizeVersion} from './authorization.js';
import {PgBriefingRepository} from './repository.js';
import {lockPersonalBriefingRequest} from './requestAuthority.js';

type Input = OperationInput<'briefing.personal.request'>;
export function personalBriefingRequestRegistration(config:ServerConfig, definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration {
  const admit = async (db:Queryable, input:Input, actor:OperationActor) => {
    if(input.space_id!==actor.space_id || !actor.on_behalf_of_user_id) throw hidden();
    return lockPersonalBriefingRequest(db, actor.space_id, actor.on_behalf_of_user_id, input);
  };
  const rechecks=new WeakMap<Queryable,Awaited<ReturnType<typeof lockPersonalBriefingRequest>>>();
  return {
    definition:definitions.get('briefing.personal.request')!,
    successStatus:output=>(output as {created:boolean}).created?201:200,
    runTerminalOwner:{async discover(db,_raw,actor){
      return (await db.query<{id:string}>(`SELECT run_id AS id FROM information_briefings WHERE space_id=$1 AND scope_key=$2 AND run_id IS NOT NULL ORDER BY run_id`,[actor.space_id,`personal:${actor.on_behalf_of_user_id}`])).rows.map(row=>({space_id:actor.space_id,id:row.id}));
    }},
    async resolve(_db,raw,actor){const input=raw as Input;return {authority:`briefing:${actor.space_id}:${actor.on_behalf_of_user_id}`,targets:input,resourceType:'space',resourceId:actor.space_id};},
    async authorize(db,raw,actor){rechecks.set(db,await admit(db,raw as Input,actor));},
    async execute(db,raw,actor){
      const input=raw as Input,user=actor.on_behalf_of_user_id!;
      const adapter=personalBriefingScope(actor.space_id,user);
      let day;
      if(input.date){
        const row=(await db.query<{id:string;period_end_utc:string}>(`SELECT id,period_end_utc::text FROM information_digests WHERE space_id=$1 AND owner_user_id=$2 AND digest_date=$3 AND digest_type='personal' FOR SHARE`,[actor.space_id,user,input.date])).rows[0];
        if(!row)throw new HttpError(422,'That day has no sealed digest',{code:'briefing_day_not_sealed'});
        day={date:input.date,digestId:row.id,cutoff:new Date(row.period_end_utc).toISOString()};
      }
      const result=await new InformationBriefingService(db,config).request(adapter,user,{kind:day?'backfill':'manual',...(day?{day}:{}),execution:rechecks.get(db)!.execution,origin:'manual',label:PERSONAL_BRIEFING_LABEL});
      await rechecks.get(db)?.recheck();
      return result;
    },
    async authorizeResult(db,raw,actor){
      const output=raw as OperationInput<'briefing.personal.request'> & {briefing:{id:string}};
      const user=actor.on_behalf_of_user_id!,repo=new PgBriefingRepository(db),row=await repo.get(actor.space_id,output.briefing.id);
      if(!row || row.scope_key!==`personal:${user}` || row.requested_by_user_id!==user)throw hidden();
      const adapter=personalBriefingScope(actor.space_id,user);
      const release=await admit(db,{space_id:actor.space_id,agent_id:row.agent_id??undefined,runtime_profile_id:row.runtime_profile_id??undefined},actor);
      const execution=await selectExecution(db,actor.space_id,user,{agent_id:row.agent_id??undefined,runtime_profile_id:row.runtime_profile_id??undefined},true);
      const auth=await authorizeVersion(db,adapter,row,await repo.inputs(row.id),{egress:execution,revisions:true});
      if(auth.changed.size || auth.outdated || auth.refs.some(ref=>!auth.allowed.has(ref)))throw hidden();
      await release.recheck();
    },
    classifyError:error=>error instanceof HttpError?markedRefusal(error,'information_digest'):undefined,
  };
}
