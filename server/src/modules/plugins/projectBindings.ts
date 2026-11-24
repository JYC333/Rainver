import {randomUUID} from 'node:crypto';
import type {OperationActor, PluginOperationManifest, PluginProjectBinding, PluginProjectBindingItem} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import {hidden, OperationRefusal} from '../systemActions/operations/errors.js';
import {assertProjectReadableLocked, canReadProject, canWriteProject, isProjectOwnerLevel, lockProjectAudience} from '../projects/access.js';
import {getOfficialPlugin} from './registry.js';
import {operationPackageFacts, operationPackages} from './operationRegistry.js';
import {lockOperationPluginScope, operationPluginEnabled} from './operationEnablement.js';

/**
 * Project bindings of Project-level operation packages (manifest
 * `project_binding: 'required'`). Install and Space/user enablement remain the
 * admission layers; a binding row decides which Projects a package reaches.
 *
 * Lock order, shared by every writer and reader that locks: plugin installs →
 * enablements (`lockOperationPluginScope`) → Project authority rows (Project,
 * Space membership, Project membership) → the binding row; an Agent's command
 * and an Agent's result release take the Project earlier still, before the
 * person and the Run (`lockAgentProjectBeforeActor`, `projects/access.ts`). A command takes the
 * Project row `FOR UPDATE` first, as the canonical aggregate write fence
 * (`lockActiveProjectForMutation`) does, and only then its authority rows
 * `FOR SHARE`: the Task and Artifact core write ports take that same fence, so
 * no command holds the Project `FOR SHARE` and later upgrades it (two
 * concurrent commands would deadlock). Bind and unbind take the Project and
 * authority rows `FOR SHARE` and the binding `FOR UPDATE`; an operation, a
 * replay, a proposal apply and a result release take the binding `FOR SHARE`,
 * so either the unbind commits first and they refuse, or the unbind waits.
 *
 * Authority follows the Project data boundary: plugin data inside a Project is
 * Project-private content (the `project_members` ACL), so every query and
 * command needs Project read and a command also Project write. A Space
 * owner/admin who is not in the Project is owner level for its configuration:
 * they may list, bind and unbind, but neither read nor write its plugin data
 * (`effective` stays false for them).
 */
interface BindingRow {
  plugin_id: string; space_id: string; project_id: string; status: 'bound' | 'unbound';
  bound_by_user_id: string | null; bound_at: string | null; unbound_by_user_id: string | null; unbound_at: string | null;
}
const COLUMNS = `plugin_id,space_id,project_id,status,bound_by_user_id,bound_at,unbound_by_user_id,unbound_at`;
const iso = (value: unknown) => value == null ? null : new Date(value as string).toISOString();
const dto = (row: BindingRow): PluginProjectBinding => ({...row, bound_at: iso(row.bound_at), unbound_at: iso(row.unbound_at)});

export function projectBoundManifest(config: ServerConfig | undefined, pluginId: string): PluginOperationManifest | undefined {
  const manifest = operationPackageFacts(config, pluginId)?.manifest;
  return manifest?.project_binding === 'required' ? manifest : undefined;
}

async function bindingRow(db: Queryable, pluginId: string, spaceId: string, projectId: string, lock: '' | ' FOR SHARE' | ' FOR UPDATE' = ''): Promise<BindingRow | undefined> {
  return (await db.query<BindingRow>(`SELECT ${COLUMNS} FROM official_plugin_project_bindings WHERE plugin_id=$1 AND space_id=$2 AND project_id=$3${lock}`, [pluginId, spaceId, projectId])).rows[0];
}

export async function isPluginProjectBound(db: Queryable, pluginId: string, spaceId: string, projectId: string, lock = false): Promise<boolean> {
  return (await bindingRow(db, pluginId, spaceId, projectId, lock ? ' FOR SHARE' : ''))?.status === 'bound';
}

async function projectStatus(db: Queryable, spaceId: string, projectId: string): Promise<string | undefined> {
  return (await db.query<{status: string}>('SELECT status FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR SHARE', [projectId, spaceId])).rows[0]?.status;
}

const archived = () => new OperationRefusal(409, 'plugins', 'Project is archived; reactivate it before making changes');

/**
 * The one host check every entry of a Project-bound package passes before
 * plugin code runs (fresh call, receipt replay, proposal apply) and again when
 * a result is released. Everything refuses as not found except a write to an
 * archived Project the person may otherwise write.
 *
 * - An Agent reaches only its Run's Project (and its Agent's access Project,
 *   when set): another Project, even one bound and readable, is not found.
 * - The person (the actor or the Agent's instructing person) reads the Project
 *   for a query, and reads and writes the active Project for a command.
 * - The binding is `bound` now. Plugin enablement is the caller's separate check.
 */
export async function assertPluginProjectTarget(db: Queryable, manifest: PluginOperationManifest, actor: OperationActor, projectId: unknown, kind: 'query' | 'command', options: {lockBinding?: boolean} = {}): Promise<void> {
  const person = actor.on_behalf_of_user_id;
  if (typeof projectId !== 'string' || !projectId || !person) throw hidden();
  if (actor.principal.kind === 'agent') {
    const run = (await db.query<{project_id: string | null}>('SELECT project_id FROM runs WHERE id=$1 AND space_id=$2', [actor.run_id, actor.space_id])).rows[0];
    const agent = (await db.query<{access_project_id: string | null}>('SELECT access_project_id FROM agents WHERE id=$1 AND space_id=$2', [actor.agent_id, actor.space_id])).rows[0];
    if (!run?.project_id || run.project_id !== projectId || agent?.access_project_id && agent.access_project_id !== projectId) throw hidden();
  }
  // Unlocked first: a person who cannot reach the Project never waits on (or blocks) its row.
  if (!await canReadProject(db, actor.space_id, projectId, person)) throw hidden();
  if (kind === 'command') {
    if (!await canWriteProject(db, actor.space_id, projectId, person)) throw hidden();
    const status = (await db.query<{status: string}>('SELECT status FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE', [projectId, actor.space_id])).rows[0]?.status;
    if (!status) throw hidden();
    await assertProjectReadableLocked(db, actor.space_id, projectId, person).catch(() => { throw hidden(); });
    if (!await canWriteProject(db, actor.space_id, projectId, person, {lockAuthority: true})) throw hidden();
    if (status !== 'active') throw archived();
  }
  if (!await isPluginProjectBound(db, manifest.id, actor.space_id, projectId, kind === 'command' || options.lockBinding)) throw hidden();
}

/** Bind: the package is Project-level and enabled for the person, the Project is active, and the person is Project owner level. */
export async function bindPluginProject(db: Queryable, config: ServerConfig, actor: OperationActor, pluginId: string, projectId: string): Promise<PluginProjectBinding> {
  const person = actor.on_behalf_of_user_id!;
  if (!projectBoundManifest(config, pluginId) || !getOfficialPlugin(pluginId, config)) throw hidden();
  await lockOperationPluginScope(db, pluginId, actor.space_id, person, config);
  if (!await isProjectOwnerLevel(db, actor.space_id, projectId, person, {lockAuthority: true})) throw hidden();
  if (!await operationPluginEnabled(db, pluginId, actor.space_id, person, config)) throw new OperationRefusal(409, 'plugins', 'Enable this plugin before binding it to a Project');
  if (await projectStatus(db, actor.space_id, projectId) !== 'active') throw archived();
  const current = await bindingRow(db, pluginId, actor.space_id, projectId, ' FOR UPDATE');
  if (current?.status === 'bound') return dto(current);
  // No row yet to lock: concurrent first binds meet at the unique key. Only the one that changes
  // the row returns it and records the event; the other sees the committed binding unchanged.
  const row = (await db.query<BindingRow>(`INSERT INTO official_plugin_project_bindings (id,plugin_id,space_id,project_id,status,bound_by_user_id,bound_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'bound',$5,now(),now(),now())
    ON CONFLICT (plugin_id,project_id) DO UPDATE SET status='bound',bound_by_user_id=EXCLUDED.bound_by_user_id,bound_at=now(),unbound_by_user_id=NULL,unbound_at=NULL,updated_at=now()
      WHERE official_plugin_project_bindings.status<>'bound'
    RETURNING ${COLUMNS}`, [randomUUID(), pluginId, actor.space_id, projectId, person])).rows[0];
  if (!row) {
    const committed = await bindingRow(db, pluginId, actor.space_id, projectId);
    if (committed?.status !== 'bound') throw hidden();
    return dto(committed);
  }
  await recordEvent(db, actor, pluginId, projectId, 'project_bound');
  return dto(row);
}

/**
 * Unbind: Project owner level only. Allowed while the plugin is disabled or
 * the Project archived, since it only narrows reach. Plugin-owned rows stay;
 * a later bind of the same Project reaches them again.
 */
export async function unbindPluginProject(db: Queryable, config: ServerConfig, actor: OperationActor, pluginId: string, projectId: string): Promise<PluginProjectBinding> {
  const person = actor.on_behalf_of_user_id!;
  if (!getOfficialPlugin(pluginId, config)) throw hidden();
  if (!await isProjectOwnerLevel(db, actor.space_id, projectId, person, {lockAuthority: true})) throw hidden();
  const current = await bindingRow(db, pluginId, actor.space_id, projectId, ' FOR UPDATE');
  if (!current) throw hidden();
  if (current.status === 'unbound') return dto(current);
  const row = (await db.query<BindingRow>(`UPDATE official_plugin_project_bindings SET status='unbound',unbound_by_user_id=$4,unbound_at=now(),updated_at=now()
    WHERE plugin_id=$1 AND space_id=$2 AND project_id=$3 RETURNING ${COLUMNS}`, [pluginId, actor.space_id, projectId, person])).rows[0]!;
  await recordEvent(db, actor, pluginId, projectId, 'project_unbound');
  return dto(row);
}

/** Who sees a Project's binding configuration: its readers and its owner-level people (a Space owner/admin outside it included). */
export async function canViewPluginProjectBindings(db: Queryable, spaceId: string, projectId: string, person: string): Promise<boolean> {
  return await canReadProject(db, spaceId, projectId, person) || await isProjectOwnerLevel(db, spaceId, projectId, person);
}

/**
 * A Project's binding configuration: every Project-level package composed
 * here, its binding and whether it is effective for this person — enabled for
 * them, bound, and the Project readable by them, the gate every entry passes.
 */
export async function listPluginProjectBindings(db: Queryable, config: ServerConfig, actor: OperationActor, projectId: string): Promise<{project_id: string; can_manage: boolean; items: PluginProjectBindingItem[]}> {
  const person = actor.on_behalf_of_user_id!;
  if (!await canViewPluginProjectBindings(db, actor.space_id, projectId, person)) throw hidden();
  const readable = await canReadProject(db, actor.space_id, projectId, person);
  const items: PluginProjectBindingItem[] = [];
  for (const plugin of operationPackages(config)) {
    const manifest = projectBoundManifest(config, plugin.id);
    if (!manifest || !getOfficialPlugin(plugin.id, config)) continue;
    const row = await bindingRow(db, plugin.id, actor.space_id, projectId);
    const enabled = await operationPluginEnabled(db, plugin.id, actor.space_id, person, config);
    items.push({
      plugin_id: plugin.id, name: manifest.name, version: manifest.version, status: row?.status ?? 'available',
      plugin_enabled: enabled, effective: enabled && readable && row?.status === 'bound', bound_at: iso(row?.bound_at), unbound_at: iso(row?.unbound_at),
    });
  }
  items.sort((a, b) => a.plugin_id.localeCompare(b.plugin_id));
  return {project_id: projectId, can_manage: await isProjectOwnerLevel(db, actor.space_id, projectId, person), items};
}

/**
 * A shared result's audience, checked live in the release transaction: every
 * reader still reads the Project. The audience fence (`lockProjectAudience`)
 * holds the Project row and its membership rows, so a membership change either
 * commits first and this refuses, or waits until the result is released.
 */
export async function assertPluginProjectAudience(db: Queryable, spaceId: string, projectId: string, readers: readonly string[]): Promise<void> {
  await lockProjectAudience(db, spaceId, projectId);
  for (const reader of readers) if (!await canReadProject(db, spaceId, projectId, reader)) throw hidden();
}

async function recordEvent(db: Queryable, actor: OperationActor, pluginId: string, projectId: string, eventType: 'project_bound' | 'project_unbound') {
  await db.query(`INSERT INTO official_plugin_events (id,space_id,plugin_id,event_type,actor_user_id,target_user_id,metadata_json,created_at) VALUES ($1,$2,$3,$4,$5,NULL,$6::jsonb,now())`,
    [randomUUID(), actor.space_id, pluginId, eventType, actor.on_behalf_of_user_id, JSON.stringify({project_id: projectId})]);
}
