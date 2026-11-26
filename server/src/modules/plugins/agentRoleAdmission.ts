import type {OperationActor} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import {projectReadAccessSql, roomConversationAudienceSql} from '../access/contentAccessSql.js';
import {lockRoomExecutionAuthority, roomAgentUseSql, runExecutionPlacement} from '../rooms/agentUsageSql.js';
import {OperationRefusal} from '../systemActions/operations/errors.js';
import {lockOperationPluginScope, operationPluginEnabled} from './operationEnablement.js';
import {isPluginProjectBound, projectBoundManifest} from './projectBindings.js';

/**
 * Execution admission of a plugin's companion Agent: one created from an
 * Agent Role a plugin contributes (`RainverPlugin.agentRoles`, Role id
 * `<plugin id>.<role key>`; catalog Role keys carry no dot). Such an Agent
 * exists for its plugin's work in a Project, so it runs only where that work
 * is set up now, whether or not this turn calls a plugin tool:
 *
 * - its Run has a Project that is active and that the instructing person reads;
 * - the plugin is enabled for that person (install, Space/user enablement and
 *   dependencies, `operationPluginEnabled`) and, for a Project-bound package,
 *   bound to that Project;
 * - the Run is in a Room of that Project that authorizes this Agent for this
 *   person now (`roomAgentUseSql`), inside the Run conversation's own audience.
 *
 * A direct chat or Run outside a Project, a Project that unbound or archived
 * the plugin, a disabled plugin, and a Room that no longer admits the Agent
 * each refuse. The Room and the conversation are the Run's placement
 * (`runExecutionPlacement`, the resolution Run claim and plugin entry use), so
 * a Run with or without a Run Group is decided alike. It is asked when a Run
 * is dispatched and claimed (`checkRunExecutionAuthorization`), at every tool
 * call the Agent's Run makes (`SystemActionDispatcher.dispatch`, gateway
 * actions included), at every operation it invokes (`OperationExecutor`) and
 * again when a gated result is released to it, so an unbind also stops a Run
 * that is already going on at its next action.
 *
 * Where the decision leads to an effect it is taken under locks
 * (`lockPluginRoleAgentAdmission`): Run claim, until its Run is `running`,
 * every operation command, inside its transaction, and every gated result
 * release (receipt replays included), inside the release transaction. A disable (the plugin
 * scope's write locks), an unbind (the binding row) or a Room or audience
 * withdrawal (`lockRoomExecutionAuthority`) then either commits first and is
 * seen, or waits until the claim or command has committed. It only admits:
 * once admitted the Agent keeps every ordinary assistant capability its Role
 * and Run grant.
 */
export function pluginOfAgentRole(roleId: string | null | undefined): string | null {
  const dot = roleId ? roleId.indexOf('.') : -1;
  return roleId && dot > 0 ? roleId.slice(0, dot) : null;
}

export interface PluginAgentRefusal {error_code: string; error_message: string}

const refusal = (error_code: string, error_message: string): PluginAgentRefusal => ({error_code, error_message});

export async function pluginRoleAgentRefusal(db: Queryable, config: ServerConfig | undefined, run: {
  space_id: string; agent_id?: string | null; instructed_by_user_id?: string | null; project_id?: string | null;
  run_group_id?: string | null; session_id?: string | null;
}, sourceRoleId?: string | null): Promise<PluginAgentRefusal | null> {
  if (!run.agent_id) return null;
  const roleId = sourceRoleId !== undefined ? sourceRoleId
    : (await db.query<{source_role_id: string | null}>('SELECT source_role_id FROM agents WHERE id=$1 AND space_id=$2', [run.agent_id, run.space_id])).rows[0]?.source_role_id;
  const pluginId = pluginOfAgentRole(roleId);
  if (!pluginId) return null;
  const person = run.instructed_by_user_id;
  if (!person || !run.project_id) {
    return refusal('plugin_agent_project_required', 'This assistant works only in a Project where its plugin is set up, so it was not run here.');
  }
  const project = await db.query(
    `SELECT 1 FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL AND status='active'
        AND ${projectReadAccessSql('$2', '$1', '$3::varchar')}`,
    [run.project_id, run.space_id, person],
  );
  if (!project.rows.length) return refusal('plugin_agent_project_unavailable', 'This assistant\'s Project is not active or not readable, so it was not run.');
  if (!await operationPluginEnabled(db, pluginId, run.space_id, person, config)) {
    return refusal('plugin_agent_plugin_disabled', 'This assistant\'s plugin is not enabled, so it was not run.');
  }
  if (projectBoundManifest(config, pluginId) && !await isPluginProjectBound(db, pluginId, run.space_id, run.project_id)) {
    return refusal('plugin_agent_project_unbound', 'This assistant\'s plugin is no longer set up in this Project, so it was not run.');
  }
  const placement = await runExecutionPlacement(db, run.space_id, run);
  const room = placement.room_id ? await db.query(
    `SELECT 1
       FROM agents a
       JOIN rooms room ON room.id = $3 AND room.space_id = a.space_id AND room.project_id = $4 AND room.status = 'active'
      WHERE a.id = $2 AND a.space_id = $1
        AND ${roomAgentUseSql('a', '$6::varchar', 'room.id')}
        AND ($5::varchar IS NULL OR ${roomConversationAudienceSql('a.space_id', '$5::varchar', '$6::varchar')})
      LIMIT 1`,
    [run.space_id, run.agent_id, placement.room_id, run.project_id, placement.session_id, person],
  ) : {rows: []};
  if (!room.rows.length) return refusal('plugin_agent_room_unauthorized', 'This assistant runs only in a Room of its Project that has it, so it was not run here.');
  return null;
}

/** The same admission for an operation an Agent's Run invokes; a refusal answers before anything runs. */
export async function assertPluginRoleAgentAdmitted(db: Queryable, config: ServerConfig | undefined, actor: OperationActor): Promise<void> {
  const run = await companionRun(db, actor);
  if (run) await refuseUnadmitted(db, config, run);
}

interface CompanionRun {
  space_id: string; agent_id: string; plugin_id: string; source_role_id: string; instructed_by_user_id: string | null;
  project_id: string | null; run_group_id: string | null; session_id: string | null;
}

/** The acting Run of a plugin companion Agent, or null for a person, another Agent or no Run. */
async function companionRun(db: Queryable, actor: OperationActor): Promise<CompanionRun | null> {
  if (actor.principal.kind !== 'agent' || !actor.run_id || !actor.agent_id) return null;
  const row = (await db.query<{instructed_by_user_id: string | null; project_id: string | null; run_group_id: string | null; session_id: string | null; source_role_id: string | null}>(
    `SELECT r.instructed_by_user_id, r.project_id, r.run_group_id, r.session_id, a.source_role_id
       FROM runs r JOIN agents a ON a.id = r.agent_id AND a.space_id = r.space_id
      WHERE r.id = $1 AND r.space_id = $2 AND r.agent_id = $3`,
    [actor.run_id, actor.space_id, actor.agent_id],
  )).rows[0];
  const pluginId = pluginOfAgentRole(row?.source_role_id);
  if (!row || !pluginId) return null;
  return {...row, space_id: actor.space_id, agent_id: actor.agent_id, plugin_id: pluginId, source_role_id: row.source_role_id!,
    instructed_by_user_id: row.instructed_by_user_id ?? actor.on_behalf_of_user_id ?? null};
}

async function refuseUnadmitted(db: Queryable, config: ServerConfig | undefined, run: CompanionRun): Promise<void> {
  const refused = await pluginRoleAgentRefusal(db, config, run, run.source_role_id);
  if (refused) throw new OperationRefusal(409, 'plugins', refused.error_message, {reason: refused.error_code});
}

/**
 * The locks a companion Agent's admission is decided under, after the Room
 * execution boundary (`lockRoomExecutionAuthority`) when the Run has a Room:
 * the plugin scope `FOR SHARE` (installs and enablements, which a disable
 * holds for update) and, for a Project-bound package, the Project binding row
 * `FOR SHARE` (which an unbind holds for update). Ask `pluginRoleAgentRefusal`
 * in a later statement so it reads what committed before these locks.
 */
export async function lockPluginRoleAgentAdmission(db: Queryable, config: ServerConfig | undefined, pluginId: string, run: {
  space_id: string; instructed_by_user_id?: string | null; project_id?: string | null;
}): Promise<void> {
  if (run.instructed_by_user_id) await lockOperationPluginScope(db, pluginId, run.space_id, run.instructed_by_user_id, config);
  if (run.project_id && projectBoundManifest(config, pluginId)) await isPluginProjectBound(db, pluginId, run.space_id, run.project_id, true);
}

/**
 * The admission again inside an Agent command's transaction, before the core
 * pins the person and the Run (the registration's `lockBeforeActor` point):
 * the Run's Project `FOR UPDATE` first, the aggregate fence an Agent command
 * takes anyway (`lockAgentProjectBeforeActor`), so no command holds it
 * `FOR SHARE` and upgrades later; then the Room boundary, then the plugin
 * locks, then the decision. An unbind, disable or Room withdrawal that
 * committed after `OperationExecutor.admit` passed refuses the command here;
 * one that comes later waits for it. Other Agents and people pass untouched.
 *
 * `release` is the same decision in a result's release transaction
 * (`OperationExecutor`, before the operation's `releaseGate`), for a fresh
 * query or command result and for a receipt replay alike: a query's own
 * transaction is read-only and cannot lock, so a Room removal or audience
 * freeze that commits after its entry is seen only here. The Project is taken
 * `FOR SHARE`, the strength every release gate takes it at next, so the
 * release upgrades no lock; the order (Project → Room → plugin scope and
 * binding → then the gate's people and Run) is the command's.
 */
export async function assertPluginRoleAgentAdmittedLocked(db: Queryable, config: ServerConfig | undefined, actor: OperationActor, mode: 'command' | 'release' = 'command'): Promise<void> {
  const run = await companionRun(db, actor);
  if (!run) return;
  if (run.project_id) {
    await db.query(`SELECT id FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL ${mode === 'release' ? 'FOR SHARE' : 'FOR UPDATE'}`, [run.project_id, run.space_id]);
    const placement = await runExecutionPlacement(db, run.space_id, run);
    if (placement.room_id) await lockRoomExecutionAuthority(db, run.space_id, run.project_id, placement.room_id);
  }
  await lockPluginRoleAgentAdmission(db, config, run.plugin_id, run);
  await refuseUnadmitted(db, config, run);
}
