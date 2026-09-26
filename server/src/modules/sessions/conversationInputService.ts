import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type TransformCallback } from "node:stream";
import type { Readable } from "node:stream";
import type { FileNode } from "@rainver/folder-read";
import type {
  ConversationInputFileSearchResponse,
  ConversationInputImagePart,
  ConversationInputMediaOut,
  ConversationInputPart,
  ConversationInputResource,
  ConversationInputResourceDescriptor,
  InputResourceSelection,
} from "@rainver/protocol";
import {
  CONVERSATION_MAX_FILE_REFERENCES,
  CONVERSATION_MAX_FILE_SNAPSHOT_BYTES,
  CONVERSATION_MAX_IMAGE_BYTES,
  CONVERSATION_MAX_TOTAL_FILE_SNAPSHOT_BYTES,
  CONVERSATION_MAX_TOTAL_IMAGE_BYTES,
  ConversationImageMediaTypeSchema,
  INPUT_RESOURCE_MAX_BYTES,
  INPUT_RESOURCE_MAX_TOTAL_BYTES,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { PgProjectFolderRepository } from "../projectFolders/repository.js";
import { projectReadAccessSql } from "../access/contentAccessSql.js";
import { PgConversationExecutionContextRepository } from "./executionContextRepository.js";

const IMAGE_MEDIA_TYPES = new Set(ConversationImageMediaTypeSchema.options);
const MEDIA_RETENTION_MS = 24 * 60 * 60 * 1000;

export class ConversationInputError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "ConversationInputError";
  }
}

export interface PreparedConversationImage {
  kind: "image";
  media_id: string;
  filename: string;
  media_type: ConversationInputImagePart["media_type"];
  byte_size: number;
  sha256: string;
  storage_path: string;
}

export interface PreparedConversationFile {
  kind: "file_reference";
  project_folder_id: string;
  workspace_location_id: string;
  relative_path: string;
  display_name: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  content: string;
}

export interface PreparedConversationResource {
  kind: "input_resource";
  source_state: "saved" | "draft";
  project_id: string;
  project_folder_id: string;
  workspace_location_id: string;
  relative_path: string;
  display_name: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  content: string;
  draft_id: string | null;
  draft_version: number | null;
  base_sha256: string | null;
  selection: InputResourceSelection | undefined;
}

export type PreparedConversationInputPart = PreparedConversationImage | PreparedConversationFile | PreparedConversationResource;

interface InputResourceDescriptorRow {
  resource_id: string;
  resource_source_state: "saved" | "draft";
  display_name: string;
  media_type: string;
  byte_size: number;
  resource_sha256: string;
  resource_relative_path: string | null;
  resource_captured_at: Date | string;
  resource_selection_start_line: number | null;
  resource_selection_start_column: number | null;
  resource_selection_end_line: number | null;
  resource_selection_end_column: number | null;
}

export async function loadConversationInputResourceDescriptors(
  db: Queryable,
  input: { spaceId: string; messageId: string },
): Promise<ConversationInputResourceDescriptor[]> {
  const result = await db.query<InputResourceDescriptorRow>(
    `SELECT resource.id AS resource_id, resource.source_state AS resource_source_state,
            resource.display_name, resource.media_type, resource.byte_size,
            resource.sha256 AS resource_sha256, resource.relative_path AS resource_relative_path,
            resource.captured_at AS resource_captured_at,
            resource.selection_start_line AS resource_selection_start_line,
            resource.selection_start_column AS resource_selection_start_column,
            resource.selection_end_line AS resource_selection_end_line,
            resource.selection_end_column AS resource_selection_end_column
       FROM message_input_parts part
       JOIN conversation_input_resources resource
         ON resource.id = part.resource_id AND resource.space_id = part.space_id
        AND resource.message_id = part.message_id
      WHERE part.space_id = $1 AND part.message_id = $2 AND part.kind = 'input_resource'
      ORDER BY part.position ASC`,
    [input.spaceId, input.messageId],
  );
  return result.rows.map(inputResourceDescriptor);
}

export function renderConversationInputResourceDescriptors(
  descriptors: readonly ConversationInputResourceDescriptor[],
): string {
  if (descriptors.length === 0) return "";
  const hasDraft = descriptors.some((descriptor) => descriptor.source_state === "draft");
  return [
    "[Attached immutable input resources]",
    "These snapshots are the authoritative input for this turn; a workspace file at the same relative_path may differ.",
    "Use input_resource.read or input_resource.search with resource_id to inspect a resource.",
    ...(hasDraft ? [
      "IMPORTANT: every descriptor with source_state=draft is the user's latest acknowledged unsaved content.",
      "Before reading or modifying its relative_path, read that resource's complete draft with input_resource.read (continue from next_line while truncated=true) and use it as the baseline; do not base the change on the same-path workspace file.",
      "Preserve the draft's content unless the user's instruction explicitly replaces it.",
    ] : []),
    ...descriptors.map((descriptor) => JSON.stringify(descriptor)),
  ].join("\n");
}

function inputResourceDescriptor(row: InputResourceDescriptorRow): ConversationInputResourceDescriptor {
  const selection = row.resource_selection_start_line !== null
    && row.resource_selection_start_column !== null
    && row.resource_selection_end_line !== null
    && row.resource_selection_end_column !== null
    ? {
        start_line: row.resource_selection_start_line,
        start_column: row.resource_selection_start_column,
        end_line: row.resource_selection_end_line,
        end_column: row.resource_selection_end_column,
      }
    : undefined;
  return {
    resource_id: row.resource_id,
    source_state: row.resource_source_state,
    display_name: row.display_name,
    media_type: row.media_type,
    relative_path: row.resource_relative_path,
    byte_size: row.byte_size,
    sha256: row.resource_sha256,
    captured_at: new Date(row.resource_captured_at).toISOString(),
    ...(selection ? { selection } : {}),
  };
}

export interface ConversationInputMediaRecord extends ConversationInputMediaOut {
  space_id: string;
  owner_user_id: string;
  lifecycle: "pending" | "claimed" | "deleted";
  storage_path: string;
  message_id: string | null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("conversation file search cancelled");
  error.name = "AbortError";
  throw error;
}

export class ConversationInputService {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {}

  storageRoot(): string {
    return resolve(this.config.rainverHome, "storage", "conversation-inputs");
  }

  async searchFiles(input: {
    spaceId: string;
    userId: string;
    sessionId: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ConversationInputFileSearchResponse> {
    throwIfAborted(input.signal);
    const contextRepository = new PgConversationExecutionContextRepository(this.db);
    const session = await contextRepository.getVisibleSession({ spaceId: input.spaceId, userId: input.userId }, input.sessionId);
    if (!session) throw new ConversationInputError(404, "conversation not found");
    if (!session.project_id) throw new ConversationInputError(422, "file search requires a Project conversation");
    const context = await contextRepository.getContext(input.spaceId, input.sessionId);
    if (!context || context.state !== "initialized") {
      throw new ConversationInputError(409, "initialize the conversation execution context before searching files");
    }

    const sources: Array<{ projectFolderId: string; workspaceLocationId: string; label: string }> = [];
    if (context.primary_workspace_mode === "location" && context.primary_project_folder_id && context.primary_workspace_location_id) {
      const location = await contextRepository.getLocation(
        input.spaceId,
        context.primary_project_folder_id,
        context.primary_workspace_location_id,
      );
      if (location?.status === "active") {
        sources.push({
          projectFolderId: location.project_folder_id,
          workspaceLocationId: location.id,
          label: `Primary · ${location.folder_name}`,
        });
      }
    }
    for (const attachment of await contextRepository.listAttachments(input.spaceId, input.sessionId)) {
      if (attachment.status !== "active") continue;
      sources.push({
        projectFolderId: attachment.project_folder_id,
        workspaceLocationId: attachment.workspace_location_id,
        label: `Attached · ${attachment.folder_name}`,
      });
    }

    const query = input.query.trim().toLowerCase();
    const matches: Array<ConversationInputFileSearchResponse["items"][number]> = [];
    const repository = new PgProjectFolderRepository(this.db, this.config);
    for (const source of dedupeFileSources(sources)) {
      throwIfAborted(input.signal);
      const tree = await repository.getTree(
        { spaceId: input.spaceId, userId: input.userId },
        session.project_id,
        source.projectFolderId,
        { workspaceLocationId: source.workspaceLocationId, signal: input.signal },
      );
      collectFileMatches(tree, source, query, matches, input.limit + 1);
      if (matches.length > input.limit) break;
    }
    return {
      items: matches.slice(0, input.limit),
      truncated: matches.length > input.limit,
    };
  }

  async uploadImage(input: {
    spaceId: string;
    userId: string;
    filename: string;
    mediaType: string;
    stream: Readable;
  }): Promise<ConversationInputMediaOut> {
    if (!IMAGE_MEDIA_TYPES.has(input.mediaType as ConversationInputImagePart["media_type"])) {
      throw new ConversationInputError(415, "Only PNG, JPEG, and WebP images are supported");
    }
    const mediaId = randomUUID();
    const root = this.storageRoot();
    const finalPath = resolve(root, input.spaceId, `${mediaId}.bin`);
    const temporaryPath = `${finalPath}.upload`;
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    let byteSize = 0;
    let prefix = Buffer.alloc(0);
    const sha256 = createHash("sha256");
    const meter = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        byteSize += chunk.byteLength;
        if (byteSize > CONVERSATION_MAX_IMAGE_BYTES) {
          callback(new ConversationInputError(413, `image exceeds ${CONVERSATION_MAX_IMAGE_BYTES} bytes`));
          return;
        }
        if (prefix.byteLength < 16) prefix = Buffer.concat([prefix, chunk]).subarray(0, 16);
        sha256.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(input.stream, meter, createWriteStream(temporaryPath, { mode: 0o600 }));
      const readable = input.stream as Readable & { truncated?: boolean };
      if (readable.truncated) throw new ConversationInputError(413, "image exceeds the upload limit");
      if (!matchesImageMagic(input.mediaType, prefix)) {
        throw new ConversationInputError(415, "image bytes do not match the declared PNG, JPEG, or WebP type");
      }
      if (byteSize <= 0) throw new ConversationInputError(422, "image must not be empty");
      await rename(temporaryPath, finalPath);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + MEDIA_RETENTION_MS).toISOString();
      const digest = sha256.digest("hex");
      try {
        await this.db.query(
          `INSERT INTO conversation_input_media (
             id, space_id, owner_user_id, filename, media_type, byte_size,
             sha256, storage_path, lifecycle, expires_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)`,
          [mediaId, input.spaceId, input.userId, safeFilename(input.filename), input.mediaType, byteSize, digest,
            relativeStoragePath(this.storageRoot(), finalPath), expiresAt, now.toISOString()],
        );
      } catch (error) {
        await unlink(finalPath).catch(() => undefined);
        throw error;
      }
      return {
        media_id: mediaId,
        filename: safeFilename(input.filename),
        media_type: input.mediaType as ConversationInputMediaOut["media_type"],
        byte_size: byteSize,
        sha256: digest,
        expires_at: expiresAt,
      };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof ConversationInputError) throw error;
      throw new ConversationInputError(400, `image upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async prepareMessageParts(input: {
    spaceId: string;
    userId: string;
    sessionId: string;
    parts: ConversationInputPart[];
  }): Promise<PreparedConversationInputPart[]> {
    if (input.parts.length === 0) return [];
    const prepared: PreparedConversationInputPart[] = [];
    let totalImageBytes = 0;
    let totalSnapshotBytes = 0;
    let totalFileReferences = 0;
    const mediaIds = new Set<string>();
    for (const part of input.parts) {
      if (part.kind === "image") {
        if (mediaIds.has(part.media_id)) throw new ConversationInputError(422, "an image may only appear once in a message");
        mediaIds.add(part.media_id);
        const result = await this.db.query<{
          id: string; filename: string; media_type: string; byte_size: number; sha256: string; storage_path: string;
        }>(
          `SELECT id, filename, media_type, byte_size, sha256, storage_path
             FROM conversation_input_media
            WHERE id = $1 AND space_id = $2 AND owner_user_id = $3
              AND lifecycle = 'pending' AND expires_at > now()
            FOR UPDATE`,
          [part.media_id, input.spaceId, input.userId],
        );
        const media = result.rows[0];
        if (!media) throw new ConversationInputError(422, `image '${part.media_id}' is unavailable or expired`);
        if (media.media_type !== part.media_type || media.byte_size !== part.byte_size
          || (part.sha256 && media.sha256 !== part.sha256)) {
          throw new ConversationInputError(422, `image '${part.media_id}' metadata does not match its upload`);
        }
        totalImageBytes += media.byte_size;
        if (totalImageBytes > CONVERSATION_MAX_TOTAL_IMAGE_BYTES) {
          throw new ConversationInputError(413, `images exceed the ${CONVERSATION_MAX_TOTAL_IMAGE_BYTES}-byte message limit`);
        }
        prepared.push({ kind: "image", media_id: media.id, filename: media.filename, media_type: media.media_type as PreparedConversationImage["media_type"], byte_size: media.byte_size, sha256: media.sha256, storage_path: media.storage_path });
        continue;
      }

      totalFileReferences += 1;
      if (totalFileReferences > CONVERSATION_MAX_FILE_REFERENCES) {
        throw new ConversationInputError(413, `at most ${CONVERSATION_MAX_FILE_REFERENCES} file references or resources are allowed`);
      }
      if (part.kind === "input_resource") {
        const draftPart = part.source_state === "draft" ? part : null;
        if (part.media_type.startsWith("image/")) {
          throw new ConversationInputError(422, "image files must be uploaded as images, not attached as text resources");
        }
        if (!isTextLikeMediaType(part.media_type)) {
          throw new ConversationInputError(415, `file '${part.display_name}' is not a supported text resource`);
        }
        if (part.byte_size > INPUT_RESOURCE_MAX_BYTES) {
          throw new ConversationInputError(413, `resource '${part.display_name}' exceeds ${INPUT_RESOURCE_MAX_BYTES} bytes`);
        }
        const session = await this.db.query<{ project_id: string | null }>(
          `SELECT project_id FROM sessions
            WHERE id = $1 AND space_id = $2 AND status = 'active'
              AND (user_id = $3 OR EXISTS (
                SELECT 1 FROM room_user_members member
                 WHERE member.space_id = sessions.space_id AND member.room_id = sessions.room_id
                   AND member.user_id = $3 AND member.status = 'active'
              ))`,
          [input.sessionId, input.spaceId, input.userId],
        );
        const projectId = session.rows[0]?.project_id;
        if (!projectId) throw new ConversationInputError(422, "input resources require a Project conversation");
        const projectFolderId = part.source_state === "saved" ? part.project_folder_id : null;
        const workspaceLocationId = part.source_state === "saved" ? part.workspace_location_id : null;
        const relativePath = part.source_state === "saved" ? part.relative_path : null;
        const draft = part.source_state === "draft"
          ? (await this.db.query<{
              id: string;
              project_id: string;
              project_folder_id: string;
              workspace_location_id: string;
              relative_path: string;
              base_exists: boolean;
              base_sha256: string | null;
              content: string;
              content_sha256: string;
              byte_size: number;
              version: number;
            }>(
              `SELECT id, project_id, project_folder_id, workspace_location_id,
                      relative_path, base_exists, base_sha256, content,
                      content_sha256, byte_size, version
                 FROM project_file_drafts
                WHERE id = $1 AND space_id = $2 AND owner_user_id = $3
                  AND expires_at > now()
                FOR UPDATE`,
              [draftPart?.draft_id, input.spaceId, input.userId],
            )).rows[0] ?? null
          : null;
        const resolvedFolderId = draft?.project_folder_id ?? projectFolderId;
        const resolvedLocationId = draft?.workspace_location_id ?? workspaceLocationId;
        const resolvedPath = draft?.relative_path ?? relativePath;
        if (!resolvedFolderId || !resolvedLocationId || !resolvedPath) {
          throw new ConversationInputError(422, `resource '${part.display_name}' has no authorized Folder location`);
        }
        if (draftPart && draft && (draft.project_id !== projectId
          || draft.version !== draftPart.draft_version
          || draft.content_sha256 !== draftPart.content_sha256
          || draft.byte_size !== draftPart.byte_size)) {
          throw new ConversationInputError(409, `draft '${draftPart.draft_id}' changed; flush it and attach it again`);
        }
        if (draftPart && !draft) {
          throw new ConversationInputError(409, `draft '${draftPart.draft_id}' is unavailable or expired`);
        }
        const authorized = await this.db.query<{ ok: boolean }>(
          `SELECT true AS ok
             FROM project_folders folder
             JOIN workspace_locations location
               ON location.id = $3 AND location.project_folder_id = folder.id AND location.space_id = folder.space_id
              AND location.status = 'active'
             JOIN sessions session_row
               ON session_row.id = $4 AND session_row.space_id = folder.space_id AND session_row.project_id = $5
             LEFT JOIN conversation_execution_contexts context
               ON context.space_id = session_row.space_id AND context.session_id = session_row.id
            WHERE folder.id = $2 AND folder.space_id = $1 AND folder.project_id = $5 AND folder.status = 'active'
              AND (
                (context.primary_workspace_location_id = location.id AND context.primary_project_folder_id = folder.id)
                OR EXISTS (
                  SELECT 1 FROM conversation_folder_access_grants grant_row
                   WHERE grant_row.space_id = folder.space_id AND grant_row.session_id = session_row.id
                     AND grant_row.project_folder_id = folder.id AND grant_row.workspace_location_id = location.id
                     AND grant_row.status = 'active'
                )
              )
           LIMIT 1`,
          [input.spaceId, resolvedFolderId, resolvedLocationId, input.sessionId, projectId],
        );
        if (!authorized.rows[0]) {
          throw new ConversationInputError(403, `resource '${part.display_name}' is not in the conversation's Primary Workspace or attached Folders`);
        }
        let content: string;
        let actualSize: number;
        let digest: string;
        let baseSha256: string | null = null;
        let sourceState: PreparedConversationResource["source_state"] = part.source_state;
        if (draft) {
          content = draft.content;
          actualSize = draft.byte_size;
          digest = draft.content_sha256;
          baseSha256 = draft.base_sha256;
        } else {
          const file = await new PgProjectFolderRepository(this.db, this.config).getFile(
            { spaceId: input.spaceId, userId: input.userId },
            projectId,
            resolvedFolderId,
            resolvedPath,
          );
          content = file.content;
          actualSize = Buffer.byteLength(content, "utf8");
          digest = createHash("sha256").update(content, "utf8").digest("hex");
        }
        if (actualSize > INPUT_RESOURCE_MAX_BYTES || looksBinaryText(content)) {
          throw new ConversationInputError(415, `resource '${part.display_name}' is not an admissible bounded text file`);
        }
        if (actualSize !== part.byte_size || digest !== (part.source_state === "draft" ? part.content_sha256 : part.sha256)) {
          throw new ConversationInputError(409, `resource '${part.display_name}' changed; refresh it and attach it again`);
        }
        totalSnapshotBytes += actualSize;
        if (totalSnapshotBytes > INPUT_RESOURCE_MAX_TOTAL_BYTES) {
          throw new ConversationInputError(413, `resources exceed the ${INPUT_RESOURCE_MAX_TOTAL_BYTES}-byte message limit`);
        }
        prepared.push({
          kind: "input_resource",
          source_state: sourceState,
          project_id: projectId,
          project_folder_id: resolvedFolderId,
          workspace_location_id: resolvedLocationId,
          relative_path: resolvedPath,
          display_name: part.display_name,
          media_type: part.media_type,
          byte_size: actualSize,
          sha256: digest,
          content,
          draft_id: draft?.id ?? null,
          draft_version: draft?.version ?? null,
          base_sha256: baseSha256,
          selection: part.selection,
        });
        continue;
      }

      if (part.media_type.startsWith("image/")) {
        throw new ConversationInputError(422, "image files must be uploaded as images, not attached as text files");
      }
      if (!isTextLikeMediaType(part.media_type)) {
        throw new ConversationInputError(415, `file '${part.display_name}' is not a supported text file`);
      }
      if (part.byte_size > CONVERSATION_MAX_FILE_SNAPSHOT_BYTES) {
        throw new ConversationInputError(413, `file '${part.display_name}' exceeds ${CONVERSATION_MAX_FILE_SNAPSHOT_BYTES} bytes`);
      }
      const session = await this.db.query<{ project_id: string | null }>(
        `SELECT project_id FROM sessions
          WHERE id = $1 AND space_id = $2 AND status = 'active'
            AND (user_id = $3 OR EXISTS (
              SELECT 1 FROM room_user_members member
               WHERE member.space_id = sessions.space_id AND member.room_id = sessions.room_id
                 AND member.user_id = $3 AND member.status = 'active'
            ))`,
        [input.sessionId, input.spaceId, input.userId],
      );
      const projectId = session.rows[0]?.project_id;
      if (!projectId) throw new ConversationInputError(422, "file references require a Project conversation");
      const authorized = await this.db.query<{ ok: boolean }>(
        `SELECT true AS ok
           FROM project_folders folder
           JOIN workspace_locations location
             ON location.id = $3 AND location.project_folder_id = folder.id AND location.space_id = folder.space_id
            AND location.status = 'active'
           JOIN sessions session_row
             ON session_row.id = $4 AND session_row.space_id = folder.space_id AND session_row.project_id = folder.project_id
           LEFT JOIN conversation_execution_contexts context
             ON context.space_id = session_row.space_id AND context.session_id = session_row.id
          WHERE folder.id = $2 AND folder.space_id = $1 AND folder.project_id = $5 AND folder.status = 'active'
            AND (
              (context.primary_workspace_location_id = location.id AND context.primary_project_folder_id = folder.id)
              OR EXISTS (
                SELECT 1 FROM conversation_folder_access_grants grant_row
                 WHERE grant_row.space_id = folder.space_id AND grant_row.session_id = session_row.id
                   AND grant_row.project_folder_id = folder.id AND grant_row.workspace_location_id = location.id
                   AND grant_row.status = 'active'
              )
            )
          LIMIT 1`,
        [input.spaceId, part.project_folder_id, part.workspace_location_id, input.sessionId, projectId],
      );
      if (!authorized.rows[0]) {
        throw new ConversationInputError(403, `file '${part.display_name}' is not in the conversation's Primary Workspace or attached Folders`);
      }
      const file = await new PgProjectFolderRepository(this.db, this.config).getFile(
        { spaceId: input.spaceId, userId: input.userId },
        projectId,
        part.project_folder_id,
        part.relative_path,
      );
      const actualSize = Buffer.byteLength(file.content, "utf8");
      if (actualSize > CONVERSATION_MAX_FILE_SNAPSHOT_BYTES) {
        throw new ConversationInputError(413, `file '${part.display_name}' exceeds ${CONVERSATION_MAX_FILE_SNAPSHOT_BYTES} bytes`);
      }
      if (looksBinaryText(file.content)) {
        throw new ConversationInputError(415, `file '${part.display_name}' is binary; only text files can be attached`);
      }
      totalSnapshotBytes += actualSize;
      if (totalSnapshotBytes > CONVERSATION_MAX_TOTAL_FILE_SNAPSHOT_BYTES) {
        throw new ConversationInputError(413, `file snapshots exceed the ${CONVERSATION_MAX_TOTAL_FILE_SNAPSHOT_BYTES}-byte message limit`);
      }
      const digest = createHash("sha256").update(file.content, "utf8").digest("hex");
      if (part.byte_size !== actualSize) {
        throw new ConversationInputError(409, `file '${part.display_name}' changed; refresh it and attach it again`);
      }
      if (digest !== part.sha256) throw new ConversationInputError(409, `file '${part.display_name}' changed; refresh it and attach it again`);
      prepared.push({
        kind: "file_reference",
        project_folder_id: part.project_folder_id,
        workspace_location_id: part.workspace_location_id,
        relative_path: file.path,
        display_name: part.display_name,
        media_type: part.media_type,
        byte_size: actualSize,
        sha256: digest,
        content: file.content,
      });
    }
    return prepared;
  }

  /** Must be called on the same transaction client that inserted the message. */
  async attachMessageParts(input: {
    spaceId: string;
    userId: string;
    sessionId: string;
    messageId: string;
    parts: PreparedConversationInputPart[];
  }): Promise<void> {
    for (let position = 0; position < input.parts.length; position += 1) {
      const part = input.parts[position]!;
      if (part.kind === "image") {
        const result = await this.db.query(
          `UPDATE conversation_input_media
              SET lifecycle = 'claimed', message_id = $4, claimed_at = now()
            WHERE id = $1 AND space_id = $2 AND owner_user_id = $3
              AND lifecycle = 'pending' AND expires_at > now()
            RETURNING id`,
          [part.media_id, input.spaceId, input.userId, input.messageId],
        );
        if (!result.rows[0]) throw new ConversationInputError(422, `image '${part.media_id}' could not be claimed`);
        await this.db.query(
          `INSERT INTO message_input_parts (
             id, space_id, session_id, message_id, position, kind, media_id,
             display_name, media_type, byte_size, sha256
           ) VALUES ($1, $2, $3, $4, $5, 'image', $6, $7, $8, $9, $10)`,
          [randomUUID(), input.spaceId, input.sessionId, input.messageId, position, part.media_id,
            part.filename, part.media_type, part.byte_size, part.sha256],
        );
      } else if (part.kind === "input_resource") {
        const blobId = await this.ensureResourceBlob(input.spaceId, input.userId, part);
        const resourceId = randomUUID();
        await this.db.query(
          `INSERT INTO conversation_input_resources (
             id, space_id, session_id, message_id, blob_id, source_kind, source_state,
             project_id, project_folder_id, workspace_location_id, relative_path,
             display_name, media_type, byte_size, sha256, draft_id, draft_version,
             base_sha256, capture_actor_user_id, captured_at,
             selection_start_line, selection_start_column, selection_end_line, selection_end_column
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                     $14, $15, $16, $17, $18, $19, now(), $20, $21, $22, $23)`,
          [resourceId, input.spaceId, input.sessionId, input.messageId, blobId,
            part.source_state === "draft" ? "project_file_draft" : "project_file",
            part.source_state, part.project_id, part.project_folder_id,
            part.workspace_location_id, part.relative_path, part.display_name,
            part.media_type, part.byte_size, part.sha256, part.draft_id,
            part.draft_version, part.base_sha256, input.userId,
            part.selection?.start_line ?? null, part.selection?.start_column ?? null,
            part.selection?.end_line ?? null, part.selection?.end_column ?? null],
        );
        await this.db.query(
          `INSERT INTO message_input_parts (
             id, space_id, session_id, message_id, position, kind, resource_id,
             display_name, media_type, byte_size, sha256
           ) VALUES ($1, $2, $3, $4, $5, 'input_resource', $6, $7, $8, $9, $10)`,
          [randomUUID(), input.spaceId, input.sessionId, input.messageId, position,
            resourceId, part.display_name, part.media_type, part.byte_size, part.sha256],
        );
      } else {
        const snapshotId = randomUUID();
        await this.db.query(
          `INSERT INTO conversation_file_snapshots (
             id, space_id, session_id, message_id, project_folder_id,
             workspace_location_id, relative_path, display_name, media_type,
             byte_size, sha256, content, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
          [snapshotId, input.spaceId, input.sessionId, input.messageId, part.project_folder_id,
            part.workspace_location_id, part.relative_path, part.display_name, part.media_type,
            part.byte_size, part.sha256, part.content],
        );
        await this.db.query(
          `INSERT INTO message_input_parts (
             id, space_id, session_id, message_id, position, kind, file_snapshot_id,
             project_folder_id, workspace_location_id, relative_path, display_name,
             media_type, byte_size, sha256
           ) VALUES ($1, $2, $3, $4, $5, 'file_reference', $6, $7, $8, $9, $10, $11, $12, $13)`,
          [randomUUID(), input.spaceId, input.sessionId, input.messageId, position, snapshotId,
            part.project_folder_id, part.workspace_location_id, part.relative_path, part.display_name,
            part.media_type, part.byte_size, part.sha256],
        );
      }
    }
  }

  /** Content-addressed blobs are deduplicated only inside their source scope. */
  private async ensureResourceBlob(
    spaceId: string,
    userId: string,
    part: PreparedConversationResource,
  ): Promise<string> {
    const scopeKey = part.source_state === "draft"
      ? `owner:${userId}`
      : `project:${part.project_id}`;
    await this.db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`conversation-input-resource:${spaceId}:${scopeKey}:${part.sha256}`],
    );
    const existing = await this.db.query<{ id: string; byte_size: number; content: string }>(
      `SELECT id, byte_size, content
         FROM conversation_input_resource_blobs
        WHERE space_id = $1 AND sha256 = $2
          AND ((project_id = $3 AND $3 IS NOT NULL)
            OR (owner_user_id = $4 AND $4 IS NOT NULL))
        LIMIT 1`,
      [spaceId, part.sha256, part.source_state === "saved" ? part.project_id : null, part.source_state === "draft" ? userId : null],
    );
    const row = existing.rows[0];
    if (row) {
      if (row.byte_size !== part.byte_size || row.content !== part.content) {
        throw new ConversationInputError(409, "resource hash collision or inconsistent immutable content");
      }
      return row.id;
    }
    const blobId = randomUUID();
    const lineCount = countLines(part.content);
    await this.db.query(
      `INSERT INTO conversation_input_resource_blobs (
         id, space_id, project_id, owner_user_id, sha256, byte_size, line_count, content, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [blobId, spaceId, part.source_state === "saved" ? part.project_id : null,
        part.source_state === "draft" ? userId : null, part.sha256, part.byte_size, lineCount, part.content],
    );
    return blobId;
  }

  async cleanupUnreferencedResourceBlobs(): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM conversation_input_resource_blobs blob
        WHERE NOT EXISTS (
          SELECT 1 FROM conversation_input_resources resource
           WHERE resource.space_id = blob.space_id AND resource.blob_id = blob.id
        )`,
    );
    return result.rowCount ?? 0;
  }

  async deletePendingMedia(spaceId: string, userId: string, mediaId: string): Promise<boolean> {
    const result = await this.db.query<{ id: string; storage_path: string }>(
      `UPDATE conversation_input_media
          SET lifecycle = 'deleted'
        WHERE id = $1 AND space_id = $2 AND owner_user_id = $3 AND lifecycle = 'pending'
        RETURNING id, storage_path`,
      [mediaId, spaceId, userId],
    );
    const row = result.rows[0];
    if (!row) return false;
    await unlinkStoragePath(this.storageRoot(), row.storage_path);
    await this.db.query(
      `DELETE FROM conversation_input_media
        WHERE id = $1 AND space_id = $2 AND owner_user_id = $3 AND lifecycle = 'deleted'`,
      [row.id, spaceId, userId],
    );
    return true;
  }

  async cleanupExpiredMedia(now = new Date()): Promise<number> {
    const result = await this.db.query<{ id: string; storage_path: string }>(
      `UPDATE conversation_input_media
          SET lifecycle = 'deleted', message_id = NULL
        WHERE lifecycle = 'deleted'
           OR (lifecycle = 'pending' AND expires_at <= $1)
           OR (lifecycle = 'claimed' AND message_id IS NULL AND claimed_at <= $2)
        RETURNING id, storage_path`,
      [now.toISOString(), new Date(now.getTime() - MEDIA_RETENTION_MS).toISOString()],
    );
    const removableIds: string[] = [];
    await Promise.all(result.rows.map(async (row) => {
      try {
        await unlinkStoragePath(this.storageRoot(), row.storage_path);
        removableIds.push(row.id);
      } catch {
        // Leave the tombstone for the next scheduler pass. A crash or a
        // transient filesystem failure must not make the row disappear while
        // its file remains unreachable by any later cleanup sweep.
      }
    }));
    if (removableIds.length === 0) return 0;
    const deleted = await this.db.query(
      `DELETE FROM conversation_input_media
        WHERE lifecycle = 'deleted' AND id = ANY($1::varchar[])`,
      [removableIds],
    );
    return deleted.rowCount ?? removableIds.length;
  }

  async getVisibleMedia(spaceId: string, userId: string, mediaId: string): Promise<ConversationInputMediaRecord | null> {
    const result = await this.db.query<ConversationInputMediaRecord>(
      `SELECT media.id AS media_id, media.space_id, media.owner_user_id, media.filename,
              media.media_type, media.byte_size, media.sha256, media.storage_path,
              media.lifecycle, media.message_id, media.expires_at
         FROM conversation_input_media media
        WHERE media.id = $1 AND media.space_id = $2 AND media.lifecycle = 'claimed'
          AND EXISTS (
            SELECT 1
               FROM messages message_row
               JOIN sessions session_row
                 ON session_row.id = message_row.session_id AND session_row.space_id = message_row.space_id
             WHERE message_row.id = media.message_id
               AND session_row.status = 'active'
               AND (
                 session_row.project_id IS NULL
                 OR ${projectReadAccessSql("session_row.space_id", "session_row.project_id", "$3")}
               )
               AND (
                 session_row.user_id = $3
                 OR EXISTS (
                   SELECT 1 FROM room_user_members member
                    WHERE member.space_id = session_row.space_id AND member.room_id = session_row.room_id
                      AND member.user_id = $3 AND member.status = 'active'
                 )
               )
          )
        LIMIT 1`,
      [mediaId, spaceId, userId],
    );
    return result.rows[0] ?? null;
  }

  async readMedia(record: ConversationInputMediaRecord): Promise<Buffer> {
    return this.readStoragePath(record.storage_path);
  }

  async readStoragePath(storagePath: string): Promise<Buffer> {
    const path = resolve(this.storageRoot(), storagePath);
    const root = await realpath(this.storageRoot()).catch(() => null);
    const actualPath = await realpath(path).catch(() => null);
    if (!root || !actualPath) throw new ConversationInputError(404, "conversation media is no longer available");
    const rootRelativePath = relative(root, actualPath);
    if (!rootRelativePath || isAbsolute(rootRelativePath) || rootRelativePath.startsWith(`..${sep}`) || rootRelativePath === "..") {
      throw new ConversationInputError(500, "conversation media storage path is invalid");
    }
    const info = await stat(actualPath).catch(() => null);
    if (!info?.isFile()) throw new ConversationInputError(404, "conversation media is no longer available");
    return readFile(actualPath);
  }

  /**
   * Hydrates the persisted logical parts only at dispatch time. The returned
   * objects are ACP v1-shaped but remain plain records so this service does
   * not become an ACP transport owner. A normal dispatch exposes file
   * references as authorized ResourceLinks and relative-path instructions.
   * Legacy file references may still hydrate their historical snapshot body on
   * manual retry; new immutable resources are always descriptors for the
   * run-scoped input_resource tools.
   */
  async loadPromptParts(input: {
    spaceId: string;
    messageId: string;
    embeddedContext: boolean;
    /** Manual retries must retain the original immutable file input. */
    useImmutableSnapshot?: boolean;
    /** The Gateway already placed input-resource descriptors in the current-user Delivery block. */
    descriptorsInDelivery?: boolean;
    executionHostId?: string;
  }): Promise<{
    blocks: Array<Record<string, unknown>>;
    resources: ConversationInputResource[];
  }> {
    const result = await this.db.query<{
      part_id: string;
      kind: "image" | "file_reference" | "input_resource";
      media_id: string | null;
      resource_id: string | null;
      display_name: string;
      media_type: string;
      byte_size: number;
      storage_path: string | null;
      relative_path: string | null;
      workspace_location_id: string | null;
      snapshot_id: string | null;
      snapshot_content?: string | null;
      resource_source_state: "saved" | "draft" | null;
      resource_sha256: string | null;
      resource_captured_at: Date | string | null;
      resource_relative_path: string | null;
      resource_workspace_location_id: string | null;
      resource_selection_start_line: number | null;
      resource_selection_start_column: number | null;
      resource_selection_end_line: number | null;
      resource_selection_end_column: number | null;
      location_root_path: string | null;
      location_host_id: string | null;
      location_host_kind: string | null;
    }>(
      `SELECT part.id AS part_id, part.kind, part.media_id, part.display_name,
              part.media_type, part.byte_size, media.storage_path,
              part.relative_path, part.workspace_location_id,
              snapshot.id AS snapshot_id,
              ${input.useImmutableSnapshot ? "snapshot.content AS snapshot_content," : ""}
              resource.id AS resource_id,
              resource.source_state AS resource_source_state,
              resource.sha256 AS resource_sha256,
              resource.captured_at AS resource_captured_at,
              resource.relative_path AS resource_relative_path,
              resource.workspace_location_id AS resource_workspace_location_id,
              resource.selection_start_line AS resource_selection_start_line,
              resource.selection_start_column AS resource_selection_start_column,
              resource.selection_end_line AS resource_selection_end_line,
              resource.selection_end_column AS resource_selection_end_column,
              location.root_path AS location_root_path,
              location.execution_host_id AS location_host_id,
              location.execution_host_kind AS location_host_kind
         FROM message_input_parts part
         LEFT JOIN conversation_input_media media
           ON media.id = part.media_id AND media.space_id = part.space_id
         LEFT JOIN conversation_file_snapshots snapshot
           ON snapshot.id = part.file_snapshot_id AND snapshot.space_id = part.space_id
         LEFT JOIN conversation_input_resources resource
           ON resource.id = part.resource_id AND resource.space_id = part.space_id
         LEFT JOIN workspace_locations location
           ON location.id = part.workspace_location_id
          AND location.project_folder_id = part.project_folder_id
          AND location.space_id = part.space_id
        WHERE part.space_id = $1 AND part.message_id = $2
        ORDER BY part.position ASC`,
      [input.spaceId, input.messageId],
    );
    const blocks: Array<Record<string, unknown>> = [];
    const resources: ConversationInputResource[] = [];
    for (const part of result.rows) {
      const uri = `rainver:conversation-input:${part.part_id}`;
      if (part.kind === "image") {
        if (!part.storage_path) throw new ConversationInputError(500, `image '${part.part_id}' has no storage record`);
        const media = await this.readStoragePath(part.storage_path);
        blocks.push({ type: "image", data: media.toString("base64"), mimeType: part.media_type });
        continue;
      }
      if (part.kind === "file_reference") {
        if (!part.snapshot_id || !part.workspace_location_id || !part.relative_path) {
          throw new ConversationInputError(500, `file input '${part.part_id}' has no immutable snapshot`);
        }
        const workspaceRelativePath = input.executionHostId
          && part.location_host_id === input.executionHostId
          && part.location_host_kind === "server"
          && part.location_root_path
          ? workspaceRootRelativePath(this.config.workspaceRoot, part.location_root_path)
          : null;
        resources.push({
          input_id: part.part_id,
          workspace_location_id: part.workspace_location_id,
          relative_path: part.relative_path,
          name: part.relative_path,
          media_type: part.media_type,
          size_bytes: part.byte_size,
          ...(workspaceRelativePath ? { workspace_relative_path: workspaceRelativePath } : {}),
        });
        if (input.useImmutableSnapshot) {
          if (typeof part.snapshot_content !== "string") {
            throw new ConversationInputError(500, `file input '${part.part_id}' has no immutable snapshot content`);
          }
          if (input.embeddedContext) {
            blocks.push({
              type: "resource",
              resource: { uri, text: part.snapshot_content, mimeType: part.media_type },
            });
          } else {
            blocks.push({
              type: "resource_link",
              uri,
              name: part.relative_path,
              mimeType: part.media_type,
              size: part.byte_size,
            });
            blocks.push({
              type: "text",
              text: `[Attached file snapshot: ${part.relative_path}]\n${part.snapshot_content}`,
            });
          }
        } else {
          blocks.push({
            type: "resource_link",
            uri,
            name: part.relative_path,
            mimeType: part.media_type,
            size: part.byte_size,
          });
          blocks.push({
            type: "text",
            text: `[Referenced file: ${part.relative_path}]`,
          });
        }
        continue;
      }
      if (!part.resource_id || !part.resource_source_state || !part.resource_relative_path
        || !part.resource_workspace_location_id || !part.resource_sha256 || !part.resource_captured_at) {
        throw new ConversationInputError(500, `input resource '${part.part_id}' has no immutable reference`);
      }
      const descriptor = inputResourceDescriptor(part as InputResourceDescriptorRow);
      const resourceUri = `rainver:conversation-input-resource:${part.resource_id}`;
      blocks.push({
        type: "resource_link",
        uri: resourceUri,
        name: part.resource_relative_path,
        mimeType: part.media_type,
        size: part.byte_size,
      });
      if (!input.descriptorsInDelivery) {
        blocks.push({
          type: "text",
          text: renderConversationInputResourceDescriptors([descriptor]),
        });
      }
    }
    return { blocks, resources };
  }
}

function workspaceRootRelativePath(workspaceRoot: string, locationRoot: string): string | null {
  const root = resolve(workspaceRoot);
  const absoluteLocationRoot = isAbsolute(locationRoot)
    ? resolve(locationRoot)
    : resolve(root, locationRoot);
  const relativePath = relative(root, absoluteLocationRoot);
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) return null;
  return relativePath || ".";
}

function matchesImageMagic(mediaType: string, prefix: Buffer): boolean {
  if (mediaType === "image/png") return prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === "image/jpeg") return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  return mediaType === "image/webp" && prefix.length >= 12
    && prefix.subarray(0, 4).toString("ascii") === "RIFF"
    && prefix.subarray(8, 12).toString("ascii") === "WEBP";
}

function safeFilename(filename: string): string {
  const base = filename.replace(/[\\/\0\r\n]/gu, "_").trim();
  return base.slice(0, 512) || "image";
}

function relativeStoragePath(root: string, path: string): string {
  return path.slice(resolve(root).length + 1).split("\\").join("/");
}

async function unlinkStoragePath(root: string, storagePath: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, storagePath);
  const rootRelativePath = relative(absoluteRoot, target);
  if (!rootRelativePath || isAbsolute(rootRelativePath) || rootRelativePath === ".." || rootRelativePath.startsWith(`..${sep}`)) {
    throw new ConversationInputError(500, "conversation media storage path is invalid");
  }
  try {
    await unlink(target);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function isTextLikeMediaType(mediaType: string): boolean {
  const baseType = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (baseType.startsWith("text/")) return true;
  return new Set([
    "application/json",
    "application/ld+json",
    "application/javascript",
    "application/x-javascript",
    "application/typescript",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
    "application/sql",
    "application/graphql",
  ]).has(baseType);
}

function dedupeFileSources(sources: Array<{ projectFolderId: string; workspaceLocationId: string; label: string }>) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.projectFolderId}:${source.workspaceLocationId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectFileMatches(
  node: FileNode,
  source: { projectFolderId: string; workspaceLocationId: string; label: string },
  query: string,
  matches: Array<ConversationInputFileSearchResponse["items"][number]>,
  maxMatches: number,
): void {
  if (matches.length >= maxMatches) return;
  if (node.type === "file" && node.path !== ".") {
    const searchable = `${node.name}\n${node.path}`.toLowerCase();
    if (!query || searchable.includes(query)) {
      matches.push({
        project_folder_id: source.projectFolderId,
        workspace_location_id: source.workspaceLocationId,
        source: source.label,
        relative_path: node.path,
        display_name: node.name,
        kind: "file",
        size_bytes: node.size ?? 0,
      });
    }
  }
  node.children?.forEach((child) => collectFileMatches(child, source, query, matches, maxMatches));
}

function looksBinaryText(content: string): boolean {
  if (content.includes("\u0000") || content.includes("\uFFFD")) return true;
  let controlCharacters = 0;
  for (const character of content) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 0x09 || (code > 0x0d && code < 0x20)) && code !== 0x1b) controlCharacters += 1;
  }
  return content.length > 0 && controlCharacters / content.length > 0.01;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r\n|\r|\n/u).length;
}
