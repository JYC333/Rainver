import type {Pool} from 'pg';
import type {ServerConfig} from '../../src/config.js';
import {JobHandlerRegistry} from '../../src/modules/jobs/handlerRegistry.js';
import {registerDigestBackfillJobs} from '../../src/modules/informationDigest/backfillOperations.js';
import {claimJobForHandler} from './jobClaim.js';
/** Drive the canonical digest handler under a real persisted queue claim. */
export async function executeDigestBackfill(pool:Pool,config:ServerConfig,jobId:string){
 const registry=new JobHandlerRegistry();registerDigestBackfillJobs(registry,config);
 return registry.dispatch(await claimJobForHandler(pool,jobId)) as Promise<{digest_id:string;created:boolean}>;
}
