import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { PgHostThreadRepository } from "../hosts/threadRepository.js";

export interface ClosingDirectThread {
  threadId: string;
  hostId: string;
  agentId: string;
  includeWorkspace: boolean;
  containerKind: "direct" | "conversation";
  containerId: string;
}

/**
 * Archive a person's direct session in the caller's transaction; the Host
 * archive itself happens after commit. Returns null when the session is not
 * the person's active direct session.
 *
 * Outside a Project, a direct thread and its managed workspace are the
 * Agent × person's, shared by every non-Project direct session of that Agent,
 * so they close (with a durable `pending_archive_at`) only with the person's
 * last such session of the Agent. A direct session placed in a Project is its
 * own Conversation container, so its threads, cwd and runtime profiles close
 * with it, and it never keeps the person's general direct container alive.
 */
export async function archiveDirectSession(client: Queryable, identity: SpaceUserIdentity, sessionId: string): Promise<null | ClosingDirectThread[]> {
  const session = await client.query<{ id: string; project_id: string | null }>(
    `SELECT s.id, s.project_id
       FROM sessions s
      WHERE s.id = $1
        AND s.space_id = $2
        AND s.user_id = $3
        AND s.room_id IS NULL
        AND s.status = 'active'
      FOR UPDATE`,
    [sessionId, identity.spaceId, identity.userId],
  );
  const row = session.rows[0];
  if (!row) return null;

  await client.query(
    `UPDATE sessions SET status = 'archived', updated_at = now()
      WHERE id = $1 AND space_id = $2 AND user_id = $3`,
    [sessionId, identity.spaceId, identity.userId],
  );

  const threadRepository = new PgHostThreadRepository(client);
  if (row.project_id) {
    const closed = await threadRepository.closeDirectConversationThreads(identity.spaceId, sessionId);
    return closed
      .filter((thread) => thread.execution_host_id && thread.agent_id)
      .map((thread) => ({
        threadId: thread.id,
        hostId: thread.execution_host_id!,
        agentId: thread.agent_id!,
        includeWorkspace: thread.include_workspace,
        containerKind: "conversation" as const,
        containerId: sessionId,
      }));
  }

  const directThreads = await client.query<{
    id: string;
    agent_id: string;
    execution_host_id: string | null;
    workspace_mode: "location" | "managed";
  }>(
    `SELECT thread.id, thread.agent_id, thread.execution_host_id, thread.workspace_mode
       FROM session_conversation_backends binding
       JOIN host_threads thread
         ON thread.agent_id = binding.agent_id
        AND thread.container_kind = 'direct'
        AND thread.container_user_id = binding.bound_by_user_id
        AND thread.status IN ('active', 'session_reset')
      WHERE binding.space_id = $1
        AND binding.session_id = $2
        AND binding.bound_by_user_id = $3
      FOR UPDATE OF thread`,
    [identity.spaceId, sessionId, identity.userId],
  );

  // Like a Room's workspace, archived only when the last Agent leaves, the
  // direct container closes only with the person's last active non-Project
  // direct session of the Agent. Project sessions do not use it.
  const stillInUse = await client.query<{ agent_id: string }>(
    `SELECT DISTINCT binding.agent_id
       FROM session_conversation_backends binding
       JOIN sessions other ON other.id = binding.session_id AND other.space_id = binding.space_id
      WHERE binding.space_id = $1
        AND binding.bound_by_user_id = $2
        AND binding.session_id <> $3
        AND binding.agent_id = ANY($4::varchar[])
        AND other.user_id = $2
        AND other.room_id IS NULL
        AND other.project_id IS NULL
        AND other.status = 'active'`,
    [identity.spaceId, identity.userId, sessionId, directThreads.rows.map((thread) => thread.agent_id)],
  );
  const inUse = new Set(stillInUse.rows.map((r) => r.agent_id));
  const closing = directThreads.rows.filter((thread) => !inUse.has(thread.agent_id));

  for (const thread of closing) {
    // Always pending: even a thread with no Rainver-managed cwd has this
    // Agent's runtime profile on the host to archive.
    await threadRepository.closeDirectAgent(thread.agent_id, identity.userId, true);
  }
  return closing
    .filter((thread) => thread.execution_host_id)
    .map((thread) => ({
      threadId: thread.id,
      hostId: thread.execution_host_id!,
      agentId: thread.agent_id,
      includeWorkspace: thread.workspace_mode === "managed",
      containerKind: "direct" as const,
      containerId: identity.userId,
    }));
}
