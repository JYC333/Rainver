import type { OperationActor, OperationInput, RegisteredSystemActionDefinition } from '@rainver/protocol';
import type { Queryable } from '../routeUtils/common.js';
import { canWriteProject } from '../projects/access.js';
import { PgSessionRepository } from '../sessions/repository.js';
import { hidden, OperationBusinessError } from '../systemActions/operations/errors.js';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { collaborationContainer, taskOpen } from './collaborationBudgetRepository.js';
import { PgAgentGroupRepository } from './repository.js';

type Input = OperationInput<'room.collaboration.update_participants'>;
const conflict = () => new OperationBusinessError('operation_conflict', 409, 'agentGroups');
const invalid = () => new OperationBusinessError('operation_invalid_input', 422, 'agentGroups');
const sameParticipants = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

/** Only the authenticated human manager may change membership. Agent declarations remain immutable. */
async function authorizedContainer(db: Queryable, groupId: string, actor: OperationActor) {
  if (actor.principal.kind !== 'user' || actor.principal.id !== actor.on_behalf_of_user_id) throw hidden();
  const repo = new PgAgentGroupRepository(db);
  const group = await repo.getGroup(actor.space_id, groupId);
  if (!group || !group.room_id || group.discussion_id || group.manager_user_id !== actor.principal.id) throw hidden();
  const container = await collaborationContainer(db, group);
  if (!container?.collaboration || container.id !== groupId || !container.project_id) throw hidden();
  // Keep revocations serialized with this command, including live roster changes.
  const room = await db.query(`SELECT id FROM rooms WHERE space_id=$1 AND id=$2 AND status='active' FOR SHARE`, [actor.space_id, group.room_id]);
  const member = await db.query(`SELECT id FROM room_user_members WHERE space_id=$1 AND room_id=$2 AND user_id=$3 AND status='active' FOR SHARE`, [actor.space_id, group.room_id, actor.principal.id]);
  if (!room.rows.length || !member.rows.length
    || !await canWriteProject(db, actor.space_id, container.project_id, actor.principal.id, {lockAuthority:true})
    || !await repo.isActiveRoomUser(actor.space_id, group.room_id, actor.principal.id)) throw hidden();
  return container;
}

export function collaborationParticipantsRegistration(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration {
  return {
    definition: definitions.get('room.collaboration.update_participants')!,
    async resolve(_db, raw, actor) {
      const input = raw as Input;
      return {authority:`space:${actor.space_id}:collaboration:${input.group_id}`, targets:{group_id:input.group_id}, resourceType:'agent_run_group', resourceId:input.group_id};
    },
    async authorize(db, raw, actor) { await authorizedContainer(db, (raw as Input).group_id, actor); },
    async authorizeResult(db, raw, actor) { await authorizedContainer(db, (raw as {group_id:string}).group_id, actor); },
    async execute(db, raw, actor) {
      const input = raw as Input;
      const container = await authorizedContainer(db, input.group_id, actor);
      const previous = container.collaboration!;
      if (!['active','succeeded'].includes(container.status) || !await taskOpen(db, container, previous.task_id)) throw conflict();
      if (!sameParticipants(previous.participant_agent_ids, input.expected_participant_agent_ids)) throw conflict();
      if (input.participant_agent_ids.includes(previous.coordinator_agent_id)) throw invalid();
      // New participants must be both pinned members of this task group and current Room members.
      const participants = await db.query<{agent_id:string;name:string}>(
        `SELECT gm.agent_id, a.name FROM agent_run_group_members gm
         JOIN room_agent_members rm ON rm.space_id=gm.space_id AND rm.agent_id=gm.agent_id AND rm.room_id=$3
         JOIN agents a ON a.space_id=gm.space_id AND a.id=gm.agent_id
         WHERE gm.space_id=$1 AND gm.group_id=$2 AND gm.status='active' AND rm.status='active'
           AND a.status='active' AND gm.agent_id=ANY($4::text[]) ORDER BY gm.agent_id FOR SHARE OF gm,rm,a`,
        [actor.space_id, container.id, container.room_id, input.participant_agent_ids]);
      if (participants.rows.length !== input.participant_agent_ids.length) throw invalid();
      const removed = previous.participant_agent_ids.filter(id => !input.participant_agent_ids.includes(id));
      if (removed.length && (await db.query(
        `SELECT d.id FROM run_delegations d JOIN agent_run_groups g ON g.space_id=d.space_id AND g.id=d.group_id
         WHERE d.space_id=$1 AND (g.id=$2 OR g.budget_json->>'container_group_id'=$2)
           AND d.target_agent_id=ANY($3::text[]) AND d.status IN ('requested','queued','running') LIMIT 1`,
        [actor.space_id, container.id, removed])).rows.length) throw conflict();
      if (!sameParticipants(previous.participant_agent_ids, input.participant_agent_ids)) {
        // Replace exactly one JSON leaf: caps, Task, coordinator, offsets and charged turns are untouched.
        await db.query(`UPDATE agent_run_groups SET budget_json=jsonb_set(budget_json,'{collaboration,participant_agent_ids}',$3::jsonb), updated_at=now() WHERE space_id=$1 AND id=$2`,
          [actor.space_id, container.id, JSON.stringify(input.participant_agent_ids)]);
        const notice = await new PgSessionRepository(db).addRoomConversationNotice(actor.space_id, container.session_id!, {
          content:`Task collaboration participants changed. Previous: ${previous.participant_agent_ids.join(', ')}. Current: ${input.participant_agent_ids.map(id => { const member = participants.rows.find(row => row.agent_id === id); return `${member?.name ?? id} (${id})`; }).join(', ')}. Reason: ${input.reason}. Delegation allowance and usage are unchanged.`,
          metadata:{execution_event:'collaboration_participants_changed', execution_details:{
            container_group_id:container.id, task_id:previous.task_id, changed_by_user_id:actor.principal.id,
            previous_participant_agent_ids:previous.participant_agent_ids, participant_agent_ids:input.participant_agent_ids, reason:input.reason,
          }},
        });
        if (!notice) throw conflict();
      }
      return {group_id:container.id, task_id:previous.task_id, participant_agent_ids:input.participant_agent_ids, max_delegations:previous.max_delegations};
    },
  };
}
