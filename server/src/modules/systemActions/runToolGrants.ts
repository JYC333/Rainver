import type {ServerConfig} from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { operationPluginEnabled } from "../plugins/operationEnablement.js";
import { admitPluginDataTools, type RunScenario } from "../plugins/dataAccess.js";
import { coreDataTool } from "../plugins/coreDataTools.js";
import type { RunToolGrant } from "@rainver/protocol";
import { loadSystemActionRegistry } from "./registry.js";

export async function buildRunToolGrants(
  capabilities: readonly unknown[],
  toolPermissions: unknown,
  context?: {db:Queryable;spaceId:string;userId:string|null;config?:ServerConfig;scenario?:RunScenario|(()=>Promise<RunScenario>);sessionId?:string|null;
  /** The Run being rebound, once it exists. */
  runId?:string|null},
): Promise<RunToolGrant[]> {
  const declared = new Set(
    capabilities.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const allowed = new Set(allowedTools(toolPermissions));
  const registry = await loadSystemActionRegistry(context?.config);
  const enabled=new Set<string>();
  // Each candidate plugin's enablement is read once per build, never cached across builds.
  const pluginEnabled=new Map<string,Promise<boolean>>();
  const enabledNow=(pluginId:string)=>{if(!pluginEnabled.has(pluginId))pluginEnabled.set(pluginId,operationPluginEnabled(context!.db,pluginId,context!.spaceId,context!.userId!,context!.config));return pluginEnabled.get(pluginId)!;};
  if(context?.userId)for(const d of registry.values())if(d.id.startsWith('plugin.')&&declared.has(d.id)&&allowed.has(d.id)&&d.allowed_actor_types.includes('agent')&&await enabledNow(d.id.split('.')[1]!))enabled.add(d.id);
  // A core sensitive tool (ADR 0032) is a candidate only where its owning module makes it available.
  if(context?.userId)for(const d of registry.values()){const core=coreDataTool(d.id);if(core&&declared.has(d.id)&&allowed.has(d.id)&&d.allowed_actor_types.includes('agent')&&await core.available(context.db,{spaceId:context.spaceId,userId:context.userId,sessionId:context.sessionId??null,runId:context.runId??null}))enabled.add(d.id);}
  // Personal/sensitive tools are absent (names included) unless scenario and data-side consent admit them (ADR 0030).
  const admitted=context?await admitPluginDataTools(context.db,context.config,[...enabled],{spaceId:context.spaceId,scenario:context.scenario}):new Set<string>();
  for(const id of [...enabled])if(!admitted.has(id))enabled.delete(id);
  // A member's delegated read (ADR 0035 §4) exists only where the owner delegated a mailbox for this conversation's Project.
  if(context?.userId&&declared.has('source.gmail.delegated.read')&&allowed.has('source.gmail.delegated.read')){const {gmailDelegatedReadAvailable}=await import('../sources/gmail/gmailDelegatedReadOperation.js');if(await gmailDelegatedReadAvailable(context.db,{spaceId:context.spaceId,userId:context.userId,sessionId:context.sessionId??null}))enabled.add('source.gmail.delegated.read');}
  const grants: RunToolGrant[] = [...registry.values()]
    .filter(
      (definition) =>
        (!(definition.id.startsWith("plugin.")||coreDataTool(definition.id)||definition.id==="source.gmail.delegated.read")||enabled.has(definition.id)) &&
        definition.id !== "authorization.request" &&
        declared.has(definition.id) &&
        allowed.has(definition.id) &&
        definition.visibility.has("agent_tool") &&
        definition.allowed_actor_types.includes("agent"),
    )
    .map((definition) => ({
      action_id: definition.id,
      capability_id: null,
      approval_behavior: "none" as const,
      side_effecting: definition.side_effects !== "none",
    }));
  const requestDefinition = registry.get("authorization.request");
  return grants.length > 0 && requestDefinition
    ? [{
        action_id: requestDefinition.id,
        capability_id: null,
        approval_behavior: "none" as const,
        side_effecting: true,
      }, ...grants]
    : grants;
}

function allowedTools(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const tools = (value as Record<string, unknown>).allowed_tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}
