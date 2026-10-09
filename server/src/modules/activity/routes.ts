import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  dbPool,
  jsonBody,
  optionalString,
  parsePage,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { PgActivityRepository, summaryInputFromBody } from "./repository.js";
import {
  applyContentCreationContext,
  resolveContentCreationContext,
} from "../access/creationContext.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new PgActivityRepository(dbPool(context.config));

  app.post("/api/v1/activity", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      return reply.send(await repository().create(
        { spaceId: creation.spaceId, userId: identity.userId },
        applyContentCreationContext(body, creation),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/activity/upload", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const upload = await parseMultipartUpload(request);
      if (upload.file.length === 0) throw new HttpError(422, "uploaded file is empty");
      if (upload.file.length > MAX_UPLOAD_BYTES) {
        throw new HttpError(413, `file exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`);
      }
      // Everything the request can be refused for comes before the file
      // reaches disk; a refused upload left a file no record pointed at.
      const kind = (upload.fields.kind || "file").toLowerCase();
      if (kind !== "file" && kind !== "voice") throw new HttpError(422, "kind must be 'file' or 'voice'");
      const originalName = basename(upload.filename || "");
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(upload.fields.project_id),
      });
      const ext = extname(originalName).slice(0, 16);
      const storedName = `${randomUUID().replace(/-/g, "")}${ext}`;
      const dir = join(context.config.rainverHome, "storage", "uploads", creation.spaceId);
      await mkdir(dir, { recursive: true });
      const storedPath = join(dir, storedName);
      await writeFile(storedPath, upload.file);
      const contentType = upload.contentType || "application/octet-stream";
      const title =
        upload.fields.title ||
        originalName ||
        (kind === "voice" ? "Voice capture" : "Uploaded file");
      const content =
        upload.fields.note ||
        (kind === "voice"
          ? `Voice capture (${contentType}, ${upload.file.length} bytes)`
          : `File capture: ${originalName || storedName} (${contentType}, ${upload.file.length} bytes)`);
      let out: Awaited<ReturnType<ReturnType<typeof repository>["create"]>>;
      try {
        out = await repository().create({ spaceId: creation.spaceId, userId: identity.userId }, applyContentCreationContext({
          source_type: kind === "voice" ? "voice_capture" : "file_capture",
          content,
          title,
          project_folder_id: upload.fields.project_folder_id,
          metadata_json: {
            capture_kind: kind,
            filename: originalName || null,
            mime_type: contentType,
            size_bytes: upload.file.length,
            stored_path: `${creation.spaceId}/${storedName}`,
          },
        }, creation));
      } catch (error) {
        // The record is what makes the file reachable; without it the file
        // would stay on disk with nothing to clean it up.
        await unlink(storedPath).catch(() => undefined);
        throw error;
      }
      return reply.send(out);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  const list = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const forUserId = optionalString(q.for_user_id);
      if (forUserId && forUserId !== identity.userId) {
        return reply.code(403).send({ detail: "for_user_id must match the authenticated user" });
      }
      const { limit, offset } = parsePage(q);
      const rows = await repository().list(identity, {
        userId: forUserId,
        projectFolderId: optionalString(q.project_folder_id),
        sourceType: optionalString(q.source_type),
        status: optionalString(q.status),
        projectId: optionalString(q.project_id),
        limit,
        offset,
      });
      return reply.send(rows);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  };
  app.get("/api/v1/activity", list);
  app.get("/api/v1/activity/", list);

  app.get("/api/v1/activity/:activityId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const row = await repository().getOut(identity, params(request).activityId ?? "");
      if (!row) return reply.code(404).send({ detail: "Activity record not found" });
      return reply.send(row);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/activity/:activityId/review", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().setStatus(identity, params(request).activityId ?? "", "processed"),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/activity/:activityId/archive", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().setStatus(identity, params(request).activityId ?? "", "archived"),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/activity/:activityId/consolidate", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().consolidate(identity, params(request).activityId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/activity/summary-runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await repository().createSummaryRun(identity, summaryInputFromBody(jsonBody(request))));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

interface ParsedUpload {
  fields: Record<string, string>;
  file: Buffer;
  filename: string | null;
  contentType: string | null;
}

const UPLOAD_FIELD_BYTES = 32 * 1024 * 1024;

function errorCode(error: Error): string | undefined {
  return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function uploadTooLarge(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return errorCode(error) === "FST_REQ_FILE_TOO_LARGE" || /file too large|file size limit/i.test(error.message);
}

function uploadFormLimited(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = errorCode(error);
  return code === "FST_FIELDS_LIMIT" || code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT";
}

function multipartMediaType(request: FastifyRequest): boolean {
  const header = request.headers["content-type"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string"
    && /multipart\/form-data/i.test(value)
    && /boundary=/i.test(value);
}

/**
 * Activity capture keeps its own size and field budget. The gateway plugin's
 * registration limits belong to conversation images (10 MB, four fields).
 */
async function parseMultipartUpload(request: FastifyRequest): Promise<ParsedUpload> {
  if (!multipartMediaType(request)) throw new HttpError(415, "multipart/form-data is required");
  const fields: Record<string, string> = {};
  let file: Buffer | null = null;
  let filename: string | null = null;
  let fileContentType: string | null = null;
  try {
    const parts = request.parts({
      limits: {
        files: 1,
        fields: 16,
        fileSize: MAX_UPLOAD_BYTES,
        fieldSize: UPLOAD_FIELD_BYTES,
      },
    });
    for await (const part of parts) {
      if (part.type === "file") {
        if (part.fieldname !== "file") {
          part.file.resume();
          continue;
        }
        file = await part.toBuffer();
        filename = part.filename || null;
        fileContentType = part.mimetype || null;
      } else if (typeof part.value === "string") {
        if (part.valueTruncated) throw new HttpError(413, "field exceeds the upload limit");
        fields[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (uploadTooLarge(error)) {
      throw new HttpError(413, `file exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`);
    }
    if (uploadFormLimited(error)) throw new HttpError(413, "upload exceeds the form limits");
    throw new HttpError(415, "multipart/form-data is required");
  }
  if (!file) throw new HttpError(422, "file is required");
  return { fields, file, filename, contentType: fileContentType };
}
