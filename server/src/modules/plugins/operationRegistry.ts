import { operationPackageIdentity } from './packageIdentity.js';
import { pluginFrontendEntries, pluginRefusalOf, PluginOperationManifestSchema, type OperationActor, type RainverPlugin, type OfficialPluginDescriptor, type PolicyActionDefinition, type RegisteredSystemActionDefinition as SystemActionDefinition, type PluginOperationId, type PluginOperationExecutor, type PluginOperationManifest } from '@rainver/protocol';
import { proposalApproval } from './proposalContributions.js';
import type { PluginBackground } from './background.js';
import { pluginServiceFor } from './service.js';
import type { ServerConfig } from '../../config.js';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { operationPluginEnabled, lockOperationPluginScope } from './operationEnablement.js';
import { hidden, OperationError, OperationRefusal } from '../systemActions/operations/errors.js';
import { withPluginDb } from './operationDb.js';
import type { Queryable } from '../routeUtils/common.js';
import { registerOperationDescriptors } from './registry.js';
import { perReaderRead, pluginDataFacts, runScenario, sharedAudience } from './dataAccess.js';
import { pluginCorePorts } from './corePorts.js';
import { assertOutputWithinClass, attachReleaseFacts, readReleaseFacts, releasePluginResult, type PluginReference } from './releaseGate.js';
import { canonical } from '../systemActions/operations/repository.js';
import { assertPluginProjectAudience, assertPluginProjectTarget } from './projectBindings.js';
import { canReadProject } from '../projects/access.js';
const packages = new WeakMap<ServerConfig, readonly RainverPlugin[]>();
export function operationPackages(config?: ServerConfig) {
  return config ? packages.get(config) ?? [] : [];
}
/** Immutable package facts of one composed operation package: its parsed, frozen manifest and admission identity. */
export interface OperationPackageFacts {
  readonly plugin: RainverPlugin;
  readonly manifest: PluginOperationManifest;
  readonly identity: string;
}
const packageFacts = new WeakMap<ServerConfig, ReadonlyMap<string, OperationPackageFacts>>();
/**
 * The composed package's facts, computed once when the composition is
 * installed and released with it, per config. Only immutable package facts are
 * cached; installs, enablement, consent and revocation are always read live.
 */
export function operationPackageFacts(config: ServerConfig | undefined, pluginId: string): OperationPackageFacts | undefined {
  return config ? packageFacts.get(config)?.get(pluginId) : undefined;
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
    ...(m.project_binding ? {project_binding: m.project_binding} : {}),
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
      // A person-only operation is no Agent tool at all, not one refused at call time.
      visibility: new Set(o.actors ? ['public_api'] : ['public_api', 'agent_tool']),
      // personal/sensitive tools reach an Agent only through ADR 0030 scenario and data-side consent gates.
      allowed_actor_types: m.permissions.agent && !o.actors ? ['user', 'agent'] : ['user'],
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
      approval: proposalApproval(m, o.id, background),
      readKind: o.kind === 'query' ? 'content' : undefined,
      async resolve(_db, input, actor) {
        const base = m.scope === 'user' ? `plugin:${m.id}:user:${actor.on_behalf_of_user_id}` : `plugin:${m.id}:space:${actor.space_id}`;
        // A Project-bound operation's target is its Project; the host authorizes it, never the plugin.
        const project = m.project_binding ? projectOf(input) : undefined;
        return {
          authority: project ? `${base}:project:${project}` : base,
          targets: {
            plugin: m.id,
            ...(project ? {project_id: project} : {})
          },
          resourceType: `plugin.${m.id}`,
          resourceId: m.scope === 'user' ? actor.on_behalf_of_user_id! : actor.space_id
        };
      },
      async authorize(db, input, actor, scope) {
        await assertPluginEnabled(db, {
          ...plugin,
          operationManifest: m
        }, actor.space_id, actor.on_behalf_of_user_id!, o.kind === 'command', config);
        if (m.project_binding) await assertPluginProjectTarget(db, m, actor, projectOf(input), o.kind);
        const facts = await pluginDataFacts(db, config, actor, o.id, o.kind === 'command');
        if (facts === 'pin_mismatch') throw new OperationError('operation_not_granted', 403);
        if (facts) scope.policyFacts = {plugin_data_class: facts.dataClass, plugin_data_consent: facts.consent, plugin_data_requestable: facts.requestable, ...(facts.isolated === false ? {plugin_data_isolated: false} : {})};
      },
      // An approved request's result reaches its reviewer, on accept and on every accept receipt replay,
      // only while the Project stays bound and readable: the requester's target and the reviewer's read.
      ...(m.project_binding ? {async authorizeApprovedResult(db: Queryable, frozen: {input: unknown; actor: OperationActor}, reviewer: {spaceId: string; userId: string}, replay: boolean) {
        const project = projectOf(frozen.input);
        if (!project || !(await canReadProject(db, reviewer.spaceId, project, reviewer.userId))) throw hidden();
        if (!replay) return;
        await assertPluginEnabled(db, {...plugin, operationManifest: m}, frozen.actor.space_id, frozen.actor.on_behalf_of_user_id!, false, config);
        await assertPluginProjectTarget(db, m, frozen.actor, project, 'query', {lockBinding: true});
      }} : {}),
      policyContext(_input, _actor, scope) {
        return {...scope.policyFacts};
      },
      async execute(db, input, actor) {
        // Mapped proposal submissions are intercepted by P1; unmatched ones never invoke plugin SQL.
        if (o.side_effects === 'proposal') throw new OperationError('operation_approval_mapping_unavailable', 503);
        const references: PluginReference[] = [];
        const bound = m.project_binding && projectOf(input) ? {project_id: projectOf(input)!} : {};
        const run = async (viewer: OperationActor, collect: PluginReference[] | null) => {
          const settings = (await pluginServiceFor(config).getPlugin(db, m.id, viewer.space_id, viewer.on_behalf_of_user_id!)).effective.settings;
          const raw = await withPluginDb(db, m.id, viewer, pdb => executors.get(o.id)!(input, {
            settings,
            jobs: background?.intents(pdb, {
              spaceId: viewer.space_id,
              userId: viewer.on_behalf_of_user_id!
            }),
            db: pdb,
            core: collect ? pluginCorePorts(pdb, config, m, viewer, o.data_class, {kind: o.kind, references: collect, ...(m.project_binding ? {projectId: projectOf(input)} : {})}) : undefined,
            actor: Object.freeze({
              ...viewer,
              principal: Object.freeze({
                ...viewer.principal
              })
            })
          }));
          // Trusted classification reads the raw output, before the DTO schema can strip a label.
          assertOutputWithinClass(raw, o.data_class);
          return raw;
        };
        // caller_owned rows belong to the person who wrote them, whatever their data class, so every
        // shared read (not only a personal one) is released as what each reader reads themselves.
        if (actor.principal.kind === 'agent' && perReaderRead(m, o)) {
          const scenario = await runScenario(db, actor);
          if (!scenario) throw hidden();
          if (sharedAudience(scenario)) {
            const readers = [...scenario.audience];
            // The requester's own refusal (for example, no such row of theirs) answers exactly like
            // another reader's, so a shared Run cannot tell whose result was missing.
            const raw = await run(actor, references).catch(error => { throw pluginRefusalOf(error) ? hidden() : error; });
            // A shared audience receives only what every current reader can read through their own
            // plugin access: the same read-only query, executed as each reader, intersected by row.
            const active = (await db.query<{n: number}>(`SELECT count(*)::int AS n FROM space_memberships m JOIN users u ON u.id=m.user_id AND u.status='active' WHERE m.space_id=$1 AND m.user_id=ANY($2::varchar[]) AND m.status='active'`, [actor.space_id, readers])).rows[0]?.n;
            if (active !== readers.length) throw hidden();
            const views: unknown[] = [];
            for (const reader of readers.filter(id => id !== actor.on_behalf_of_user_id)) {
              if (!(await operationPluginEnabled(db, m.id, actor.space_id, reader, config))) throw hidden();
              if (m.project_binding && !(await canReadProject(db, actor.space_id, projectOf(input)!, reader))) throw hidden();
              // A reader's own refusal (for example, no such row of theirs) withholds, never explains.
              views.push(await run({...actor, on_behalf_of_user_id: reader}, []).catch(() => { throw hidden(); }));
            }
            const intersected = readableIntersection(raw, views);
            attachReleaseFacts(intersected, {v: 1, audience: readers, references, ...bound});
            return intersected;
          }
        }
        const raw = await run(actor, references);
        attachReleaseFacts(raw, {v: 1, references, ...bound});
        return raw;
      },
      // Only a declared plugin refusal is a business outcome; anything else stays an internal error.
      classifyError(error) {
        const refusal = pluginRefusalOf(error);
        return refusal ? new OperationRefusal(refusal.kind === 'conflict' ? 409 : 422, `plugin.${m.id}`, refusal.reason, {reason: refusal.reason}) : undefined;
      },
      releaseFacts: readReleaseFacts,
      // caller_owned is an owning-code review obligation, not a SQL/RLS isolation proof.
      // Reviewed caller-owned queries need no B11 cross-person row; the manifest label cannot waive B11.
      // Every result body, fresh or replayed, query or command, is released here (ADR 0030).
      async releaseGate(audit, release) {
        await releasePluginResult(audit, config, m, o, release.actor, release.data, release.facts as Parameters<typeof releasePluginResult>[6]);
        // An unbind, a lost Project role or a moved Run committed after execution withholds the body,
        // for a fresh result and for every replay of a stored receipt.
        if (m.project_binding) {
          const project = projectOf(release.input);
          const audience = (release.facts as Parameters<typeof releasePluginResult>[6])?.audience ?? [];
          await (async () => {
            await assertPluginProjectTarget(audit, m, release.actor, project, 'query', {lockBinding: true});
            // A shared result's audience: every reader it was intersected for still reads the Project now.
            if (audience.length) await assertPluginProjectAudience(audit, release.actor.space_id, project!, audience);
          })().catch(() => { throw new OperationError('operation_audit_unavailable', 503, true); });
        }
      }
    };
  });
}
/**
 * What a shared audience may receive of a personal read: the parts of the
 * person's own result that every other reader's own result also contains.
 *
 * A list result (`{items: [...], ...}`) releases the rows every reader's
 * result also has, compared by canonical value. Every other field — a total,
 * a cursor, a summary, however nested — describes the person's own result, so
 * it is released only when each reader's own result carries exactly the same
 * value; otherwise nothing is released. A result of any other shape is released
 * only when every reader's result is identical. Nothing is stripped to make a
 * partial answer fit: withholding is the only fallback.
 */
export function readableIntersection(own: unknown, views: readonly unknown[]): unknown {
  const isList = (value: unknown): value is {items: unknown[]} & Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as {items?: unknown}).items);
  const rest = (value: Record<string, unknown>) => canonical(Object.fromEntries(Object.entries(value).filter(([key, field]) => key !== 'items' && field !== undefined)));
  if (!isList(own)) {
    if (views.every(view => canonical(view) === canonical(own))) return own;
    throw hidden();
  }
  const ownRest = rest(own);
  const sets = views.map(view => {
    if (!isList(view) || rest(view) !== ownRest) throw hidden();
    return new Set(view.items.map(canonical));
  });
  return {...own, items: own.items.filter(item => sets.every(set => set.has(canonical(item))))};
}
function projectOf(input: unknown): string | undefined {
  const project = input && typeof input === 'object' ? (input as {project_id?: unknown}).project_id : undefined;
  return typeof project === 'string' && project ? project : undefined;
}
export async function assertPluginEnabled(db: Queryable, plugin: RainverPlugin, space: string, user: string, lock = false, config?: ServerConfig): Promise<void> {
  if (lock) await lockOperationPluginScope(db, plugin.id, space, user, config);
  if (!(await operationPluginEnabled(db, plugin.id, space, user, config))) throw hidden();
}
export function installOperationContributions(config: ServerConfig, plugins: readonly RainverPlugin[], registrations: readonly OperationRegistration[]): () => void {
  if (contributions.has(config)) throw new Error('Plugin operation composition already installed');
  const operationPlugins = plugins.filter(p => p.operationManifest);
  const facts = new Map(operationPlugins.map(p => [p.id, Object.freeze({plugin: p, manifest: validateOperationPlugin(p), identity: operationPackageIdentity(p)})]));
  const release = registerOperationDescriptors(config, operationPlugins.map(operationDescriptor), operationPlugins.filter(p => !registrations.some(r => r.definition.owning_module === `plugin.${p.id}`)).map(p => p.id), new Map([...facts].map(([id, f]) => [id, f.identity])));
  // Legacy packages remain descriptor/dependency targets, never operation contracts.
  packages.set(config, operationPlugins);
  packageFacts.set(config, facts);
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
    packageFacts.delete(config);
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
