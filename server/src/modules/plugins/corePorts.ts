import {MemoryProposalCreateCommandSchema,PLUGIN_NOTE_TEXT_MAX,type OperationActor,type PluginCorePorts,type PluginDb,type PluginOperationManifest,type PluginDataClass} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {lockSourceRetrievalReleaseBatch} from '../sources/retrievalReleaseLocks.js';
import {UNKNOWN_AUDIENCE} from './dataAccess.js';
import {enforce} from '../policy/service.js';
import {loadActionRegistry} from '../policy/actionRegistry.js';
import {OperationError,OperationInputError,hidden} from '../systemActions/operations/errors.js';
import {safeInputErrors} from '../systemActions/inputErrors.js';
import {runOperationWork} from '../../db/operationTransaction.js';
import {classifyRegisteredError,executeRegistered,registeredPolicyRequest,resolveRegisteredInput} from '../systemActions/operations/registrationSteps.js';
import {pluginHostWrite} from './operationDb.js';
import {sensitiveTaintEgressContext} from './egress.js';
import {actorReaders,referenceReadable,type PluginReference} from './releaseGate.js';
import {insertArtifactRow} from '../artifacts/reviewArtifactWriter.js';
import {readNoteRevision} from '../knowledge/noteRevisionService.js';
import {noteDraftPort} from './noteDraftPort.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';

/** Bounded inline content for a plugin-created Artifact; larger output belongs to a Run file declaration. */
export const PLUGIN_ARTIFACT_MAX_CONTENT = 64 * 1024;

/**
 * Typed core-object host ports (ADR 0030). Each port runs one existing
 * canonical owner for the invoking actor inside the operation transaction,
 * restoring the host role through the same private savepoint bridge as Job
 * intents. A write port runs the core registration's own steps, shared with
 * the executor (`registrationSteps.ts`), and its policy action, so actor
 * eligibility (for example, user-only Relations), Project gates, ADR 0017
 * origin rules and fan-out limits are the core's, not the plugin's. The
 * nested call has no idempotency of its own: it commits or rolls back with the
 * enclosing plugin command, whose key covers it. No other core writer exists.
 */
export function pluginCorePorts(db: PluginDb, config: ServerConfig, manifest: PluginOperationManifest, actor: Readonly<OperationActor>, dataClass: PluginDataClass, invocation: {kind: 'query' | 'command'; references: PluginReference[]; projectId?: string}): PluginCorePorts | undefined {
  const declared = new Set(manifest.core_ports ?? []);
  if (!declared.size) return undefined;
  // An Agent never carries personal/sensitive plugin data into Project objects through a write port.
  // A Project-bound operation writes core objects only into the Project the host authorized for it.
  const outsideBinding = (projectId: unknown) => invocation.projectId !== undefined && projectId !== invocation.projectId;
  const core = (opId: string, input: {project_id?: unknown} & Record<string, unknown>) => {
    if (actor.principal.kind === 'agent' && dataClass !== 'non_sensitive' || outsideBinding(input.project_id)) return Promise.reject(hidden());
    return pluginHostWrite(db, host => invokeCoreOperation(host, config, actor, opId, input));
  };
  return {
    ...(declared.has('tasks.create') ? {tasks: {create: async (input: {project_id: string; title: string; description?: string; due_at?: string}) => {
      const out = await core('task.create', {project_id: input.project_id, title: input.title, ...(input.description ? {description: input.description} : {}), ...(input.due_at ? {due_at: input.due_at} : {})}) as {task_id: string};
      return {task_id: out.task_id};
    }}} : {}),
    ...(declared.has('relations.person.create') ? {relations: {createPerson: async (input: {project_id: string; title: string}) => {
      const out = await core('relation.person.create', {project_id: input.project_id, title: input.title}) as {object_id: string};
      return {object_id: out.object_id};
    }}} : {}),
    ...(declared.has('memory.propose') ? {memory: {propose: (input: {title: string; content: string}) => pluginHostWrite(db, async host => {
      // B10: always a proposal for the person; personal/sensitive plugin data keeps at least that sensitivity.
      if (!actor.on_behalf_of_user_id) throw hidden();
      const {PgMemoryProposalRepository} = await import('../memory/proposalRepository.js');
      const proposal = await new PgMemoryProposalRepository(host, config).createMemoryProposal(actor.space_id, actor.on_behalf_of_user_id, MemoryProposalCreateCommandSchema.parse({
        operation: 'create', content: input.content, type: 'semantic', title: input.title, visibility: 'private',
        sensitivity_level: dataClass === 'non_sensitive' && !(actor.principal.kind === 'agent' && (await sensitiveTaintEgressContext(host, actor.space_id, actor.run_id, {id: 'memory.remember', side_effects: 'proposal'})).sensitive_plugin_read_taint) ? 'normal' : 'sensitive', scope: 'user', project_id: null, owner_user_id: actor.on_behalf_of_user_id,
      }), actor.principal.kind === 'agent' && actor.agent_id && actor.run_id ? {agentId: actor.agent_id, runId: actor.run_id, rationale: `Proposed by plugin ${manifest.id}`} : undefined);
      return {proposal_id: proposal.id};
    })}} : {}),
    ...(declared.has('artifacts.create') ? {artifacts: {create: (input: {project_id: string; title: string; content: string; format?: 'markdown' | 'text'}) => {
      if (invocation.kind !== 'command' || actor.principal.kind === 'agent' && dataClass !== 'non_sensitive' || outsideBinding(input.project_id)) return Promise.reject(hidden());
      return pluginHostWrite(db, host => createPluginArtifact(host, config, manifest, actor, input));
    }}} : {}),
    ...(declared.has('references.resolve') ? {references: {resolve: (ref: PluginReference) => {
      // Query-only: the release gate rechecks and audits every resolved reference before the
      // result leaves, for fresh reads; commands have no such recheck on replay and get none.
      if (invocation.kind !== 'query') return Promise.reject(hidden());
      // A Project-bound package reaches a space object only as a typed Note (`notes.read`).
      if (invocation.projectId !== undefined && ref?.type === 'space_object') return Promise.resolve(null);
      return pluginHostWrite(db, async host => {
        // Every current reader of the output must read the object fully, without oversight,
        // inside the Agent's Project scope (and a Project-bound operation's bound Project);
        // the requester's authority never stands in for theirs.
        const {readers, run} = await actorReaders(host, actor);
        if (!await referenceReadable(host, actor, ref, readers, run, invocation.projectId)) return null;
        const definition = {task: 'tasks', artifact: 'artifacts', space_object: 'space_objects'}[ref.type];
        const row = (await host.query<{title: string | null}>(`SELECT title FROM ${definition} WHERE id=$1 AND space_id=$2`, [ref.id, actor.space_id])).rows[0];
        if (!row) return null;
        invocation.references.push({type: ref.type, id: ref.id});
        return {type: ref.type, id: ref.id, title: row.title ?? null};
      });
    }, verify: (ref: PluginReference) => pluginHostWrite(db, async host => {
      // Save-time check for a stored reference: a boolean only, so a command output carries no content.
      if (!ref || !['task', 'artifact', 'space_object'].includes(ref.type) || typeof ref.id !== 'string') return false;
      // A Project-bound package stores a space object only as a typed Note (`notes.verify`).
      if (invocation.projectId !== undefined && ref.type === 'space_object') return false;
      return verifyPinnedReference(host, actor, {type: ref.type, id: ref.id}, invocation.projectId);
    })}} : {}),
    ...(declared.has('notes.read') ? {notes: {
      verify: (ref: {note_id: string; version?: number}) => pluginHostWrite(db, async host => {
        // Save-time check for a stored Note reference (and optionally one of its versions): the
        // current version number only, so a command output carries no Note content.
        const target = noteTarget(ref);
        if (!target || !await verifyPinnedReference(host, actor, {type: 'space_object', id: target.noteId}, invocation.projectId)) return null;
        const revision = await readNoteRevision(host, {spaceId: actor.space_id, noteId: target.noteId, ...(target.version ? {version: target.version} : {})});
        return revision ? {current_version: revision.current_version} : null;
      }),
      read: (ref: {note_id: string; version?: number; body?: boolean}) => {
        // Query-only, like `references.resolve`: the release gate rechecks and audits the Note.
        if (invocation.kind !== 'query') return Promise.reject(hidden());
        return pluginHostWrite(db, async host => {
          const target = noteTarget(ref);
          if (!target) return null;
          const {readers, run} = await actorReaders(host, actor);
          if (!await referenceReadable(host, actor, {type: 'space_object', id: target.noteId}, readers, run, invocation.projectId)) return null;
          const revision = await readNoteRevision(host, {spaceId: actor.space_id, noteId: target.noteId, ...(target.version ? {version: target.version} : {})});
          if (!revision) return null;
          invocation.references.push({type: 'space_object', id: target.noteId});
          const text = ref.body === true ? revision.normalized_text.slice(0, PLUGIN_NOTE_TEXT_MAX) : null;
          return {
            note_id: target.noteId, title: revision.title, current_version: revision.current_version, version: revision.version,
            content_hash: revision.content_hash, created_at: revision.created_at, text, truncated: text !== null && revision.normalized_text.length > PLUGIN_NOTE_TEXT_MAX,
          };
        });
      },
    }} : {}),
    ...(declared.has('notes.draft') ? {drafts: noteDraftPort(fn => pluginHostWrite(db, fn), config, manifest, actor, invocation)} : {}),
  };
}

/** A well-formed Note target; anything else is simply not a Note. */
function noteTarget(ref: {note_id?: unknown; version?: unknown} | null | undefined): {noteId: string; version?: number} | null {
  if (!ref || typeof ref.note_id !== 'string' || !ref.note_id || ref.note_id.length > 64) return null;
  if (ref.version !== undefined && !(Number.isInteger(ref.version) && (ref.version as number) >= 1)) return null;
  return {noteId: ref.note_id, ...(ref.version !== undefined ? {version: ref.version as number} : {})};
}

/**
 * Whether a stored reference may be saved now: it exists, every current reader reads it, and for a
 * Project-bound operation its whole closure stays in the bound Project.
 */
async function verifyPinnedReference(host: Queryable, actor: Readonly<OperationActor>, target: PluginReference, bound: string | undefined): Promise<boolean> {
  const {readers, run} = await actorReaders(host, actor);
  if (!readers.length || readers.includes(UNKNOWN_AUDIENCE)) return false;
  // Authorization and Project ownership are decided on one pinned closure: the object row, its
  // Project shares, every reader's grants and membership and the Projects involved are held
  // FOR SHARE to commit, so a concurrent move or revocation either commits first and is seen
  // here, or waits for this save. A closure that changed while waiting is not verified.
  const sorted = [...readers].sort();
  // The command already holds its bound Project. An object of another Project (or one whose
  // read closure reaches one) is refused at discovery, before any other lock: two saves referencing
  // each other's objects must not each wait on the other's Project. Every discovery, including
  // the release's own, which may see an unplaced object since moved elsewhere, is confined to
  // the bound Project; a change after locking fails the release's final closure comparison.
  try {
    await lockSourceRetrievalReleaseBatch(host, [{spaceId: actor.space_id, userId: sorted[0]!, refs: [{object_type: target.type, object_id: target.id}],
      additionalProjects: bound ? [bound] : [], additionalPeople: sorted.slice(1), ...(bound ? {confineProjects: [bound]} : {})}]);
  } catch (error) {
    if (error instanceof HttpError) return false;
    throw error;
  }
  return !!await referenceReadable(host, actor, target, readers, run, bound);
}

/**
 * Plugin-created Artifact through the canonical Artifact row writer
 * (`insertArtifactRow`). Placement is a Project write: the person must write
 * the active Project (the Task writer's gate) and an Agent only its Run's
 * Project from a person's own turn (ADR 0017 keeps unattended Project writes
 * behind approval, which a nested port cannot open). The producing Run is the
 * Agent's Run; the row is private to the person until they share it. The
 * `artifact.declare` policy action, with the sensitive-read egress
 * invariant, is recorded in the operation transaction.
 */
async function createPluginArtifact(host: Queryable, config: ServerConfig, manifest: PluginOperationManifest, actor: Readonly<OperationActor>, input: {project_id: string; title: string; content: string; format?: 'markdown' | 'text'}): Promise<{artifact_id: string}> {
  const person = actor.on_behalf_of_user_id;
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!person || !title || title.length > 300 || typeof input.content !== 'string' || Buffer.byteLength(input.content) > PLUGIN_ARTIFACT_MAX_CONTENT || typeof input.project_id !== 'string') throw new OperationError('operation_invalid_input', 422);
  const format = input.format === 'text' ? 'text' : 'markdown';
  if (actor.principal.kind === 'agent') {
    if (actor.origin !== 'manual' || actor.effective_origin !== 'manual') throw hidden();
    const run = (await host.query<{project_id: string | null}>('SELECT project_id FROM runs WHERE id=$1 AND space_id=$2', [actor.run_id, actor.space_id])).rows[0];
    if (!run?.project_id || run.project_id !== input.project_id) throw hidden();
  }
  await assertProjectWriter(host, actor.space_id, input.project_id, person, {allowArchived: false}).catch(() => { throw hidden(); });
  await lockActiveProjectForMutation(host, actor.space_id, input.project_id).catch(() => { throw hidden(); });
  await assertProjectWriterForMutation(host, actor.space_id, input.project_id, person).catch(() => { throw hidden(); });
  const policy = await enforce({...config, auditTransaction: host}, await loadActionRegistry(config), {
    action: 'artifact.plugin_create', force_record: true, actor_type: actor.principal.kind, actor_id: actor.principal.id,
    space_id: actor.space_id, resource_space_id: actor.space_id, resource_type: 'project', resource_id: input.project_id, run_id: actor.run_id,
    context: {...(actor.principal.kind === 'agent' ? await sensitiveTaintEgressContext(host, actor.space_id, actor.run_id, {id: 'artifact.submit', side_effects: 'durable'}) : {}),
      action_id: 'plugin.core.artifacts.create', trigger_origin: actor.effective_origin, instructed_by_user_id: person, via_plugin_core_port: true},
    metadata_json: {via_plugin_core_port: true, plugin_id: manifest.id},
  });
  if (policy.status !== 'allow') throw hidden();
  const mime = format === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
  const id = await insertArtifactRow(host, {
    spaceId: actor.space_id, ownerUserId: person, artifactType: 'plugin_output', title, content: input.content,
    metadata: {plugin_id: manifest.id, created_via: 'plugin_core_port'}, canonicalFormat: format, visibility: 'private', mimeType: mime,
    runId: actor.principal.kind === 'agent' ? actor.run_id : null, projectId: input.project_id, trustLevel: actor.principal.kind === 'agent' ? 'low' : 'medium', surfaceRole: 'user_output',
  });
  return {artifact_id: id};
}

/**
 * One nested canonical command for a declared port, through the registration's
 * own steps shared with the executor (resolve → normalize → authorize → policy →
 * execute → output schema → authorizeResult, with its error classification).
 * It runs under the enclosing plugin operation's grant: the manifest's declared
 * `core_ports` are the plugin's reviewed host ceiling, so the Run needs no grant
 * of the core action itself, while the core's actor eligibility, Project gates
 * and policy action still decide. No receipt, approval or placement of its own:
 * it commits or rolls back with the enclosing command, whose key covers it.
 */
export async function invokeCoreOperation(host: Queryable, config: ServerConfig, actor: Readonly<OperationActor>, opId: string, raw: unknown): Promise<unknown> {
  const {operationRuntime} = await import('../systemActions/operations/runtime.js');
  const item = (await operationRuntime(config)).registrations.get(opId);
  const d = item?.definition;
  if (!item || !d || d.execution?.kind !== 'command' || !d.allowed_actor_types.includes(actor.principal.kind) || item.approval) throw hidden();
  const parsed = d.input_schema.safeParse(raw);
  if (!parsed.success) throw new OperationInputError(safeInputErrors(d, parsed.error));
  try {
    const {scope, input} = await resolveRegisteredInput(item, host, parsed.data, actor);
    await runOperationWork(() => item.authorize(host, input, actor, scope));
    const policy = await enforce({...config, auditTransaction: host}, await loadActionRegistry(config),
      await registeredPolicyRequest(host, item, input, actor, scope, {space: actor.space_id, context: {via_plugin_core_port: true}, metadata: {via_plugin_core_port: true}}));
    if (policy.status !== 'allow') throw hidden();
    return (await executeRegistered(item, host, input, actor)).data;
  } catch (error) {
    throw classifyRegisteredError(item, error);
  }
}
