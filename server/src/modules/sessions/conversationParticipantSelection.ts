import type {ConversationExecutionInitializeRequest, ConversationRuntimeChoice} from '@rainver/protocol';
import type {Queryable, SpaceUserIdentity} from '../routeUtils/common.js';
import {PgRoomRepository} from '../rooms/repository.js';
import {PgConversationExecutionContextRepository, type ExecutionSessionRow, type ExecutionContextRow} from './executionContextRepository.js';
import {ConversationExecutionContextError} from './executionContextError.js';

/** Called only after the Project audience, Room and Conversation admission locks.
 * Participation changes future admission; existing Run/group snapshots stay frozen. */
export async function prepareConversationParticipants(
  db: Queryable, identity: SpaceUserIdentity, session: ExecutionSessionRow,
  context: ExecutionContextRow, request: ConversationExecutionInitializeRequest,
  requestedRuntimes: ConversationRuntimeChoice[],
) {
  const repository = new PgConversationExecutionContextRepository(db);
  const room = session.room_id ? await new PgRoomRepository(db).getVisibleRoom(identity.spaceId,identity.userId,session.room_id) : null;
  const defaults = room?.conversation_defaults_json ?? [];
  if (context.state !== 'initialized' && session.room_id && !request.participant_agent_ids) {
    const rosterIds = await repository.listConversationParticipantAgentIds(session);
    request = {...request,participant_agent_ids:rosterIds.filter(id=>defaults.find(item=>item.agent_id===id)?.participating!==false)};
  }

  const snapshot = await repository.participationSnapshot(session);
  if (context.state==='initialized' && (request.participant_agent_ids || request.participant_changes)) {
    if(request.participants_revision!==snapshot.participants_revision) throw new ConversationExecutionContextError(409,"Participants changed; refresh and retry your selection");
    const ids=new Set(snapshot.participant_agent_ids);
    if(request.participant_changes){
      if(request.participant_agent_ids) throw new ConversationExecutionContextError(422,"Use either participant changes or a complete selection");
      if(new Set(request.participant_changes.map(change=>change.agent_id)).size!==request.participant_changes.length) throw new ConversationExecutionContextError(422,"Select each participant once");
      for(const change of request.participant_changes) change.participating?ids.add(change.agent_id):ids.delete(change.agent_id);
      request={...request,participant_agent_ids:[...ids]};
    }
    for(const id of new Set([...snapshot.participant_agent_ids,...request.participant_agent_ids!])) {
      if(snapshot.participant_agent_ids.includes(id)===request.participant_agent_ids!.includes(id))continue;
      if(!await repository.canAgentParticipate(session,id,identity.userId))throw new ConversationExecutionContextError(403,"Participant edit is not authorized");
    }
  }
  if(context.state==='initialized' && request.participant_agent_ids){
    for(const id of request.participant_agent_ids){
      if(snapshot.participant_agent_ids.includes(id)||requestedRuntimes.some(runtime=>runtime.agent_id===id))continue;
      const binding=await repository.getBinding(identity.spaceId,session.id,id);
      if(!binding||await repository.getConversationThread(identity.spaceId,session.id,id))continue;
      const profile=await repository.getRuntimeProfile(identity.spaceId,id,binding.runtime_profile_id);
      if(!profile?.runtime_installation)throw new ConversationExecutionContextError(409,"Select an available runtime before restoring this participant");
      requestedRuntimes.push({agent_id:id,runtime_profile_id:profile.id,runtime_key:profile.runtime_key,runtime_installation:profile.runtime_installation});
    }
  }
  // Persistent participation is separate from one message's recipients.
  // Retain inactive bindings and Host threads so rejoining preserves continuity.
  if (request.participant_agent_ids) {
    if (!session.room_id) throw new ConversationExecutionContextError(422,"Participant edits require a Room conversation");
    const roster = await db.query<{agent_id:string;role:string}>(`SELECT agent_id,role FROM room_agent_members WHERE space_id=$1 AND room_id=$2 AND status='active' FOR SHARE`,[identity.spaceId,session.room_id]);
    const ids = request.participant_agent_ids;
    if (new Set(ids).size!==ids.length || !roster.rows.some(member=>member.role==='manager'&&ids.includes(member.agent_id))) throw new ConversationExecutionContextError(422,"Keep the Room manager and select each participant once");
    for (const id of ids) if (!roster.rows.some(member=>member.agent_id===id) || (!snapshot.participant_agent_ids.includes(id) && !await repository.canAgentParticipate(session,id,identity.userId))) throw new ConversationExecutionContextError(403,"Selected participant is unavailable");
    if (requestedRuntimes.some(runtime=>!ids.includes(runtime.agent_id))) throw new ConversationExecutionContextError(422,"A runtime selection must belong to a selected participant");
    {
      await db.query(`UPDATE session_conversation_backends SET participating=(agent_id=ANY($3::text[])),updated_at=clock_timestamp() WHERE space_id=$1 AND session_id=$2 AND participating IS DISTINCT FROM (agent_id=ANY($3::text[]))`,[identity.spaceId,session.id,ids]);
      for (const id of context.state==='initialized'?ids:[]) if (!await repository.getBinding(identity.spaceId,session.id,id) && !requestedRuntimes.some(runtime=>runtime.agent_id===id)) throw new ConversationExecutionContextError(409,"Choose a runtime for each newly added participant");
    }
  }
  return {request, defaults};
}
