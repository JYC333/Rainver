import {ResearchWorkspaceMutationError} from '../workspaceErrors.js';
import { replayProblemCommand,saveProblemCommand } from "../../inquiry/problemFacts.js";
import { ResearchCallContentUnavailable, assertResearchCallReadable } from "../researchCallAccess.js";
import { researchMetadataReadableSql } from "../researchOperationMetadata.js";
import { SCREENING_AUTO_CONTINUE_CORPUS_LIMIT } from "../researchCheckpointPolicy.js";
import { randomUUID } from "node:crypto";
import { prepareResearchAcquisition } from "../researchProblemCalls.js";
import { ProjectOperationService } from "../../projects/projectOperationService.js";
import { lockActiveProjectForMutation } from "../../projects/access.js";
import { createHash } from "node:crypto";
import type { Queryable, SpaceUserIdentity } from "../../routeUtils/common.js";
import { HttpError, withQueryableTransaction } from "../../routeUtils/common.js";
import { PgJobQueueRepository } from "../../jobs/repository.js";
import { assertProjectWriter } from "../../projects/access.js";
import { assertThreadReadable } from "../../inquiry/threadAccess.js";
import { RESEARCH_PIPELINE_START_JOB } from "./researchAcquisitionPipelineJob.js";

interface StartResearchAcquisitionInput {
  requestKey?:string;
  originRunId?:string|null;
  threadId: string;
  intentNote?: string | null;
  originRoomId: string | null;
  originSessionId: string | null;
  /**
   * The Room task group whose Agent started this acquisition, if an Agent
   * did: its result turn is Agent-triggered and charged to that group's
   * container, like a delegation result. Null when a person started it.
   */
  originGroupId?: string | null;
  /** How many of the newest matches to read; the pipeline's own default applies when absent. */
  maxItems?: number | null;
  /** ISO date floor for collection; all available history when absent. */
  since?: string | null;
}

type StartResearchAcquisitionResult =
  | { status: "queued"; thread_id: string;operation_id:string }
  | { status: "already_starting"; thread_id: string;operation_id?:string };

/** Synchronous admission binds the existing Workflow/Operation/Step and queues
 * the original execution Job atomically. Provider planning and Source setup
 * remain asynchronous; they resume this exact invocation. */
export class ResearchAcquisitionService {
  constructor(private readonly db: Queryable) {}

  async startAcquisition(
    identity: SpaceUserIdentity,
    projectId: string,
    input: StartResearchAcquisitionInput,
  ): Promise<StartResearchAcquisitionResult> {
    if(input.maxItems!=null&&(!Number.isInteger(input.maxItems)||input.maxItems<1||input.maxItems>2000))throw new ResearchWorkspaceMutationError(422,"max_items must be an integer from 1 to 2000");
    if(input.since&&Number.isNaN(Date.parse(input.since)))throw new ResearchWorkspaceMutationError(422,"since must be an ISO date");
    if(input.intentNote&&input.intentNote.length>4000)throw new ResearchWorkspaceMutationError(422,"intent_note is too long");
    return withQueryableTransaction(this.db, async (db) => {
      // The person whose turn this is must be able to write the Project and
      // reach the Thread themselves — Project membership is necessary but not
      // sufficient for a Thread (`threadAccess.ts`), and the pipeline that
      // follows reads the Thread's statement into Project-visible records.
      await assertProjectWriter(db, identity.spaceId, projectId, identity.userId);
      await lockActiveProjectForMutation(db,identity.spaceId,projectId);
      await assertThreadReadable(db, identity, projectId, input.threadId, "change");
      const thread = await db.query<{ object_id: string;version:number;problem_revision:number }>(
        `SELECT object_id,version,problem_revision FROM inquiry_threads
          WHERE object_id=$1 AND space_id=$2 AND project_id=$3
            AND kind='question' AND lifecycle_status='active'`,
        [input.threadId, identity.spaceId, projectId],
      );
      if (!thread.rows[0]) {
        throw new HttpError(404, "Inquiry Thread not found or is not an active Question");
      }
      // Serializes the "already starting" check against the enqueue below.
      // Do not check without this lock. Two near-simultaneous calls would
      // both see no active job and both enqueue one, each burning a real LLM
      // planning or live-search pipeline run before either row is visible
      // to the other.
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`research-start-acquisition:${identity.spaceId}:${input.threadId}`],
      );
      const request={thread:input.threadId,note:input.intentNote??null,max:input.maxItems??null,since:input.since??null};
      const fingerprint=createHash("sha256").update(JSON.stringify(request)).digest("hex");
      const receiptKey=input.requestKey?`research_acquisition:${createHash("sha256").update(`${identity.userId}:${input.threadId}:${input.requestKey}`).digest("hex")}`:null;
      const authorizeMetadata=async(id:string)=>{const visible=await db.query(`SELECT id FROM project_operations op WHERE id=$1 AND space_id=$2 AND project_id=$3 AND ${researchMetadataReadableSql("op","$4")}`,[id,identity.spaceId,projectId,identity.userId]);if(!visible.rows[0])throw new HttpError(404,"Research invocation not found");};
      if(receiptKey){
       const replay=await replayProblemCommand(db,identity.spaceId,input.threadId,receiptKey,request);
       if(replay){await authorizeMetadata(String(replay.operation_id));return replay as StartResearchAcquisitionResult;}
      }
      const active=(await db.query<{id:string;research_call_json:unknown;progress_json:unknown}>(`SELECT id,research_call_json,progress_json FROM project_operations WHERE space_id=$1 AND project_id=$2 AND kind='research' AND status IN ('active','waiting_review') AND research_call_json->>'thread_id'=$3 ORDER BY created_at,id LIMIT 1 FOR SHARE`,[identity.spaceId,projectId,input.threadId])).rows[0];
      if(active){
       // An admitted but unreadable call is a generic conflict, never an id disclosure.
       try{await assertResearchCallReadable(db,identity,projectId,active.research_call_json,active.progress_json,"stop");}
       catch(error){if(error instanceof HttpError && error.statusCode===404)throw new ResearchWorkspaceMutationError(409,"Another research invocation is active");throw error;}
       let call;
       try{call=await assertResearchCallReadable(db,identity,projectId,active.research_call_json,active.progress_json);}
       catch(error){if(error instanceof ResearchCallContentUnavailable)throw new ResearchWorkspaceMutationError(409,"Active research content is unavailable; inspect or stop the invocation before starting new work");throw error;}
       if(!call)throw new ResearchWorkspaceMutationError(409,"Active research binding is unresolved");
       const history=call.scope.history as {max_items?:number;from?:string|null}|undefined;
       if(call.thread_version!==thread.rows[0].version || input.intentNote!=null&&input.intentNote!==call.gap || input.maxItems!=null&&input.maxItems!==history?.max_items || input.since!=null&&(!history?.from||Date.parse(input.since)!==Date.parse(history.from)))throw new ResearchWorkspaceMutationError(409,"An active invocation has different scope or problem version; inspect or cancel it before a new request");
       const response={status:"already_starting" as const,thread_id:input.threadId,operation_id:active.id};
       if(receiptKey)await saveProblemCommand(db,identity,projectId,input.threadId,receiptKey,request,response);
       return response;
      }
      const prepared=await prepareResearchAcquisition(db,identity,projectId,{threadId:input.threadId,key:input.requestKey??`unkeyed:${randomUUID()}`,fingerprint,gap:input.intentNote??"Find evidence for the accepted problem",maxItems:input.maxItems??SCREENING_AUTO_CONTINUE_CORPUS_LIMIT,since:input.since??null,runId:input.originRunId});
      const job=await new PgJobQueueRepository(db).enqueue({
        job_type: RESEARCH_PIPELINE_START_JOB,
        space_id: identity.spaceId,
        user_id: identity.userId,
        payload: {
          operation_id:prepared.id,
          call_request_key:input.requestKey??null,
          origin_run_id:input.originRunId??null,
          expected_thread_version:thread.rows[0].version,
          thread_id: input.threadId,
          project_id: projectId,
          intent_note: input.intentNote ?? null,
          origin_room_id: input.originRoomId,
          origin_session_id: input.originSessionId,
          ...(input.originGroupId ? { origin_group_id: input.originGroupId } : {}),
          ...(input.maxItems ? { max_items: input.maxItems } : {}),
          ...(input.since ? { since: input.since } : {}),
        },
      });
      await new ProjectOperationService(db).link(identity.spaceId,projectId,prepared.id,"job",job.id,"acquisition_pipeline");
      await db.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('acquisition_job_id',$3::text) WHERE id=$1 AND space_id=$2`,[prepared.id,identity.spaceId,job.id]);
      const response={ status: "queued" as const, thread_id: input.threadId,operation_id:prepared.id };
      if(receiptKey)await saveProblemCommand(db,identity,projectId,input.threadId,receiptKey,request,response);
      return response;
    });
  }
}
