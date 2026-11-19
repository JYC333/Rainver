import type { OperationResponse } from '@rainver/protocol';
import type {SystemActionDispatchResult} from '../toolResult.js';
export class OperationToolResponse {
  constructor(readonly httpStatus: number, readonly body: Record<string, unknown>, readonly summary:Record<string,unknown>={}) {}
}
/** Domain output stays transport-neutral until this adapter. */
export function formatOperationForAgent(result:OperationResponse,tool:string):SystemActionDispatchResult {
  const failed='error' in result.body;
  // A missing approval mapping is a policy boundary, not a transient transport fault.
  let body='error' in result.body && result.body.error.code==='operation_approval_mapping_unavailable'
    && (['task.create','board.configure','task.move_to_column','task.set_status','task.delete','task.complete','research.start_acquisition','research.adopt_result'].includes(tool))
    ? {...result.body,error:{...result.body.error,retryable:false,
      message:'This Run source requires human initiation or approval for this change. The approval path has not been migrated. Do not retry automatically or change the Run origin; ask a person to initiate the change.'}}
    : result.body;
  if('error' in body && body.error.code==='operation_invalid_input'
    && body.error.metadata.code==='completion_requirements_unmet'
    && ['task.complete','task.set_status','task.move_to_column','board.configure'].includes(tool)){
    body={...body,error:{...body.error,
      message:'Task completion requirements are not met. required_outputs are Artifact type labels, not a report or a workspace edit. Leave the required file in the output directory and declare it with artifact.submit, or use task.request_review for a person to decide. The safe missing and unacknowledged lists identify the unmet requirements.'}};
  }
  if('error' in body && body.error.code==='operation_conflict' && body.error.domain==='workspaces' && Object.keys(body.error.metadata).length===0){
    body={...body,error:{...body.error,message:'The visible workspace state does not allow this request. Read workspace.change.get for current revision, progress and action applicability. Wait for pending work; preserve files and do not automatically replay a write.',metadata:{recovery_action:'workspace.change.get'}}};
  }
  if('error' in body && body.error.code==='operation_not_granted'){
    body={...body,error:{...body.error,message:'This action is not available to this Run. Read rainver list; do not guess another action or replay a write.'}};
  }
  if('error' in body && body.error.code==='operation_consent_required'){
    body={...body,error:{...body.error,retryable:false,message:"This data needs its owner's consent for this Run. Call authorization.request with this policy_decision_record_id and a one-line reason, then stop; do not retry until it is approved."}};
  }
  if('error' in body && body.error.code==='operation_not_found'){
    body={...body,error:{...body.error,message:'Object unavailable. Check only the current Run action list and objects returned by authorized reads. Do not guess names or ids, replay writes, or promise an unverified repair.'}};
  }
  return {
    modelResult:{ok:!failed,tool,...body,http_status:result.http_status,replayed:result.replayed,policy_decision_record_id:result.policy_decision_record_id},
    summary:{tool_name:tool,ok:!failed,http_status:result.http_status,replayed:result.replayed,policy_decision_record_id:result.policy_decision_record_id,...('error' in body?{error_code:body.error.code,error_message:body.error.message}:{status:body.status})},
  };
}
export function operationToolResponse(result: OperationResponse, tool: string): OperationToolResponse {
  const formatted=formatOperationForAgent(result,tool);
  return new OperationToolResponse(result.http_status,formatted.modelResult as Record<string,unknown>,formatted.summary);
}
