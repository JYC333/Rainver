import type {ServerConfig} from '../../config.js';
import {HttpError,optionalObject,optionalString,type Queryable} from '../routeUtils/common.js';
import {PgAgentRepository} from '../agents/repository.js';
import {agentTemplateSystemPromptKey,resolveAgentSystemPrompt} from '../agents/promptRegistry.js';
import {promptProvenanceOf} from '../prompts/provenance.js';
import {parseExecutionConstraints,rejectRetiredAgentDeploymentFields} from '../agents/agentRouteInputs.js';
import {findSpec,templateVersionToOut} from './routes.js';

/** Create one Agent from a published catalog template in an already-resolved placement. */
export async function instantiateAgentTemplate(db:Queryable,config:ServerConfig,placement:{spaceId:string;userId:string;projectId:string|null;visibility:'private'|'space_shared'},templateId:string,body:Record<string,unknown>){
  const template=await findSpec(config.catalogRoot,templateId);
  if(!template||template.visibility==='system_internal')throw new HttpError(404,'Agent template not found');
  const version=templateVersionToOut(template);
  const requestedVersion=optionalString(body.template_version_id);
  if(requestedVersion&&requestedVersion!==version.id&&requestedVersion!==version.version)throw new HttpError(404,'Agent template version not found');
  rejectRetiredAgentDeploymentFields(body);
  const executionConstraints=parseExecutionConstraints(body.execution_constraints??version.execution_constraints);
  const requestSystemPrompt=optionalString(body.system_prompt);
  const resolvedSystemPrompt=requestSystemPrompt?null:await resolveAgentSystemPrompt(db,{spaceId:placement.spaceId,userId:placement.userId,assetKey:agentTemplateSystemPromptKey(template.key)});
  if(!requestSystemPrompt&&!resolvedSystemPrompt)throw new HttpError(500,'Agent template system prompt is not resolvable');
  const systemPrompt=requestSystemPrompt??resolvedSystemPrompt?.system??null;
  if(!systemPrompt)throw new HttpError(500,'Agent template system prompt is not resolvable');
  return new PgAgentRepository(db).create({
    spaceId:placement.spaceId,projectId:placement.projectId,userId:placement.userId,
    name:optionalString(body.name)??template.name,
    description:body.description===undefined?template.description:optionalString(body.description),
    visibility:placement.visibility,systemPrompt,
    promptProvenanceJson:resolvedSystemPrompt?promptProvenanceOf(resolvedSystemPrompt.resolveResult):null,
    contextPolicyJson:optionalObject(body.context_policy_json)??version.context_policy_json,
    memoryPolicyJson:optionalObject(body.memory_policy_json)??version.memory_policy_json,
    riskLevel:executionConstraints.risk_level,maxRunTimeSeconds:executionConstraints.max_run_time_seconds,
    toolPolicyJson:optionalObject(body.tool_policy_json)??version.tool_policy_json,
    outputPolicyJson:optionalObject(body.output_policy_json)??version.output_policy_json,
    scheduleConfigJson:optionalObject(body.schedule_config_json)??version.schedule_defaults_json,
    outputSchemaJson:optionalObject(body.output_schema_json)??version.output_schema_json,
    sourceTemplate:{templateId:template.id,versionId:version.id},
  });
}
