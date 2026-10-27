import {HttpError} from '../../routeUtils/common.js';
import {RunBudgetExceededError} from '../../runs/budgetEnforcement.js';
/** Goal-local dispatch state; never persist arbitrary exception text. */
export function goalDispatchErrorCode(error:unknown):string{
 if(error instanceof RunBudgetExceededError)return 'source_goal_exploration_budget_exhausted';
 const e=error as {code?:unknown;statusCode?:number;responseBody?:{error?:unknown};message?:string}|null;
 const code=typeof e?.code==='string'?e.code:typeof e?.responseBody?.error==='string'?e.responseBody.error:e instanceof HttpError?e.message:undefined;
 switch(code){
  case 'source_goal_exploration_budget_exhausted':
  case 'source_goal_execution_setup_required':
  case 'source_goal_stopped':
  case 'source_goal_access_required':return code;
 }
 if(e?.statusCode===403)return 'source_goal_access_required';
 return 'source_goal_dispatch_failed';
}

export function sourceGoalError(status:number,code:string){return new HttpError(status,code,{error:code,message:code});}
