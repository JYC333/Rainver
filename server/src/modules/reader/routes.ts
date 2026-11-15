import { projectReadingRecords } from './readingRecords.js';
import { registerReaderOperationRoutes } from './operationRoutes.js';
import { ReaderDocumentNotes } from "./documentNotes.js";
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, optionalString, params, query, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { PgAnnotationRepository, PgCommentRepository, PgReaderActionRepository, PgReaderRepository } from "./repository.js";
import { ReaderAppearanceSettings, ReaderPositionStore } from "./positions.js";
import { ReaderSourceVersions } from "./sourceVersions.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const readerRepo = () => new PgReaderRepository(dbPool(context.config), context.config);
  const annotationRepo = () => new PgAnnotationRepository(dbPool(context.config));
  const commentRepo = () => new PgCommentRepository(dbPool(context.config));
  const actionRepo = () => new PgReaderActionRepository(dbPool(context.config));
  const base = "/api/v1/reader";
  registerReaderOperationRoutes(app, context);

  app.get(`${base}/source-items/:itemId/records`,async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{return reply.send(await projectReadingRecords(dbPool(context.config),identity,params(request).itemId??'',Number(query(request).offset??0),typeof query(request).project_id==='string'?String(query(request).project_id):undefined,typeof query(request).snapshot_id==='string'?String(query(request).snapshot_id):undefined));}
    catch(error){return sendRouteError(reply,error);}
  });
  app.get(`${base}/source-items/:itemId/versions`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const offset = Number(query(request).offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) return reply.code(422).send({ detail: 'Invalid offset' });
      return reply.send(await new ReaderSourceVersions(dbPool(context.config), context.config).list(identity, params(request).itemId ?? '', offset));
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.get(`${base}/source-items/:itemId/versions/:snapshotId`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await new ReaderSourceVersions(dbPool(context.config), context.config).get(identity, p.itemId ?? '', p.snapshotId ?? ''));
    } catch (error) { return sendRouteError(reply, error); }
  });

  app.get(`${base}/documents/:documentType/:documentId`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const p = params(request);
      // `origin=serendipity` says the reader came from the digest's serendipity
      // section, so this open is not interest evidence (B54).
      const origin = query(request).origin === "project" ? "project" as const : query(request).origin === "serendipity" ? "serendipity" as const : "library" as const;
      const doc = await readerRepo().getDocument(identity, p.documentType ?? "", p.documentId ?? "", { origin });
      return doc ? reply.send(doc) : reply.code(404).send({ detail: "Document not found or not accessible" });
    } catch (error) { return sendRouteError(reply, error); }
  });
  // A person's private reading position; never part of read status or reading origin.
  app.get(`${base}/documents/:documentType/:documentId/position`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { const p = params(request); return reply.send({ position: await new ReaderPositionStore(dbPool(context.config)).get(identity, p.documentType ?? "", p.documentId ?? ""), accepted: true }); }
    catch (error) { return sendRouteError(reply, error); }
  });
  app.get(`${base}/preferences/appearance`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { return reply.send(await new ReaderAppearanceSettings(dbPool(context.config)).get(identity)); }
    catch (error) { return sendRouteError(reply, error); }
  });
  app.get(`${base}/documents/:documentType/:documentId/note`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { const p = params(request); return reply.send(await new ReaderDocumentNotes(dbPool(context.config)).get(identity, p.documentType ?? "", p.documentId ?? "")); }
    catch (error) { return sendRouteError(reply, error); }
  });
  app.get(`${base}/documents/:documentType/:documentId/annotations`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { const p = params(request); return reply.send({ items: await annotationRepo().listAnnotations(identity, p.documentType ?? "", p.documentId ?? "") }); }
    catch (error) { return sendRouteError(reply, error); }
  });
  app.get(`${base}/annotations/:annotationId/threads`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { return reply.send({ items: await commentRepo().listThreads(identity, params(request).annotationId ?? "") }); }
    catch (error) { return sendRouteError(reply, error); }
  });
  app.get(`${base}/annotations`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const q = query(request); const projectId = optionalString(q.project_id);
      if (!projectId) return reply.code(400).send({ detail: "project_id is required" });
      const raw = Number(q.limit ?? 20); const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100) : 20;
      return reply.send({ items: await actionRepo().listProjectAnnotations(identity, projectId, limit) });
    } catch (error) { return sendRouteError(reply, error); }
  });
}
