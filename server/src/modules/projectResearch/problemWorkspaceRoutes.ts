import {ProjectResearchReportRepository} from "./reportRepository.js";
import type { FastifyInstance } from 'fastify';
import type { ModuleContext } from '../../gateway/routeRegistry.js';
import { dbPool, HttpError, jsonBody, params, query, resolveIdentity, sendRouteError } from '../routeUtils/common.js';
import { ResearchAcquisitionService } from './pipeline/researchAcquisitionService.js';
import { ProjectOperationService } from '../projects/projectOperationService.js';
import { assertProjectReadable } from '../projects/access.js';
import { assertThreadReadable } from '../inquiry/threadAccess.js';
import { researchMetadataReadableSql } from './researchOperationMetadata.js';
import { enforce, loadActionRegistry } from '../policy/index.js';
import { z } from 'zod';
const start = z.object({ thread_id: z.string().min(1), idempotency_key: z.string().min(1).max(128), intent_note: z.string().trim().min(1).max(4000), max_items: z.number().int().min(1).max(2000).optional(), since: z.string().optional() }).strict();
export function registerProblemResearchRoutes(app: FastifyInstance, context: ModuleContext) {
    app.get('/api/v1/projects/:projectId/research/report-page',async(request,reply)=>{
      const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
      try{const rawCursor=query(request).after_report_id;if(rawCursor!==undefined&&(typeof rawCursor!=='string'||!rawCursor.trim()||rawCursor.length>128))throw new HttpError(422,'Invalid report cursor');return reply.send(await new ProjectResearchReportRepository(dbPool(context.config)).page(identity,String(params(request).projectId),rawCursor===undefined?null:String(rawCursor)));}catch(error){return sendRouteError(reply,error);}
    });
    app.post('/api/v1/projects/:projectId/research/acquisitions', async (request, reply) => {
        const identity = await resolveIdentity(context.config, request, reply);
        if (!identity)
            return reply;
        try {
            const parsed = start.safeParse(jsonBody(request));
            if (!parsed.success)
                throw new HttpError(422, parsed.error.message);
            const gate = await enforce(context.config, await loadActionRegistry(), { action: 'research.acquisition.start', actor_type: 'user', actor_id: identity.userId, space_id: identity.spaceId, resource_type: 'inquiry_thread', resource_id: parsed.data.thread_id, context: { trigger_origin: 'manual' }, force_record: false });
            if (gate.status !== 'allow')
                return reply.code(403).send({ detail: gate.message ?? 'Policy denied' });
            const b = parsed.data;
            return reply.code(202).send(await new ResearchAcquisitionService(dbPool(context.config)).startAcquisition(identity, String(params(request).projectId), { threadId: b.thread_id, requestKey: `human:${identity.userId}:${b.idempotency_key}`, intentNote: b.intent_note, ...(b.max_items === undefined ? {} : { maxItems: b.max_items }), ...(b.since ? { since: b.since } : {}), originRoomId: null, originSessionId: null }));
        }
        catch (error) {
            return sendRouteError(reply, error);
        }
    });
    app.get('/api/v1/projects/:projectId/inquiry/threads/:threadId/research-operations', async (request, reply) => {
        const identity = await resolveIdentity(context.config, request, reply);
        if (!identity)
            return reply;
        try {
            const p = params(request), db = dbPool(context.config), project = String(p.projectId), thread = String(p.threadId);
            await assertProjectReadable(db, identity.spaceId, project, identity.userId);
            await assertThreadReadable(db, identity, project, thread, 'read_content');
            const cursor=query(request).after_operation_id;
            if(cursor!==undefined&&(typeof cursor!=='string'||!cursor.trim()||cursor.length>128))throw new HttpError(422,'Invalid operation cursor');
            if(cursor){const found=await db.query(`SELECT id FROM project_operations op WHERE id=$1 AND space_id=$2 AND project_id=$3 AND research_call_json->>'thread_id'=$4 AND ${researchMetadataReadableSql('op','$5')}`,[cursor,identity.spaceId,project,thread,identity.userId]);if(!found.rows[0])throw new HttpError(422,'Invalid operation cursor');}
            const rows = await db.query<{
                id: string;
            }>(`SELECT op.id FROM project_operations op WHERE space_id=$1 AND project_id=$2 AND research_call_json->>'thread_id'=$3 AND ($5::varchar IS NULL OR (op.created_at,op.id)<(SELECT created_at,id FROM project_operations WHERE id=$5 AND space_id=$1 AND project_id=$2 AND research_call_json->>'thread_id'=$3)) AND ${researchMetadataReadableSql('op', '$4')} ORDER BY op.created_at DESC,op.id DESC LIMIT 51`, [identity.spaceId, project, thread, identity.userId, query(request).after_operation_id ?? null]);
            const service = new ProjectOperationService(db);
            const items = [];
            for (const row of rows.rows.slice(0, 50))
                items.push(await service.get(identity, project, row.id));
            return reply.send({ items, next_cursor: rows.rows.length > 50 ? rows.rows[49]!.id : null });
        }
        catch (error) {
            return sendRouteError(reply, error);
        }
    });
}
