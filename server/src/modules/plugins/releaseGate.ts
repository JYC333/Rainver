import {GMAIL_APPLICATION_FACTS_LIST_ACTION,PLUGIN_DATA_CLASS_RANK,type OperationActor,type PluginDataClass,type PluginOperationManifest} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {assertCurrentActor} from '../systemActions/operations/actor.js';
import {canonical} from '../systemActions/operations/repository.js';
import {persistRunContextTaint} from '../runs/contextTaint.js';
import {GMAIL_DIGEST_CONSENT_ID} from '../sources/gmail/gmailDigests.js';
import {recordAgentDataRead, resultResourceIds} from '../contentAccess/agentReads.js';
import {ContentAccessAuditService} from '../contentAccess/audit.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {contentAclProjects} from '../runtimeContext/envelopeAuthority.js';
import {lockActivePeople} from '../access/activePerson.js';
import {sourceLineageReadable} from '../retrieval/sourcePolicy.js';
import {perReaderRead, pluginDataFacts, runAudience, sharedAudience, UNKNOWN_AUDIENCE} from './dataAccess.js';
import {dependencyIds, lockOperationPluginScope, operationPluginEnabled} from './operationEnablement.js';

/**
 * Release gate for plugin operation results (ADR 0030).
 *
 * Classification is trusted only from the raw executor output, before the
 * declared output schema can strip a `data_class` label: a label anywhere in
 * the output may raise the class, never lower it below the operation's pinned
 * class, and any label above that class (or not a class at all) withholds the
 * whole result. Every released result — query, command, and idempotent
 * command replay — then passes `releasePluginResult` in a separate audit
 * transaction that must commit before the result leaves the server.
 */
const CLASSES = new Set<string>(['non_sensitive', 'personal', 'sensitive']);
const withheld = () => new OperationError('operation_audit_unavailable', 503, true);

export function assertOutputWithinClass(raw: unknown, operationClass: PluginDataClass): void {
  const stack: Array<[unknown, number]> = [[raw, 0]];
  let visited = 0;
  while (stack.length) {
    const [value, depth] = stack.pop()!;
    if (!value || typeof value !== 'object') continue;
    if (++visited > 100_000 || depth > 64) throw withheld();
    const children = Array.isArray(value) ? value : Object.entries(value).map(([key, child]) => {
      if (key === 'data_class' && (typeof child !== 'string' || !CLASSES.has(child) || PLUGIN_DATA_CLASS_RANK[child as PluginDataClass] > PLUGIN_DATA_CLASS_RANK[operationClass])) throw withheld();
      return child;
    });
    for (const child of children) stack.push([child, depth + 1]);
  }
}

export type PluginReference = {type: 'task' | 'artifact' | 'space_object'; id: string};
/** Host-computed facts of one execution, persisted with a command receipt so a replay is rechecked against the same closure. */
export interface PluginReleaseFacts {
  v: 1;
  /** The audience whose readable intersection a shared personal read was computed for. */
  audience?: string[];
  /** References the plugin resolved through the core port. */
  references?: PluginReference[];
  /** The bound Project of a Project-bound operation, which every resolved reference must stay in. */
  project_id?: string;
  /** Bundled Applications row IDs; the host verifies the released Project and owner at audit time. */
  applicationIds?: string[];
  applicationRelatedIds?: string[];
  applicationProjectOnly?: boolean;
}
export const RELEASE_FACTS = Symbol('rainver.plugin.release_facts');
export function attachReleaseFacts(raw: unknown, facts: PluginReleaseFacts): void {
  if (!facts.audience && !facts.references?.length && !facts.applicationIds) return;
  if (!raw || typeof raw !== 'object') throw withheld();
  Object.defineProperty(raw, RELEASE_FACTS, {value: facts, enumerable: false});
}
export function readReleaseFacts(raw: unknown): PluginReleaseFacts | null {
  return raw && typeof raw === 'object' ? (raw as {[RELEASE_FACTS]?: PluginReleaseFacts})[RELEASE_FACTS] ?? null : null;
}

interface ReleaseRun {id: string; visibility: 'private' | 'selected_users' | 'space_shared'; owner_user_id: string | null; session_id: string | null; project_id: string | null; agent_id: string | null}

/**
 * The closure a resolved reference must satisfy for the actor's current
 * readers: the canonical content gate answers `full` for every reader
 * (oversight excluded: copying into a shared Run output is publication), and
 * an Agent's Run never reaches another Project's content. Shared by the port
 * at execution and by the release recheck. Returns owner/visibility for taint.
 */
export async function referenceReadable(db: Queryable, actor: OperationActor, ref: PluginReference, readers: readonly string[], run: Pick<ReleaseRun, 'project_id' | 'agent_id'> | null, boundProject?: string): Promise<{ownerUserId: string | null; visibility: 'private' | 'selected_users' | 'space_shared'} | null> {
  if (!readers.length || readers.includes(UNKNOWN_AUDIENCE)) return null;
  for (const userId of readers) if (await contentDecisionFromDb(db, {spaceId: actor.space_id, userId}, ref.type, ref.id, {includeOversight: false}) !== 'full') return null;
  // A Note's text answers to its Source lineage too (inherited lineage included): every
  // reader, and the Agent reading for them, must still be admitted by each Source.
  if (ref.type === 'space_object') {
    const agentId = actor.principal.kind === 'agent' ? actor.agent_id ?? null : null;
    for (const userId of readers) if (!await sourceLineageReadable(db, actor.space_id, 'note', [ref.id], {viewerUserId: userId, agentId})) return null;
  }
  // A Project-bound operation references only its bound Project's own objects, for a person too.
  // A space object (a Note through the `notes.read` port) may also belong to no Project at all —
  // a reusable personal Note — but its whole Project closure (owner Project and every Project it
  // is shared with) must stay inside the bound Project.
  if (boundProject !== undefined) {
    if (ref.type === 'space_object') {
      if ((await contentAclProjects(db, actor.space_id, ref.type, ref.id)).some(p => p !== boundProject)) return null;
    } else {
      const table = ref.type === 'task' ? 'tasks' : 'artifacts';
      const own = (await db.query<{project_id: string | null}>(`SELECT project_id FROM ${table} WHERE id=$1 AND space_id=$2`, [ref.id, actor.space_id])).rows[0]?.project_id ?? null;
      if (own !== boundProject) return null;
    }
  }
  if (actor.principal.kind === 'agent') {
    const agent = (await db.query<{access_project_id: string | null}>('SELECT access_project_id FROM agents WHERE id=$1 AND space_id=$2', [actor.agent_id, actor.space_id])).rows[0];
    const bound = run?.project_id ?? agent?.access_project_id ?? null;
    if (agent?.access_project_id && run?.project_id && agent.access_project_id !== run.project_id) return null;
    const table = {task: 'tasks', artifact: 'artifacts', space_object: 'space_objects'}[ref.type];
    const own = ref.type === 'space_object' ? null : (await db.query<{project_id: string | null}>(`SELECT project_id FROM ${table} WHERE id=$1 AND space_id=$2`, [ref.id, actor.space_id])).rows[0]?.project_id ?? null;
    const projects = new Set([...await contentAclProjects(db, actor.space_id, ref.type, ref.id), ...(own ? [own] : [])]);
    if (bound ? [...projects].some(p => p !== bound) : projects.size > 0) return null;
  }
  const definition = contentResourceDefinition(ref.type)!;
  const row = (await db.query<{owner: string | null; visibility: string}>(`SELECT ${definition.ownerColumn} AS owner, visibility FROM ${definition.tableName} WHERE id=$1 AND space_id=$2`, [ref.id, actor.space_id])).rows[0];
  if (!row) return null;
  const visibility = row.visibility === 'space_shared' || row.visibility === 'selected_users' ? row.visibility : 'private';
  return {ownerUserId: row.owner, visibility};
}

export const APPLICATION_DRAFT_PREVIEW = 'plugin.phd_application.material.get_generation';

export function isApplicationDraftAction(id: string): boolean {
  return id === 'plugin.phd_application.material.generate' || id === APPLICATION_DRAFT_PREVIEW ||
    id === 'plugin.phd_application.material.apply_generation';
}

/** Readers an actor's output reaches: the person alone, or an Agent Run's live audience. */
export async function actorReaders(db: Queryable, actor: OperationActor): Promise<{readers: string[]; run: ReleaseRun | null}> {
  if (actor.principal.kind !== 'agent') return {readers: [actor.on_behalf_of_user_id!], run: null};
  const run = (await db.query<ReleaseRun>('SELECT id,visibility,owner_user_id,session_id,project_id,agent_id FROM runs WHERE id=$1 AND space_id=$2', [actor.run_id, actor.space_id])).rows[0];
  if (!run) return {readers: [], run: null};
  return {readers: await runAudience(db, {spaceId: actor.space_id, visibility: run.visibility, ownerUserId: run.owner_user_id, sessionId: run.session_id, runId: run.id}), run};
}

/**
 * Releases one plugin result. Lock order, discovered in full before the first
 * lock and identical to every writer's: (an Agent's Project-bound result: its
 * Project with the person's member row, taken first by the caller in
 * `operationRegistry.ts`) → people (users → memberships) → Run
 * (FOR UPDATE; taint) → plugin installs → enablements (whole dependency
 * closure, sorted) → consent row (FOR SHARE). Disable/uninstall take the
 * install row FOR UPDATE and revocation the consent row FOR UPDATE, so each
 * either commits first (this release rechecks and withholds) or waits for it.
 * The command transaction holds the Run only FOR SHARE and has committed
 * before this runs, so no lock is ever upgraded.
 */
export async function releasePluginResult(db: Queryable, config: ServerConfig, manifest: PluginOperationManifest, op: {id: string; kind: 'query' | 'command'; data_class: PluginDataClass}, actor: OperationActor, data: unknown, facts: PluginReleaseFacts | null, boundProjectId?: string) {
  const person = actor.on_behalf_of_user_id!;
  const references = facts?.references ?? [];
  if (actor.principal.kind !== 'agent') {
    try { await lockActivePeople(db, actor.space_id, [person]); } catch { throw withheld(); }
    await lockOperationPluginScope(db, manifest.id, actor.space_id, person, config);
    if (!await operationPluginEnabled(db, manifest.id, actor.space_id, person, config)) throw withheld();
    // A person's own read: references are rechecked and cross-person ones recorded under B11.
    if (references.length) await releaseReferences(db, actor, references, [person], null, facts?.project_id);
    return;
  }
  const discovered = await actorReaders(db, actor);
  if (!discovered.run || discovered.readers.includes(UNKNOWN_AUDIENCE)) throw withheld();
  const shared = sharedAudience({audience: discovered.readers, instructingUserId: person});
  // A shared per-reader read (personal, or any caller_owned query) is released only for the audience
  // it was intersected for; it, or a reference checked for every reader, needs every reader pinned.
  const perReader = shared && perReaderRead(manifest, op);
  const pinned = perReader || shared && references.length ? discovered.readers : [person];
  try { await lockActivePeople(db, actor.space_id, pinned); } catch { throw withheld(); }
  const run = (await db.query<ReleaseRun>('SELECT id,visibility,owner_user_id,session_id,project_id,agent_id FROM runs WHERE id=$1 AND space_id=$2 FOR UPDATE', [actor.run_id, actor.space_id])).rows[0];
  if (!run) throw withheld();
  try { await assertCurrentActor(db, actor); } catch { throw withheld(); }
  const readers = (await actorReaders(db, actor)).readers;
  if (op.id === APPLICATION_DRAFT_PREVIEW && (readers.length !== 1 || readers[0] !== person)) throw withheld();
  if (canonical(readers) !== canonical(discovered.readers)) throw withheld();
  if (perReader && canonical(facts?.audience ?? null) !== canonical(readers)) throw withheld();
  const ids = dependencyIds(manifest.id, config);
  const members = perReader ? readers : [person];
  await db.query('SELECT id FROM plugin_installs WHERE plugin_id=ANY($1::text[]) ORDER BY plugin_id FOR SHARE', [ids]);
  await db.query('SELECT id FROM official_plugin_enablements WHERE plugin_id=ANY($1::text[]) AND (space_id=$2 OR user_id=ANY($3::varchar[])) ORDER BY plugin_id,id FOR SHARE', [ids, actor.space_id, members]);
  for (const member of members) if (!await operationPluginEnabled(db, manifest.id, actor.space_id, member, config)) throw withheld();
  const consent = await pluginDataFacts(db, config, actor, op.id, true);
  if (!consent || consent === 'pin_mismatch' || !consent.consent) throw withheld();
  const referenceTaint = references.length ? await releaseReferences(db, actor, references, readers, run, facts?.project_id) : [];
  // The owner's ledger of what their mail recorded (ADR 0034) is their mail's: released only while the Run is
  // still in their own private conversation of that Project (rechecked here, under the Run lock), and held
  // by the Run as a read of that mail, so its outward writes are refused also when it never read Gmail.
  const gmailDerived = op.id === GMAIL_APPLICATION_FACTS_LIST_ACTION;
  if (gmailDerived) {
    const {gmailApplicationFactsAudienceAdmitted} = await import('../sources/gmail/gmailApplicationUpdates.js');
    if (!boundProjectId || !await gmailApplicationFactsAudienceAdmitted(db, actor, {project_id: boundProjectId})) throw withheld();
  }
  if (consent.dataClass !== 'non_sensitive' || referenceTaint.length || gmailDerived) {
    await persistRunContextTaint(db, {
      runId: run.id, spaceId: actor.space_id, instructingUserId: person, runVisibility: run.visibility,
      items: [...(consent.dataClass !== 'non_sensitive' || gmailDerived ? [{ownerUserId: person, visibility: 'private' as const}] : []), ...referenceTaint],
      pluginReads: [
        ...(consent.dataClass !== 'non_sensitive' ? [{plugin_id: manifest.id, data_class: consent.dataClass, owner_user_id: person}] : []),
        ...(gmailDerived ? [{plugin_id: GMAIL_DIGEST_CONSENT_ID, data_class: 'sensitive' as const, owner_user_id: person}] : []),
      ],
    });
  }
  if (!facts?.applicationIds) await recordAgentDataRead(db, {
    spaceId: actor.space_id, ownerUserId: person, runId: run.id, agentId: actor.agent_id, actionId: op.id, resourceType: `plugin.${manifest.id}`,
    resourceIds: resultResourceIds(data), dataClass: consent.dataClass, grantId: consent.grantId,
  });
  return consent;
}

/** Rechecks every resolved reference for the current readers and records it: B11 for cross-person rows, the owner log for an Agent's same-owner rows. */
async function releaseReferences(db: Queryable, actor: OperationActor, references: readonly PluginReference[], readers: readonly string[], run: ReleaseRun | null, boundProject?: string) {
  const taint: Array<{ownerUserId: string | null; visibility: 'private' | 'selected_users' | 'space_shared'}> = [];
  const byType = new Map<string, string[]>();
  for (const ref of references) {
    const readable = await referenceReadable(db, actor, ref, readers, run, boundProject);
    if (!readable) throw withheld();
    taint.push(readable);
    byType.set(ref.type, [...(byType.get(ref.type) ?? []), ref.id]);
  }
  for (const [resourceType, resourceIds] of byType) {
    await new ContentAccessAuditService(db).recordReads({
      spaceId: actor.space_id, resourceType, resourceIds, viewerUserId: actor.on_behalf_of_user_id!,
      agentId: actor.agent_id, runId: actor.run_id, actionId: actor.principal.kind === 'agent' ? 'plugin.core.references.resolve' : null,
      accessType: 'plugin_reference', reason: 'Plugin core reference',
    });
  }
  return taint;
}
