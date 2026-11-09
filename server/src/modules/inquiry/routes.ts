import {registerInquiryOperationRoutes} from './operationRoutes.js';
import {registerThreadCreationOperationRoutes} from './threadCreationOperationRoutes.js';
import {threadReadableSql} from "./threadAccess.js";
import {assertProjectReadable,canWriteProject} from "../projects/access.js";
import { InquiryTaskAssociationService } from "./taskAssociations.js";
import { InquiryProblemEngineService } from "./problemEngineService.js";
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  HttpError,
  intQuery,
  optionalString,
  params,
  query,
  requiredString,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { InquiryThreadService } from "./threadService.js";
import { InquiryIterationService } from "./iterationService.js";
import { InquirySignalService } from "./signalService.js";
import { registerInquiryProjectIntegration } from "./projectIntegration.js";
import { InquiryGraphService } from "./graphService.js";
import { inquiryRetrievalRegistry } from "./retrievalAdapter.js";
import { RetrievalSearchService } from "../retrieval/index.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerInquiryProjectIntegration();
  registerInquiryOperationRoutes(app,context);
  const threads = () => InquiryThreadService.fromConfig(context.config);
  const iterations = () => InquiryIterationService.fromConfig(context.config);
  const signals = () => InquirySignalService.fromConfig(context.config);
  const graphs = () => InquiryGraphService.fromConfig(context.config);

  const problems = () => new InquiryProblemEngineService(dbPool(context.config));
  app.get("/api/v1/projects/:projectId/inquiry/threads/:threadId/problem",async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try { const p=params(request);return reply.send(await problems().projection(identity,requiredString(p.projectId,"project_id"),requiredString(p.threadId,"thread_id"),{limit:intQuery(query(request).limit,50)??50,before_step:query(request).before_step?Number(query(request).before_step):undefined,before_closeout:query(request).before_closeout?Number(query(request).before_closeout):undefined})); } catch(error){return sendRouteError(reply,error);}
  });
  app.get('/api/v1/projects/:projectId/inquiry/workspace-threads',async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{const project=requiredString(params(request).projectId,'project_id'),db=dbPool(context.config),q=query(request);await assertProjectReadable(db,identity.spaceId,project,identity.userId);
      const status=q.status??'active';if(!['active','history','all'].includes(String(status)))throw new HttpError(422,'Invalid problem filter');
      const rows=await db.query(`SELECT t.object_id AS id,t.kind,left(t.statement,500) AS statement,length(t.statement)>500 AS statement_truncated,t.lifecycle_status,t.attention_state,so.updated_at,CASE WHEN ${threadReadableSql('so','$3','read_content')} THEN left(COALESCE(qs.current_answer_summary,hs.proposed_claim),300) ELSE NULL END AS judgment FROM inquiry_threads t JOIN space_objects so ON so.id=t.object_id AND so.space_id=t.space_id LEFT JOIN inquiry_question_states qs ON qs.thread_id=t.object_id LEFT JOIN inquiry_hypothesis_states hs ON hs.thread_id=t.object_id WHERE t.space_id=$1 AND t.project_id=$2 AND ${threadReadableSql('so','$3','read')} AND ($4='all' OR ($4='active' AND t.lifecycle_status='active') OR ($4='history' AND t.lifecycle_status<>'active')) AND ($5::varchar IS NULL OR t.object_id>$5) AND t.statement ILIKE $6 ORDER BY t.object_id LIMIT 51`,[identity.spaceId,project,identity.userId,status,q.after_thread_id??null,'%'+String(q.q??'').slice(0,200)+'%']);
      return reply.send({items:rows.rows.slice(0,50),next_cursor:rows.rows.length>50?rows.rows[49]!.id:null});
    }catch(error){return sendRouteError(reply,error);}
  });
  app.get('/api/v1/projects/:projectId/inquiry/workspace-access',async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{const project=requiredString(params(request).projectId,'project_id'),db=dbPool(context.config);await assertProjectReadable(db,identity.spaceId,project,identity.userId);return reply.send({can_write:(await db.query(`SELECT id FROM projects WHERE id=$1 AND space_id=$2 AND status='active'`,[project,identity.spaceId])).rowCount===1 && await canWriteProject(db,identity.spaceId,project,identity.userId)});}catch(error){return sendRouteError(reply,error);}
  });
  const taskAssociations=()=>new InquiryTaskAssociationService(dbPool(context.config));
  const taskPath="/api/v1/projects/:projectId/inquiry/threads/:threadId/tasks";
  app.get(taskPath,async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{const p=params(request);return reply.send(await taskAssociations().tasks(identity,requiredString(p.projectId,"project_id"),requiredString(p.threadId,"thread_id"),optionalString(query(request).after_task_id)??undefined));}catch(error){return sendRouteError(reply,error);}
  });
  app.get(`${taskPath}/:taskId/result`,async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{const p=params(request);return reply.send(await taskAssociations().result(identity,requiredString(p.projectId,"project_id"),requiredString(p.threadId,"thread_id"),requiredString(p.taskId,"task_id")));}catch(error){return sendRouteError(reply,error);}
  });
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

  registerThreadCreationOperationRoutes(app,context);

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



  app.get("/api/v1/projects/:projectId/inquiry/open-steps", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await iterations().listOpenProjectSteps(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/inquiry/threads/:threadId/steps", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const threadId = requiredString(p.threadId, "thread_id");
      return reply.send(await iterations().listSteps(identity, projectId, threadId));
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


  app.get("/api/v1/projects/:projectId/inquiry/delta-briefs/:briefId",async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{const p=params(request),brief=await signals().latestDeltaBrief(identity,requiredString(p.projectId,"project_id"),requiredString(p.briefId,"brief_id"));if(!brief)throw new HttpError(404,"Brief not found");return reply.send(brief);}catch(error){return sendRouteError(reply,error);}
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

  // Combined Project graph composer: unions the Inquiry
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
