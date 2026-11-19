import {pluginToolsetExpansion,type OperationActor,type PluginDataClass,type PluginOperationManifest,type PluginToolPin,type PluginToolset,type RunToolGrant} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import {operationPackageFacts} from './operationRegistry.js';
import {coreDataTool, coreDataToolByConsentId, coreDataToolIdentity, coreDataToolManifest} from './coreDataTools.js';

/**
 * Plugin data-class authority for Agents (ADR 0030).
 *
 * Effective Agent authority over a personal/sensitive plugin tool is the Run's
 * frozen tool snapshot (declaration ∩ allowance) ∩ scenario allowance ∩
 * data-side consent ∩ plugin enablement. Snapshot construction and every call
 * (including idempotent replay) evaluate the same predicates; the call-time
 * check re-reads the live Run, its audience and the consent row, and refuses
 * any pinned tool whose manifest contract changed since the snapshot/consent.
 * `non_sensitive` keeps its pre-existing behavior.
 */
export interface PluginToolMeta {
  pluginId: string;
  manifest: PluginOperationManifest;
  toolset: PluginToolset;
  pin: PluginToolPin;
  authorityHash: string;
}

export function pluginToolMeta(config: ServerConfig | undefined, actionId: string): PluginToolMeta | undefined {
  if (!actionId.startsWith('plugin.')) {
    // A core sensitive tool (ADR 0032) takes the same pin, scenario, consent and isolation path.
    const core = coreDataTool(actionId);
    return core ? {pluginId: core.consentId, manifest: coreDataToolManifest(core), toolset: 'read', pin: core.pin, authorityHash: coreDataToolIdentity(core)} : undefined;
  }
  const pluginId = actionId.split('.')[1]!;
  // The composed package's parsed, frozen manifest — the one its operations were registered from.
  const facts = operationPackageFacts(config, pluginId);
  const op = facts?.manifest.operations.find(o => o.id === actionId);
  if (!facts || !op) return undefined;
  const toolset: PluginToolset = op.kind === 'query' ? 'read' : 'write';
  return {
    pluginId, manifest: facts.manifest, toolset,
    pin: {action_id: op.id, action_version: op.version, data_class: op.data_class, side_effects: op.side_effects, gate_class: op.gate_class ?? null},
    authorityHash: facts.identity,
  };
}

export function samePin(a: PluginToolPin | undefined, b: PluginToolPin): boolean {
  return !!a && a.action_id === b.action_id && a.action_version === b.action_version && a.data_class === b.data_class && a.side_effects === b.side_effects && (a.gate_class ?? null) === (b.gate_class ?? null);
}

export function currentExpansion(meta: Pick<PluginToolMeta, 'manifest'>, toolset: PluginToolset, dataClass: PluginDataClass): PluginToolPin[] {
  return pluginToolsetExpansion(meta.manifest, toolset, dataClass);
}

export type ScenarioOrigin = 'manual' | 'scheduled' | 'delegated' | 'system';
export interface RunScenario {
  origin: ScenarioOrigin;
  instructingUserId: string | null;
  /** Every human who can read this Run's output. */
  audience: readonly string[];
}

/**
 * Delegation or an Agent instruction anywhere in the immediate Run marks it
 * delegated; continuation and system wakes fail closed. `effectiveOrigin` is
 * the Run lineage root's trigger origin (`OperationActor.effective_origin`),
 * so the immediate Run and its root must agree.
 */
export function scenarioOrigin(run: {trigger_origin: string; delegation_id?: string | null; instructed_by_agent_id?: string | null}, effectiveOrigin?: string): ScenarioOrigin {
  if (run.delegation_id || run.instructed_by_agent_id || run.trigger_origin === 'delegation' || effectiveOrigin === 'delegation' || effectiveOrigin === 'delegated') return 'delegated';
  if (run.trigger_origin === 'manual' && (effectiveOrigin === undefined || effectiveOrigin === 'manual')) return 'manual';
  if (run.trigger_origin === 'automation' && (effectiveOrigin === undefined || effectiveOrigin === 'automation')) return 'scheduled';
  return 'system';
}

/**
 * Who can read a Run's output: its Room's actual audience (the Rooms owner's
 * `roomAudience` — a mainline is every Project reader, a limited Room its
 * roster that can still read the Project), explicit selected-user grantees
 * plus the owner, every active Space member for a Space-shared Run. Computed
 * identically before insert (from creation input) and at call/release time
 * (from the stored Run). An unknown visibility or an unreadable Room yields a
 * marker no person matches, which refuses every personal/sensitive tool.
 */
export async function runAudience(db: Queryable, input: {
  spaceId: string; visibility: string; ownerUserId: string | null; sessionId: string | null; runId?: string; granteeUserIds?: readonly string[];
}): Promise<string[]> {
  const people = new Set<string>();
  if (input.ownerUserId) people.add(input.ownerUserId);
  if (input.sessionId) {
    const room = (await db.query<{room_id: string | null; id: string | null; project_id: string | null; is_mainline: boolean | null}>(`SELECT s.room_id,r.id,r.project_id,r.is_mainline FROM sessions s LEFT JOIN rooms r ON r.id=s.room_id AND r.space_id=s.space_id
      WHERE s.id=$1 AND s.space_id=$2`, [input.sessionId, input.spaceId])).rows[0];
    if (room?.id && room.project_id) {
      const {roomAudience} = await import('../rooms/threadReferences.js');
      for (const id of await roomAudience(db, input.spaceId, {id: room.id, project_id: room.project_id, is_mainline: !!room.is_mainline})) people.add(id);
    } else if (room?.room_id) people.add(UNKNOWN_AUDIENCE);
  }
  if (input.visibility === 'space_shared') {
    for (const row of (await db.query<{user_id: string}>(`SELECT user_id FROM space_memberships WHERE space_id=$1 AND status='active'`, [input.spaceId])).rows) people.add(row.user_id);
  } else if (input.visibility === 'selected_users') {
    for (const id of input.granteeUserIds ?? []) people.add(id);
    if (input.runId) for (const row of (await db.query<{grantee_user_id: string}>(`SELECT grantee_user_id FROM content_access_grants WHERE space_id=$1 AND resource_type='run' AND resource_id=$2 AND revoked_at IS NULL`, [input.spaceId, input.runId])).rows) people.add(row.grantee_user_id);
  } else if (input.visibility !== 'private') {
    people.add(UNKNOWN_AUDIENCE);
  }
  return [...people].sort();
}
export const UNKNOWN_AUDIENCE = '\u0000unknown-audience';

export type Eligibility = 'normal' | 'needs_space_consent' | 'needs_run_consent' | 'needs_background_consent' | 'refused';

/**
 * Scenario table of ADR 0030; pure so snapshot and call-time checks cannot drift.
 * A shared audience (multi-person Room, selected users, Space-shared Run) may
 * only get personal reads, and only as the readable intersection the release
 * gate computes and rechecks (`sharedAudience`); sensitive data and any write
 * stay owner-only. The instructing person's authority never stands in for
 * another reader's.
 */
export function pluginDataEligibility(pin: PluginToolPin, scenario: RunScenario): Eligibility {
  if (pin.data_class === 'non_sensitive') return 'normal';
  const person = scenario.instructingUserId;
  if (!person || !scenario.audience.includes(person) || scenario.audience.includes(UNKNOWN_AUDIENCE)) return 'refused';
  const write = pin.side_effects !== 'none';
  // A Project-bound core read (ADR 0033 §6, Gmail) may answer a shared conversation of its Project: the
  // owner's own turn or the scheduled Run of their digest, never a delegated or system Run. Whether every
  // reader still reads the consent's Project is decided with the consent (`audienceWithinProject`).
  const core = coreDataTool(pin.action_id);
  if (core?.projectBound && !write && core.pin.data_class === pin.data_class) {
    if (scenario.origin === 'manual' && core.origin === 'manual') return 'needs_run_consent';
    if (scenario.origin === 'scheduled' && core.origin === 'scheduled') return 'needs_background_consent';
    return 'refused';
  }
  if (sharedAudience(scenario)) return pin.data_class === 'personal' && !write && scenario.origin !== 'delegated' ? 'needs_space_consent' : 'refused';
  // Personal/sensitive writes are proposals only and only from a person's own turn.
  if (write && (pin.side_effects !== 'proposal' || scenario.origin !== 'manual')) return 'refused';
  // Personal consent is the Space owner's standing opt-in; sensitive consent never is.
  if (pin.data_class === 'personal') return 'needs_space_consent';
  // A plugin's per-Run consent, or a core tool's standing Project consent (ADR 0033): both only from the owner's own turn.
  if (scenario.origin === 'manual') return 'needs_run_consent';
  if (scenario.origin === 'scheduled' && !write) return 'needs_background_consent';
  return 'refused';
}

/**
 * Whether a shared Agent Run receives this read only as the readable intersection
 * of every reader's own result (ADR 0030 / B53). Personal reads always are; so is
 * every query of a caller_owned package, whose rows are per person even when not
 * personal data. Shared by execution and the release gate.
 */
export function perReaderRead(manifest: Pick<PluginOperationManifest, 'data_access'>, op: {kind: 'query' | 'command'; data_class: string}): boolean {
  return op.kind === 'query' && (op.data_class === 'personal' || manifest.data_access === 'caller_owned');
}
/** True when someone besides the instructing person can read the Run's output. */
export function sharedAudience(scenario: Pick<RunScenario, 'audience' | 'instructingUserId'>): boolean {
  return scenario.audience.some(id => id !== scenario.instructingUserId);
}

/** The live scenario of an Agent actor's Run, from the stored Run and current audience. */
export async function runScenario(db: Queryable, actor: OperationActor): Promise<RunScenario | null> {
  const run = (await db.query<Pick<CallRun, 'id' | 'space_id' | 'visibility' | 'owner_user_id' | 'session_id' | 'trigger_origin' | 'delegation_id' | 'instructed_by_agent_id'>>(`SELECT id,space_id,visibility,owner_user_id,session_id,trigger_origin,delegation_id,instructed_by_agent_id FROM runs WHERE id=$1 AND space_id=$2`, [actor.run_id, actor.space_id])).rows[0];
  if (!run) return null;
  return {
    origin: scenarioOrigin(run, actor.effective_origin),
    instructingUserId: actor.on_behalf_of_user_id,
    audience: await runAudience(db, {spaceId: run.space_id, visibility: run.visibility, ownerUserId: run.owner_user_id, sessionId: run.session_id, runId: run.id}),
  };
}

interface GrantRow {id: string; expanded_json: unknown}
const PIN_SQL = `status='active' AND (expires_at IS NULL OR expires_at>now())`;

/**
 * The active consent covering this exact pinned tool, or null. `lock` takes FOR SHARE (revocation takes FOR UPDATE).
 * A core data tool's only consent is the owner's standing Project consent its module finds (ADR 0033); `bindingId`
 * narrows it to one bound resource (for Gmail, the connection being read).
 */
export async function findConsent(db: Queryable, input: {
  spaceId: string; meta: PluginToolMeta; eligibility: Eligibility; ownerUserId: string | null; runId: string | null; lock?: boolean; bindingId?: string | null;
}): Promise<string | null> {
  const {meta} = input;
  let rows: GrantRow[] = [];
  const lock = input.lock ? ' FOR SHARE' : '';
  const core = coreDataToolByConsentId(meta.pluginId);
  if (core) {
    // Each core tool's consent admits only its own scenario: the owner's turn, or its scheduled Run.
    const scenarioMatches = core.origin === 'manual' ? input.eligibility === 'needs_run_consent' : input.eligibility === 'needs_background_consent';
    if (scenarioMatches && input.ownerUserId && input.runId)
      rows = await core.consents(db, {spaceId: input.spaceId, ownerUserId: input.ownerUserId, runId: input.runId, bindingId: input.bindingId, lock: input.lock});
  } else if (input.eligibility === 'needs_space_consent') {
    rows = (await db.query<GrantRow>(`SELECT id,expanded_json FROM plugin_data_grants WHERE space_id=$1 AND plugin_id=$2 AND toolset=$3 AND data_class='personal' AND scope='space' AND ${PIN_SQL} ORDER BY id${lock}`, [input.spaceId, meta.pluginId, meta.toolset])).rows;
  } else if (input.eligibility === 'needs_run_consent' && input.ownerUserId && input.runId) {
    rows = (await db.query<GrantRow>(`SELECT id,expanded_json FROM plugin_data_grants WHERE space_id=$1 AND plugin_id=$2 AND toolset=$3 AND data_class='sensitive' AND scope='run' AND target_run_id=$4 AND data_owner_user_id=$5 AND granted_by_user_id=$5 AND ${PIN_SQL} ORDER BY id${lock}`, [input.spaceId, meta.pluginId, meta.toolset, input.runId, input.ownerUserId])).rows;
  } else if (input.eligibility === 'needs_background_consent' && input.ownerUserId) {
    rows = (await db.query<GrantRow>(`SELECT id,expanded_json FROM plugin_data_grants WHERE space_id=$1 AND plugin_id=$2 AND toolset='read' AND data_class='sensitive' AND scope='background' AND data_owner_user_id=$3 AND granted_by_user_id=$3 AND ${PIN_SQL} ORDER BY id${lock}`, [input.spaceId, meta.pluginId, input.ownerUserId])).rows;
  }
  for (const row of rows) {
    const pinned = Array.isArray(row.expanded_json) ? row.expanded_json as PluginToolPin[] : [];
    if (samePin(pinned.find(p => p.action_id === meta.pin.action_id), meta.pin)) return row.id;
  }
  return null;
}

/** Snapshot-time pins for plugin tools; a pin mismatch at call time refuses the tool instead of silently following an upgrade. */
export function pluginToolPins(config: ServerConfig | undefined, grants: readonly RunToolGrant[]): Record<string, PluginToolPin> {
  const pins: Record<string, PluginToolPin> = {};
  for (const grant of grants) {
    const meta = pluginToolMeta(config, grant.action_id);
    if (meta) pins[grant.action_id] = meta.pin;
  }
  return pins;
}

/** Filter plugin tools out of a snapshot unless the scenario and data-side consent admit them. Names of refused tools are absent. */
export async function admitPluginDataTools(db: Queryable, config: ServerConfig | undefined, ids: readonly string[], context: {spaceId: string; scenario?: RunScenario | (() => Promise<RunScenario>)}): Promise<Set<string>> {
  const admitted = new Set<string>();
  // Computed only when a personal/sensitive tool is a candidate; other Runs issue no extra query.
  let scenario: RunScenario | undefined;
  const resolve = async () => scenario ??= typeof context.scenario === 'function' ? await context.scenario() : context.scenario;
  for (const id of ids) {
    const meta = pluginToolMeta(config, id);
    if (!meta) continue;
    if (meta.pin.data_class === 'non_sensitive') { admitted.add(id); continue; }
    if (!context.scenario) continue;
    const current = await resolve();
    if (!current) continue;
    const eligibility = pluginDataEligibility(meta.pin, current);
    if (eligibility === 'refused') continue;
    // A per-Run sensitive consent can only exist once the Run does, and a core tool's Project consent is
    // found against the Run's conversation at call time; the owner decides a missing one on request.
    if (eligibility === 'needs_run_consent') { admitted.add(id); continue; }
    // A core tool's consent is bound to the Run's conversation or delivery and found at call time; a core tool
    // of the other scenario is refused here (an on-demand read never runs scheduled, a digest read never manual).
    const core = coreDataToolByConsentId(meta.pluginId);
    if (core) { if (core.origin === 'scheduled' && eligibility === 'needs_background_consent') admitted.add(id); continue; }
    if (await findConsent(db, {spaceId: context.spaceId, meta, eligibility, ownerUserId: current.instructingUserId, runId: null})) admitted.add(id);
  }
  return admitted;
}

export interface PluginDataFacts {
  dataClass: PluginDataClass;
  consent: boolean;
  requestable: boolean;
  grantId: string | null;
  /** Live audience for personal/sensitive tools; null for normal tools, which have no audience rule. */
  audience: string[] | null;
  /** False when a sensitive tool's Run has no trusted network-isolation proof. */
  isolated?: boolean;
  /** False when a Project-bound read's audience reaches beyond its consent's Project. */
  withinProject?: boolean;
}

/**
 * Whether every reader of a Run's output reads `projectId` now (ADR 0033 §6): a Project-bound read is
 * released to the conversation's audience only while nobody outside that Project is in it. An unknown
 * audience never is.
 */
export async function audienceWithinProject(db: Queryable, spaceId: string, projectId: string, audience: readonly string[]): Promise<boolean> {
  if (!audience.length || audience.includes(UNKNOWN_AUDIENCE)) return false;
  const {canReadProject} = await import('../projects/access.js');
  for (const userId of audience) if (!await canReadProject(db, spaceId, projectId, userId)) return false;
  return true;
}

/**
 * Trusted network-isolation proof for a Run (ADR 0030): its latest attempt is
 * live, was launched, and the server recorded with that very launch nonce a
 * strict built-in Host (`hosts.kind = 'server'`, whose daemon applies the
 * bubblewrap namespace) and egress profile `none` (`--unshare-net`). The
 * record is written only by the dispatching server; no request reaches it.
 * `default`/`install` egress, a paired Host, an unlaunched or relaunched
 * attempt without a matching record all fail the proof.
 */
export async function runLaunchIsolated(db: Queryable, spaceId: string, runId: string): Promise<boolean> {
  const row = (await db.query<{ok: boolean}>(`SELECT (a.launch_isolation_json->>'egress_profile') = 'none' AND (a.launch_isolation_json->>'host_kind') = 'server' AND h.kind = 'server' AS ok
      FROM run_attempts a JOIN hosts h ON h.id = a.launch_isolation_json->>'host_id'
     WHERE a.space_id=$1 AND a.run_id=$2 AND a.status IN ('queued','running') AND a.launch_id IS NOT NULL AND a.launch_isolation_json->>'launch_id' = a.launch_id
       AND a.attempt_number = (SELECT max(c.attempt_number) FROM run_attempts c WHERE c.space_id=$1 AND c.run_id=$2)`, [spaceId, runId])).rows[0];
  return row?.ok === true;
}

interface CallRun {
  id: string; space_id: string; visibility: string; owner_user_id: string | null; session_id: string | null;
  trigger_origin: string; delegation_id: string | null; instructed_by_agent_id: string | null; instructed_by_user_id: string | null;
  permission_snapshot_json: unknown;
}

/**
 * Call-time recheck for an Agent's personal/sensitive plugin tool, against the
 * live Run, current audience, current manifest contract and the consent row.
 * Throws `pin` refusal (as not granted) when the frozen snapshot pin no longer
 * matches. Never consults the requester's or an administrator's authority in
 * place of the data owner's consent.
 */
export async function pluginDataFacts(db: Queryable, config: ServerConfig | undefined, actor: OperationActor, actionId: string, lock = false, bindingId?: string | null): Promise<PluginDataFacts | 'pin_mismatch' | null> {
  const meta = pluginToolMeta(config, actionId);
  if (!meta || actor.principal.kind !== 'agent') return null;
  const run = (await db.query<CallRun>(`SELECT id,space_id,visibility,owner_user_id,session_id,trigger_origin,delegation_id,instructed_by_agent_id,instructed_by_user_id,permission_snapshot_json FROM runs WHERE id=$1 AND space_id=$2`, [actor.run_id, actor.space_id])).rows[0];
  if (!run) return 'pin_mismatch';
  const pins = (run.permission_snapshot_json as {plugin_tool_pins?: Record<string, PluginToolPin>} | null)?.plugin_tool_pins;
  const pinned = pins?.[actionId];
  if (pinned ? !samePin(pinned, meta.pin) : meta.pin.data_class !== 'non_sensitive') return 'pin_mismatch';
  if (meta.pin.data_class === 'non_sensitive') return {dataClass: 'non_sensitive', consent: true, requestable: false, grantId: null, audience: null};
  const scenario = (await runScenario(db, actor))!;
  const eligibility = pluginDataEligibility(meta.pin, scenario);
  if (eligibility === 'refused' || eligibility === 'normal') return {dataClass: meta.pin.data_class, consent: false, requestable: false, grantId: null, audience: [...scenario.audience]};
  const core = coreDataToolByConsentId(meta.pluginId);
  // A person's consent cannot stand in for isolation: a plugin's sensitive data reaches only a Run whose live
  // launch the server recorded as a strict built-in Host namespace without network (ADR 0030). A Project-bound
  // core read runs on the conversation's own runtime instead (ADR 0033 §6); its boundary is the Project.
  if (meta.pin.data_class === 'sensitive' && !core?.projectBound && !await runLaunchIsolated(db, run.space_id, run.id)) return {dataClass: 'sensitive', consent: false, requestable: false, grantId: null, audience: [...scenario.audience], isolated: false};
  const grantId = await findConsent(db, {spaceId: run.space_id, meta, eligibility, ownerUserId: actor.on_behalf_of_user_id, runId: run.id, lock, bindingId});
  if (core?.projectBound) {
    // With a consent, its Project; without one, the Project a new consent from this conversation would bind.
    // Either way a reader outside it refuses with a fixed code and is never offered a consent card (ADR 0033 §6).
    const projectId = grantId
      ? (await db.query<{project_id: string | null}>(`SELECT project_id FROM plugin_data_grants WHERE id=$1 AND space_id=$2`, [grantId, run.space_id])).rows[0]?.project_id
      : (await db.query<{project_id: string | null}>(`SELECT project_id FROM sessions WHERE id=$1 AND space_id=$2`, [run.session_id, run.space_id])).rows[0]?.project_id;
    if (!projectId || !await audienceWithinProject(db, run.space_id, projectId, scenario.audience))
      return {dataClass: meta.pin.data_class, consent: false, requestable: false, grantId: null, audience: [...scenario.audience], withinProject: false};
  }
  return {dataClass: meta.pin.data_class, consent: !!grantId, requestable: !grantId && (eligibility === 'needs_run_consent' || eligibility === 'needs_space_consent'), grantId, audience: [...scenario.audience]};
}
