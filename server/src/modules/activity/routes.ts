import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import { basename } from "node:path";
import {resolveRequestId} from '../../gateway/requestContext.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  dbPool,
  optionalString,
  parsePage,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { PgActivityRepository } from "./repository.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new PgActivityRepository(dbPool(context.config));

  registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/activity',operation:'activity.create'}]);

  app.post("/api/v1/activity/upload", {config:{operation:'activity.upload'}}, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const requestId=resolveRequestId(request);
    reply.header('x-request-id',requestId).header('cache-control','private, no-store');
    try {
      const upload = await parseMultipartUpload(request);
      const key=request.headers['idempotency-key'];
      const out=await (await operationRuntime(context.config)).execute('activity.upload',{
        ...upload.fields,filename:basename(upload.filename??''),content_type:upload.contentType||'application/octet-stream',content_base64:upload.file.toString('base64'),
      },sessionActor(identity),requestId,typeof key==='string'?key:undefined);
      return reply.code(out.http_status).send(out.body);
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

  registerOperationAdapters(app,context.config,[{method:'PATCH',url:'/api/v1/activity/:activityId/review',operation:'activity.review',params:{activityId:'activity_id'}}]);

  registerOperationAdapters(app,context.config,[{method:'PATCH',url:'/api/v1/activity/:activityId/archive',operation:'activity.archive',params:{activityId:'activity_id'}}]);

  registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/activity/:activityId/consolidate',operation:'activity.consolidate',params:{activityId:'activity_id'}}]);

  registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/activity/summary-runs',operation:'activity.summary.request'}]);
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
        if(!['kind','title','note','project_id','project_folder_id'].includes(part.fieldname))throw new HttpError(422,'unknown upload field');
        if(Object.hasOwn(fields,part.fieldname))throw new HttpError(422,'duplicate upload field');
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
