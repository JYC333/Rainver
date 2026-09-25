import type {
  InputResourceReadInput,
  InputResourceReadOutput,
  InputResourceSearchInput,
  InputResourceSearchOutput,
  SystemActionId,
} from "@rainver/protocol";
import {
  INPUT_RESOURCE_MAX_READ_BYTES,
  INPUT_RESOURCE_MAX_READ_LINES,
  INPUT_RESOURCE_MAX_SEARCH_RESULTS,
  InputResourceReadInputSchema,
  InputResourceReadOutputSchema,
  InputResourceSearchInputSchema,
  InputResourceSearchOutputSchema,
} from "@rainver/protocol";
import { createHash } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { RunRecord } from "../runs/repository.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { Queryable } from "../routeUtils/common.js";
import { contentAccessLevelSql, contentReadSql, projectReadAccessSql, roomRunReadAccessSql } from "../access/contentAccessSql.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { bodyWithheld, type ContentAccessLevel } from "../access/contentAccessTypes.js";
import { ContentAccessAuditService } from "../contentAccess/audit.js";

const ARTIFACT_ACCESS = contentResourceDefinition("artifact")!;

/**
 * A Run's change reaches another Run as a link to its `remote_diff` Artifact
 * (`agentGroups/runChangeBlock.ts`); the resource tools accept the link or
 * the bare Artifact id as `resource_id`.
 */
export const RUN_ARTIFACT_URI_PREFIX = "rainver://artifacts/";

export class ConversationInputResourceToolError extends Error {
  constructor(readonly code: "resource_not_found" | "resource_unavailable" | "invalid_resource_request", message: string) {
    super(message);
    this.name = "ConversationInputResourceToolError";
  }
}

interface ResourceRow {
  id: string;
  sha256: string;
  content: string | null;
}

/**
 * Sessions-owned read authority for immutable message resources. The Run and
 * originating message are supplied by the dispatcher; this service never
 * looks up a live Folder or accepts a Host path.
 */
export class ConversationInputResourceService {
  constructor(private readonly db: Queryable) {}

  async read(input: {
    spaceId: string;
    runId: string;
    messageId: string;
    request: InputResourceReadInput;
  }): Promise<InputResourceReadOutput> {
    const request = InputResourceReadInputSchema.parse(input.request);
    const resource = await this.loadResource(input, request.resource_id);
    const lines = splitLines(resource.content);
    const startLine = request.start_line;
    if (lines.length > 0 && startLine > lines.length) {
      throw new ConversationInputResourceToolError("invalid_resource_request", `start_line ${startLine} is past the end of the resource`);
    }
    const selected: string[] = [];
    let byteSize = 0;
    let endLine = startLine - 1;
    let truncated = false;
    for (let index = startLine - 1; index < lines.length && selected.length < Math.min(request.line_count, INPUT_RESOURCE_MAX_READ_LINES); index += 1) {
      const candidate = lines[index]!;
      const separatorBytes = selected.length > 0 ? 1 : 0;
      const candidateBytes = Buffer.byteLength(candidate, "utf8") + separatorBytes;
      if (selected.length > 0 && byteSize + candidateBytes > INPUT_RESOURCE_MAX_READ_BYTES) {
        truncated = true;
        break;
      }
      if (selected.length === 0 && candidateBytes > INPUT_RESOURCE_MAX_READ_BYTES) {
        selected.push(truncateUtf8(candidate, INPUT_RESOURCE_MAX_READ_BYTES));
        byteSize = INPUT_RESOURCE_MAX_READ_BYTES;
        truncated = true;
      } else {
        selected.push(candidate);
        byteSize += candidateBytes;
      }
      endLine = index + 1;
    }
    truncated = truncated || endLine < lines.length;
    const output = {
      resource_id: resource.id,
      start_line: startLine,
      end_line: Math.max(startLine, endLine),
      next_line: truncated ? Math.max(startLine, endLine) + 1 : null,
      total_lines: lines.length,
      sha256: resource.sha256,
      content: selected.join("\n"),
      truncated,
    } satisfies InputResourceReadOutput;
    return InputResourceReadOutputSchema.parse(output);
  }

  async search(input: {
    spaceId: string;
    runId: string;
    messageId: string;
    request: InputResourceSearchInput;
  }): Promise<InputResourceSearchOutput> {
    const request = InputResourceSearchInputSchema.parse(input.request);
    const resource = await this.loadResource(input, request.resource_id);
    const needle = request.case_sensitive ? request.query : request.query.toLocaleLowerCase();
    const matches: Array<{ line: number; excerpt: string }> = [];
    const lines = splitLines(resource.content);
    let truncated = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const haystack = request.case_sensitive ? line : line.toLocaleLowerCase();
      if (!haystack.includes(needle)) continue;
      if (matches.length >= Math.min(request.max_results, INPUT_RESOURCE_MAX_SEARCH_RESULTS)) {
        truncated = true;
        break;
      }
      matches.push({ line: index + 1, excerpt: line.slice(0, 1024) });
    }
    const output = {
      resource_id: resource.id,
      sha256: resource.sha256,
      matches,
      truncated,
    } satisfies InputResourceSearchOutput;
    return InputResourceSearchOutputSchema.parse(output);
  }

  private async loadResource(
    input: { spaceId: string; runId: string; messageId: string },
    resourceId: string,
  ): Promise<ResourceRow & { content: string }> {
    const linkedArtifactId = resourceId.startsWith(RUN_ARTIFACT_URI_PREFIX)
      ? resourceId.slice(RUN_ARTIFACT_URI_PREFIX.length)
      : null;
    const row = linkedArtifactId === null
      ? await this.loadMessageResource(input, resourceId)
      : null;
    const resource = row ?? await this.loadConversationRunChange(input, linkedArtifactId ?? resourceId);
    if (!resource) throw new ConversationInputResourceToolError("resource_not_found", "The attached resource is not available to this Run.");
    if (typeof resource.content !== "string") {
      throw new ConversationInputResourceToolError("resource_unavailable", "The attached resource body is unavailable.");
    }
    return { ...resource, content: resource.content };
  }

  private async loadMessageResource(input: { spaceId: string; runId: string; messageId: string }, resourceId: string): Promise<ResourceRow | null> {
    const result = await this.db.query<ResourceRow>(
      `SELECT resource.id, resource.sha256, blob.content
         FROM conversation_input_resources resource
         JOIN conversation_input_resource_blobs blob
           ON blob.id = resource.blob_id AND blob.space_id = resource.space_id
         JOIN message_input_parts part
           ON part.resource_id = resource.id AND part.space_id = resource.space_id
          AND part.message_id = resource.message_id
         JOIN runs run_row
           ON run_row.id = $1 AND run_row.space_id = resource.space_id
          AND run_row.session_id = resource.session_id
         JOIN sessions session_row
           ON session_row.id = resource.session_id AND session_row.space_id = resource.space_id
          AND session_row.status = 'active'
        WHERE resource.id = $2
          AND resource.space_id = $3
          AND resource.message_id = $4
          AND ${liveRunInConversationSql("run_row", "session_row")}
        LIMIT 1`,
      [input.runId, resourceId, input.spaceId, input.messageId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Another Run's change, handed to this Run as a `rainver://artifacts/<id>`
   * link: only a `remote_diff` Artifact of a Run in this Run's own
   * conversation, and only when the person this Run acts for can read that
   * Artifact through the ordinary Artifact read gate (content ACL and Room Run
   * grants) with its body — never by admin oversight, since the Agent's reply
   * goes to everyone in the conversation. The read is audited for that person.
   */
  private async loadConversationRunChange(
    input: { spaceId: string; runId: string },
    artifactId: string,
  ): Promise<ResourceRow | null> {
    const reader = "run_row.instructed_by_user_id";
    const result = await this.db.query<{
      id: string;
      content: string | null;
      viewer_user_id: string;
      agent_id: string | null;
      effective_access_level: ContentAccessLevel;
    }>(
      `SELECT artifact.id, artifact.content, run_row.instructed_by_user_id AS viewer_user_id,
              run_row.agent_id,
              ${contentAccessLevelSql({ definition: ARTIFACT_ACCESS, alias: "artifact", userExpr: reader, includeOversight: false })} AS effective_access_level
         FROM artifacts artifact
         JOIN runs source_run
           ON source_run.id = artifact.run_id AND source_run.space_id = artifact.space_id
         JOIN runs run_row
           ON run_row.id = $1 AND run_row.space_id = artifact.space_id
          AND run_row.session_id = source_run.session_id
         JOIN sessions session_row
           ON session_row.id = run_row.session_id AND session_row.space_id = run_row.space_id
          AND session_row.status = 'active'
        WHERE artifact.id = $2
          AND artifact.space_id = $3
          AND artifact.artifact_type = 'remote_diff'
          AND ${liveRunInConversationSql("run_row", "session_row")}
          AND ${contentReadSql("artifact", "artifact", reader, { includeOversight: false })}
          AND ${roomRunReadAccessSql("artifact.run_id", "artifact.space_id", reader)}
        LIMIT 1`,
      [input.runId, artifactId, input.spaceId],
    );
    const row = result.rows[0];
    if (!row || bodyWithheld(row.effective_access_level)) return null;
    if (typeof row.content !== "string") return { id: row.id, sha256: "", content: null };
    await new ContentAccessAuditService(this.db).recordReads({
      spaceId: input.spaceId,
      resourceType: "artifact",
      resourceIds: [row.id],
      viewerUserId: row.viewer_user_id,
      accessType: "explicit_read",
      agentId: row.agent_id,
      runId: input.runId,
    });
    return {
      id: row.id,
      sha256: createHash("sha256").update(row.content, "utf8").digest("hex"),
      content: row.content,
    };
  }
}

/**
 * The reading Run is live and acts for a person who is in this conversation:
 * the direct chat's own person, or an active member of its Room, with read
 * access to the conversation's Project.
 */
function liveRunInConversationSql(run: string, session: string): string {
  return `${run}.status IN ('queued', 'running', 'cancelling', 'waiting_for_review', 'waiting_for_dependency')
          AND ${run}.instructed_by_user_id IS NOT NULL
          AND (
            (${session}.room_id IS NULL AND ${session}.user_id = ${run}.instructed_by_user_id)
            OR (
              ${session}.room_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM room_user_members resource_room_member
                 WHERE resource_room_member.space_id = ${session}.space_id
                   AND resource_room_member.room_id = ${session}.room_id
                   AND resource_room_member.user_id = ${run}.instructed_by_user_id
                   AND resource_room_member.status = 'active'
              )
            )
          )
          AND (${session}.project_id IS NULL OR ${projectReadAccessSql(
            `${session}.space_id`,
            `${session}.project_id`,
            `${run}.instructed_by_user_id`,
          )})`;
}

export function registerConversationInputResourceExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
  messageId: string,
): void {
  if (!config.databaseUrl || !messageId) return;
  const service = new ConversationInputResourceService(getDbPool(config.databaseUrl));
  executors.set("input_resource.read", async (input) => {
    const output = await service.read({
      spaceId: run.space_id,
      runId: run.id,
      messageId,
      request: input as InputResourceReadInput,
    });
    return {
      modelResult: { ok: true, tool: "input_resource.read", ...output },
      summary: {
        tool_name: "input_resource.read",
        ok: true,
        resource_id: output.resource_id,
        start_line: output.start_line,
        end_line: output.end_line,
        truncated: output.truncated,
      },
    };
  });
  executors.set("input_resource.search", async (input) => {
    const output = await service.search({
      spaceId: run.space_id,
      runId: run.id,
      messageId,
      request: input as InputResourceSearchInput,
    });
    return {
      modelResult: { ok: true, tool: "input_resource.search", ...output },
      summary: {
        tool_name: "input_resource.search",
        ok: true,
        resource_id: output.resource_id,
        match_count: output.matches.length,
        truncated: output.truncated,
      },
    };
  });
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split(/\r\n|\r|\n/u);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}
