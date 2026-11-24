import type {
  ContinueRoomAfterProposalRequest,
  ConversationRetryResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  ExtendRoomDiscussionRequest,
  OpenRoomDiscussionRequest,
  OpenRoomDiscussionResponse,
  Page,
  QueuedRoomMessage,
  QueuedRoomMessageResponse,
  Room,
  RoomAgentAddRequest,
  RoomAgentCandidatesResponse,
  RoomAgentMutationResponse,
  RoomAgentPresetRequest,
  RoomConversation,
  RoomConversationQuota,
  RoomDetail,
  RoomDiscussion,
  RoomDiscussionDetail,
  RoomDiscussionListResponse,
  RoomInvitation,
  RoomInvitationCreateRequest,
  RoomInvitationDecisionRequest,
  RoomInvitationListResponse,
  RoomMessage,
  RoomOwnerTransferRequest,
  RoomPendingApprovalListResponse,
  SendRoomMessageRequest,
  ThreadReferencePick,
} from '../types/api'
import { commandReceipt, operationAt, queryOperation } from './operations'
import type { RequestOptions } from './transport'
import { ApiRequestError, get, pageQuery } from './transport'
import { ROOM_LIVE_INPUT_CHOICE_REQUIRED, ROOM_LIVE_INPUT_TARGET_UNAVAILABLE, type ConversationInputPart, type OperationOutput, type RunLiveInputResult } from '@rainver/protocol'

/** A live input's recorded outcome is read back briefly; past that it is reported as still pending. */
async function roomDetailAfter(receipt:{room_id:string;space_id:string},options:RequestOptions={}):Promise<RoomDetail>{
  return get<RoomDetail>(`/rooms/${encodeURIComponent(receipt.room_id)}`,{...options,spaceId:receipt.space_id})
}

async function roomMutationAfter(receipt:{room_id:string;space_id:string},options:RequestOptions={},revoked=0):Promise<RoomAgentMutationResponse>{
  return {...await roomDetailAfter(receipt,options),revoked_grant_count:revoked}
}

async function roomInvitationAfter(receipt:{room_id:string;space_id:string;invitation_id:string}):Promise<RoomInvitation>{
  // The exact invitation, however many newer ones exist; access is the page's.
  const page=await get<RoomInvitationListResponse>(`/rooms/${encodeURIComponent(receipt.room_id)}/invitations?limit=1&invitation_id=${encodeURIComponent(receipt.invitation_id)}`,{spaceId:receipt.space_id})
  const invitation=page.items.find(item=>item.id===receipt.invitation_id);if(!invitation)throw new Error('Room invitation no longer available');return invitation
}

/** The receipt's exact message (an old one on replay, too) with the conversation it belongs to. */
async function turnAfter(receipt:{room_id:string;session_id:string;space_id:string;message_id:string},options:RequestOptions={}){
  const q=new URLSearchParams({limit:'1',message_id:receipt.message_id})
  const page=await get<{items:RoomMessage[];conversation?:RoomConversation}>(`/rooms/${encodeURIComponent(receipt.room_id)}/conversations/${encodeURIComponent(receipt.session_id)}/messages?${q}`,{...options,spaceId:receipt.space_id})
  return turnFrom(page,receipt.message_id)
}

/** The posted turn's message and conversation, read back from the conversation page. */
function turnFrom(page:{items:RoomMessage[];conversation?:RoomConversation},messageId:string):{message:RoomMessage;conversation:RoomConversation}{
  const message=page.items.find(item=>item.id===messageId)
  if(!message||!page.conversation)throw new Error('Room message no longer available')
  return {message,conversation:page.conversation}
}

/** An ordinary send that went into an active Run through its live input. */
export interface RoomLiveInputSent {
  message: RoomMessage
  conversation: RoomConversation
  live: { run_id: string; message_id: string; state: RunLiveInputResult['state'] }
}

export const roomsApi = {
  /** The viewer's own task collaboration in one conversation (`modules/rooms.md`). */
  collaboration: async (roomId: string, sessionId: string, options: RequestOptions = {}): Promise<OperationOutput<'room.collaboration.get'>> => {
    const result = await queryOperation('room.collaboration.get', { room_id: roomId, session_id: sessionId }, options)
    if (!('status' in result) || result.status !== 'succeeded') throw new Error('Query did not complete')
    return result.data
  },
  /** Pause, resume or stop the collaboration's task group through the existing group status command. */
  setCollaborationStatus: (groupId: string, status: 'active' | 'paused' | 'cancelled', key: string = crypto.randomUUID(), options: RequestOptions = {}) =>
    commandReceipt('agent_group.status.set', { group_id: groupId, status }, key, options),
  list: (params: { project_id?: string; limit?: number; offset?: number } = {}, options: RequestOptions = {}) => {
    const q: Record<string, string> = {}
    if (params.project_id) q.project_id = params.project_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<Room>>('/rooms?' + new URLSearchParams(q), options)
  },
  pendingApprovals: (params: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return get<RoomPendingApprovalListResponse>(`/rooms/pending-approvals?${q}`)
  },
  create: async (body: CreateRoomRequest, idempotencyKey: string = crypto.randomUUID()): Promise<CreateRoomResponse> =>
    roomDetailAfter(await commandReceipt('room.create', body, idempotencyKey)),
  get: (roomId: string, options: RequestOptions = {}) => get<RoomDetail>(`/rooms/${roomId}`, options),
  /** Copy picked content into a conversation that already exists. */
  attachReferences: async (
    roomId: string,
    sessionId: string,
    body: { references: ThreadReferencePick[]; confirm_disclosure?: boolean | string[] }, options: RequestOptions = {},
  ) => {
    // The retained URL, not the generic entry: it prepares owner-funded imported-session summaries before the command.
    const receipt = await operationAt<OperationOutput<'room.conversation.attach_references'>>('POST', `/rooms/${encodeURIComponent(roomId)}/conversations/${encodeURIComponent(sessionId)}/references`, body, options.idempotencyKey ?? crypto.randomUUID(), options)
    const page = await roomsApi.messages(receipt.room_id, receipt.session_id, { limit: 50 }, { ...options, spaceId: receipt.space_id })
    return { items: page.items, task_group_ids: page.task_group_ids, conversation: page.conversation ?? null, limit: page.limit, offset: page.offset }
  },
  agentCandidates: (roomId: string, params: { q?: string; limit?: number; offset?: number } = {}) =>
    get<RoomAgentCandidatesResponse>(`/rooms/${roomId}/agent-candidates?${pageQuery(params)}`),
  // Host restore/archive happen after the roster commits; the receipt says whether a restore was requested.
  addAgent: async (roomId: string, body: RoomAgentAddRequest, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.agent.add', { ...body, room_id: roomId }, key)),
  addAgentPreset: async (roomId: string, body: RoomAgentPresetRequest, idempotencyKey: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.agent.add_preset', { ...body, room_id: roomId }, idempotencyKey)),
  removeAgent: async (roomId: string, agentId: string, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> => {
    const receipt = await commandReceipt('room.agent.remove', { room_id: roomId, agent_id: agentId }, key)
    return roomMutationAfter(receipt, {}, receipt.revoked_grant_count)
  },
  invitations: (roomId: string, params: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return get<RoomInvitationListResponse>(`/rooms/${roomId}/invitations?${q}`)
  },
  inviteUser: async (roomId: string, body: RoomInvitationCreateRequest, key: string = crypto.randomUUID()) =>
    roomInvitationAfter(await commandReceipt('room.invitation.create', { ...body, room_id: roomId }, key)),
  decideInvitation: async (roomId: string, invitationId: string, body: RoomInvitationDecisionRequest, key: string = crypto.randomUUID()) =>
    roomInvitationAfter(await commandReceipt('room.invitation.decide', { ...body, room_id: roomId, invitation_id: invitationId }, key)),
  removeUser: async (roomId: string, userId: string, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse | null> => {
    const receipt = await commandReceipt('room.member.remove', { room_id: roomId, user_id: userId }, key)
    // Leaving may end the person's own access; the roster is then simply no longer theirs to read.
    return roomMutationAfter(receipt).catch(() => null)
  },
  transferOwner: async (roomId: string, body: RoomOwnerTransferRequest, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.owner.transfer', { ...body, room_id: roomId }, key)),
  claimOwner: async (roomId: string, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.owner.claim', { room_id: roomId }, key)),
  resetAgentContext: async (roomId: string, agentId: string, sessionId?: string, options: RequestOptions = {}): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.agent.reset_context', { room_id: roomId, agent_id: agentId, ...(sessionId ? { session_id: sessionId } : {}) }, options.idempotencyKey ?? crypto.randomUUID(), options), options),
  summarizeAgentContext: async (roomId: string, agentId: string, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.agent.summarize_context', { room_id: roomId, agent_id: agentId }, key)),
  restartFromSummary: async (roomId: string, agentId: string, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.agent.restart_from_summary', { room_id: roomId, agent_id: agentId }, key)),
  conversations: (roomId: string, params: { limit?: number; offset?: number; status?: 'archived' | 'deleted' } = {}, options: RequestOptions = {}) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    if (params.status) q.set('status', params.status)
    return get<Page<RoomConversation>>(`/rooms/${roomId}/conversations?${q}`, options)
  },
  conversationDefaults: async (roomId: string, options: RequestOptions = {}) => {
    const result = await queryOperation('room.settings.read', {room_id:roomId}, options)
    if (!('status' in result) || result.status !== 'succeeded') throw new Error('Room settings unavailable')
    return result.data
  },
  saveConversationDefaults: async (roomId: string, defaults: import('@rainver/protocol').RoomConversationDefault[], expectedRevision: number, options: RequestOptions = {}) => {
    await commandReceipt('room.defaults.save', {room_id:roomId,defaults,expected_revision:expectedRevision}, options.idempotencyKey ?? crypto.randomUUID(),options)
  },
  setConversationArchived: async (roomId: string, sessionId: string, archived: boolean, options: RequestOptions = {}) => {
    await commandReceipt(archived ? 'room.conversation.archive' : 'room.conversation.restore',
      { room_id: roomId, session_id: sessionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
  },
  restoreDeletedConversation: async (roomId: string, sessionId: string, options: RequestOptions = {}) => {
    await commandReceipt('room.conversation.restore_deleted', { room_id: roomId, session_id: sessionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
  },
  deleteConversation: async (roomId: string, sessionId: string, options: RequestOptions = {}) => {
    await commandReceipt('room.conversation.delete', { room_id: roomId, session_id: sessionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
  },
  createConversation: async (roomId: string, options: RequestOptions = {}): Promise<RoomConversation> => {
    const receipt = await commandReceipt('room.conversation.create', { room_id: roomId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    const page = await roomsApi.messages(receipt.room_id, receipt.session_id, { limit: 1 }, { ...options, spaceId: receipt.space_id })
    if (!page.conversation) throw new Error('Room conversation no longer available')
    return page.conversation
  },
  messages: (
    roomId: string,
    sessionId: string,
    params: { limit?: number; offset?: number } = {}, options: RequestOptions = {},
  ) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return (
    get<{
      items: RoomMessage[]
      /** What people said while the turn was taken, not yet posted. */
      queued?: QueuedRoomMessage[]
      /** Visible active Room Runs across the conversation, on the first page. */
      active_run_ids?: string[]
      conversation?: RoomConversation
      task_group_ids: string[]
      limit: number
      offset: number
    }>(`/rooms/${roomId}/conversations/${sessionId}/messages?${q}`, options)
    )
  },
  sendMessage: async (
    roomId: string,
    sessionId: string,
    body: Omit<SendRoomMessageRequest, 'input_parts' | 'queue'> & { input_parts?: ConversationInputPart[]; queue?: boolean }, options: RequestOptions = {},
  ): Promise<{ message: RoomMessage; conversation: RoomConversation; task_group_ids: string[]; run_ids: string[] } | QueuedRoomMessageResponse | { queued: null } | RoomLiveInputSent> => {
    const receipt = await commandReceipt('room.message.send', { ...body, room_id: roomId, session_id: sessionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
      .catch(error => {
        // Several active Runs could take it, or the Run the person chose no longer can: nothing was
        // recorded or sent, and the person chooses (`modules/rooms.md`).
        const metadata = error instanceof ApiRequestError ? (error.payload?.error as { metadata?: Record<string, unknown> } | undefined)?.metadata : undefined
        if (metadata?.code === ROOM_LIVE_INPUT_CHOICE_REQUIRED || metadata?.code === ROOM_LIVE_INPUT_TARGET_UNAVAILABLE) {
          throw new ApiRequestError(error.message, error.status, metadata.code, metadata, error.requestId)
        }
        throw error
      })
    try {
      if (receipt.status === 'live_input') {
        // Added to an active Run; the message is canonical in the conversation, its outcome is the Run's to report.
        return { ...await turnAfter(receipt, options), live: { run_id: receipt.run_id, message_id: receipt.message_id, state: receipt.delivery_state } }
      }
      if (receipt.status === 'queued') {
        // Queued messages are listed whole with any page; only one item is needed.
        const page = await roomsApi.messages(receipt.room_id, receipt.session_id, { limit: 1 }, { ...options, spaceId: receipt.space_id })
        // A successful receipt is durable even if the message already left the queue.
        return { queued: page.queued?.find(item => item.id === receipt.queued_id) ?? null }
      }
      return { ...await turnAfter(receipt, options), task_group_ids: receipt.task_group_ids, run_ids: receipt.run_ids }
    } catch (error) {
      // The write receipt already succeeded. A read failure must preserve the send key.
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { cause: error })
    }
  },
  /** Takes back one's own message that is still waiting for the turn. */
  withdrawQueuedMessage: async (roomId: string, sessionId: string, queuedId: string, options: RequestOptions = {}) => {
    const receipt = await commandReceipt('room.message.withdraw_queued', { room_id: roomId, session_id: sessionId, queued_id: queuedId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return { id: receipt.queued_id }
  },
  retryMessage: async (roomId: string, sessionId: string, runId: string, options: RequestOptions = {}): Promise<Omit<ConversationRetryResponse, 'reused'>> => {
    const { space_id: _space, room_id: _room, ...retry } = await commandReceipt('room.message.retry', { room_id: roomId, session_id: sessionId, run_id: runId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return retry
  },
  continueAfterProposal: async (
    roomId: string,
    sessionId: string,
    body: ContinueRoomAfterProposalRequest, options: RequestOptions = {},
  ): Promise<{ message: RoomMessage; conversation: RoomConversation; task_group_ids: string[]; run_ids: string[] }> => {
    const receipt = await commandReceipt('room.message.continue_after_proposal', { ...body, room_id: roomId, session_id: sessionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return { ...await turnAfter(receipt, options), task_group_ids: receipt.task_group_ids, run_ids: receipt.run_ids }
  },
  /** Posts the topic as the person's message and dispatches the first wave; 409 while another discussion is active. */
  openDiscussion: async (roomId: string, sessionId: string, body: OpenRoomDiscussionRequest, options: RequestOptions = {}): Promise<OpenRoomDiscussionResponse> => {
    const receipt = await commandReceipt('room.discussion.start', { ...body, room_id: roomId, session_id: sessionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    const scoped = { ...options, spaceId: receipt.space_id }
    const [turn, detail] = await Promise.all([turnAfter(receipt, options), roomsApi.discussion(receipt.room_id, receipt.session_id, receipt.discussion_id, scoped)])
    return { ...turn, task_group_ids: receipt.task_group_ids, run_ids: receipt.run_ids, discussion: detail.discussion }
  },
  /** Newest first. */
  discussions: (roomId: string, sessionId: string, options: RequestOptions = {}) =>
    get<RoomDiscussionListResponse>(`/rooms/${roomId}/conversations/${sessionId}/discussions`, options),
  discussion: (roomId: string, sessionId: string, discussionId: string, options: RequestOptions = {}) =>
    get<RoomDiscussionDetail>(`/rooms/${roomId}/conversations/${sessionId}/discussions/${discussionId}`, options),
  /** No further waves; the Manager then writes the conclusion. */
  stopDiscussion: async (roomId: string, sessionId: string, discussionId: string, options: RequestOptions = {}): Promise<RoomDiscussion> => {
    const receipt = await commandReceipt('room.discussion.stop', { room_id: roomId, session_id: sessionId, discussion_id: discussionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return (await roomsApi.discussion(receipt.room_id, receipt.session_id, receipt.discussion_id, { ...options, spaceId: receipt.space_id })).discussion
  },
  /** Adds rounds; on an emergent discussion held at its cap this also opens it. */
  extendDiscussion: async (roomId: string, sessionId: string, discussionId: string, body: ExtendRoomDiscussionRequest, options: RequestOptions = {}): Promise<RoomDiscussion> => {
    const receipt = await commandReceipt('room.discussion.extend', { ...body, room_id: roomId, session_id: sessionId, discussion_id: discussionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return (await roomsApi.discussion(receipt.room_id, receipt.session_id, receipt.discussion_id, { ...options, spaceId: receipt.space_id })).discussion
  },
  /** The Space's quota lines, the windows of the logins this conversation's Agents use, and what is held. */
  conversationQuota: (roomId: string, sessionId: string, options: RequestOptions = {}) =>
    get<RoomConversationQuota>(`/rooms/${roomId}/conversations/${sessionId}/quota`, options),
  /** "Continue anyway": admits the Agent-triggered turns held at the reserve line (Project writer). */
  continuePastQuota: async (roomId: string, sessionId: string, options: RequestOptions = {}): Promise<RoomConversationQuota> => {
    const receipt = await commandReceipt('room.quota.continue', { room_id: roomId, session_id: sessionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return roomsApi.conversationQuota(receipt.room_id, receipt.session_id, { ...options, spaceId: receipt.space_id })
  },
}
