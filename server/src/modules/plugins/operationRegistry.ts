import { operationPackageIdentity } from './packageIdentity.js';
import { pluginFrontendEntries, PluginOperationManifestSchema, type RainverPlugin, type OfficialPluginDescriptor, type PolicyActionDefinition, type RegisteredSystemActionDefinition as SystemActionDefinition, type PluginOperationId, type PluginOperationExecutor } from '@rainver/protocol';
import { proposalApproval } from './proposalContributions.js';
import type { PluginBackground } from './background.js';
import { pluginServiceFor } from './service.js';
import type { ServerConfig } from '../../config.js';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { operationPluginEnabled, lockOperationPluginScope } from './operationEnablement.js';
import { hidden, OperationError } from '../systemActions/operations/errors.js';
import { withPluginDb } from './operationDb.js';
import type { Queryable } from '../routeUtils/common.js';
import { registerOperationDescriptors } from './registry.js';
const packages = new WeakMap<ServerConfig, readonly RainverPlugin[]>();
export function operationPackages(config?: ServerConfig) {
  return config ? packages.get(config) ?? [] : [];
}
const contributions = new WeakMap<ServerConfig, readonly OperationRegistration[]>();
const policies = new WeakMap<ServerConfig, readonly PolicyActionDefinition[]>();
export function pluginOperations(config?: ServerConfig): readonly OperationRegistration[] {
  return config ? contributions.get(config) ?? [] : [];
}
export function pluginPolicies(config?: ServerConfig): readonly PolicyActionDefinition[] {
  return config ? policies.get(config) ?? [] : [];
}
export function validateOperationPlugin(plugin: RainverPlugin) {
  const manifest = PluginOperationManifestSchema.parse(plugin.operationManifest);
  if (manifest.id !== plugin.id || manifest.version !== plugin.version) throw new Error('Plugin manifest/runtime mismatch');
  // Later-stage surfaces must not silently register outside the declared operation contract.
  return freezeManifest(manifest);
}
export function operationDescriptor(plugin: RainverPlugin): OfficialPluginDescriptor {
  const m = validateOperationPlugin(plugin);
  return {
    operation_api: 1,
    id: m.id,
    version: m.version,
    name: m.name,
    description: m.description,
    category: 'system',
    scope: m.scope,
    default_enabled: false,
    default_visible: false,
    lifecycle_status: 'available',
    frontend_entries: pluginFrontendEntries(m),
    backend_feature_ids: m.entities.map(e => e.name),
    permissions: {
      creates_activity: false,
      can_propose_memory: false,
      can_contribute_context: 'never',
      uses_ai: false,
      uses_scheduler: !!m.schedules?.length
    },
    settings_defaults: {}
  };
}
export function composePluginOperations(config: ServerConfig, plugin: RainverPlugin, executors: ReadonlyMap<string, PluginOperationExecutor>, background?: PluginBackground): OperationRegistration[] {
  const m = validateOperationPlugin(plugin);
  if (executors.size !== m.operations.length || m.operations.some(o => !executors.has(o.id))) throw new Error('Declared/registered operation mismatch');
  return m.operations.map(o => {
    const definition: SystemActionDefinition = {
      id: o.id,
      version: o.version,
      title: o.title,
      description: o.description,
      execution: {
        kind: o.kind,
        tx: 'core_owned'
      },
      input_schema: o.input_schema,
      output_schema: o.output_schema,
      side_effects: o.side_effects,
      idempotency_required: o.kind === 'command',
      policy_action: o.id as PluginOperationId,
      owning_module: `plugin.${m.id}`,
      application_service: 'PluginHost',
      proposal_type: o.proposal_type ?? null,
      gate_class: o.gate_class,
      grantable: false,
      visibility: new Set(['public_api', 'agent_tool']),
      allowed_actor_types: m.permissions.agent && o.data_class === 'non_sensitive' ? ['user', 'agent'] : ['user'],
      agent_tool_surface: 'generic',
      policy_adapter: 'declared_resource',
      policy_resource: {
        resource_type: `plugin.${m.id}`,
        resource_id_fallback: 'run',
        check_action_approval_grant: false
      }
    };
    return {
      definition,
      approval: proposalApproval(m, o.id),
      readKind: o.kind === 'query' ? 'content' : undefined,
      async resolve(_db, _input, actor) {
        return {
          authority: m.scope === 'user' ? `plugin:${m.id}:user:${actor.on_behalf_of_user_id}` : `plugin:${m.id}:space:${actor.space_id}`,
          targets: {
            plugin: m.id
          },
          resourceType: `plugin.${m.id}`,
          resourceId: m.scope === 'user' ? actor.on_behalf_of_user_id! : actor.space_id
        };
      },
      async authorize(db, _input, actor) {
        await assertPluginEnabled(db, {
          ...plugin,
          operationManifest: m
        }, actor.space_id, actor.on_behalf_of_user_id!, o.kind === 'command', config);
      },
      async execute(db, input, actor) {
        // Mapped proposal submissions are intercepted by P1; unmatched ones never invoke plugin SQL.
        if (o.side_effects === 'proposal') throw new OperationError('operation_approval_mapping_unavailable', 503);
        const settings = (await pluginServiceFor(config).getPlugin(db, m.id, actor.space_id, actor.on_behalf_of_user_id!)).effective.settings;
        return withPluginDb(db, m.id, actor, pdb => executors.get(o.id)!(input, {
          settings,
          jobs: background?.intents(pdb, {
            spaceId: actor.space_id,
            userId: actor.on_behalf_of_user_id!
          }),
          db: pdb,
          actor: Object.freeze({
            ...actor,
            principal: Object.freeze({
              ...actor.principal
            })
          })
        }));
      },
      // caller_owned is an owning-code review obligation, not a SQL/RLS isolation proof.
      async readAudit() {/* Reviewed caller-owned queries need no B11 content-access row. A cross-person adapter is not supported: the manifest label alone cannot waive B11. */}
    };
  });
}
export async function assertPluginEnabled(db: Queryable, plugin: RainverPlugin, space: string, user: string, lock = false, config?: ServerConfig): Promise<void> {
  if (lock) await lockOperationPluginScope(db, plugin.id, space, user, config);
  if (!(await operationPluginEnabled(db, plugin.id, space, user, config))) throw hidden();
}
export function installOperationContributions(config: ServerConfig, plugins: readonly RainverPlugin[], registrations: readonly OperationRegistration[]): () => void {
  if (contributions.has(config)) throw new Error('Plugin operation composition already installed');
  const release = registerOperationDescriptors(config, plugins.filter(p => p.operationManifest).map(operationDescriptor), plugins.filter(p => p.operationManifest && !registrations.some(r => r.definition.owning_module === `plugin.${p.id}`)).map(p => p.id), new Map(plugins.filter(p => p.operationManifest).map(p => [p.id, operationPackageIdentity(p)])));
  // Legacy packages remain descriptor/dependency targets, never operation contracts.
  packages.set(config, plugins.filter(p => p.operationManifest));
  contributions.set(config, registrations);
  const operationPolicies: PolicyActionDefinition[] = registrations.map(r => ({
    action: r.definition.id,
    resource_type: r.definition.owning_module,
    default_risk_level: 'low',
    default_decision: r.approval?.mode === 'proposal_submission' ? 'allow' : r.definition.gate_class ? 'require_approval' : 'allow',
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: 'OperationExecutor',
    description: r.definition.description,
    lifecycle_status: 'wired_direct',
    record_failure_mode: 'fail_closed'
  }));
  policies.set(config, [...operationPolicies, ...plugins.filter(p => registrations.some(r => r.definition.owning_module === `plugin.${p.id}`)).flatMap(p => (p.operationManifest?.jobs ?? []).map(j => ({
    action: j.id,
    resource_type: `plugin.${p.id}`,
    default_risk_level: 'low' as const,
    default_decision: 'allow' as const,
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: 'PluginHost Job',
    description: j.id,
    lifecycle_status: 'wired_direct' as const,
    record_failure_mode: 'fail_closed' as const
  })))]);
  return () => {
    release();
    packages.delete(config);
    contributions.delete(config);
    policies.delete(config);
  };
}
function freezeManifest<T>(value: T): T {
  if (value && typeof value === 'object' && typeof (value as {
    safeParse?: unknown;
  }).safeParse !== 'function') {
    for (const child of Object.values(value)) freezeManifest(child);
    Object.freeze(value);
  }
  return value;
}
