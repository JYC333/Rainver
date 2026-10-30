import type {ServerConfig} from '../../../config.js';
import type {RunRecord} from '../../runs/repository.js';
import {getDbPool} from '../../../db/pool.js';
import type {Queryable} from '../../routeUtils/common.js';
import {assertNativeCollectionDispatch} from '../goals/nativeDispatch.js';
import {assertItemProcessingDispatch,materialItemContext} from './items.js';
/** All material Runs use the same dispatch boundary; adapters remain ordinary. */
export async function assertMaterialProcessingDispatch(config:ServerConfig,run:RunRecord,db?:Queryable){
 if(materialItemContext(run))return (await assertItemProcessingDispatch(db??getDbPool(config.databaseUrl!),config,run))?.source??undefined;
 return assertNativeCollectionDispatch(config,run,db);
}
