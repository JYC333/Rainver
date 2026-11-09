import {WorkspaceIntegrationNoticeSchema,type WorkspaceIntegrationNotice} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {PgSessionRepository} from '../sessions/repository.js';
import {PgRunRepository} from '../runs/repository.js';
import {bodyWithheld} from '../access/contentAccessTypes.js';

const PUBLIC_REASONS=new Set(['integration_agent_verification_failed','integration_agent_verification_unavailable','integration_agent_verification_incomplete','integration_not_yet_adopted','verification_unconfigured','integration_verification_failed','workspace_verification_layout_missing',
 'integration_requires_semantic_decision','integration_repair_failed','integration_repair_incomplete','integration_repair_unavailable',
 'integration_resolution_scope_changed','integration_resolution_unavailable','workspace_egress_review_required','workspace_checkpoint_blocked',
 'integration_waiting_local_changes','integration_target_keeps_moving','integration_retry_exhausted']);

/** Joins the caller transaction. The same event key also repairs a missing
 * terminal notice on Job replay without reposting an already delivered result. */
export async function postWorkspaceIntegrationNotice(db:Queryable,id:string,attemptId:string,outcome:WorkspaceIntegrationNotice['outcome']){
 const row=(await db.query<{space_id:string;requested_by_user_id:string;originating_run_id:string;session_id:string|null;
  change_set_id:string;target_ref:string;task_commit:string|null;detail_json:Record<string,unknown>;repair_status:string|null}>(`SELECT m.space_id,m.requested_by_user_id,c.originating_run_id,r.session_id,
   m.change_set_id,m.target_ref,m.task_commit,m.detail_json,repair.status AS repair_status
  FROM task_merges m JOIN workspace_change_sets c ON c.id=m.change_set_id AND c.space_id=m.space_id
  JOIN runs r ON r.id=c.originating_run_id AND r.space_id=m.space_id
  LEFT JOIN runs repair ON repair.id=COALESCE(m.resolution_run_id,m.detail_json->'completed_repair_runs'->>-1) AND repair.space_id=m.space_id
  WHERE m.id=$1 AND m.attempt_id=$2`,[id,attemptId])).rows[0];
 if(!row?.session_id||row.detail_json.reply_owner_run_id)return;
 const visible=await new PgRunRepository(db).getVisibleRun(row.space_id,row.requested_by_user_id,row.originating_run_id);
 if(!visible||bodyWithheld(visible.effective_access_level))return;
 const error=row.detail_json.error,reason=typeof error==='string'&&PUBLIC_REASONS.has(error)?error:null;
 const verification=row.detail_json.verification as {level?:string;status?:string;checks?:Array<{status?:string}>}|undefined;
 const rawChecks=verification?.checks??row.detail_json.checks;
 const checks=Array.isArray(rawChecks)?rawChecks as Array<{status?:string}>:[];
 const repair=row.repair_status;
 const details=WorkspaceIntegrationNoticeSchema.parse({schema_version:'workspace_integration_notice.v1',run_id:row.originating_run_id,
  integration_id:id,attempt_id:attemptId,change_set_id:row.change_set_id,target_ref:row.target_ref,outcome,reason,
  repair_status:!repair?'not_needed':['queued','running','succeeded','waiting_for_review'].includes(repair)?repair:['failed','degraded','cancelled','orphaned'].includes(repair)?'failed':'unknown',
  ...(verification?.level==='basic'?{verification_level:'basic' as const}:{}),
  verification_status:outcome==='integrated'||verification?.status==='passed'?'passed':reason==='verification_unconfigured'?'unconfigured':reason==='integration_verification_failed'?'failed':'not_run',
  checks_passed:checks.filter(c=>c?.status==='passed').length,checks_failed:checks.filter(c=>c?.status==='failed'||c?.status==='error').length,
  candidate_ready:Boolean(row.task_commit),preserved:outcome!=='integrated'&&outcome!=='no_changes',
 });
 const target=row.target_ref.replace(/^refs\/heads\//,'');
 const result=outcome==='integrated'?`Changes integrated into ${target}. Verification passed.`
  :outcome==='no_changes'?`No new changes need integration into ${target}.`
  :outcome==='repair_started'?`Agent preparation or repair queued. Changes have not been integrated into ${target}.`
  :`Changes have not been integrated into ${target}. ${details.candidate_ready?'An isolated candidate was built.':'The saved source changes remain preserved.'}`;
 const explanation=reason==='verification_unconfigured'?'The Agent will inspect the project and prepare verification before retrying integration; no manual command configuration is required.'
  :reason==='integration_verification_failed'?'Candidate verification failed. Inspect and fix the failed checks before retrying.'
  :outcome==='repair_started'?'You can continue this conversation; the integration result will be posted here.'
  :outcome==='integrated'||outcome==='no_changes'?'':'Integration stopped before publication. Review the integration details before retrying.';
 await new PgSessionRepository(db).addExecutionSystemEvent(row.space_id,row.requested_by_user_id,row.session_id,{
  event:'workspace_integration',eventKey:`${id}:${attemptId}:${outcome}`,content:[result,details.repair_status==='succeeded'?'The integration Agent Run finished successfully.':'',explanation].filter(Boolean).join('\n'),details,
 });
}
