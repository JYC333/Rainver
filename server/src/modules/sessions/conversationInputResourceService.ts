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
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { RunRecord } from "../runs/repository.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { Queryable } from "../routeUtils/common.js";
import { projectReadAccessSql } from "../access/contentAccessSql.js";

export class ConversationInputResourceToolError extends Error {
  constructor(readonly code: "resource_not_found" | "resource_unavailable" | "invalid_resource_request", message: string) {
    super(message);
    this.name = "ConversationInputResourceToolError";
  }
}

interface ResourceRow {
  id: string;
  sha256: string;
  content: string;
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

  private async loadResource(input: { spaceId: string; runId: string; messageId: string }, resourceId: string): Promise<ResourceRow> {
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
          AND run_row.status IN ('queued', 'running', 'cancelling', 'waiting_for_review', 'waiting_for_dependency')
          AND run_row.instructed_by_user_id IS NOT NULL
          AND (
            (session_row.room_id IS NULL AND session_row.user_id = run_row.instructed_by_user_id)
            OR (
              session_row.room_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM room_user_members resource_room_member
                 WHERE resource_room_member.space_id = session_row.space_id
                   AND resource_room_member.room_id = session_row.room_id
                   AND resource_room_member.user_id = run_row.instructed_by_user_id
                   AND resource_room_member.status = 'active'
              )
            )
          )
          AND (session_row.project_id IS NULL OR ${projectReadAccessSql(
            "session_row.space_id",
            "session_row.project_id",
            "run_row.instructed_by_user_id",
          )})
        LIMIT 1`,
      [input.runId, resourceId, input.spaceId, input.messageId],
    );
    const row = result.rows[0];
    if (!row) throw new ConversationInputResourceToolError("resource_not_found", "The attached resource is not available to this Run.");
    if (typeof row.content !== "string") {
      throw new ConversationInputResourceToolError("resource_unavailable", "The attached resource body is unavailable.");
    }
    return row;
  }
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
