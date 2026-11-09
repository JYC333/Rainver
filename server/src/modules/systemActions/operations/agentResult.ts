import type { OperationResponse } from '@rainver/protocol';
import type {SystemActionDispatchResult} from '../toolResult.js';
export class OperationToolResponse {
  constructor(readonly httpStatus: number, readonly body: Record<string, unknown>, readonly summary:Record<string,unknown>={}) {}
}
/** Domain output stays transport-neutral until this adapter. */
export function formatOperationForAgent(result:OperationResponse,tool:string):SystemActionDispatchResult {
  const failed='error' in result.body;
  return {
    modelResult:{ok:!failed,tool,...result.body,http_status:result.http_status,replayed:result.replayed,policy_decision_record_id:result.policy_decision_record_id},
    summary:{tool_name:tool,ok:!failed,http_status:result.http_status,replayed:result.replayed,policy_decision_record_id:result.policy_decision_record_id,...('error' in result.body?{error_code:result.body.error.code,error_message:result.body.error.message}:{status:result.body.status})},
  };
}
export function operationToolResponse(result: OperationResponse, tool: string): OperationToolResponse {
  const formatted=formatOperationForAgent(result,tool);
  return new OperationToolResponse(result.http_status,formatted.modelResult as Record<string,unknown>,formatted.summary);
}
