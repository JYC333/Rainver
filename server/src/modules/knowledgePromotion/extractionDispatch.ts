import type {ServerConfig} from '../../config.js';
import {objectValue} from '../routeUtils/common.js';
import {getDbPool} from '../../db/pool.js';
import {KnowledgeExtractionService} from './extractionService.js';
export async function assertKnowledgeExtractionDispatch(config:ServerConfig,run:Parameters<KnowledgeExtractionService['assertDispatch']>[0]){
 if(objectValue(objectValue(run.contract_snapshot_json).workflow_input_json).kind!=='knowledge_candidate_extraction')return;
 await new KnowledgeExtractionService(getDbPool(config.databaseUrl!)).assertDispatch(run);
}
