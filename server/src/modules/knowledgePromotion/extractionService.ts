import {recordDetailRead} from '../contentAccess/audit.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {CandidateMutationError} from './candidateErrors.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {canWriteProject} from '../projects/access.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import { randomUUID } from "node:crypto";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import {
  HttpError,
  objectValue,
  optionalString,
  requiredString,
  withQueryableTransaction,
} from "../routeUtils/common.js";
import { assertProjectWriter, lockActiveProjectForMutation } from "../projects/access.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { threadReadableSql } from "../inquiry/threadAccess.js";
import { PgRunRepository } from "../runs/repository.js";
import { runOutputResult } from "../runs/orchestrationResults.js";
import { PgJobQueueRepository } from "../jobs/repository.js";

const CANDIDATE_KINDS = new Set(["concept", "lesson", "procedure", "decision", "summary"]);

export class KnowledgeExtractionService {
  constructor(private readonly db: Queryable) {}

  async queue(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return withQueryableTransaction(this.db,db=>new KnowledgeExtractionService(db).queueInTransaction(identity,projectId,body));
  }

  private async queueInTransaction(identity:SpaceUserIdentity,projectId:string,body:Record<string,unknown>):Promise<Record<string,unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const sourceKind = requiredString(body.source_kind, "source_kind");
    const sourceId = requiredString(body.source_id, "source_id");
    const agentId = requiredString(body.agent_id, "agent_id");
    const runtimeProfileId = optionalString(body.runtime_profile_id);
    if(await contentDecisionFromDb(this.db,identity,'agent',agentId,{includeOversight:false})!=='full')throw new HttpError(404,'Agent not found');
    if(sourceKind!=='experiment_interpretation'&&!await this.currentSourceAccess(this.db,identity,sourceKind,sourceId,projectId))throw new HttpError(404,'Source not found');
    const source = await this.resolveSource(identity, projectId, sourceKind, sourceId);
    if(sourceKind!=='experiment_interpretation'){
      try{await recordDetailRead(this.db,{spaceId:identity.spaceId,viewerUserId:identity.userId,resourceType:'space_object',resourceId:sourceId});}
      catch{throw new OperationError('operation_audit_unavailable',503,true);}
    }
    const prompt = [
      "Extract durable learning candidates from the immutable source below.",
      "Return JSON with key knowledge_candidates, an array of at most 10 objects.",
      "Each object must contain candidate_kind (concept|lesson|procedure|decision|summary), proposed_title, and proposed_content.",
      "Do not claim these are canonical Knowledge; they will enter human review.",
      "",
      source.text,
    ].join("\n");
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const run = await new PgRunRepository(db).createQueuedRun({
        execution_kind: "agent",
        agent_id: agentId,
        space_id: identity.spaceId,
        user_id: identity.userId,
        mode: "live",
        ...(source.visibility!=="space_shared"?{visibility:"private" as const}:{}),
        run_type: "agent",
        trigger_origin: "manual",
        project_id: projectId,
        runtime_profile_id: runtimeProfileId,
        runtime_profile_selection_source: runtimeProfileId ? "explicit" : "default",
        prompt,
        instruction: "Propose Knowledge Candidates from one pinned source revision.",
        contract_snapshot: {
          source: { kind: "direct", id: sourceId },
          project_id: projectId,
          max_attempts: 3,
          required_outputs_json: ["knowledge_candidates"],
          structured_output_json: {
            type: "object",
            required: ["knowledge_candidates"],
          },
          workflow_input_json: {
            kind: "knowledge_candidate_extraction",
            source_kind: sourceKind,
            source_id: sourceId,
            source_ref: source.ref,
            source_visibility: source.visibility,
            source_owner_user_id: source.ownerUserId,
          },
        },
      });
      await new PgJobQueueRepository(db).enqueue({
        job_type: "agent_run",
        space_id: identity.spaceId,
        user_id: identity.userId,
        agent_id: agentId,
        payload: { run_id: run.id },
      });
      return { run_id: run.id, status: run.status, source_ref: source.ref };
    });
  }

  async reconcile(spaceId: string, runId: string): Promise<number> {
    try { return await withQueryableTransaction(this.db, async (db) => {
      // Reuse the canonical event writer gate before any domain row. Never wait
      // for a Run/source row while holding it: the existing Job defer owns retry.
      const gate=(await db.query<{locked:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended('run_events:' || $1::text,0)) AS locked",[runId])).rows[0];
      if(!gate?.locked)throw new JobDeferredError('Knowledge publication is busy',1000);
      const prior=(await db.query<{metadata_json:{created_count:number}}>("SELECT metadata_json FROM run_events WHERE space_id=$1 AND run_id=$2 AND event_type='action_completed' AND actor_id IS NULL AND metadata_json->>'action_name'='knowledge.candidate.extraction.publish' ORDER BY event_index LIMIT 1",[spaceId,runId])).rows[0];
      if(prior)return prior.metadata_json.created_count;
      const initial=(await db.query<{project_id:string|null;contract_snapshot_json:unknown;instructed_by_user_id:string|null;owner_user_id:string|null;agent_id:string|null}>('SELECT project_id,contract_snapshot_json,instructed_by_user_id,owner_user_id,agent_id FROM runs WHERE id=$1 AND space_id=$2',[runId,spaceId])).rows[0];
      if(!initial)return 0;
      const initialUser=initial.instructed_by_user_id??initial.owner_user_id;
      const binding=objectValue(objectValue(initial.contract_snapshot_json).workflow_input_json);
      if(binding.kind!=='knowledge_candidate_extraction')return 0;
      const sourceTable=binding.source_kind==='experiment_interpretation'?'experiment_interpretations':'space_objects';
      const sourceProjectColumn=sourceTable==='space_objects'?'primary_project_id':'project_id';
      const sourceParent=(await db.query<{project_id:string|null}>(`SELECT ${sourceProjectColumn} AS project_id FROM ${sourceTable} WHERE id=$1 AND space_id=$2`,[binding.source_id,spaceId])).rows[0]?.project_id??null;
      const projects=[...new Set([initial.project_id,sourceParent].filter((p):p is string=>!!p))].sort();
      for(const project of projects)await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR SHARE NOWAIT',[project,spaceId]);
      await db.query('SELECT id FROM project_members WHERE space_id=$1 AND user_id=$2 AND project_id=ANY($3::varchar[]) ORDER BY id FOR SHARE NOWAIT',[spaceId,initialUser,projects]);
      await db.query('SELECT id FROM space_memberships WHERE space_id=$1 AND user_id=$2 ORDER BY id FOR SHARE NOWAIT',[spaceId,initialUser]);
      await db.query("SELECT id FROM content_access_grants WHERE space_id=$1 AND grantee_user_id=$2 AND resource_id=ANY($3::varchar[]) ORDER BY id FOR SHARE NOWAIT",[spaceId,initialUser,[String(binding.source_id),initial.agent_id].filter(Boolean)]);
      await db.query('SELECT id FROM agents WHERE id=$1 AND space_id=$2 FOR SHARE NOWAIT',[initial.agent_id,spaceId]);
      await db.query(`SELECT id FROM ${sourceTable} WHERE id=$1 AND space_id=$2 FOR SHARE NOWAIT`,[binding.source_id,spaceId]);
      if(((await db.query<{project_id:string|null}>(`SELECT ${sourceProjectColumn} AS project_id FROM ${sourceTable} WHERE id=$1 AND space_id=$2`,[binding.source_id,spaceId])).rows[0]?.project_id??null)!==sourceParent)throw new JobDeferredError('Knowledge source scope changed',1000);
      const result = await db.query<{
        id: string; project_id: string | null; instructed_by_user_id: string | null;
        owner_user_id: string | null; agent_id: string | null; status: string; output_json: unknown; contract_snapshot_json: unknown;
      }>(
        `SELECT id,project_id,instructed_by_user_id,owner_user_id,agent_id,status,output_json,contract_snapshot_json
           FROM runs WHERE id=$1 AND space_id=$2 FOR UPDATE NOWAIT`,
        [runId, spaceId],
      );
      const run = result.rows[0];
      if (!run || run.status !== "succeeded" || !run.project_id) return 0;
      const workflowInput = objectValue(objectValue(run.contract_snapshot_json).workflow_input_json);
      if (workflowInput.kind !== "knowledge_candidate_extraction") return 0;
      if(run.project_id!==initial.project_id||run.agent_id!==initial.agent_id||(run.instructed_by_user_id??run.owner_user_id)!==initialUser||JSON.stringify(objectValue(objectValue(run.contract_snapshot_json).workflow_input_json))!==JSON.stringify(binding))throw new JobDeferredError('Knowledge extraction binding changed',1000);
      const receipt=async(count:number,reason:string)=>{
        const event=await new PgRunRepository(db).appendRunEvent({space_id:spaceId,run_id:runId,event_type:'action_completed',status:reason==='published'?'succeeded':'skipped',metadata_json:{action_name:'knowledge.candidate.extraction.publish',instructed_by_user_id:run.instructed_by_user_id,created_count:count,disposition:reason}});
        if(!event)throw new Error('Knowledge publication receipt unavailable');return count;
      };
      const existing = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM knowledge_promotion_candidates
          WHERE space_id=$1 AND source_ref_json->>'extraction_run_id'=$2`,
        [spaceId, runId],
      );
      if ((existing.rows[0]?.count ?? 0) > 0) return receipt(existing.rows[0]!.count,'published');
      const who=run.instructed_by_user_id??run.owner_user_id;
      const identity={spaceId,userId:who??''};
      const active=(await db.query("SELECT 1 FROM users u JOIN space_memberships m ON m.user_id=u.id WHERE u.id=$1 AND u.status='active' AND m.space_id=$2 AND m.status='active'",[who,spaceId])).rows.length>0;
      const project=(await db.query("SELECT status FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL",[run.project_id,spaceId])).rows[0];
      if(!active||project?.status!=='active'||!await canWriteProject(db,spaceId,run.project_id,who??''))return receipt(0,'authority_revoked');
      if(!initial.agent_id||!(await db.query("SELECT id FROM agents WHERE id=$1 AND space_id=$2 AND status='active'",[initial.agent_id,spaceId])).rows.length||await contentDecisionFromDb(db,identity,'agent',initial.agent_id,{includeOversight:false})!=='full')return receipt(0,'agent_unavailable');
      const current=await this.currentSourceAccess(db,identity,String(workflowInput.source_kind),String(workflowInput.source_id),run.project_id);
      if(!current)return receipt(0,'source_unavailable');
      const candidates = Array.isArray(runOutputResult(run.output_json).knowledge_candidates)
        ? runOutputResult(run.output_json).knowledge_candidates as unknown[]
        : [];
      const sourceKind = requiredString(workflowInput.source_kind, "source_kind");
      const sourceId = requiredString(workflowInput.source_id, "source_id");
      const sourceRef = objectValue(workflowInput.source_ref);
      // Only an explicitly shared source yields shared candidates; anything
      // else (private, or shared with selected people whose grants do not
      // travel) stays with the source's owner.
      const visibility = workflowInput.source_visibility === "space_shared" && current.visibility === "space_shared" ? "space_shared" : "private";
      const ownerUserId = optionalString(current.owner_user_id)
        ?? optionalString(workflowInput.source_owner_user_id)
        ?? run.instructed_by_user_id
        ?? run.owner_user_id;
      const now = new Date().toISOString();
      let created = 0;
      for (const value of candidates.slice(0, 10)) {
        const row = objectValue(value);
        const kind = optionalString(row.candidate_kind);
        const title = optionalString(row.proposed_title);
        const content = optionalString(row.proposed_content);
        if (!kind || !CANDIDATE_KINDS.has(kind) || !title || !content) continue;
        await db.query(
          `INSERT INTO knowledge_promotion_candidates (
             id,space_id,project_id,trigger,source_kind,source_id,source_ref_json,
             candidate_kind,proposed_title,proposed_content,visibility,owner_user_id,
             status,created_by_user_id,created_at,updated_at
           ) VALUES ($1,$2,$3,'promotion',$4,$5,$6::jsonb,$7,$8,$9,$10,$11,'pending',$12,$13,$13)`,
          [
            randomUUID(), spaceId, run.project_id, sourceKind, sourceId,
            JSON.stringify({ ...sourceRef, extraction_run_id: runId }),
            kind, title, content, visibility, visibility === "private" ? ownerUserId : null,
            run.instructed_by_user_id, now,
          ],
        );
        created += 1;
      }
      return receipt(created,'published');
    }); }catch(error){if((error as {code?:string})?.code==='55P03')throw new JobDeferredError('Knowledge publication rows are busy',1000);throw error;}
  }

  async assertDispatch(run:Pick<import('../runs/repository.js').AgentRunRecord,'space_id'|'project_id'|'instructed_by_user_id'|'owner_user_id'|'agent_id'|'visibility'|'contract_snapshot_json'>):Promise<void>{
    const binding=objectValue(objectValue(run.contract_snapshot_json).workflow_input_json);
    if(binding.kind!=='knowledge_candidate_extraction')return;
    const who=run.instructed_by_user_id??run.owner_user_id,identity={spaceId:run.space_id,userId:who??''};
    const source=await this.currentSourceAccess(this.db,identity,String(binding.source_kind),String(binding.source_id),run.project_id??'');
    const active=(await this.db.query("SELECT 1 FROM users u JOIN space_memberships m ON m.user_id=u.id WHERE u.id=$1 AND u.status='active' AND m.space_id=$2 AND m.status='active'",[who,run.space_id])).rows.length>0;
    const project=(await this.db.query('SELECT status FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL',[run.project_id,run.space_id])).rows[0];
    const agent=(await this.db.query("SELECT id FROM agents WHERE id=$1 AND space_id=$2 AND status='active'",[run.agent_id,run.space_id])).rows[0];
    if(!active||!source||project?.status!=='active'||!run.project_id||!await canWriteProject(this.db,run.space_id,run.project_id,identity.userId)||!agent||await contentDecisionFromDb(this.db,identity,'agent',String(run.agent_id),{includeOversight:false})!=='full'||source.visibility!=='space_shared'&&run.visibility!=='private')throw new HttpError(403,'Knowledge extraction authorization changed; start a new extraction');
  }

  private async currentSourceAccess(db:Queryable,identity:SpaceUserIdentity,kind:string,id:string,projectId:string):Promise<{visibility:string;owner_user_id:string|null}|null>{
    if(kind==='experiment_interpretation')return (await db.query<{visibility:string;owner_user_id:null}>("SELECT 'space_shared' AS visibility,NULL::varchar AS owner_user_id FROM experiment_interpretations WHERE id=$1 AND space_id=$2 AND project_id=$3 AND status='converted'",[id,identity.spaceId,projectId])).rows[0]??null;
    const row=(await db.query<{visibility:string;owner_user_id:string|null}>("SELECT visibility,owner_user_id FROM space_objects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL",[id,identity.spaceId])).rows[0];
    if(!row||await contentDecisionFromDb(db,identity,'space_object',id,{includeOversight:false})!=='full')return null;return row;
  }

  private async resolveSource(
    identity: SpaceUserIdentity,
    projectId: string,
    sourceKind: string,
    sourceId: string,
  ): Promise<{ ref: Record<string, unknown>; text: string; visibility: string; ownerUserId: string | null }> {
    if (sourceKind === "note") {
      const row = await this.db.query<{
        revision_id: string; version: number; content_hash: string; normalized_text: string;
        visibility: string; owner_user_id: string | null;
      }>(
        `SELECT nr.id AS revision_id,nr.version,nr.content_hash,nr.normalized_text,so.visibility,so.owner_user_id
           FROM note_revisions nr JOIN space_objects so ON so.id=nr.note_id AND so.space_id=nr.space_id
          WHERE nr.note_id=$1 AND nr.space_id=$2 AND ${contentReadSql("space_object", "so", "$3")}
          ORDER BY nr.version DESC LIMIT 1`,
        [sourceId, identity.spaceId, identity.userId],
      );
      const value = row.rows[0];
      if (!value) throw new HttpError(404, "Note not found or inaccessible");
      return {
        ref: { kind: "note_revision", note_id: sourceId, revision_id: value.revision_id, version: value.version, content_hash: value.content_hash, block_anchors: [] },
        text: value.normalized_text,
        visibility: value.visibility,
        ownerUserId: value.owner_user_id,
      };
    }
    if (sourceKind === "inquiry_thread") {
      const row = await this.db.query<{
        revision_id: string; version: number; content_hash: string; statement: string;
        kind: string; answer_state: string | null; evaluation_state: string | null;
        confidence: number | null; state_snapshot_json: unknown;
        visibility: string; owner_user_id: string | null;
      }>(
        // Only a Thread the person reaches on their own is a source (oversight
        // is audit), and what is extracted keeps the Thread's own visibility.
        `SELECT r.id AS revision_id,r.version,r.content_hash,r.statement,r.kind,
                r.answer_state,r.evaluation_state,r.confidence,r.state_snapshot_json,
                so.visibility,so.owner_user_id
           FROM inquiry_thread_revisions r JOIN inquiry_threads t ON t.object_id=r.thread_id AND t.space_id=r.space_id
           JOIN space_objects so ON so.id=t.object_id AND so.space_id=t.space_id
          WHERE r.thread_id=$1 AND r.space_id=$2 AND t.project_id=$3
            AND ${threadReadableSql("so", "$4", "change")}
          ORDER BY r.version DESC LIMIT 1`,
        [sourceId, identity.spaceId, projectId, identity.userId],
      );
      const value = row.rows[0];
      if (!value) throw new HttpError(404, "Inquiry Thread not found");
      return {
        ref: { kind: "inquiry_thread_revision", thread_id: sourceId, revision_id: value.revision_id, version: value.version, content_hash: value.content_hash },
        text: JSON.stringify({
          statement: value.statement,
          kind: value.kind,
          answer_state: value.answer_state,
          evaluation_state: value.evaluation_state,
          confidence: value.confidence,
          state: value.state_snapshot_json,
        }),
        visibility: value.visibility,
        ownerUserId: value.owner_user_id,
      };
    }
    if (sourceKind === "experiment_interpretation") {
      const row = await this.db.query<{
        definition_id: string; run_ids_json: unknown; verdict: string; conclusion: string | null;
        negative_results: string | null; limitations: string | null; repro_lock_json: unknown; status: string;
      }>(
        `SELECT definition_id,run_ids_json,verdict,conclusion,negative_results,limitations,repro_lock_json,status
           FROM experiment_interpretations WHERE id=$1 AND space_id=$2 AND project_id=$3`,
        [sourceId, identity.spaceId, projectId],
      );
      const value = row.rows[0];
      if (!value) throw new HttpError(404, "Experiment Interpretation not found");
      if (value.status !== "converted") throw new CandidateMutationError(409, "Only a converted Interpretation can be extracted");
      const text = JSON.stringify({
        verdict: value.verdict,
        conclusion: value.conclusion,
        negative_results: value.negative_results,
        limitations: value.limitations,
      });
      const runIds = Array.isArray(value.run_ids_json)
        ? value.run_ids_json.filter((item): item is string => typeof item === "string")
        : [];
      return {
        ref: {
          kind: "experiment_interpretation",
          interpretation_id: sourceId,
          content_hash: await sha256(text),
          definition_id: value.definition_id,
          run_ids: runIds,
          repro_lock_hash: await sha256(JSON.stringify(objectValue(value.repro_lock_json))),
        },
        text,
        visibility: "space_shared",
        ownerUserId: null,
      };
    }
    throw new HttpError(422, "source_kind must be note, inquiry_thread, or experiment_interpretation");
  }
}

async function sha256(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}
