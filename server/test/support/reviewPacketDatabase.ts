import {beforeEach} from 'vitest';
import {useTestDatabase} from './testDatabase.js';
import {resetTables} from './resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './domainSeeds.js';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {seedArxivSourceChain} from './researchSeeds.js';
import type {Queryable,QueryResult} from '../../src/modules/routeUtils/common.js';

/** Real proposal/artifact persistence with SQL observation, never a fake transaction.
 * `failOn` injects one named statement failure at the driver boundary so a test can
 * assert that the real transaction rolled back; every other statement reaches PostgreSQL. */
export function useReviewPacketDatabase(file:string){
 const db=useTestDatabase(file);
 beforeEach(async()=>{
  if(!db.available)return;
  await resetTables(db.pool,['spaces','users'],{cascade:true});
  await seedSpaceOwnerProject(db.pool,{space:'space-1',owner:'user-1',project:'project-1'});
  await seedSpaceMember(db.pool,{space:'space-1',user:'admin-1',role:'admin'});
 });
 return {
  database:db,
  observe(options:{failOn?:{pattern:RegExp;message:string}}={}):Queryable&{calls:Array<{sql:string;params:readonly unknown[]}>}{
   const calls:Array<{sql:string;params:readonly unknown[]}>=[];
   const inject=(sql:string)=>{if(options.failOn?.pattern.test(sql.replace(/\s+/g,' ').trim()))throw new Error(options.failOn.message);};
   return {
    calls,
    query:async<Row>(sql:string,params:readonly unknown[]=[])=>{calls.push({sql,params});inject(sql);return (await db.pool.query(sql,[...params])) as unknown as QueryResult<Row>;},
    ...{connect:async()=>{
     const client=await db.pool.connect();
     return {query:async(sql:string,params:readonly unknown[]=[])=>{calls.push({sql,params});inject(sql);return client.query(sql,[...params]);},release:()=>client.release()};
    }},
   };
  },
 };
}

/** A Space Source connection with the given governance JSON. Connector/provider keys are
 * database-global and survive the Space reset, so the first call seeds that chain and later
 * calls attach another connection to it. */
export async function seedSourceConnection(pool:Pool,input:{id:string;space:string;owner:string;consent?:unknown;policy?:unknown}):Promise<void>{
 const mapping=(await pool.query<{id:string}>("SELECT pc.id FROM source_provider_connectors pc JOIN source_connectors c ON c.id=pc.connector_id WHERE c.connector_key='arxiv_api' LIMIT 1")).rows[0]?.id;
 if(mapping){
  await pool.query(`INSERT INTO source_connections(id,space_id,provider_connector_id,owner_user_id,name,status,capture_policy,trust_level,consent_json,policy_json,config_json,created_at,updated_at)
   VALUES($1,$2,$3,$4,'arXiv','active','reference_only','normal','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,now(),now())`,[input.id,input.space,mapping,input.owner]);
 }else await seedArxivSourceChain(pool,{connector:randomUUID(),connection:input.id,channel:randomUUID(),space:input.space,owner:input.owner,now:new Date().toISOString()});
 if(input.consent!==undefined)await pool.query('UPDATE source_connections SET consent_json=$2::jsonb WHERE id=$1',[input.id,JSON.stringify(input.consent)]);
 if(input.policy!==undefined)await pool.query('UPDATE source_connections SET policy_json=$2::jsonb WHERE id=$1',[input.id,JSON.stringify(input.policy)]);
}
