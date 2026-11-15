import type {SourceGoalService} from '../../src/modules/sources/goals/service.js';
import {publicGoalContribution} from '../../src/modules/sources/goals/privacy.js';
import type {SpaceUserIdentity} from '../../src/modules/routeUtils/common.js';
/**
 * The retained synchronous preview, for domain tests: the command's admission
 * followed in-process by the `goal_preview` Job body, returning the stored
 * preview as the goal reader publishes it.
 */
export async function previewNow(service:SourceGoalService,identity:SpaceUserIdentity,goalId:string,versionId:string,signal:AbortSignal){
 const id=await service.admitPreview(service.db,identity,goalId,versionId);
 await service.runPreview(identity,goalId,id,signal);
 const row=(await service.db.query('SELECT result_json FROM source_goal_previews WHERE id=$1',[id])).rows[0];
 const result=row.result_json as {contributions?:Record<string,unknown>[]}&Record<string,unknown>;
 return {id,...result,contributions:(result.contributions??[]).map(c=>publicGoalContribution(c as never))} as unknown as {id:string;complete:boolean;contributions:Array<Record<string,unknown>&{source_connection_id:string;status:string;output?:{items:Array<Record<string,unknown>>}}>}&Record<string,unknown>;
}
