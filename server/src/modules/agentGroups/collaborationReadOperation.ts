import {
  collaborationNextReminder,
  type OperationActor, type OperationInput, type OperationOutput, type RegisteredSystemActionDefinition,
} from '@rainver/protocol';
import type { Queryable } from '../routeUtils/common.js';
import { canWriteProject } from '../projects/access.js';
import { hidden } from '../systemActions/operations/errors.js';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { collaborationResults, collaborationStopReason, collaborationTask, parseStoredCollaboration, type Container } from './collaborationBudgetRepository.js';
import { PgAgentGroupRepository, type AgentRunGroupRecord } from './repository.js';

type GetInput = OperationInput<'room.collaboration.get'>;

/**
 * The human manager's read of their newest task collaboration in one Room
 * conversation: counts, the next reminder, the admission projection and the
 * Task only under the reader's own Task access. There is no mode to switch
 * and no limit to show; pause, resume and stop use the group status command.
 */
export function collaborationReadRegistration(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration {
  return {
    definition: definitions.get('room.collaboration.get')!,
    readKind: 'metadata',
    async resolve(_db, raw, actor) {
      const input = raw as GetInput;
      return { authority: `space:${actor.space_id}:room:${input.room_id}`, targets: { room_id: input.room_id, session_id: input.session_id }, resourceType: 'room', resourceId: input.room_id };
    },
    async authorize(db, raw, actor) { await readableConversation(db, raw as GetInput, actor); },
    async execute(db, raw, actor): Promise<OperationOutput<'room.collaboration.get'>> {
      const input = raw as GetInput;
      await readableConversation(db, input, actor);
      // The person's own newest task container in this conversation that ever
      // declared a collaboration — a present key of any value, so a stored
      // null is reported invalid exactly as admission refuses it.
      const row = (await db.query<AgentRunGroupRecord>(
        `SELECT * FROM agent_run_groups WHERE space_id=$1 AND room_id=$2 AND session_id=$3 AND manager_user_id=$4
           AND discussion_id IS NULL AND budget_json ? 'collaboration' AND NOT (budget_json ? 'container_group_id')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [actor.space_id, input.room_id, input.session_id, actor.principal.id])).rows[0];
      if (!row) return { collaboration: null, invalid: false };
      const collaboration = parseStoredCollaboration(row.budget_json?.collaboration);
      if (!collaboration) return { collaboration: null, invalid: true };
      const container: Container = { ...row, collaboration };
      const results = await collaborationResults(db, container);
      const turns = Number(row.budget_json?.container_turns_used ?? 0);
      // Task content only under the reader's current Task access, in this
      // Project, while the Project is active; otherwise it is hidden and the
      // collaboration does not admit (task_unavailable).
      const task = await collaborationTask(db, container, collaboration.task_id, actor.principal.id, false);
      const writer = row.project_id ? await canWriteProject(db, actor.space_id, row.project_id, actor.principal.id) : false;
      // The admission projection itself, without row locks; admission
      // rechecks it under the container lock.
      const stopReason = await collaborationStopReason(db, container, results, false);
      return { invalid: false, collaboration: {
        group_id: row.id, group_status: row.status, task_id: collaboration.task_id,
        task_title: task?.title ?? null, task_status: task?.status ?? null,
        delegations_used: results.length, turns_used: Math.max(0, turns - collaboration.turns_offset),
        next_reminder_at: collaborationNextReminder(results.length),
        participant_agent_ids: collaboration.participant_agent_ids, active: stopReason === null, stop_reason: stopReason,
        can_manage: writer,
      } };
    },
  };
}

async function readableConversation(db: Queryable, input: GetInput, actor: OperationActor) {
  if (actor.principal.kind !== 'user' || actor.principal.id !== actor.on_behalf_of_user_id) throw hidden();
  const session = await db.query(`SELECT s.id FROM sessions s JOIN rooms r ON r.space_id=s.space_id AND r.id=s.room_id AND r.status='active'
    WHERE s.space_id=$1 AND s.id=$2 AND s.room_id=$3`, [actor.space_id, input.session_id, input.room_id]);
  if (!session.rows.length || !await new PgAgentGroupRepository(db).isActiveRoomUser(actor.space_id, input.room_id, actor.principal.id, input.session_id)) throw hidden();
}
