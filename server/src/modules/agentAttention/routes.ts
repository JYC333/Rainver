import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentAttentionQuerySchema, IdSchema } from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, parseBody, resolveIdentity, sendRouteError, withQueryableTransaction } from "../routeUtils/common.js";
import { readAttentionSnapshot } from "./snapshot.js";
import { AgentAttentionRepository } from "./repository.js";
import { boundWork } from "./readModel.js";
import { findWork, loadWorks } from "./readStateService.js";
const itemQuery = z.object({
  space_id: IdSchema,
  kind: z.enum(['task', 'session', 'agent_group', 'run']),
  source_id: IdSchema,
  runs_cursor: z.string().min(1).max(2048).optional()
}).strict();
export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get('/api/v1/me/agent-attention/snapshot', async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const result = await readAttentionSnapshot(dbPool(context.config), identity.userId);
      return reply.send({ type: 'attention.snapshot', seq: 1, page: result.page, version: result.version, unread_count: result.unread_count, notices: [] });
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.get('/api/v1/me/agent-attention', async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const query = parseBody(AgentAttentionQuerySchema, request.query);
      const baseline = await new AgentAttentionRepository(dbPool(context.config)).baseline(identity.userId);
      return await withQueryableTransaction(dbPool(context.config), async db => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const candidates = await loadWorks(db, identity.userId, baseline);
        const result = await new AgentAttentionRepository(db).page(candidates.map(i => boundWork(i)), query, new Date().toISOString());
        return reply.send(result);
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
  app.get('/api/v1/me/agent-attention/item', async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const query = parseBody(itemQuery, request.query);
      const baseline = await new AgentAttentionRepository(dbPool(context.config)).baseline(identity.userId);
      return await withQueryableTransaction(dbPool(context.config), async db => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const items = await loadWorks(db, identity.userId, baseline, {
          space_id: query.space_id,
          identity: {
            kind: query.kind,
            source_id: query.source_id
          }
        });
        return reply.send(boundWork(findWork(items, query.space_id, {
          kind: query.kind,
          source_id: query.source_id
        }), query.runs_cursor));
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
  registerOperationAdapters(app,context.config,[
   {method:'POST',url:'/api/v1/me/agent-attention/views',operation:'attention.views.record',admission:'person'},
   {method:'PATCH',url:'/api/v1/me/agent-attention/read-state',operation:'attention.read_state.change',admission:'person'},
  ]);
}
