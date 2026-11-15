import {registerContentRetrievalRoutes} from '../retrieval/contentRequests.js';
import {registerOperationAdapters} from "../systemActions/operations/routeAdapter.js";
import {registerNoteLinkOperationRoutes} from "./noteLinkOperationRoutes.js";
import {registerKnowledgeReviewRoutes} from '../knowledgePromotion/reviewOperationRoutes.js';
import {registerNoteObjectOperationRoutes} from './noteObjectOperationRoutes.js';
import {registerNoteControlOperationRoutes} from './noteControlOperationRoutes.js';
import type {FastifyInstance,FastifyReply,FastifyRequest} from "fastify";
import * as protocol from "@rainver/protocol";
import type {ClaimTrajectoryRequest,SpaceObjectProfileListRequest} from "@rainver/protocol";
import type {ServerConfig} from "../../config.js";
import type {ModuleContext} from "../../gateway/routeRegistry.js";
import {csvQuery,dbPool,HttpError,numberValue,optionalString,parsePage,params,query,resolveIdentity,sendRouteError} from "../routeUtils/common.js";
import {requireSpaceOwnerOrAdmin} from "../routeUtils/access.js";

import {PgKnowledgeRepository} from "./repository.js";

import {buildClaimTrajectory} from "./claimReviewLoop.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerContentRetrievalRoutes(app,context,'knowledge');
  registerNoteControlOperationRoutes(app,context);
  registerOperationAdapters(app,context.config,[{"method": "POST", "url": "/api/v1/knowledge/items/proposals", "operation": "knowledge.item.propose_create"}, {"method": "PATCH", "url": "/api/v1/knowledge/items/:itemId/proposals", "operation": "knowledge.item.propose_update", "params": {"itemId": "item_id"}}, {"method": "DELETE", "url": "/api/v1/knowledge/items/:itemId", "operation": "knowledge.item.propose_archive", "params": {"itemId": "item_id"}}, {"method": "POST", "url": "/api/v1/knowledge/claims/proposals", "operation": "knowledge.claim.propose_create"}, {"method": "PATCH", "url": "/api/v1/knowledge/claims/:claimId/proposals", "operation": "knowledge.claim.propose_update", "params": {"claimId": "claim_id"}}, {"method": "DELETE", "url": "/api/v1/knowledge/claims/:claimId", "operation": "knowledge.claim.propose_archive", "params": {"claimId": "claim_id"}}, {"method": "POST", "url": "/api/v1/knowledge/object-relations/proposals", "operation": "knowledge.relation.propose_create"}, {"method": "DELETE", "url": "/api/v1/knowledge/object-relations/:relationId", "operation": "knowledge.relation.propose_archive", "params": {"relationId": "relation_id"}}]);
  registerOperationAdapters(app,context.config,[{"method": "POST", "url": "/api/v1/knowledge/object-schema/imports/proposals", "operation": "knowledge.object_schema.propose_import"}, {"method": "POST", "url": "/api/v1/knowledge/object-schema/profiles/proposals", "operation": "knowledge.object_kind.propose_create"}, {"method": "PATCH", "url": "/api/v1/knowledge/object-schema/profiles/:profileId/proposals", "operation": "knowledge.object_kind.propose_update", "params": {"profileId": "profile_id"}}, {"method": "POST", "url": "/api/v1/knowledge/object-schema/profiles/:profileId/deprecate-proposals", "operation": "knowledge.object_kind.propose_deprecate", "params": {"profileId": "profile_id"}}, {"method": "DELETE", "url": "/api/v1/knowledge/object-schema/profiles/:profileId", "operation": "knowledge.object_kind.propose_archive", "params": {"profileId": "profile_id"}}]);
  registerOperationAdapters(app,context.config,[{"method": "POST", "url": "/api/v1/knowledge/retrieval/feedback", "operation": "knowledge.retrieval.feedback"}, {"method": "POST", "url": "/api/v1/knowledge/retrieval/reindex", "operation": "knowledge.retrieval.reindex"}]);
  registerNoteLinkOperationRoutes(app,context);
  registerNoteObjectOperationRoutes(app,context);
  registerKnowledgeReviewRoutes(app,context,'evidence');
  const repository = () => new PgKnowledgeRepository(dbPool(context.config));

  app.get("/api/v1/knowledge", knowledgeHealth(context));
  app.get("/api/v1/knowledge/", knowledgeHealth(context));

  app.get("/api/v1/knowledge/summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().summary(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Maintenance scan: a read-only, batched report of review
  // candidates (duplicates, orphans, thin pages, suggested relations) over the
  // derived projection. It writes NOTHING canonical — acting on a finding stays
  // on the proposal/approval flow. Owner/admin only, and every finding is
  // revalidated through the same read gate as search (no private-title leak).
  // Member/reviewer initiation is allowed only when the Space Context Ops scan
  // setting opts into member scans.

  // Advisory claim trajectory. Read-only and viewer-gated (the service
  // only loads visible claims), so it needs no Context Ops scan authority.
  app.get("/api/v1/knowledge/claims/trajectory", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      // optionalString returns null for missing params, but the schema fields are
      // .optional() (undefined, not null), so only include keys that are present.
      const subjectObjectId = optionalString(q.subject_object_id);
      const claimId = optionalString(q.claim_id);
      const limit = optionalString(q.limit);
      const body = parseClaimTrajectoryBody(protocol.ClaimTrajectoryRequestSchema, {
        ...(subjectObjectId ? { subject_object_id: subjectObjectId } : {}),
        ...(claimId ? { claim_id: claimId } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      });
      const response = await buildClaimTrajectory(dbPool(context.config), {
        spaceId: identity.spaceId,
        userId: identity.userId,
        subjectObjectId: body.subject_object_id ?? null,
        claimId: body.claim_id ?? null,
        limit: body.limit,
      });
      return reply.send(response);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Deterministic, access-safe contradiction-discovery scan. Gated by
  // Context Ops scan authority; optionally fans findings into a Claim Candidate
  // Packet so the only canonical write path stays the proposal-gated packet flow.

  // Deterministic candidate-relation discovery scan. Gated by Context Ops
  // scan authority; emits a single batched proposal packet — never a direct edge
  // or item write.

  app.get("/api/v1/knowledge/object-schema/profiles", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      const body = parseSpaceObjectProfileListRequest(protocol.SpaceObjectProfileListRequestSchema, {
        ...(optionalString(q.base_object_type) ? { base_object_type: optionalString(q.base_object_type) } : {}),
        ...(optionalString(q.status) ? { status: optionalString(q.status) } : {}),
        limit,
        offset,
      });
      return reply.send(
        await repository().listObjectProfiles(identity, {
          baseObjectType: body.base_object_type ?? null,
          status: body.status ?? null,
          limit: body.limit,
          offset: body.offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/object-schema/profiles/:profileId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const kind = await repository().getObjectProfile(identity, params(request).profileId ?? "");
      if (!kind) return reply.code(404).send({ detail: "Object kind not found" });
      return reply.send(kind);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/object-schema/export", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context.config, identity, reply))) return reply;
    try {
      return reply.send(await repository().exportObjectSchema(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(
        await repository().listItems(identity, {
          knowledgeKind: optionalString(q.knowledge_kind),
          status: optionalString(q.status) ?? "active",
          visibility: optionalString(q.visibility),
          projectId: optionalString(q.project_id),
          projectFolderId: optionalString(q.project_folder_id),
          q: optionalString(q.q),
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/items/:itemId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const item = await repository().getItem(identity, params(request).itemId ?? "");
      if (!item) return reply.code(404).send({ detail: "Knowledge item not found" });
      return reply.send(item);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/items/:itemId/relations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().itemRelations(identity, params(request).itemId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/items/:itemId/backlinks", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().entityLinks(identity, {
          target_type: "knowledge_item",
          target_id: params(request).itemId ?? "",
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/claims", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(
        await repository().listClaims(identity, {
          claimKind: optionalString(q.claim_kind),
          status: optionalString(q.status) ?? "active",
          subjectObjectId: optionalString(q.subject_object_id),
          q: optionalString(q.q),
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/claims/:claimId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const claim = await repository().getClaim(identity, params(request).claimId ?? "");
      if (!claim) return reply.code(404).send({ detail: "Claim not found" });
      return reply.send(claim);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/claims/:claimId/sources", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().claimSources(identity, params(request).claimId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/claims/:claimId/relations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().claimRelations(identity, params(request).claimId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/object-relations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().objectRelations(identity, query(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/sources", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(
        await repository().listSources(identity, {
          sourceType: optionalString(q.source_type),
          status: optionalString(q.status),
          q: optionalString(q.q),
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/sources/:sourceId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const source = await repository().getSource(identity, params(request).sourceId ?? "");
      if (!source) return reply.code(404).send({ detail: "Source not found" });
      return reply.send(source);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/sources/:sourceId/items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listSourceItems(identity, params(request).sourceId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/items/:itemId/sources", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listItemSources(identity, params(request).itemId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/entity-links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().entityLinks(identity, query(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/notes", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(
        await repository().listNotes(identity, {
          status: optionalString(q.status),
          projectId: optionalString(q.project_id),
          collectionId: optionalString(q.collection_id),
          collectionIds: csvQuery(q.collection_ids),
          q: optionalString(q.q),
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  /**
   * The Project's notes folder, created on first use. The Project notes surface
   * is hoisted to it, so it has to exist before the surface can show anything.
   * Notes are a Project-level surface reachable from every Area. Do not
   * create this folder from the Research Area.
   */

  app.get("/api/v1/notes/collections", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listNoteCollections(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  registerOperationAdapters(app, context.config, [{ method: 'POST', url: '/api/v1/knowledge/notes/deleted/purge', operation: 'knowledge.note.trash.purge' }]);

  // "jot a note" from an evidence or material card. Creates (or appends
  // to) a note and makes the note_link in one call, so the connection is
  // recorded without a trip to the Notes page and back for an id.

  // The reverse of a jot: what notes cite this object. The note backlinks
  // route cannot answer it — that one is note-keyed on both sides.
  app.get("/api/v1/knowledge/objects/:objectId/note-links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const objectId = params(request).objectId ?? "";
      return reply.send(await repository().notesLinkingToObject(identity, objectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/notes/:noteId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const note = await repository().getNote(identity, params(request).noteId ?? "");
      if (!note) return reply.code(404).send({ detail: "Note not found" });
      return reply.send(note);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  /**
   * Placements. A note may sit in several folders at once; adding one is a
   * separate action from moving the note, and removing the last one is refused
   * rather than quietly leaving a note no tree can reach.
   */

  /**
   * Cross-Project shares. Listing is gated by the note's own read gate, so
   * a caller who cannot see the note cannot learn which Projects can.
   */
  app.get("/api/v1/knowledge/notes/:noteId/shares", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listNoteProjectShares(identity, params(request).noteId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Promote a selected passage into a Knowledge Item. Builds an ordinary
  // knowledge_create proposal — the review gate still applies — and records the
  // originating Note as provenance.

  // The reverse of a promotion: what this note produced.
  app.get("/api/v1/knowledge/notes/:noteId/promoted", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const noteId = params(request).noteId ?? "";
      return reply.send(await repository().knowledgeItemsPromotedFromNote(identity, noteId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/notes/:noteId/revisions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const limit = numberValue(query(request).limit) ?? undefined;
      return reply.send(
        await repository().listNoteRevisions(identity, params(request).noteId ?? "", limit),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/notes/:noteId/links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().noteLinks(identity, params(request).noteId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/notes/:noteId/backlinks", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().noteLinks(identity, params(request).noteId ?? "", true));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

}

function knowledgeHealth(context: ModuleContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    return reply.send({ ok: true });
  };
}

async function requireSpaceMaintenanceRole(
  config: ServerConfig,
  identity: { spaceId: string; userId: string },
  reply: FastifyReply,
): Promise<boolean> {
  return requireSpaceOwnerOrAdmin(config, identity, reply);
}

type ProtocolSchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
};

function parseClaimTrajectoryBody(
  schema: ProtocolSchema<ClaimTrajectoryRequest>,
  value: unknown,
): ClaimTrajectoryRequest {
  return parseProtocolBody(schema, value);
}

function parseSpaceObjectProfileListRequest(
  schema: ProtocolSchema<SpaceObjectProfileListRequest>,
  value: unknown,
): SpaceObjectProfileListRequest {
  return parseProtocolBody(schema, value);
}

function parseProtocolBody<T>(schema: ProtocolSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(422, validationMessage(parsed.error.issues));
  return parsed.data;
}

function validationMessage(issues: Array<{ path: Array<string | number>; message: string }>): string {
  const issue = issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}
