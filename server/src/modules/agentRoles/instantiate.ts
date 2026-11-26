import type {ServerConfig} from '../../config.js';
import {HttpError,optionalObject,optionalString,type Queryable} from '../routeUtils/common.js';
import {PgAgentRepository} from '../agents/repository.js';
import {agentRoleSystemPromptKey,resolveAgentSystemPrompt} from '../agents/promptRegistry.js';
import {promptProvenanceOf} from '../prompts/provenance.js';
import {parseExecutionConstraints,rejectRetiredAgentDeploymentFields} from '../agents/agentRouteInputs.js';
import {findSpec,roleVersionToOut} from './routes.js';
import {AgentMutationError} from '../agents/agentMutationError.js';
import {pluginOfAgentRole} from '../plugins/agentRoleAdmission.js';

/**
 * Create one Agent from a published Role in an already-resolved placement (the
 * caller has locked the Project and checked its write authority).
 *
 * A plugin's Role is a Project-specific assistant, created only from that
 * plugin's page in a Project: without a Project it is refused, and a Project
 * where the plugin is not enabled for this person or not bound finds no such
 * Role. The binding row is read `FOR SHARE`, so an unbind either commits first
 * or waits for this creation.
 */
export async function instantiateAgentRole(db:Queryable,config:ServerConfig,placement:{spaceId:string;userId:string;projectId:string|null;visibility:'private'|'space_shared'},roleId:string,body:Record<string,unknown>){
  if(pluginOfAgentRole(roleId)&&!placement.projectId)throw new AgentMutationError(422,"This assistant is set up from its plugin's page in a Project");
  const role=await findSpec(config,roleId,{db,spaceId:placement.spaceId,userId:placement.userId,projectId:placement.projectId,lockBinding:true});
  if(!role||role.visibility==='system_internal')throw new HttpError(404,'Agent role not found');
  if(role.pluginId&&!placement.projectId)throw new AgentMutationError(422,"This assistant is set up from its plugin's page in a Project");
  const version=roleVersionToOut(role);
  const requestedVersion=optionalString(body.role_version_id);
  if(requestedVersion&&requestedVersion!==version.id&&requestedVersion!==version.version)throw new HttpError(404,'Agent role version not found');
  rejectRetiredAgentDeploymentFields(body);
  const executionConstraints=parseExecutionConstraints(body.execution_constraints??version.execution_constraints);
  const requestSystemPrompt=optionalString(body.system_prompt);
  // A plugin Role carries its own prompt; a catalog Role resolves its asset.
  const resolvedSystemPrompt=requestSystemPrompt||role.systemPrompt?null:await resolveAgentSystemPrompt(db,{spaceId:placement.spaceId,userId:placement.userId,assetKey:agentRoleSystemPromptKey(role.key)});
  if(!requestSystemPrompt&&!role.systemPrompt&&!resolvedSystemPrompt)throw new HttpError(500,'Agent role system prompt is not resolvable');
  const systemPrompt=requestSystemPrompt??role.systemPrompt??resolvedSystemPrompt?.system??null;
  if(!systemPrompt)throw new HttpError(500,'Agent role system prompt is not resolvable');
  return new PgAgentRepository(db).create({
    spaceId:placement.spaceId,projectId:placement.projectId,userId:placement.userId,
    name:optionalString(body.name)??role.name,
    description:body.description===undefined?role.description:optionalString(body.description),
    visibility:placement.visibility,systemPrompt,
    promptProvenanceJson:resolvedSystemPrompt?promptProvenanceOf(resolvedSystemPrompt.resolveResult):null,
    contextPolicyJson:optionalObject(body.context_policy_json)??version.context_policy_json,
    memoryPolicyJson:optionalObject(body.memory_policy_json)??version.memory_policy_json,
    riskLevel:executionConstraints.risk_level,maxRunTimeSeconds:executionConstraints.max_run_time_seconds,
    toolPolicyJson:optionalObject(body.tool_policy_json)??version.tool_policy_json,
    outputPolicyJson:optionalObject(body.output_policy_json)??version.output_policy_json,
    scheduleConfigJson:optionalObject(body.schedule_config_json)??version.schedule_defaults_json,
    outputSchemaJson:optionalObject(body.output_schema_json)??version.output_schema_json,
    sourceRole:{roleId:role.id,versionId:version.id},
  });
}
