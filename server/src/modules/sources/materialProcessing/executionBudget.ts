import {explicitRunTimeLimit} from '../../runs/runTimeLimit.js';
/** Saved-item preparation requests ten minutes. Following discovery supplies no
 * default duration; only an explicit canonical owner-set budget expires it. */
export const MATERIAL_RUN_SECONDS=600;
export function materialRunExpired(run:{started_at:string|Date|null;contract_snapshot_json?:unknown},now=Date.now()){
 const limit=explicitRunTimeLimit(run.contract_snapshot_json,null);
 return !!run.started_at&&!!limit&&new Date(run.started_at).getTime()+limit.ms<=now;
}
