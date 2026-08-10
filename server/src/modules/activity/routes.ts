import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
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
} from "../routeUtils/common";
import { PgActivityRepository, summaryInputFromBody } from "./repository";
import {
  applyContentCreationContext,
  resolveContentCreationContext,
} from "../access/creationContext";

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
      const upload = parseMultipartUpload(request);
      if (upload.file.length === 0) throw new HttpError(422, "uploaded file is empty");
      if (upload.file.length > MAX_UPLOAD_BYTES) {
        throw new HttpError(413, `file exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`);
      }
      const originalName = basename(upload.filename || "");
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(upload.fields.project_id),
      });
      const ext = extname(originalName).slice(0, 16);
      const storedName = `${randomUUID().replace(/-/g, "")}${ext}`;
      const dir = join(context.config.agentSpaceHome, "storage", "uploads", creation.spaceId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, storedName), upload.file);
      const kind = (upload.fields.kind || "file").toLowerCase();
      if (kind !== "file" && kind !== "voice") throw new HttpError(422, "kind must be 'file' or 'voice'");
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
      const out = await repository().create({ spaceId: creation.spaceId, userId: identity.userId }, applyContentCreationContext({
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

function parseMultipartUpload(request: FastifyRequest): ParsedUpload {
  if (!(request.body instanceof Buffer)) throw new HttpError(422, "multipart body is required");
  const contentTypeHeader = request.headers["content-type"];
  const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
  const boundaryMatch = /boundary=([^;]+)/i.exec(contentType ?? "");
  if (!boundaryMatch) throw new HttpError(415, "multipart/form-data is required");
  const boundary = `--${boundaryMatch[1]}`;
  const text = request.body.toString("binary");
  const parts = text.split(boundary).slice(1, -1);
  const fields: Record<string, string> = {};
  let file: Buffer | null = null;
  let filename: string | null = null;
  let fileContentType: string | null = null;

  for (const rawPart of parts) {
    const trimmed = rawPart.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const separator = trimmed.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const rawHeaders = trimmed.slice(0, separator);
    let rawBody = trimmed.slice(separator + 4);
    if (rawBody.endsWith("\r\n")) rawBody = rawBody.slice(0, -2);
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(rawHeaders)?.[1] ?? "";
    const name = /name="([^"]+)"/i.exec(disposition)?.[1];
    if (!name) continue;
    const partContentType = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders)?.[1]?.trim() ?? null;
    const partFilename = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    if (name === "file") {
      file = Buffer.from(rawBody, "binary");
      filename = partFilename;
      fileContentType = partContentType;
    } else {
      fields[name] = Buffer.from(rawBody, "binary").toString("utf8");
    }
  }
  if (!file) throw new HttpError(422, "file is required");
  return { fields, file, filename, contentType: fileContentType };
}
