import {sourceItemFullContentReadClause} from '../sources/sourceItemAccess.js';
import type {OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {lockReadingMutations} from '../sources/readingMutationAccess.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {SourceAnnotationService} from './service.js';
type Input=OperationInput<'reading.annotation.retry'>;
export function annotationRetryRegistration(config:ServerConfig,defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 const prepared=new WeakMap<Queryable,Awaited<ReturnType<SourceAnnotationService['prepareManualRetry']>>>();
 return {
  definition:defs.get('reading.annotation.retry')!,domainAuthorizationFirst:true,
  async resolve(_db,raw,a){const i=raw as Input;return {authority:`annotation:${a.space_id}:${a.on_behalf_of_user_id}`,targets:{...i,user_id:a.on_behalf_of_user_id},resourceType:'space',resourceId:a.space_id};},
  async authorize(db,raw,a){if((raw as Input).space_id!==a.space_id)throw hidden();const i=raw as Input;prepared.set(db,await new SourceAnnotationService(db,config).prepareManualRetry(a.space_id,a.on_behalf_of_user_id!,{episodeId:i.episode_id,connectionId:i.connection_id}));},
  async authorizeResult(db,raw,a){
   const out=raw as Input&{user_id:string;item_ids:string[]};if(out.space_id!==a.space_id||out.user_id!==a.on_behalf_of_user_id)throw hidden();
   const p={spaceId:a.space_id,userId:a.on_behalf_of_user_id!};await lockReadingMutations(db,p,out.item_ids);
   for(const id of out.item_ids){if(await contentDecisionFromDb(db,p,'source_item',id,{includeOversight:false})!=='full')throw hidden();const row=(await db.query(`SELECT i.id FROM source_items i LEFT JOIN source_connections c ON c.space_id=i.space_id AND c.id=i.connection_id WHERE i.space_id=$1 AND i.id=$2 AND i.deleted_at IS NULL AND COALESCE(c.owner_user_id,i.owner_user_id)=$3 AND (i.connection_id IS NULL OR (c.id IS NOT NULL AND c.deleted_at IS NULL AND c.status<>'archived')) AND ${sourceItemFullContentReadClause('i','$3')}`,[a.space_id,id,p.userId])).rows[0];if(!row)throw hidden();}
  },
  async execute(db,raw,a){const i=raw as Input;return {...i,user_id:a.on_behalf_of_user_id!,...await new SourceAnnotationService(db,config).manualRetry(a.space_id,a.on_behalf_of_user_id!,{episodeId:i.episode_id,connectionId:i.connection_id},prepared.get(db))};},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'reading'):undefined,
 };
}
