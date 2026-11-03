import {composeProjectReading} from '../composition/service.js';
import type {JobHandlerRegistry} from '../../jobs/handlerRegistry.js';
import type {ServerConfig} from '../../../config.js';
import {getDbPool} from '../../../db/pool.js';
import {settleThemeRound} from './service.js';
import {registerBriefingSettlement} from '../briefing/settlement.js';
export function registerProjectReadingJobs(registry:JobHandlerRegistry,config:ServerConfig){
 registerBriefingSettlement();
 registry.register('project_reading_compose',async job=>{if(typeof job.payload.round_id!=='string')throw new Error('Analysis round required for composition');return {composition_id:await composeProjectReading(getDbPool(config.databaseUrl!),job.space_id,String(job.payload.project_id),job.payload.round_id)};});
 registry.register('project_reading_theme',async job=>{await settleThemeRound(getDbPool(config.databaseUrl!),config,String(job.payload.round_id));return {status:'checked'};});
}
