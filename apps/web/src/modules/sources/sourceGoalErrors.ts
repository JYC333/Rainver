/** Present an actionable category without exposing internal diagnostics. */
export function sourceGoalErrorKind(error:unknown){
 const e=error as {status?:number;code?:string;message?:string}|null
 const categories:Record<string,string>={
  source_repair_calibration_unavailable:'calibrationUnavailable',source_authority_revoked:'authorityRevoked',
  source_goal_use_credential_channel:'errorCredentials',use_credential_channel:'errorCredentials',
  source_goal_execution_setup_required:'errorSetup',source_goal_run_in_progress:'errorBusy',
  source_goal_stopped:'errorStopped',source_goal_exploration_budget_exhausted:'errorBudget',
  source_goal_access_required:'errorAccess',source_goal_message_superseded:'errorConflict',
  source_goal_transfer_changed:'errorConflict',source_goal_owns_schedule:'errorConflict',
  source_quota_exhausted:'errorLimited',source_cooldown:'errorLimited',
 }
 const structured=e?.code&&categories[e.code];if(structured)return structured
 // Compatibility with older detail-only responses. Stable codes take precedence.
 const code=e?.message??e?.code??''
 if(/use_credential_channel/.test(code))return 'errorCredentials'
 if(/setup|[Pp]rofile/.test(code))return 'errorSetup'
 if(/run_in_progress|[Rr]un.*progress/.test(code))return 'errorBusy'
 if(/stopped|[Gg]oal stopped/.test(code)||e?.status===404)return 'errorStopped'
 if(/quota|cooldown/.test(code))return 'errorLimited'
 if(/budget|Budget/.test(code)||e?.status===429)return 'errorBudget'
 if(e?.status===403)return 'errorAccess'
 if(e?.status===409)return 'errorConflict'
 return 'errorHint'
}
