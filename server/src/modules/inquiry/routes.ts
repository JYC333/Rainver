import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import {
  dbPool,
  HttpError,
  jsonBody,
  intQuery,
  numberValue,
  optionalString,
  params,
  query,
  requiredString,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common";
import { InquiryThreadService } from "./threadService";
import { InquiryIterationService } from "./iterationService";
import { InquirySignalService } from "./signalService";
import { registerInquiryProjectIntegration } from "./projectIntegration";
import { InquiryGraphService } from "./graphService";
import { InquiryAdviceService } from "./adviceService";
import { inquiryRetrievalRegistry } from "./retrievalAdapter";
import { RetrievalSearchService } from "../retrieval";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerInquiryProjectIntegration();
  const threads = () => InquiryThreadService.fromConfig(context.config);
  const iterations = () => InquiryIterationService.fromConfig(context.config);
  const signals = () => InquirySignalService.fromConfig(context.config);
  const graphs = () => InquiryGraphService.fromConfig(context.config);
  const advice = () => InquiryAdviceService.fromConfig(context.config);

  app.get("/api/v1/projects/:projectId/inquiry/threads", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await threads().listThreads(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/threads", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await threads().createThread(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // NE: raise a passage of a note as a Question — creates the Thread and the
  // link back to the note in one call, so the Question keeps a route to the
  // reasoning it came from.
  app.post("/api/v1/projects/:projectId/inquiry/threads/from-note", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await threads().raiseNoteAsQuestion(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/threads/:threadId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.send(await threads().getThread(identity, projectId, threadId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/threads/:threadId/iterations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.code(201).send(await iterations().recordIteration(identity, projectId, threadId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/threads/:threadId/iterations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.send(await iterations().listIterations(identity, projectId, threadId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/threads/:threadId/revisions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.send(await iterations().listRevisions(identity, projectId, threadId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/threads/:threadId/definition-revisions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.code(201).send(await iterations().reviseDefinition(identity, projectId, threadId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/projects/:projectId/inquiry/threads/:threadId/work-state", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.send(await iterations().updateWork(identity, projectId, threadId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/threads/:threadId/lifecycle-transitions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.send(await iterations().transitionLifecycle(identity, projectId, threadId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/threads/:threadId/work-events", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.send(await iterations().listWorkEvents(identity, projectId, threadId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/relations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await threads().addRelation(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/projects/:projectId/inquiry/relations/:relationId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const relationId = requiredString(p.relationId, "relation_id");
      await threads().removeRelation(identity, projectId, relationId);
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/projects/:projectId/inquiry/threads/:threadId/primary-parent", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      const body = jsonBody(request);
      const parentThreadId = typeof body.parent_thread_id === "string" ? body.parent_thread_id : null;
      return reply.send(await threads().setPrimaryParent(identity, projectId, threadId, parentThreadId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/threads/:threadId/notes", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.code(201).send(await threads().linkNote(identity, projectId, threadId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/projects/:projectId/inquiry/threads/:threadId/notes/:noteObjectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      const noteObjectId = requiredString(p.noteObjectId, "note_object_id");
      await threads().unlinkNote(identity, projectId, threadId, noteObjectId);
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/projects/:projectId/inquiry/threads/:threadId/personal-focus", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      const body = jsonBody(request);
      await threads().setPersonalFocus(identity, projectId, threadId, body.in_focus !== false);
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/focus", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const [personal, limit] = await Promise.all([
        threads().listPersonalFocus(identity, projectId),
        threads().getSharedFocusWipLimit(identity, projectId),
      ]);
      return reply.send({ personal_focus: personal, shared_focus_wip_limit: limit });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/projects/:projectId/inquiry/settings/shared-focus-wip-limit", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const body = jsonBody(request);
      const limit = numberValue(body.shared_focus_wip_limit);
      if (limit === null) throw new HttpError(422, "shared_focus_wip_limit is required");
      const updated = await threads().setSharedFocusWipLimit(identity, projectId, limit);
      return reply.send({ shared_focus_wip_limit: updated });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/threads/:threadId/signals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.code(201).send(await signals().createSignal(identity, projectId, threadId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/signals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const threadId = query(request).thread_id;
      return reply.send(await signals().listAllSignals(identity, projectId, threadId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/candidates", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const status = query(request).status;
      return reply.send(await signals().listCandidates(identity, projectId, status));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/candidates/:candidateId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const candidateId = requiredString(p.candidateId, "candidate_id");
      return reply.send(await signals().getCandidate(identity, projectId, candidateId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/candidates/:candidateId/reopen", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await signals().reopenCandidate(
        identity,
        requiredString(p.projectId, "project_id"),
        requiredString(p.candidateId, "candidate_id"),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/candidates/:candidateId/decision", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const candidateId = requiredString(p.candidateId, "candidate_id");
      return reply.send(await signals().decideCandidate(identity, projectId, candidateId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/review-packets", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const body = jsonBody(request);
      return reply.code(201).send(await signals().openReviewPacket(identity, projectId, numberValue(body.limit) ?? undefined));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/review-packets/:packetId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const packetId = requiredString(p.packetId, "packet_id");
      return reply.send(await signals().getReviewPacket(identity, projectId, packetId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/review-packets/:packetId/close", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const packetId = requiredString(p.packetId, "packet_id");
      return reply.send(await signals().closeReviewPacket(identity, projectId, packetId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/threads/:threadId/advice", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.send(await advice().getAdvice(identity, projectId, threadId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/threads/:threadId/advice", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.code(201).send(await advice().generateAdvice(identity, projectId, threadId, "user_request"));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Adoption is orchestrated here rather than inside the advice service so
  // the work-state command stays the single Next Focus write authority (and
  // keeps enforcing the focused-Thread invariant and its work events).
  app.post("/api/v1/projects/:projectId/inquiry/threads/:threadId/advice/adopt", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      const adviceService = advice();
      const current = await adviceService.getAdvice(identity, projectId, threadId);
      if (!current) throw new HttpError(404, "No advice to adopt for this Thread");
      const thread = await iterations().updateWork(identity, projectId, threadId, {
        next_focus_kind: current.recommended_focus_kind,
        blocked_reason: null,
      });
      await adviceService.markAdopted(identity, projectId, threadId);
      return reply.send({
        thread,
        advice: await adviceService.getAdvice(identity, projectId, threadId),
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/threads/:threadId/advice/dismiss", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.send(await advice().dismissAdvice(identity, projectId, threadId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/delta-briefs/latest", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await signals().latestDeltaBrief(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/inquiry/delta-briefs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await signals().generateDeltaBrief(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Unified read plane: the Inquiry domain
  // adapter feeds the shared zero-LLM retrieval engine's rebuildable
  // Resource/Search projection. Space-wide search, filtered to the requested
  // Project — a candidate is only returned when both the Project and the
  // Thread's own `revalidate` gate agree it is readable right now.
  app.get("/api/v1/projects/:projectId/inquiry/search", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const q = optionalString(query(request).q);
      if (!q) throw new HttpError(422, "q is required");
      const projectThreads = await threads().listThreads(identity, projectId);
      const projectThreadIds = new Set(projectThreads.map((thread) => thread.id as string));
      const search = new RetrievalSearchService(dbPool(context.config), inquiryRetrievalRegistry);
      const result = await search.search({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        query: q,
        objectTypes: ["inquiry_thread"],
        maxResults: 50,
      });
      return reply.send({
        ...result,
        items: result.items.filter((item) => projectThreadIds.has(item.object_id)),
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/graph", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const limit = graphLimit(query(request).limit);
      return reply.send(await graphs().getInquiryGraph(identity, projectId, { limit }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Combined Project graph composer (plan section 16): unions the Inquiry
  // producer with the existing space_objects/object_relations projection for
  // this Project. Lives here (not modules/graph or modules/projects) because
  // Inquiry is currently the only non-space_objects producer; move ownership
  // to a shared composer once a second domain (Decision, Experiment) needs
  // the same union.
  app.get("/api/v1/projects/:projectId/graph/combined", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const limit = graphLimit(query(request).limit);
      return reply.send(await graphs().getCombinedProjectGraph(identity, projectId, { limit }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function graphLimit(value: string | undefined): number {
  const limit = intQuery(value, 300);
  if (limit === null || limit < 1 || limit > 2000) {
    throw new HttpError(422, "limit must be between 1 and 2000");
  }
  return limit;
}
