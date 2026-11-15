import type {MemoryMaintenanceScanRequest} from '@rainver/protocol';
import * as protocol from '@rainver/protocol';
import {HttpError,withQueryableTransaction,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {canInitiateContextOpsScan,canReviewSpaceOpsPackets} from '../contextOps/reviewPolicy.js';
import {MemoryMaintenanceService} from './maintenance.js';
import {createMemoryMaintenanceProposalPacket,persistMemoryMaintenanceReportArtifact} from './maintenanceArtifacts.js';
import {createMemoryMaintenanceJob,runMemoryMaintenanceJobOnce} from './maintenanceJobs.js';
import {PgMemoryReadRepository} from './repository.js';
import {PgActivityConsolidationRepository} from '../activity/consolidationRepository.js';

export async function runMemoryReport(db:Queryable,identity:SpaceUserIdentity,operation:string,raw:unknown):Promise<unknown>{
 switch(operation){
case 'memory.maintenance.scan': {
      const body = protocol.MemoryMaintenanceScanRequestSchema.parse(
        raw,
      ) as MemoryMaintenanceScanRequest;
      if (body.create_packet && !body.persist_report) {
        throw new HttpError(422,"create_packet requires persist_report");
      }
      const pool = db;
      const canScan = await canInitiateContextOpsScan(pool, identity.spaceId, identity.userId);
      if (!canScan) {
        throw new HttpError(403,"Requires space owner/admin role or enabled Context Ops member scan access");
      }
      const reviewScope = body.review_scope ?? "private";
      if (reviewScope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(pool, identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403,"space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const scanInput = {
        spaceId: identity.spaceId,
        userId: identity.userId,
        limit: body.limit,
        staleAfterDays: body.stale_after_days,
        thinContentChars: body.thin_content_chars,
        maxFindings: body.max_findings,
        projectId: body.project_id ?? null,
        scanMode: body.scan_mode,
        cursor: body.cursor ?? null,
        excludePersonalVisibility: reviewScope === "space_ops",
      };
      const scanOptions = {
        limit: body.limit,
        stale_after_days: body.stale_after_days,
        thin_content_chars: body.thin_content_chars,
        max_findings: body.max_findings,
        project_id: body.project_id ?? null,
        scan_mode: body.scan_mode,
        cursor: body.cursor ?? null,
      };

      if (body.persist_report) {
        const persisted = await withQueryableTransaction(pool, async (client) => {
          const result = await new MemoryMaintenanceService(client).scan(scanInput);
          const artifactId = await persistMemoryMaintenanceReportArtifact(client, {
            spaceId: identity.spaceId,
            ownerUserId: identity.userId,
            report: result.report,
            scanOptions,
            reviewScope,
          });
          const proposalId = body.create_packet
            ? await createMemoryMaintenanceProposalPacket(client, {
                spaceId: identity.spaceId,
                ownerUserId: identity.userId,
                report: result.report,
                scanOptions,
                artifactId,
                reviewScope,
              })
            : undefined;
          await new PgMemoryReadRepository(client).recordMaintenanceReads(
            result.contributingMemoryIds,
            identity.spaceId,
            identity.userId,
            artifactId,
          );
          return { report: result.report, artifactId, proposalId };
        });
        return ({
          ...persisted.report,
          artifact_id: persisted.artifactId,
          ...(persisted.proposalId ? { proposal_id: persisted.proposalId } : {}),
        });
      }

      const result = await new MemoryMaintenanceService(pool).scan(scanInput);
      await new PgMemoryReadRepository(pool).recordMaintenanceReads(
        result.contributingMemoryIds,
        identity.spaceId,
        identity.userId,
        null,
      );
      return (result.report);

    }
case 'memory.maintenance.job.create': {
      const body = protocol.MemoryMaintenanceJobCreateRequestSchema.parse(raw);
      if (body.create_packet && !body.persist_report) {
        throw new HttpError(422,"create_packet requires persist_report");
      }
      const pool = db;
      const canScan = await canInitiateContextOpsScan(pool, identity.spaceId, identity.userId);
      if (!canScan) {
        throw new HttpError(403,"Requires space owner/admin role or enabled Context Ops member scan access");
      }
      if (body.review_scope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(pool, identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403,"space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const job = await createMemoryMaintenanceJob(pool, {
        spaceId: identity.spaceId,
        ownerUserId: identity.userId,
        request: body,
      });
      return (protocol.MemoryMaintenanceJobSchema.parse(job));

    }
case 'memory.maintenance.job.run': {
      const pool = db;
      const canScan = await canInitiateContextOpsScan(pool, identity.spaceId, identity.userId);
      if (!canScan) {
        throw new HttpError(403,"Requires space owner/admin role or enabled Context Ops member scan access");
      }
      const includeSpaceOps = await canReviewSpaceOpsPackets(pool, identity.spaceId, identity.userId);
      const result = await withQueryableTransaction(pool, async (client) =>
        runMemoryMaintenanceJobOnce(client, {
          spaceId: identity.spaceId,
          userId: identity.userId,
          jobId: String((raw as {job_id:string}).job_id),
          includeSpaceOps,
        }));
      if (!result) throw new HttpError(404,"Memory maintenance job not found");
      return (protocol.MemoryMaintenanceJobRunResponseSchema.parse(result));

    }
case 'memory.consolidation.run': {
      const body = raw as {batch_limit?:number;activity_ids?:string[]};
      const batchLimit = boundedInt(body.batch_limit, 50, 1, 500);
      const rawIds = body.activity_ids;
      const activityIds =
        Array.isArray(rawIds) && rawIds.length > 0 ? rawIds.map((value) => String(value)) : null;
      const repo = new PgActivityConsolidationRepository(db);
      const result = await repo.runPending({
        spaceId: identity.spaceId,
        actingUserId: identity.userId,
        batchLimit,
        activityIds,
      });
      return (result);

    }
 default:throw new HttpError(422,'Unknown memory report operation');
 }
}
function boundedInt(value:unknown,fallback:number,min:number,max:number){if(value===undefined)return fallback;if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new HttpError(422,'Invalid batch_limit');return value;}
