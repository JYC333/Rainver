import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { HttpError, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { enforce } from "./service.js";
import { withPolicyAuditRecovery } from "./auditWriter.js";
import { loadActionRegistry } from "./actionRegistry.js";
import { ActionApprovalGrantService } from "./actionApprovalGrantService.js";
import { redactEvidenceText } from "../runs/evidenceRedaction.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import {lockProjectAudience} from '../projects/access.js';
import {lockDemotionReleaseClosure} from '../contentAccess/demotionReleaseClosure.js';
import {contentOwnerOnlySql, runReadSql} from '../access/contentAccessSql.js';
import {canReadAgent} from '../agents/agentAccess.js';
import {pluginToolMeta} from '../plugins/dataAccess.js';

interface DecisionRow {
  id: string;
  space_id: string;
  run_id: string | null;
  actor_type: string | null;
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  decision: string;
  policy_rule_id: string | null;
  policy_source: string | null;
  metadata_json: Record<string, unknown> | null;
}

interface RunRow {
  id: string;
  space_id: string;
  agent_id: string;
  instructed_by_user_id: string | null;
  project_id: string | null;
}

interface AuthorizationRequestOut {
  id: string;
  space_id: string;
  run_id: string;
  agent_id: string;
  instructed_by_user_id: string;
  policy_decision_record_id: string;
  action_id: string;
  policy_action: string;
  project_id: string | null;
  resource_kind: string | null;
  resource_id: string | null;
  reason: string;
  status: "pending" | "approved" | "rejected" | "expired";
  resulting_action_grant_id: string | null;
  decided_by_user_id: string | null;
  requested_at: string;
  decided_at: string | null;
  request_kind: "action_grant" | "plugin_data";
  resulting_plugin_data_grant_id: string | null;
}

const REQUEST_COLUMN_NAMES = [
  "id", "space_id", "run_id", "agent_id", "instructed_by_user_id",
  "policy_decision_record_id", "action_id", "policy_action",
  "project_id", "resource_kind", "resource_id", "reason", "status",
  "resulting_action_grant_id", "decided_by_user_id", "requested_at", "decided_at",
  "request_kind", "resulting_plugin_data_grant_id",
] as const;
const REQUEST_COLUMNS = REQUEST_COLUMN_NAMES.join(", ");
const requestColumns = (alias: string) => REQUEST_COLUMN_NAMES.map((column) => `${alias}.${column}`).join(", ");
/**
 * The Run waits for exactly this request: paused for it by `createFromDeniedDecision` and not yet resumed,
 * cancelled or failed. The same predicate the resume (`requeueApprovedAuthorizationRequest`) and the consent
 * card's projection use; `$req` is the request id's placeholder.
 */
const runWaitsForRequestSql = (run: string, req: string) => `(${run}.status = 'waiting_for_review' AND ${run}.error_json->>'authorization_request_id' = ${req})`;

/**
 * Converts only an audited, same-Run denial into a bounded human request.
 * Only registry actions explicitly marked grantable may cross this boundary.
 */
export class AuthorizationRequestService {
  constructor(
    private readonly db: Queryable,
    private readonly config: Pick<ServerConfig, "databaseUrl">,
  ) {}

  async createFromDeniedDecision(input: {
    spaceId: string;
    runId: string;
    agentId: string;
    policyDecisionRecordId: string;
    reason: string;
  }): Promise<AuthorizationRequestOut> {
    const reason = redactEvidenceText(input.reason.trim()) ?? "";
    if (!reason || reason.length > 1000) throw new HttpError(422, "reason must contain 1 to 1000 characters");
    return withQueryableTransaction(this.db,async client=>{
      const decisionResult = await client.query<DecisionRow>(
        `SELECT id, space_id, run_id, actor_type, actor_id, action,
                resource_type, resource_id, decision,
                policy_rule_id, policy_source, metadata_json
           FROM policy_decision_records
          WHERE id = $1 AND space_id = $2 AND run_id = $3
          LIMIT 1`,
        [input.policyDecisionRecordId, input.spaceId, input.runId],
      );
      const runResult = await client.query<RunRow>(
        `SELECT id, space_id, agent_id, instructed_by_user_id, project_id
           FROM runs
          WHERE id = $1 AND space_id = $2 AND agent_id = $3
            AND status = 'running'
          LIMIT 1 FOR UPDATE`,
        [input.runId, input.spaceId, input.agentId],
      );
      const decision = decisionResult.rows[0];
      const run = runResult.rows[0];
      if (!decision || !run) throw new HttpError(404, "Denied policy decision not found for an active Run");
      if (decision.decision !== "deny") throw new HttpError(409, "Only denied decisions can raise an authorization request");
      if (decision.actor_type !== "agent" || decision.actor_id !== input.agentId) {
        throw new HttpError(403, "Denied policy decision does not belong to this Run Agent");
      }
      if (!run.instructed_by_user_id) throw new HttpError(409, "Run has no instructing user who can review authorization");

      const requestClass = await classifyRequestableDecision(decision,this.config as ServerConfig);
      if (!requestClass) {
        throw new HttpError(403, "This denial is a hard authorization boundary and cannot be requested");
      }
      // A core data tool's request freezes the consent it asks for (ADR 0033): the owner, the Project of
      // their private conversation and the connection the call named at its current generation, and the
      // purpose. The card shows exactly this and approval writes exactly this, or nothing.
      const binding = requestClass.kind === "plugin_data" ? await frozenCoreBinding(client, {
        spaceId: input.spaceId, ownerUserId: run.instructed_by_user_id, runId: input.runId, actionId: requestClass.actionId, resourceId: decision.resource_id,
      }) : null;
      const now = new Date().toISOString();
      const id = randomUUID();
      const inserted = await client.query<AuthorizationRequestOut>(
      `INSERT INTO authorization_requests (
         id, space_id, run_id, agent_id, instructed_by_user_id,
         policy_decision_record_id, action_id, policy_action,
         project_id, resource_kind, resource_id, reason, status, requested_at, request_kind,
         consent_owner_user_id, consent_project_id, consent_connection_id, consent_connection_generation, consent_purpose
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12, 'pending', $13, $14,
         $15, $16, $17, $18, $19
       )
       ON CONFLICT (space_id, policy_decision_record_id) DO UPDATE
         SET reason = authorization_requests.reason
       RETURNING ${REQUEST_COLUMNS}`,
      [
        id,
        input.spaceId,
        input.runId,
        input.agentId,
        run.instructed_by_user_id,
        decision.id,
        requestClass.actionId,
        decision.action,
        run.project_id,
        decision.resource_type,
        decision.resource_id,
        reason,
        now,
        requestClass.kind,
        binding?.owner_user_id ?? null, binding?.project_id ?? null, binding?.binding_id ?? null, binding?.generation ?? null, binding?.purpose ?? null,
      ],
      );
      const request = inserted.rows[0]!;
      if (request.status !== "pending") {
        throw new HttpError(409, "This denied decision already has a completed authorization request");
      }
      const paused = await client.query(
        `WITH updated AS (
           UPDATE runs
              SET status = 'waiting_for_review',
                  error_json = jsonb_build_object(
                    'error_code', 'authorization_request_pending',
                    'authorization_request_id', $3::text
                  ),
                  error_message = 'Agent authorization request is pending review.',
                  updated_at = $4
            WHERE id = $1 AND space_id = $2 AND status = 'running'
            RETURNING id, space_id
         )
         UPDATE run_attempts attempt
            SET status = 'waiting_for_review',
                error_code = 'authorization_request_pending',
                error_json = jsonb_build_object(
                  'error_code', 'authorization_request_pending',
                  'authorization_request_id', $3::text
                ),
                last_activity_at = $4,
                updated_at = $4
           FROM updated
          WHERE attempt.run_id = updated.id
            AND attempt.space_id = updated.space_id
            AND attempt.status = 'running'
            AND attempt.attempt_number = (
              SELECT max(candidate.attempt_number)
                FROM run_attempts candidate
               WHERE candidate.run_id = updated.id
                 AND candidate.space_id = updated.space_id
            )
         RETURNING updated.id`,
        [input.runId, input.spaceId, request.id, now],
      );
      if (!paused.rows[0]) throw new HttpError(409, "Run could not be paused for authorization review");
      return request;
    });
  }

  /**
   * The Run's requests a person may see. A Run under the owner-only predicate (it may read the owner's mail,
   * drafted an owner-only proposal, or carries a sensitive conversation) shows its requests — reason, resource,
   * Project — to its owner alone: no Space owner, oversight mode or other instructing person sees the rows.
   */
  async listForRun(identity: { spaceId: string; userId: string }, runId: string): Promise<(AuthorizationRequestOut & { approver: "data_owner" | "space_owner"; consent_state?: ConsentCardState; consent_target?: ConsentTargetOut | null })[]> {
    const result = await this.db.query<AuthorizationRequestOut>(
      `SELECT ${requestColumns("ar")}
         FROM authorization_requests ar
         JOIN runs r ON r.id = ar.run_id AND r.space_id = ar.space_id
        WHERE ar.space_id = $1
          AND ar.run_id = $2
          AND CASE WHEN ${contentOwnerOnlySql("run", "r")}
            THEN r.owner_user_id = $3 AND ar.instructed_by_user_id = $3
            -- A core data tool's consent request (Gmail, ADR 0033) is the mailbox owner's alone, in any conversation.
            WHEN ar.request_kind = 'plugin_data' AND ar.action_id = ANY($4::varchar[])
            THEN ar.instructed_by_user_id = $3
            ELSE (
              ar.instructed_by_user_id = $3
              OR EXISTS (
                SELECT 1 FROM space_memberships sm
                 WHERE sm.space_id = ar.space_id
                   AND sm.user_id = $3
                   AND sm.status = 'active'
                   AND sm.role = 'owner'
              )
            ) END
        ORDER BY ar.requested_at ASC, ar.id ASC`,
      [identity.spaceId, runId, identity.userId, await coreDataToolActionIds()],
    );
    const { coreDataTool } = await import("../plugins/coreDataTools.js");
    // Who decides: a sensitive plugin-data request is the data owner's alone (ADR 0030).
    return Promise.all(result.rows.map(async (row) => {
      const out = {
        ...row,
        approver: row.request_kind === "plugin_data" && pluginToolMeta(this.config as ServerConfig, row.action_id)?.pin.data_class === "sensitive" ? "data_owner" as const : "space_owner" as const,
      };
      // A core data tool's card names the mailbox and Project it would allow, to its owner only (ADR 0033).
      if (row.request_kind !== "plugin_data" || !coreDataTool(row.action_id) || row.instructed_by_user_id !== identity.userId || row.status !== "pending") return out;
      return { ...out, ...await coreConsentCard(this.db, identity, row.id) };
    }));
  }

  async decide(
    identity: { spaceId: string; userId: string },
    requestId: string,
    decision: "approved" | "rejected",
  ): Promise<AuthorizationRequestOut> {
    // Recovery owns the whole transaction, including rollback and connection release.
    return withPolicyAuditRecovery(this.config.databaseUrl, () => this.decideTransaction(identity, requestId, decision));
  }

  private async decideTransaction(
    identity: { spaceId: string; userId: string },
    requestId: string,
    decision: "approved" | "rejected",
  ): Promise<AuthorizationRequestOut> {
    return withQueryableTransaction(this.db,client=>this.decideInTransaction(client,identity,requestId,decision));
  }

  /** Same owner for REST/core and internal callers; no transaction escape. */
  async authorizeDecision(db:Queryable,identity:{spaceId:string;userId:string},requestId:string,decision:'approved'|'rejected'){
    const candidate=(await db.query<AuthorizationRequestOut&{owner_only:boolean;run_owner_user_id:string|null;consent_project_id:string|null}>(`SELECT ${requestColumns('ar')},${contentOwnerOnlySql('run','r')} AS owner_only,r.owner_user_id AS run_owner_user_id,ar.consent_project_id
      FROM authorization_requests ar JOIN runs r ON r.id=ar.run_id AND r.space_id=ar.space_id WHERE ar.id=$1 AND ar.space_id=$2`,[requestId,identity.spaceId])).rows[0];
    // An owner-only Run's request does not exist for anyone else, the same as in its list; nor does a core
    // data tool's consent request (Gmail, ADR 0033) for anyone but the mailbox owner, in any conversation.
    if(!candidate||(candidate.owner_only&&(candidate.run_owner_user_id!==identity.userId||candidate.instructed_by_user_id!==identity.userId)))throw new HttpError(404,'Authorization request not found');
    if(candidate.request_kind==='plugin_data'&&(await coreDataToolActionIds()).includes(candidate.action_id)&&candidate.instructed_by_user_id!==identity.userId)throw new HttpError(404,'Authorization request not found');
    const before=(await db.query<RunRow>('SELECT id,space_id,agent_id,instructed_by_user_id,project_id FROM runs WHERE id=$1 AND space_id=$2',[candidate.run_id,identity.spaceId])).rows[0];
    if(!before)throw new HttpError(404,'Run not found');
    if(decision==='approved'){
      const requester={spaceId:identity.spaceId,userId:candidate.instructed_by_user_id};
      // One discovered closure: Agent/Run Projects and shares, Folder, Room,
      // memberships, roots and grants. Rechecking the requester never uses
      // the approving owner's oversight or role as a substitute.
      // A frozen consent's Project is in it too, so the approval holds it before the Run (Project → Run →
      // bound resource → request), as its membership writer's counterpart.
      await lockDemotionReleaseClosure(db,requester,{resource:{type:'agent',id:candidate.agent_id},runIds:[candidate.run_id],artifactIds:[],proposalIds:[],
        additionalProjectIds:candidate.consent_project_id?[candidate.consent_project_id]:[]});
      const readable=await db.query(`SELECT id FROM runs request_run WHERE id=$1 AND space_id=$2 AND ${runReadSql('$3','request_run',{includeOversight:false})}`,[candidate.run_id,identity.spaceId,candidate.instructed_by_user_id]);
      if(!readable.rows.length||!await canReadAgent(db,requester,candidate.agent_id))throw new HttpError(403,'Requester no longer reaches this Run or Agent');
    }else if(before.project_id)await lockProjectAudience(db,identity.spaceId,before.project_id);
    const people=[...new Set([identity.userId,...(decision==='approved'?[candidate.instructed_by_user_id]:[])])].sort();
    await db.query("SELECT id FROM users WHERE id=ANY($1::varchar[]) AND status='active' ORDER BY id FOR SHARE",[people]);
    const members=(await db.query<{user_id:string;role:string}>("SELECT user_id,role FROM space_memberships WHERE space_id=$1 AND user_id=ANY($2::varchar[]) AND status='active' ORDER BY id FOR SHARE",[identity.spaceId,people])).rows;
    const active=(await db.query<{id:string}>("SELECT id FROM users WHERE id=ANY($1::varchar[]) AND status='active'",[people])).rows;
    // A sensitive plugin-data request is the data owner's alone (ADR 0030): for caller-owned
    // data that is the instructing person, and a Space owner cannot decide it on their behalf.
    const dataOwnerDecides=candidate.request_kind==='plugin_data'&&pluginToolMeta(this.config as ServerConfig,candidate.action_id)?.pin.data_class==='sensitive';
    const approverAllowed=dataOwnerDecides?identity.userId===candidate.instructed_by_user_id:members.find(m=>m.user_id===identity.userId)?.role==='owner';
    if(active.length!==people.length||members.length!==people.length||!approverAllowed)throw new HttpError(403,'Current owner and requester authority required');
    await db.query('SELECT id FROM agents WHERE id=$1 AND space_id=$2 FOR SHARE',[candidate.agent_id,identity.spaceId]);
    const run=(await db.query<RunRow&{status:string}>('SELECT id,space_id,agent_id,instructed_by_user_id,project_id,status FROM runs WHERE id=$1 AND space_id=$2 FOR SHARE',[candidate.run_id,identity.spaceId])).rows[0];
    if(!run||run.project_id!==before.project_id||run.agent_id!==candidate.agent_id||run.instructed_by_user_id!==candidate.instructed_by_user_id)throw new HttpError(409,'Authorization requester changed');
    return candidate;
  }

  /**
   * Lock order of an approval (ADR 0033): Project audiences → people → Agent → Run `FOR SHARE`
   * (`authorizeDecision`) → a core data tool's bound resource `FOR SHARE` (`lockBinding`) → the request
   * `FOR UPDATE` → the consent rows. Each writer that ends a pending request keeps that order from wherever
   * it starts: a Project membership writer (Project → request), the review timeout (Run → request), a
   * connection writer (connection `FOR UPDATE` → consents → request). Under these locks an approval writes
   * only while the request is pending and its Run still waits for exactly this request; a rejection needs
   * neither, so an ended card can always be closed.
   */
  async decideInTransaction(client:Queryable,identity:{spaceId:string;userId:string},requestId:string,decision:'approved'|'rejected'):Promise<AuthorizationRequestOut>{
      await this.authorizeDecision(client,identity,requestId,decision);
      if (decision === "approved") await lockCoreBinding(client, identity.spaceId, requestId);
      const locked = await client.query<AuthorizationRequestOut>(
        `SELECT ${REQUEST_COLUMNS}
           FROM authorization_requests
          WHERE id = $1 AND space_id = $2
          FOR UPDATE`,
        [requestId, identity.spaceId],
      );
      const request = locked.rows[0];
      if (!request) throw new HttpError(404, "Authorization request not found");
      if (request.status !== "pending") throw new HttpError(409, "Authorization request has already been decided");
      // The Run is held since authorizeDecision, so a cancel, timeout or resume cannot land between this and commit.
      if (decision === "approved" && !(await client.query(
        `SELECT 1 FROM runs r WHERE r.id = $1 AND r.space_id = $2 AND ${runWaitsForRequestSql("r", "$3")}`,
        [request.run_id, request.space_id, request.id],
      )).rows[0]) throw new HttpError(409, "The Run no longer waits for this request; it can only be rejected", { code: "authorization_request_run_not_waiting" });

      let grantId: string | null = null;
      let dataGrantId: string | null = null;
      if (request.request_kind === "plugin_data") {
        if (decision === "approved") dataGrantId = await this.createPluginDataGrant(client, identity, request);
        else if (pluginToolMeta(this.config as ServerConfig, request.action_id)?.pin.data_class !== "sensitive") await this.assertMayReview(client, identity, request);
      } else if (decision === "approved") {
        grantId = await this.createGrant(client, identity, request);
      } else {
        await this.assertMayReview(client, identity, request);
      }
      const now = new Date().toISOString();
      const updated = await client.query<AuthorizationRequestOut>(
        `UPDATE authorization_requests
            SET status = $3,
                resulting_action_grant_id = $4,
                decided_by_user_id = $5,
                decided_at = $6,
                resulting_plugin_data_grant_id = $7
          WHERE id = $1 AND space_id = $2 AND status = 'pending'
          RETURNING ${REQUEST_COLUMNS}`,
        [requestId, identity.spaceId, decision, grantId, identity.userId, now, dataGrantId],
      );
      if (!updated.rows[0]) throw new HttpError(409, "Authorization request has already been decided");
      const decided = updated.rows[0];
      await new PgJobQueueRepository(client).enqueue({
        job_type: "authorization_request_reconcile",
        space_id: request.space_id,
        user_id: identity.userId,
        agent_id: request.agent_id,
        payload: {
          authorization_request_id: request.id,
          run_id: request.run_id,
        },
        // The Run lock is released by the execution that surfaced this
        // request. A high durable retry ceiling also covers worker death until
        // the normal stale-lock reclaimer has run.
        max_attempts: 900,
      });
      return decided;
  }

  private async createGrant(
    client: Queryable,
    identity: { spaceId: string; userId: string },
    request: AuthorizationRequestOut,
  ): Promise<string> {
    await this.assertMayReview(client, identity, request);
    const decision = await enforce({...this.config, auditTransaction: client},await loadActionRegistry(this.config as ServerConfig),{
      action:'policy.action_grant.create',actor_type:'user',actor_id:identity.userId,space_id:identity.spaceId,
      resource_type:'action_approval_grant',resource_id:null,force_record:true,
      metadata_json:{authorization_request_id:request.id,run_id:request.run_id},
    });
    if(decision.status!=='allow') throw new HttpError(decision.status==='blocked'?403:503,'Action grant policy refused');
    const grant = await new ActionApprovalGrantService(client,this.config as ServerConfig).createInTransaction(identity, {
      agent_id: request.agent_id,
      action_id: request.action_id,
      target_run_id: request.run_id,
      max_uses: 1,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    return String((grant as { id: unknown }).id);
  }

  /** Approval writes the consent through its canonical writer under the approver's own identity. */
  private async createPluginDataGrant(client: Queryable, identity: { spaceId: string; userId: string }, request: AuthorizationRequestOut): Promise<string> {
    const config = this.config as ServerConfig;
    const meta = pluginToolMeta(config, request.action_id);
    if (!meta || meta.pin.data_class === "non_sensitive") throw new HttpError(409, "This plugin tool no longer needs data consent");
    const decision = await enforce({...this.config, auditTransaction: client}, await loadActionRegistry(config), {
      action: "plugin_data_grant.manage", actor_type: "user", actor_id: identity.userId, space_id: identity.spaceId,
      resource_type: "plugin_data_grant", resource_id: null, force_record: true,
      metadata_json: {authorization_request_id: request.id, run_id: request.run_id},
    });
    if (decision.status !== "allow") throw new HttpError(decision.status === "blocked" ? 403 : 503, "Plugin data grant policy refused");
    const { PluginDataGrantRepository } = await import("../plugins/dataGrantRepository.js");
    const { coreDataToolByConsentId } = await import("../plugins/coreDataTools.js");
    // A core data tool's approval is the owner's standing consent for the Project of this private
    // conversation and the resource the refused call named (ADR 0033), never a per-Run consent.
    const frozen = (await client.query<{ owner_user_id: string | null; project_id: string | null; binding_id: string | null; generation: number | null; purpose: string | null }>(
      `SELECT consent_owner_user_id AS owner_user_id, consent_project_id AS project_id, consent_connection_id AS binding_id,
              consent_connection_generation AS generation, consent_purpose AS purpose
         FROM authorization_requests WHERE id=$1 AND space_id=$2`, [request.id, request.space_id])).rows[0];
    const frozenBinding = frozen?.owner_user_id && frozen.project_id && frozen.binding_id && frozen.generation !== null && frozen.purpose
      ? { owner_user_id: frozen.owner_user_id, project_id: frozen.project_id, binding_id: frozen.binding_id, generation: frozen.generation, purpose: frozen.purpose }
      : null;
    const grant = await new PluginDataGrantRepository(client, config).create(identity, coreDataToolByConsentId(meta.pluginId)
      ? { plugin_id: meta.pluginId, toolset: "read", data_class: "sensitive", scope: "project", target_run_id: request.run_id, frozen_binding: frozenBinding }
      : meta.pin.data_class === "sensitive"
      ? { plugin_id: meta.pluginId, toolset: meta.toolset, data_class: "sensitive", scope: "run", target_run_id: request.run_id }
      : { plugin_id: meta.pluginId, toolset: meta.toolset, data_class: "personal", scope: "space" });
    return grant.id;
  }

  private async assertMayReview(
    db: Queryable,
    identity: { spaceId: string; userId: string },
    request: AuthorizationRequestOut,
  ): Promise<void> {
    const owner = await db.query(
      `SELECT 1 FROM space_memberships
        WHERE space_id = $1 AND user_id = $2 AND status = 'active' AND role = 'owner'
        LIMIT 1`,
      [identity.spaceId, identity.userId],
    );
    if (!owner.rows[0]) throw new HttpError(403, "Space owner access required");
  }
}

async function coreDataToolActionIds(): Promise<string[]> {
  const { coreDataTools } = await import("../plugins/coreDataTools.js");
  return coreDataTools().map((tool) => tool.pin.action_id);
}

/** What a core data tool's card shows its owner: the frozen Project and mailbox. Content-free. */
export interface ConsentTargetOut { project_id: string; project_name: string | null; mailbox_email: string | null; purpose: string }

/**
 * A pending core data tool card as the server would decide it now (ADR 0033): `approvable` only while every
 * part an approval rechecks still holds — the Run waits for this review, the tool is offered in its
 * conversation, the owner is an active person of the Space who reads the frozen Project, and the frozen
 * connection is active, opted in and at the frozen generation. `superseded`: made before the binding was
 * frozen (ADR 0032's per-Run consent). `ended`: some part no longer holds; it can only be rejected. Only an
 * approvable card names the mailbox and Project. Approval rechecks all of it under locks regardless.
 */
export type ConsentCardState = "approvable" | "ended" | "superseded";

async function coreConsentCard(db: Queryable, identity: { spaceId: string; userId: string }, requestId: string): Promise<{ consent_state: ConsentCardState; consent_target: ConsentTargetOut | null }> {
  const row = (await db.query<{ action_id: string; run_id: string; session_id: string | null; run_waiting: boolean; owner_active: boolean;
    project_id: string | null; project_name: string | null; connection_id: string | null; generation: number | null; purpose: string | null; mailbox_email: string | null }>(
    `SELECT ar.action_id, ar.run_id, r.session_id, ${runWaitsForRequestSql("r", "ar.id")} AS run_waiting,
            EXISTS (SELECT 1 FROM users u JOIN space_memberships sm ON sm.user_id = u.id AND sm.space_id = ar.space_id AND sm.status = 'active'
                     WHERE u.id = ar.consent_owner_user_id AND u.status = 'active') AS owner_active,
            ar.consent_project_id AS project_id, p.name AS project_name, ar.consent_connection_id AS connection_id,
            ar.consent_connection_generation AS generation, ar.consent_purpose AS purpose, c.mailbox_email
       FROM authorization_requests ar
       JOIN runs r ON r.id = ar.run_id AND r.space_id = ar.space_id
       LEFT JOIN projects p ON p.id = ar.consent_project_id AND p.space_id = ar.space_id AND p.deleted_at IS NULL
       LEFT JOIN gmail_connections c ON c.id = ar.consent_connection_id AND c.space_id = ar.space_id AND c.owner_user_id = ar.consent_owner_user_id
            AND c.status = 'active' AND c.agent_read_enabled AND c.generation = ar.consent_connection_generation
      WHERE ar.id = $1 AND ar.space_id = $2 AND ar.status = 'pending' AND ar.instructed_by_user_id = $3`,
    [requestId, identity.spaceId, identity.userId],
  )).rows[0];
  if (!row) return { consent_state: "ended", consent_target: null };
  if (!row.project_id || !row.connection_id || row.generation === null || !row.purpose) return { consent_state: "superseded", consent_target: null };
  const ended = { consent_state: "ended" as const, consent_target: null };
  if (!row.run_waiting || !row.owner_active || !row.project_name || !row.mailbox_email) return ended;
  const { coreDataTool } = await import("../plugins/coreDataTools.js");
  const core = coreDataTool(row.action_id);
  if (!core || !await core.available(db, { spaceId: identity.spaceId, userId: identity.userId, sessionId: row.session_id })) return ended;
  // The same live target an approval writes, without its locks: the conversation's Project and the connection now.
  const live = await core.consentTarget(db, { spaceId: identity.spaceId, ownerUserId: identity.userId, runId: row.run_id, bindingId: row.connection_id }).catch(() => null);
  if (!live || live.projectId !== row.project_id || live.bindingId !== row.connection_id || live.generation !== row.generation || live.purpose !== row.purpose) return ended;
  return { consent_state: "approvable", consent_target: { project_id: row.project_id, project_name: row.project_name, mailbox_email: row.mailbox_email, purpose: row.purpose } };
}

/**
 * Before an approval locks the request: a core data tool request's frozen resource `FOR SHARE`. Its binding
 * columns never change after the request is written, so they are read without a lock. A plugin's request
 * (no binding) takes nothing here.
 */
async function lockCoreBinding(db: Queryable, spaceId: string, requestId: string): Promise<void> {
  const row = (await db.query<{ action_id: string; owner_user_id: string | null; binding_id: string | null }>(
    `SELECT action_id, consent_owner_user_id AS owner_user_id, consent_connection_id AS binding_id FROM authorization_requests WHERE id = $1 AND space_id = $2`,
    [requestId, spaceId])).rows[0];
  if (!row?.owner_user_id || !row.binding_id) return;
  const { coreDataTool } = await import("../plugins/coreDataTools.js");
  await coreDataTool(row.action_id)?.lockBinding(db, { spaceId, ownerUserId: row.owner_user_id, bindingId: row.binding_id });
}

/** The frozen consent a core data tool's request asks for; null for a plugin's request. */
async function frozenCoreBinding(db: Queryable, input: { spaceId: string; ownerUserId: string; runId: string; actionId: string; resourceId: string | null }) {
  const { coreDataTool } = await import("../plugins/coreDataTools.js");
  const core = coreDataTool(input.actionId);
  if (!core) return null;
  const target = await core.consentTarget(db, { spaceId: input.spaceId, ownerUserId: input.ownerUserId, runId: input.runId, bindingId: input.resourceId });
  return { owner_user_id: input.ownerUserId, project_id: target.projectId, binding_id: target.bindingId, generation: target.generation, purpose: target.purpose };
}

export async function classifyRequestableDecision(
  decision: DecisionRow,
  config?:ServerConfig,
): Promise<{ actionId: string; kind: "action_grant" | "plugin_data" } | null> {
  // A missing data-side consent (ADR 0030); an ineligible scenario is a different, non-requestable rule.
  if (decision.policy_rule_id === "plugin_data_consent_required" && decision.policy_source !== "hard_invariant") {
    const meta = pluginToolMeta(config, decision.action);
    return meta && meta.pin.data_class !== "non_sensitive" ? { actionId: decision.action, kind: "plugin_data" } : null;
  }
  if (
    decision.policy_source === "hard_invariant"
    || decision.policy_rule_id !== "managed_system_action_grant_required"
  ) return null;
  const metadataActionId = stringValue(decision.metadata_json?.action_id)
    ?? stringValue(decision.metadata_json?.tool_name);
  if (
    !metadataActionId
    || decision.metadata_json?.surface !== "managed_run_system_action_gateway"
  ) return null;
  const { loadSystemActionRegistry } = await import("../systemActions/registry.js");
  const definition = [...(await loadSystemActionRegistry(config)).values()].find(
    (candidate) =>
      candidate.grantable
      && candidate.policy_action === decision.action
      && candidate.id === metadataActionId,
  );
  return definition ? { actionId: definition.id, kind: "action_grant" } : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
