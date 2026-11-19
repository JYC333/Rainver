import {randomUUID} from 'node:crypto';
import {diffPluginToolset,type PluginDataConsentOption,type PluginDataGrant,type PluginOperationManifest,type PluginToolPin} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {admitGrantTarget} from '../personalMemoryGrants/admission.js';
import {operationPackageFacts, operationPackages} from './operationRegistry.js';
import {operationPluginEnabled} from './operationEnablement.js';
import {currentExpansion} from './dataAccess.js';
import {coreDataToolByConsentId, coreDataToolIdentity, coreDataToolManifest} from './coreDataTools.js';
import {endPendingCoreConsentRequests} from '../policy/consentRequestLifecycle.js';

interface Row {
  id: string; space_id: string; plugin_id: string; toolset: 'read' | 'write'; data_class: 'personal' | 'sensitive'; scope: 'space' | 'run' | 'background' | 'project';
  project_id: string | null; connection_id: string | null; purpose: PluginDataGrant['purpose'];
  data_owner_user_id: string | null; granted_by_user_id: string; target_run_id: string | null; plugin_version: string; authority_hash: string;
  expanded_json: unknown; status: 'active' | 'revoked' | 'expired'; expires_at: Date | string | null; revoked_at: Date | string | null; created_at: Date | string;
}
const COLUMNS = 'id,space_id,plugin_id,toolset,data_class,scope,project_id,connection_id,purpose,data_owner_user_id,granted_by_user_id,target_run_id,plugin_version,authority_hash,expanded_json,status,expires_at,revoked_at,created_at';
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
export interface GrantCreate {
  plugin_id: string; toolset: 'read' | 'write'; data_class: 'personal' | 'sensitive'; scope: 'space' | 'run' | 'background' | 'project';
  /** For `run` scope the Run consented for; for a core tool's `project` scope the Run whose conversation the owner consented from (not stored). */
  target_run_id?: string; expires_in_seconds?: number;
  /** `project` scope: the resource the refused call would have read (for Gmail, the connection). */
  binding_id?: string | null;
  /**
   * `project` scope: what the owner was shown when the request was made (ADR 0033). The consent is
   * written only when every part still holds live and is identical; none means a request made under
   * the earlier per-Run consent, which is never approved into a standing one.
   */
  frozen_binding?: FrozenConsentBinding | null;
  /**
   * The package contract identity of the option the person confirmed. Every
   * person-facing `create` carries it (the operation schema requires it); the
   * authorization-request approval path consents to the requested tool itself.
   */
  authority_hash?: string;
}
type Identity = {spaceId: string; userId: string};
export interface FrozenConsentBinding {owner_user_id: string; project_id: string; binding_id: string; generation: number; purpose: string}

/**
 * Ends a person's standing Project consents (ADR 0033) when they lose what the consent rests on: in a
 * Project membership writer, after its `lockProjectAudienceForChange`, for that Project; at account
 * disable for every Project. Status `revoked`, kept as history; pending requests for one end (`expired`). A
 * later re-admission restores neither, so regaining access needs a new confirmation. A read in flight
 * holds the Project `FOR SHARE` at release and rechecks the consent there, so it either commits first or
 * sees this.
 */
export async function endProjectDataConsents(db: Queryable, input: {spaceId?: string; projectId?: string; userId: string; endedByUserId: string}): Promise<void> {
  await db.query(`UPDATE plugin_data_grants SET status='revoked',revoked_at=now(),revoked_by_user_id=$4,updated_at=now()
    WHERE data_owner_user_id=$3 AND scope='project' AND status='active' AND ($1::varchar IS NULL OR space_id=$1) AND ($2::varchar IS NULL OR project_id=$2)`,
    [input.spaceId ?? null, input.projectId ?? null, input.userId, input.endedByUserId]);
  // A pending card asking for such a consent ends with it, so being re-admitted never lets it be approved.
  await endPendingCoreConsentRequests(db, {ownerUserId: input.userId, spaceId: input.spaceId, projectId: input.projectId});
}

/**
 * Canonical writer of `plugin_data_grants` (ADR 0030). A sensitive grant is
 * written only by the data owner — for caller-owned plugin data, the person
 * the Run acts for — and never by a requester or an administrator on their
 * behalf; personal consent is a Space owner's. Re-consent supersedes the
 * previous active grant of the same key; revocation is final.
 */
export class PluginDataGrantRepository {
  constructor(private readonly db: Queryable, private readonly config: ServerConfig) {}

  private manifest(pluginId: string): {manifest: PluginOperationManifest; hash: string} {
    const core = coreDataToolByConsentId(pluginId);
    if (core) return {manifest: coreDataToolManifest(core), hash: coreDataToolIdentity(core)};
    const facts = operationPackageFacts(this.config, pluginId);
    if (!facts) throw new HttpError(404, 'Plugin not found');
    return {manifest: facts.manifest, hash: facts.identity};
  }

  /** Writers hold the role row until commit; the read-only list must not lock. */
  private async spaceOwner(identity: Identity, lock = true): Promise<boolean> {
    return (await this.db.query(`SELECT 1 FROM space_memberships m JOIN users u ON u.id=m.user_id WHERE m.space_id=$1 AND m.user_id=$2 AND m.status='active' AND m.role='owner' AND u.status='active'${lock ? ' FOR SHARE OF m' : ''}`, [identity.spaceId, identity.userId])).rows.length > 0;
  }

  async create(identity: Identity, input: GrantCreate): Promise<PluginDataGrant> {
    // Identity, expansion and pinned hash come from the same immutable composed
    // facts, so a confirmed identity that still matches expands to exactly the
    // tools shown; an upgrade composes new facts and a new identity.
    const {manifest, hash} = this.manifest(input.plugin_id);
    if (input.data_class === 'personal' && (input.scope !== 'space' || input.target_run_id)) throw new HttpError(422, 'Personal consent is Space-wide');
    if (input.data_class === 'sensitive' && input.scope === 'space') throw new HttpError(422, 'Sensitive consent is bound to a Run or to your own unattended Runs');
    if (input.scope !== 'project' && input.scope === 'run' !== !!input.target_run_id) throw new HttpError(422, 'target_run_id is required exactly for Run consent');
    if (input.scope === 'background' && input.toolset !== 'read') throw new HttpError(422, 'Background consent is read-only');
    if (input.data_class === 'personal' && !await this.spaceOwner(identity)) throw new HttpError(403, 'Only a Space owner gives personal-data consent');
    if (input.scope === 'run') await admitGrantTarget(this.db, identity.userId, identity.spaceId, input.target_run_id!);
    const core = coreDataToolByConsentId(input.plugin_id);
    let binding: Awaited<ReturnType<NonNullable<typeof core>['consentTarget']>> | null = null;
    if (core) {
      // A core sensitive tool's one consent is the owner's standing Project consent (ADR 0033 §6), given from a
      // Run of their own turn in an ordinary conversation of that Project while the tool is available there and
      // every reader reads the Project (`consentTarget` rechecks this at approval).
      if (input.data_class !== 'sensitive' || input.scope !== 'project' || input.toolset !== 'read' || !input.target_run_id) throw new HttpError(422, 'This consent exists only for a Project');
      await admitGrantTarget(this.db, identity.userId, identity.spaceId, input.target_run_id);
      const session = (await this.db.query<{session_id: string | null}>('SELECT session_id FROM runs WHERE id=$1 AND space_id=$2', [input.target_run_id, identity.spaceId])).rows[0]?.session_id ?? null;
      if (!await core.available(this.db, {spaceId: identity.spaceId, userId: identity.userId, sessionId: session})) throw new HttpError(404, 'Plugin not found');
      const frozen = input.frozen_binding;
      if (!frozen) throw new HttpError(409, 'This request was made under the earlier per-turn consent and cannot be approved; reject it and ask again', {code: 'consent_request_superseded'});
      if (frozen.owner_user_id !== identity.userId) throw new HttpError(403, 'Only the mailbox owner gives this consent');
      binding = await core.consentTarget(this.db, {spaceId: identity.spaceId, ownerUserId: identity.userId, runId: input.target_run_id, bindingId: frozen.binding_id, lock: true});
      // Nothing the owner was not shown: same Project, same connection at the same generation, same purpose.
      if (binding.projectId !== frozen.project_id || binding.bindingId !== frozen.binding_id || binding.generation !== frozen.generation || binding.purpose !== frozen.purpose)
        throw new HttpError(409, 'The mailbox or Project of this request changed after it was made; reject it and ask again', {code: 'consent_request_changed'});
    } else if (input.scope === 'project') throw new HttpError(422, 'Project consent exists only for a core data tool');
    else if (!await operationPluginEnabled(this.db, input.plugin_id, identity.spaceId, identity.userId, this.config)) throw new HttpError(404, 'Plugin not found');
    if (input.authority_hash !== undefined && input.authority_hash !== hash) throw new HttpError(409, 'This plugin changed after you reviewed it; refresh and confirm the consent again');
    const expanded = currentExpansion({manifest}, input.toolset, input.data_class);
    if (!expanded.length) throw new HttpError(422, 'This plugin has no tools of that class and toolset');
    // A Project consent stands until revoked (ADR 0033); it ends with the connection generation it names.
    const seconds = input.scope === 'project' ? undefined : input.expires_in_seconds ?? (input.data_class === 'sensitive' ? (input.scope === 'run' ? 3600 : 86_400) : undefined);
    const expiresAt = seconds === undefined ? null : new Date(Date.now() + seconds * 1000).toISOString();
    const owner = input.data_class === 'sensitive' ? identity.userId : null;
    const storedRun = input.scope === 'run' ? input.target_run_id! : null;
    const key = [identity.spaceId, input.plugin_id, input.toolset, input.data_class, input.scope, storedRun ?? '', owner ?? '', binding?.projectId ?? '', binding?.bindingId ?? '', binding?.purpose ?? ''];
    const previous = (await this.db.query<{id: string}>(`SELECT id FROM plugin_data_grants WHERE space_id=$1 AND plugin_id=$2 AND toolset=$3 AND data_class=$4 AND scope=$5 AND COALESCE(target_run_id,'')=$6 AND COALESCE(data_owner_user_id,'')=$7
      AND COALESCE(project_id,'')=$8 AND COALESCE(connection_id,'')=$9 AND COALESCE(purpose,'')=$10 AND status='active' ORDER BY id FOR UPDATE`, key)).rows;
    if (previous.length) await this.db.query(`UPDATE plugin_data_grants SET status=CASE WHEN expires_at IS NOT NULL AND expires_at<=now() THEN 'expired' ELSE 'revoked' END,
      revoked_at=CASE WHEN expires_at IS NOT NULL AND expires_at<=now() THEN NULL ELSE now() END,revoked_by_user_id=CASE WHEN expires_at IS NOT NULL AND expires_at<=now() THEN NULL ELSE $2 END,updated_at=now() WHERE id=ANY($1::varchar[])`, [previous.map(r => r.id), identity.userId]);
    const row = await this.db.query<Row>(`INSERT INTO plugin_data_grants (id,space_id,plugin_id,toolset,data_class,scope,data_owner_user_id,granted_by_user_id,target_run_id,plugin_version,authority_hash,expanded_json,status,expires_at,
        project_id,connection_id,connection_generation,purpose,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'active',$13,$14,$15,$16,$17,now(),now()) RETURNING ${COLUMNS}`,
      [randomUUID(), identity.spaceId, input.plugin_id, input.toolset, input.data_class, input.scope, owner, identity.userId, storedRun, manifest.version, hash, JSON.stringify(expanded), expiresAt,
        binding?.projectId ?? null, binding?.bindingId ?? null, binding?.generation ?? null, binding?.purpose ?? null])
      .catch((error: {code?: string}) => {
        // A concurrent consent for the same key won the partial unique index.
        if (error?.code === '23505') throw new HttpError(409, 'A consent for this scope was just written; read it and retry');
        throw error;
      });
    return this.out(row.rows[0]!);
  }

  /**
   * A core tool's standing Project consent given by its data owner through an owner-only confirmation
   * card rather than an authorization request (ADR 0033 phase B: a scheduled Gmail digest). The caller —
   * that card's applier — has already rechecked, under the owner's locks, everything the card showed.
   * Expansion and identity come from the core tool's pin, as for every core consent. Returns the id.
   */
  async createCoreProjectConsent(identity: Identity, input: {consentId: string; projectId: string; connectionId: string; generation: number; purpose: string}): Promise<string> {
    const core = coreDataToolByConsentId(input.consentId);
    if (!core) throw new HttpError(404, 'Plugin not found');
    const {manifest, hash} = this.manifest(input.consentId);
    const expanded = currentExpansion({manifest}, 'read', 'sensitive');
    const id = randomUUID();
    await this.db.query(`INSERT INTO plugin_data_grants (id,space_id,plugin_id,toolset,data_class,scope,data_owner_user_id,granted_by_user_id,target_run_id,plugin_version,authority_hash,expanded_json,status,expires_at,
        project_id,connection_id,connection_generation,purpose,created_at,updated_at)
      VALUES ($1,$2,$3,'read','sensitive','project',$4,$4,NULL,$5,$6,$7::jsonb,'active',NULL,$8,$9,$10,$11,now(),now())`,
      [id, identity.spaceId, input.consentId, identity.userId, manifest.version, hash, JSON.stringify(expanded), input.projectId, input.connectionId, input.generation, input.purpose])
      .catch((error: {code?: string}) => {
        if (error?.code === '23505') throw new HttpError(409, 'A consent for this scope already exists');
        throw error;
      });
    return id;
  }

  /** Locks the grant FOR UPDATE: the revocation side of the read finalization lock order. */
  async revoke(identity: Identity, grantId: string): Promise<PluginDataGrant> {
    const row = (await this.db.query<Row>(`SELECT ${COLUMNS} FROM plugin_data_grants WHERE id=$1 AND space_id=$2 FOR UPDATE`, [grantId, identity.spaceId])).rows[0];
    if (!row || !await this.mayManage(identity, row)) throw new HttpError(404, 'Grant not found');
    if (row.status !== 'active') return this.out(row);
    const updated = (await this.db.query<Row>(`UPDATE plugin_data_grants SET status='revoked',revoked_at=now(),revoked_by_user_id=$2,updated_at=now() WHERE id=$1 AND status='active' RETURNING ${COLUMNS}`, [grantId, identity.userId])).rows[0]!;
    return this.out(updated);
  }

  /**
   * One step: every active consent of the owner that reaches this Run — bound to
   * it, or a background or Project consent this Run's reads actually used (a
   * scheduled Run has no Run-bound grant; a core tool's Project consent is
   * standing, so revoking it here ends it for the whole Project). Never another
   * person's consent, a Space-wide personal opt-in, or a consent this Run never used.
   */
  async revokeRun(identity: Identity, runId: string): Promise<{run_id: string; revoked_grant_ids: string[]}> {
    const rows = (await this.db.query<{id: string}>(`SELECT id FROM plugin_data_grants WHERE space_id=$1 AND data_owner_user_id=$3 AND status='active'
      AND (target_run_id=$2 OR (scope IN ('background','project') AND id IN (SELECT grant_id FROM agent_data_read_logs WHERE space_id=$1 AND run_id=$2 AND owner_user_id=$3 AND grant_id IS NOT NULL)))
      ORDER BY id FOR UPDATE`, [identity.spaceId, runId, identity.userId])).rows;
    if (rows.length) await this.db.query(`UPDATE plugin_data_grants SET status='revoked',revoked_at=now(),revoked_by_user_id=$2,updated_at=now() WHERE id=ANY($1::varchar[]) AND status='active'`, [rows.map(r => r.id), identity.userId]);
    return {run_id: runId, revoked_grant_ids: rows.map(r => r.id)};
  }

  /** With `run_id`: the consents bound to that Run plus those its reads on this person's behalf used. */
  async list(identity: Identity, filter: {plugin_id?: string; status?: string; run_id?: string}): Promise<{items: PluginDataGrant[]; consentable?: PluginDataConsentOption[]}> {
    const owner = await this.spaceOwner(identity, false);
    const rows = (await this.db.query<Row>(`SELECT ${COLUMNS} FROM plugin_data_grants WHERE space_id=$1 AND (data_owner_user_id=$2 OR (data_class='personal' AND $3::boolean))
      AND ($4::varchar IS NULL OR plugin_id=$4) AND ($5::varchar IS NULL OR (CASE WHEN status='active' AND expires_at IS NOT NULL AND expires_at<=now() THEN 'expired' ELSE status END)=$5)
      AND ($6::varchar IS NULL OR target_run_id=$6 OR id IN (SELECT grant_id FROM agent_data_read_logs WHERE space_id=$1 AND run_id=$6 AND owner_user_id=$2 AND grant_id IS NOT NULL))
      ORDER BY created_at DESC, id DESC LIMIT 200`, [identity.spaceId, identity.userId, owner, filter.plugin_id ?? null, filter.status ?? null, filter.run_id ?? null])).rows;
    const items = rows.map(row => {
      const out = this.out(row);
      let reconsent = null;
      try {
        const current = currentExpansion({manifest: this.manifest(row.plugin_id).manifest}, row.toolset, row.data_class);
        const diff = diffPluginToolset(out.expanded, current);
        if (diff.added.length || diff.removed.length || diff.changed.length) reconsent = diff;
      } catch { reconsent = {added: [], removed: out.expanded.map(p => p.action_id), changed: []}; }
      return {...out, reconsent};
    });
    return filter.run_id ? {items} : {items, consentable: await this.consentable(identity, owner, items, filter.plugin_id)};
  }

  /**
   * What this person may consent to now, for each operation package enabled for
   * them: personal Space-wide consent only for a Space owner, sensitive only as
   * their own read-only background consent. `create` re-applies every rule.
   */
  private async consentable(identity: Identity, owner: boolean, items: readonly PluginDataGrant[], pluginId?: string): Promise<PluginDataConsentOption[]> {
    const options: PluginDataConsentOption[] = [];
    for (const plugin of operationPackages(this.config)) {
      const facts = operationPackageFacts(this.config, plugin.id);
      if (!facts || pluginId && plugin.id !== pluginId) continue;
      const candidates = [
        ...(owner ? (['read', 'write'] as const).map(toolset => ({toolset, data_class: 'personal' as const, scope: 'space' as const})) : []),
        {toolset: 'read' as const, data_class: 'sensitive' as const, scope: 'background' as const},
      ].map(c => ({...c, tools: currentExpansion({manifest: facts.manifest}, c.toolset, c.data_class)})).filter(c => c.tools.length);
      if (!candidates.length || !await operationPluginEnabled(this.db, plugin.id, identity.spaceId, identity.userId, this.config)) continue;
      for (const c of candidates) {
        const same = items.filter(g => g.plugin_id === plugin.id && g.toolset === c.toolset && g.data_class === c.data_class && g.scope === c.scope && (c.data_class === 'personal' || g.data_owner_user_id === identity.userId));
        const latest = same[0];
        const diff = latest ? diffPluginToolset(latest.expanded, c.tools) : null;
        options.push({
          plugin_id: plugin.id, plugin_name: facts.manifest.name, plugin_version: facts.manifest.version, authority_hash: facts.identity, ...c,
          default_expires_in_seconds: c.data_class === 'sensitive' ? 86_400 : null,
          active_grant_id: same.find(g => g.status === 'active')?.id ?? null,
          changes: diff && (diff.added.length || diff.removed.length || diff.changed.length) ? diff : null,
        });
      }
    }
    return options;
  }

  async get(identity: Identity, grantId: string): Promise<PluginDataGrant | null> {
    const row = (await this.db.query<Row>(`SELECT ${COLUMNS} FROM plugin_data_grants WHERE id=$1 AND space_id=$2`, [grantId, identity.spaceId])).rows[0];
    return row && await this.mayManage(identity, row, false) ? this.out(row) : null;
  }

  private async mayManage(identity: Identity, row: Row, lock = true): Promise<boolean> {
    return row.data_class === 'sensitive' ? row.data_owner_user_id === identity.userId : this.spaceOwner(identity, lock);
  }

  private out(row: Row): PluginDataGrant {
    const expired = row.status === 'active' && row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now();
    return {
      id: row.id, space_id: row.space_id, plugin_id: row.plugin_id, toolset: row.toolset, data_class: row.data_class, scope: row.scope,
      project_id: row.project_id, connection_id: row.connection_id, purpose: row.purpose,
      data_owner_user_id: row.data_owner_user_id, granted_by_user_id: row.granted_by_user_id, target_run_id: row.target_run_id,
      plugin_version: row.plugin_version, authority_hash: row.authority_hash, expanded: (Array.isArray(row.expanded_json) ? row.expanded_json : []) as PluginToolPin[],
      status: expired ? 'expired' : row.status, expires_at: iso(row.expires_at), revoked_at: iso(row.revoked_at), created_at: iso(row.created_at)!,
    };
  }
}
