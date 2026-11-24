import {applicationContactWrites} from './dataAccess.js';
import {GMAIL_APPLICATION_FACT_ACTION, isProjectNoteAgentAction} from '@rainver/protocol';
import type {OperationActor, RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {gmailAgentReadConsentLive, GMAIL_CONSENT_ID} from '../sources/gmail/gmailAgentReadGrants.js';
import {hasSensitivePluginRead, readRunContextTaint} from '../runs/contextTaint.js';

/**
 * Writes a Run may still make after reading sensitive plugin data (ADR 0030):
 * asking for authorization and Memory (forced into a gated proposal that
 * inherits the sensitivity). All other side-effecting actions, including
 * sensitive plugin proposals, are outward and refused by
 * `sensitivePluginReadBlocksOutward`.
 */
const TAINTED_RUN_WRITES = new Set(['authorization.request', 'memory.remember', 'memory.revise',
  // ADR 0034: the owner's application-update automation, also after this conversation read mail. Drafting
  // is an owner-only card only the owner decides directly; pausing or ending narrows; the flag keeps a
  // message id for the owner. Each executor admits only the owner's turn in their own private
  // conversation, or the automation's own Run; none publishes anything to anyone else.
  'source.gmail.application_updates.propose', 'source.gmail.application_updates.set_status', 'source.gmail.application_updates.flag',
  // ADR 0035: the owner's combined card (only parts the separate cards above already allow) and ending a delegation (narrowing).
  'source.gmail.setup.propose', 'source.gmail.delegation.end']);

export function isOutwardAfterSensitiveRead(definition: Pick<RegisteredSystemActionDefinition, 'id' | 'side_effects'>): boolean {
  return definition.side_effects !== 'none' && !TAINTED_RUN_WRITES.has(definition.id);
}

/** Policy-context facts for an Agent action; read from the Run's merge-only taint, never from the call. */
export async function sensitiveTaintEgressContext(db: Queryable, spaceId: string, runId: string | null, definition: Pick<RegisteredSystemActionDefinition, 'id' | 'side_effects'>): Promise<{sensitive_plugin_read_taint: boolean; outward_action: boolean}> {
  const outward = isOutwardAfterSensitiveRead(definition);
  if (!runId) return {sensitive_plugin_read_taint: false, outward_action: outward};
  return {sensitive_plugin_read_taint: hasSensitivePluginRead(await readRunContextTaint(db, spaceId, runId)), outward_action: outward};
}


// These commands store data in the bound Project. Nested tasks and references
// also pass the core port's own Project and access checks.
const APPLICATION_PROJECT_WRITES = new Set([
  'application.create', 'application.update', 'application.update_status', 'application.record_submission', 'application.propose_status',
  'deadline.add', 'deadline.update', 'deadline.remove',
  'funding.link', 'funding.unlink', 'material.add', 'material.update', 'material.remove',
  'material.link_note', 'material.add_source', 'material.remove_source',
  'library.add', 'library.update', 'library.remove',
].map(action => `plugin.applications.${action}`));

/** These write paths resolve their Project and check the actor's write authority
 * before policy evaluation. Only include operations whose effects stay in that Project. */
export async function canWriteGmailDerivedProjectContent(
  db: Queryable, actor: Pick<OperationActor, "space_id" | "run_id" | "effective_origin" | "on_behalf_of_user_id">, actionId: string, targets: unknown, input: unknown,
  unstartedCancellationProject?: string,
): Promise<boolean> {
  // The owner's application-update automation records external facts only through its dedicated gate (ADR 0034).
  if (actionId === GMAIL_APPLICATION_FACT_ACTION) {
    const {gmailApplicationFactAdmitted} = await import('../sources/gmail/gmailApplicationUpdates.js');
    return gmailApplicationFactAdmitted(db, {...actor, principal: {kind: 'agent'}} as never, input);
  }
  const application = APPLICATION_PROJECT_WRITES.has(actionId) || applicationContactWrites.has(actionId);
  const task = actionId === 'task.create' || actionId === 'task.update' || actionId === 'task.create_batch';
  // Only the core Task registration can provide the Project of a locked, eligible Task.
  const cancellation = actionId === 'task.set_status' && unstartedCancellationProject !== undefined;
  if (!application && !task && !cancellation && !isProjectNoteAgentAction(actionId)) return false;
  if (actor.effective_origin !== 'manual' || !actor.run_id || !actor.on_behalf_of_user_id) return false;
  const options = input as {reference?: unknown; links?: readonly unknown[]};
  if (!application && (options.reference || options.links?.length)) return false;
  const projectId = cancellation ? unstartedCancellationProject : (targets as {project_id?: unknown} | null)?.project_id;
  if (typeof projectId !== 'string') return false;
  if (actionId === 'task.create_batch') {
    const {tasks} = input as {tasks?: Array<{project_id?: string; links?: unknown[]}>};
    if (!Array.isArray(tasks) || !tasks.length ||
      tasks.some(item => !item || item.links?.length || (item.project_id && item.project_id !== projectId))) return false;
  }
  // Held until commit without upgrading the actor pin's FOR SHARE (`readRunContextTaint`).
  const taint = await readRunContextTaint(db, actor.space_id, actor.run_id, {forShare: true});
  const reads = taint?.plugin_reads?.filter(read => read.data_class === 'sensitive');
  if (!reads?.length || taint?.personal_memory_grant_ids.length) return false;
  const grants = new Map<string, string>();
  for (const read of reads) {
    if (read.plugin_id !== GMAIL_CONSENT_ID || !read.owner_user_id || read.gmail_scope?.project_id !== projectId ||
      (!cancellation && read.owner_user_id !== actor.on_behalf_of_user_id)) return false;
    const {grant_id} = read.gmail_scope;
    if (grants.has(grant_id) && grants.get(grant_id) !== read.owner_user_id) return false;
    grants.set(grant_id, read.owner_user_id);
  }
  // A peer's fixed cancellation publishes no Gmail text. Still require every original
  // consent, and keep an unknown owner or a different restricted source fail-closed.
  const permittedOwners = cancellation ? new Set(grants.values()) : new Set<string>();
  if (taint?.non_instructing_owner_user_ids.some(owner => !permittedOwners.has(owner)) ||
    (cancellation && reads.length !== taint?.plugin_reads?.length)) return false;
  for (const [grantId, ownerUserId] of [...grants].sort(([a], [b]) => a.localeCompare(b))) {
    if (!await gmailAgentReadConsentLive(db, { spaceId: actor.space_id, ownerUserId, grantId, projectId })) return false;
  }
  return true;
}
