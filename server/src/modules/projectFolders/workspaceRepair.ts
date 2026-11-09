import type {ServerConfig} from '../../config.js';
import type {Pool} from '../../db/pool.js';
import type {Queryable} from '../routeUtils/common.js';
import {PgRunRepository,type RunRecord} from '../runs/repository.js';
import type {WorkspaceIntegrationRow} from '../hosts/workspaceIntegrations.js';
import type {ExecutionWorkspaceRow} from './executionWorkspaces.js';
import {WORKSPACE_INTEGRATION_LIMITS as limits} from './workspacePolicy.js';
import {PgHostThreadRepository} from '../hosts/threadRepository.js';
import {admitAgentOriginRun} from '../rooms/quotaGate.js';
import {liveQuotaSource} from '../rooms/subscriptionLogins.js';
import type {RunContractSnapshotInput} from '../runs/contractSnapshot.js';
import {bodyWithheld} from '../access/contentAccessTypes.js';
import {runActor,assertCurrentActor,assertOperationGrant} from '../systemActions/operations/actor.js';
import {authorizedWorkspaceChange} from './workspaceOperations.js';

/** A durable repair request keeps the requesting Run's runtime and lineage.
 * Recheck live authority even if that chat Run has already finished. */
export async function requestedWorkspaceRepairOrigin(db:Queryable,m:WorkspaceIntegrationRow):Promise<RunRecord>{
 const request=(m.detail_json.agent_repair??m.detail_json.verification_request) as {run_id?:unknown;user_id?:unknown};
 if(typeof request.run_id!=='string'||request.user_id!==m.requested_by_user_id)throw new Error('integration_repair_authority_changed');
 const run=await new PgRunRepository(db).getVisibleRun(m.space_id,m.requested_by_user_id,request.run_id);
 if(!run||bodyWithheld(run.effective_access_level))throw new Error('integration_repair_authority_changed');
 const actor=await runActor(db,run);
 if(actor.on_behalf_of_user_id!==m.requested_by_user_id)throw new Error('integration_repair_authority_changed');
 await assertCurrentActor(db,actor,false,true);
 await assertOperationGrant(db,actor,'workspace.integration.retry');
 await authorizedWorkspaceChange(db,m.change_set_id,actor,false,true);
 return run;
}

/** Internal creator; ordinary Run admission, budgets, quota and finalization. */
export async function dispatchWorkspaceRepair(db:Queryable,pool:Pool,_config:ServerConfig,m:WorkspaceIntegrationRow,w:ExecutionWorkspaceRow,origin:RunRecord,files:string[]):Promise<string|null>{
 if((origin.contract_snapshot_json as {workspace_access?:string}|null)?.workspace_access==='read')return null;
 const verificationSetup=m.detail_json.repair_kind==='verification_setup';
 if(!verificationSetup&&Number(m.detail_json.repair_kind==='verification'?m.detail_json.verification_repairs??0:m.detail_json.automatic_repairs??0)>=limits.automaticRepairs)return null;
 if(!origin.agent_id||files.length===0||files.length>500||m.resolution_run_id||limits.automaticRepairs<1)return null;
 const verificationTools=verificationSetup||m.detail_json.repair_kind==='verification'?['workspace.integration.verification.get','workspace.integration.verification.configure']:[];
 const contract=origin.contract_snapshot_json as RunContractSnapshotInput;
 const profile=origin.runtime_profile_id??origin.requested_runtime_profile_id;
 if(!profile)return null;
 const binding=(await db.query<{runtime_key:string;runtime_installation:string}>(`SELECT runtime_key,runtime_installation FROM agent_runtime_profiles WHERE id=$1 AND space_id=$2 AND agent_id=$3 AND enabled=true AND execution_host_id=$4`,[profile,m.space_id,origin.agent_id,w.execution_host_id])).rows[0];
 if(!binding||binding.runtime_key!==origin.runtime_key)return null;
 const thread=await new PgHostThreadRepository(db).create({executionHostId:w.execution_host_id,workspaceLocationId:w.workspace_location_id,runtimeKey:binding.runtime_key,runtimeInstallation:binding.runtime_installation,createdByUserId:m.requested_by_user_id});
 // A later chat can have a wider audience than the frozen source. Explicit
 // repair logs stay requester-private rather than inheriting that audience.
 const explicitRepair=Boolean(m.detail_json.agent_repair||m.detail_json.verification_request);
 const grants=explicitRepair?[]:(await db.query<{grantee_user_id:string}>("SELECT grantee_user_id FROM content_access_grants WHERE space_id=$1 AND resource_type='run' AND resource_id=$2",[m.space_id,origin.id])).rows.map(r=>r.grantee_user_id);
 const prompt=workspaceRepairPrompt(m,origin,files);
 const run=await new PgRunRepository(db).createQueuedRunWithBudgetAdmission({execution_kind:'agent',agent_id:origin.agent_id,space_id:m.space_id,user_id:m.requested_by_user_id,
  mode:'live',run_type:'agent',trigger_origin:'system',session_id:origin.session_id,project_id:w.project_id,project_folder_id:origin.project_folder_id,
  workspace_location_id:w.workspace_location_id,trust_mode:origin.trust_mode==='trusted_host'?'trusted_host':'sandboxed',host_task_thread_id:thread.id,
  parent_run_id:origin.id,root_run_id:origin.root_run_id??origin.id,runtime_profile_id:profile,runtime_profile_selection_source:'explicit',
  prompt,instruction:prompt,scenario_tool_allowance:verificationTools,capabilities_json:verificationTools,visibility:explicitRepair?'private':origin.visibility==='selected_users'?'selected_users':origin.visibility==='space_shared'?'space_shared':'private',
  grantee_user_ids:grants,allow_system_assistant:Boolean(origin.session_id),
  model_override_json:{host_thread:{schema_version:'host_thread.v1',thread_id:thread.id,runtime_session_id:null}},
  contract_snapshot:{source:contract.source??{kind:'direct',id:null},project_id:w.project_id,project_folder_id:origin.project_folder_id,
   budget_sources:contract.budget_sources,acceptance_criteria_json:[],required_outputs_json:[],
   max_attempts:1,max_cost:Math.min(contract.max_cost??limits.repairMaxCost,limits.repairMaxCost),
   max_duration_seconds:Math.min(contract.max_duration_seconds??limits.repairMaxSeconds,limits.repairMaxSeconds),
   workspace_access:'write',execution_workspace_version:1,
   workspace_integration_id:m.id,workspace_integration_attempt_id:m.attempt_id},
 });
 await admitAgentOriginRun(db,{spaceId:m.space_id,runId:run.id,job:{user_id:m.requested_by_user_id,agent_id:origin.agent_id,project_folder_id:origin.project_folder_id,payload:{run_id:run.id}},source:liveQuotaSource(pool)});
 return run.id;
}

export function workspaceRepairPrompt(m:WorkspaceIntegrationRow,origin:RunRecord,files:string[]){
 const verificationSetup=m.detail_json.repair_kind==='verification_setup';
 return [
  verificationSetup?'Prepare and perform verification for this authorized integration in its exact isolated candidate. The user has asked you to finish and merge; verification setup is your work, not a form for the user.':'Resolve the integration conflict in this isolated candidate. Preserve the intent of both sides.',
  ...(verificationSetup?[
   `Inspect this repository's manifests, README, scripts and affected files. Identify suitable tests, type checks or builds. Prepare the candidate's dependencies when needed and run the appropriate checks. Fix observed failures within the allowed change scope. Do not ask the user to type test commands, internal IDs or repeat merge authorization.`,
   `Read workspace.integration.verification.get for integration ${m.id}, then use workspace.integration.verification.configure with its observed config_version and the real test_commands/build_commands you selected. If configuration reports operation_conflict, reread its current config_version and retry the meaningful plan with a new idempotency key; do not wait for another Run or ask the user to enter commands. The system will rerun these commands on the captured candidate before publication. Use direct argv-compatible commands, not shell operators or environment assignments.`,
   `If repository inspection finds no applicable project checks, submit empty command arrays with no_project_checks=true and a concrete note explaining what you inspected. The system will still run exact-candidate integrity checks and report that project tests were unavailable; never invent a passing test or configure true/echo as validation.`,
   'After submitting the verification plan, finish this execution phase. The existing integration worker owns capture, fresh verification and publication; do not call integration retry yourself.',
  ]:[]),
  ...(m.detail_json.human_resolution?[`The requester supplied this content-resolution instruction for the listed conflicts (it does not waive verification or publication checks): ${JSON.stringify(m.detail_json.human_resolution)}`]:[]),
  ...(m.detail_json.agent_repair?[`An authorized Agent requested candidate editing with these instructions, not a human approval: ${JSON.stringify(m.detail_json.agent_repair)}. Use your native file tools in this candidate workspace to implement the requested result. Ask for clarification only if the user's intent cannot be determined.`]:[]),
  `Original request: ${origin.instruction??origin.prompt??''}`,
  `Target: ${m.target_ref}. Frozen source: ${m.source_commit}.`,
  ...(m.detail_json.repair_kind==='verification'?[`Read workspace.integration.verification.get for integration ${m.id} to see its saved verification commands. Rerun the failed checks, fix their actual failures in this candidate and leave the result for system capture. If a check could not launch because its command is invalid, correct the verification plan through workspace.integration.verification.configure with the observed config_version instead of editing unrelated files; the worker will rerun the real corrected commands. Do not ask the user to write test commands.`]:[]),
  verificationSetup?'Select meaningful checks for this actual project; preserve unrelated code.':m.detail_json.checks?`Failed checks: ${JSON.stringify(m.detail_json.checks).slice(0,8000)}`:m.detail_json.agent_repair||m.detail_json.human_resolution?'Resolve the listed conflicts according to the supplied instruction while preserving unrelated work.':'Inspect both sides and the original request. Resolve text, rename, deletion and content conflicts while preserving the requested behavior and unrelated work. Make routine implementation decisions yourself. Ask only when the original intent cannot be determined from the available context.',
  ...(['verification_setup','verification'].includes(String(m.detail_json.repair_kind))?[
   'Prepare dependencies and build prerequisites in this candidate before submitting the plan. Ignored dependency/build files remain available for verification after capture; tracked files are reset to the captured candidate. Verification commands have a fresh temporary HOME, no Agent credentials and no personal package cache. Save repeatable test/build commands using prepared workspace-local dependencies, rather than an offline install that assumes your login HOME/store is available. If setup is needed, use a writable candidate-local cache and the existing allowed tools; do not share credentials or weaken isolation.',
   ...(m.detail_json.verification_diagnostics?[`Actual failed command output (bounded and secret-redacted): ${JSON.stringify(m.detail_json.verification_diagnostics).slice(0,18000)}`]:[]),
  ]:[]),
  'Only edits to these permitted paths are collected:',...files.map(f=>`- ${f}`),
  'Do not commit, reset, stash, switch branches or change Git metadata. Leave resolved files for Host capture and verification.',
 ].join('\n');
}
