import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { withQueryableTransaction } from "../routeUtils/common.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import {
  providerSupportsTask,
  resolveProviderCommandStore,
  type ProviderCommandStore,
} from "../providers/commands/store.js";
import { completeProviderMessages } from "../providers/invocation/invocation.js";
import {
  isProviderEligibleForUser,
  providerCredentialEligibilitySql,
  type ProviderEligibilityRow,
} from "../providers/eligibility.js";

export const ROOM_CONVERSATION_TITLE_JOB = "room_conversation_title";
export const ROOM_CONVERSATION_TITLE_TASK = "room_conversation_title";

const PLACEHOLDER_TITLE_SQL = `lower(btrim(COALESCE(session_row.title, ''))) IN ('', 'conversation', 'new conversation')`;

export interface RoomConversationTitleDependencies {
  resolveProviderStore?: (config: ServerConfig) => ProviderCommandStore;
  completeProviderMessages?: typeof completeProviderMessages;
}

export interface RoomConversationTitleResult {
  id: string;
  space_id: string;
  user_id: null;
  project_folder_id: string | null;
  project_id: string;
  room_id: string;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Give the first Room message a useful zero-cost title immediately, then queue
 * a tiny optional model pass. The provisional update and job enqueue happen in
 * the caller's transaction, so a failed message dispatch leaves neither behind.
 */
export async function requestRoomConversationTitle(
  db: Queryable,
  input: {
    spaceId: string;
    roomId: string;
    sessionId: string;
    sourceMessageId: string;
    sourceUserId: string;
    content: string;
  },
): Promise<RoomConversationTitleResult | null> {
  return withQueryableTransaction(db, async (client) => {
    const provisionalTitle = titleFromMessage(input.content);
    const updated = await client.query<Omit<RoomConversationTitleResult, "user_id">>(
      `UPDATE sessions session_row
          SET title=$4, updated_at=now()
        WHERE session_row.space_id=$1
          AND session_row.room_id=$2
          AND session_row.id=$3
          AND session_row.status='active'
          AND ${PLACEHOLDER_TITLE_SQL}
       RETURNING session_row.id,session_row.space_id,session_row.project_folder_id,
                 session_row.project_id,session_row.room_id,session_row.title,
                 session_row.status,session_row.created_at,session_row.updated_at`,
      [
        input.spaceId,
        input.roomId,
        input.sessionId,
        provisionalTitle,
      ],
    );
    const conversation = updated.rows[0];
    if (!conversation) return null;

    await new PgJobQueueRepository(client).enqueue({
      job_type: ROOM_CONVERSATION_TITLE_JOB,
      space_id: input.spaceId,
      user_id: input.sourceUserId,
      payload: {
        room_id: input.roomId,
        session_id: input.sessionId,
        source_message_id: input.sourceMessageId,
        provisional_title: provisionalTitle,
      },
      max_attempts: 1,
    });
    return { ...conversation, user_id: null };
  });
}

export class RoomConversationTitleService {
  private readonly resolveProviderStore: (config: ServerConfig) => ProviderCommandStore;
  private readonly complete: typeof completeProviderMessages;

  constructor(
    private readonly config: ServerConfig,
    private readonly db: Queryable,
    dependencies: RoomConversationTitleDependencies = {},
  ) {
    this.resolveProviderStore = dependencies.resolveProviderStore ?? resolveProviderCommandStore;
    this.complete = dependencies.completeProviderMessages ?? completeProviderMessages;
  }

  async process(input: {
    spaceId: string;
    roomId: string;
    sessionId: string;
    sourceMessageId: string;
    sourceUserId: string;
    provisionalTitle: string;
    jobId?: string | null;
  }): Promise<Record<string, unknown>> {
    const source = await this.db.query<{ content: string }>(
      `SELECT message.content
         FROM messages message
         JOIN sessions session_row
           ON session_row.id=message.session_id AND session_row.space_id=message.space_id
         JOIN rooms room
           ON room.id=session_row.room_id AND room.space_id=session_row.space_id
         JOIN room_user_members member
           ON member.room_id=room.id AND member.space_id=room.space_id
          AND member.user_id=$5 AND member.status='active'
        WHERE message.space_id=$1 AND session_row.room_id=$2
          AND session_row.id=$3 AND message.id=$4
          AND message.user_id=$5 AND message.role='user'
          AND session_row.status='active' AND room.status='active'
        LIMIT 1`,
      [input.spaceId, input.roomId, input.sessionId, input.sourceMessageId, input.sourceUserId],
    );
    const content = source.rows[0]?.content;
    if (!content) return { status: "skipped", reason: "source_unavailable" };

    const store = this.resolveProviderStore(this.config);
    let providerId: string | null = null;
    try {
      const taskChain = await store.getTaskChain(input.spaceId, ROOM_CONVERSATION_TITLE_TASK);
      providerId = taskChain?.[0]?.provider_id
        ?? await this.loadUserProviderId(input.spaceId, input.sourceUserId);
    } catch {
      return { status: "kept_provisional", title: input.provisionalTitle };
    }
    if (!providerId) return { status: "kept_provisional", title: input.provisionalTitle };

    let generated: string;
    try {
      const completion = await this.complete(store, input.spaceId, {
        provider_id: providerId,
        model: null,
        system: TITLE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: content.slice(0, 800) }],
        max_tokens: 48,
        task: ROOM_CONVERSATION_TITLE_TASK,
        metering: {
          source_type: "local_run",
          execution_channel: "managed_api",
          meter_subject_type: "user",
          meter_subject_id: input.sourceUserId,
          subject_user_id: input.sourceUserId,
          session_id: input.sessionId,
          task: ROOM_CONVERSATION_TITLE_TASK,
          metadata: input.jobId ? { job_id: input.jobId } : {},
        },
      });
      generated = cleanGeneratedTitle(completion.text) ?? input.provisionalTitle;
    } catch {
      return { status: "kept_provisional", title: input.provisionalTitle };
    }

    const updated = await this.db.query<{ title: string }>(
      `UPDATE sessions
          SET title=$4, updated_at=now()
        WHERE space_id=$1 AND room_id=$2 AND id=$3 AND status='active'
          AND title=$5
       RETURNING title`,
      [input.spaceId, input.roomId, input.sessionId, generated, input.provisionalTitle],
    );
    return updated.rows[0]
      ? { status: "renamed", title: updated.rows[0].title }
      : { status: "skipped", reason: "title_changed" };
  }

  /** Backfill old placeholder conversations without requiring another message. */
  async reconcilePending(limit = 100): Promise<number> {
    const rows = await this.db.query<{
      space_id: string;
      room_id: string;
      session_id: string;
      message_id: string;
      user_id: string;
      content: string;
    }>(
      `SELECT DISTINCT ON (session_row.id)
              session_row.space_id,session_row.room_id,session_row.id AS session_id,
              message.id AS message_id,message.user_id,message.content
         FROM sessions session_row
         JOIN rooms room
           ON room.id=session_row.room_id AND room.space_id=session_row.space_id
         JOIN messages message
           ON message.session_id=session_row.id AND message.space_id=session_row.space_id
        WHERE session_row.room_id IS NOT NULL
          AND session_row.status='active' AND room.status='active'
          AND message.role='user' AND message.user_id IS NOT NULL
          AND ${PLACEHOLDER_TITLE_SQL}
        ORDER BY session_row.id,message.created_at ASC,message.id ASC
        LIMIT $1`,
      [limit],
    );
    let updated = 0;
    for (const row of rows.rows) {
      const result = await requestRoomConversationTitle(this.db, {
        spaceId: row.space_id,
        roomId: row.room_id,
        sessionId: row.session_id,
        sourceMessageId: row.message_id,
        sourceUserId: row.user_id,
        content: row.content,
      });
      if (result) updated += 1;
    }
    return updated;
  }

  private async loadUserProviderId(spaceId: string, userId: string): Promise<string | null> {
    const result = await this.db.query<ProviderEligibilityRow & { id: string }>(
      `SELECT provider.id,
              provider.provider_type,
              provider.enabled AS provider_enabled,
              grant_row.enabled AS provider_grant_enabled,
              provider.owner_user_id AS provider_owner_user_id,
              provider_credential.credential_type AS provider_credential_type,
              ${providerCredentialEligibilitySql("provider.id", "provider.credential_id", "provider_credential")}
                AS provider_has_eligible_credential
         FROM model_providers provider
         JOIN model_provider_space_grants grant_row ON grant_row.provider_id=provider.id
         LEFT JOIN credentials provider_credential ON provider_credential.id=provider.credential_id
        WHERE grant_row.space_id=$1
          AND grant_row.enabled=true AND provider.enabled=true
        ORDER BY grant_row.is_default DESC,provider.updated_at DESC,provider.id ASC`,
      [spaceId],
    );
    return result.rows.find((row) =>
      isProviderEligibleForUser(row, userId)
      && providerSupportsTask(ROOM_CONVERSATION_TITLE_TASK, row.provider_type ?? "")
    )?.id ?? null;
  }
}

export function titleFromMessage(content: string): string {
  const compact = content
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/[`#>*_~]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:请|麻烦|能否|能不能|可以|请你|帮我|我想要?|我需要|需要你)\s*/u, "")
    .replace(/^(?:做一个|创建一个|新建一个)\s*/u, "")
    .replace(/^(?:please\s+)?(?:help\s+me\s+)?(?:i\s+(?:want|need)\s+to\s+)?/iu, "")
    .trim();
  const firstClause = compact.split(/[。！？!?\n]/u, 1)[0]?.trim() || compact;
  return truncateTitle(firstClause || "New topic");
}

export function cleanGeneratedTitle(value: string): string | null {
  const first = value
    .trim()
    .split(/\r?\n/u, 1)[0]!
    .replace(/^(?:title|标题)\s*[:：]\s*/iu, "")
    .replace(/^["'“‘`*#\s]+|["'”’`*#\s]+$/gu, "")
    .trim();
  if (!first || first.startsWith("{") || first.startsWith("[")) return null;
  return truncateTitle(first);
}

function truncateTitle(value: string): string {
  const characters = Array.from(value.trim());
  if (characters.length <= 48) return characters.join("");
  return `${characters.slice(0, 47).join("").trimEnd()}…`;
}

const TITLE_SYSTEM_PROMPT = `Create a concise title for this conversation from the user's first message.
Use the same language as the user. Keep the specific topic and intent.
For Chinese, use about 6-18 characters. For other languages, use about 3-8 words.
Return only the title: no quotes, label, JSON, markdown, explanation, or ending punctuation.`;
