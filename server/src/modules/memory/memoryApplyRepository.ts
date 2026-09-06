/**
 * Memory proposal appliers.
 *
 * Durable apply logic for memory_create / memory_update / memory_archive
 * proposals. These run the durable active-memory
 * writes for accepted memory proposals: INSERT/UPDATE `memory_entries`, write
 * `provenance_links`, and record `memory_relations` supersedes edges.
 *
 * Scope: the per-type write business logic. The cross-cutting accept
 * orchestration, source-monitoring enforcement, personal-memory egress guard,
 * digest invalidation, and proposal accept state machine live in the proposal
 * apply service.
 */

import { randomUUID } from "node:crypto";
import {
  copyProvenanceToMemory,
  dominantSourceTrust,
  userConfirmationEntry,
  mergeDistinctProvenanceEntries,
  proposalProvenanceEntry,
  recordMemorySupersedesRelation,
  writeProvenanceLinks,
  TARGET_MEMORY,
  type Queryable,
} from "./memoryApplyProvenance.js";
import { AGENT_DIRECT_WRITE_FALLBACK } from "./proposalRepository.js";
import {
  evaluateMemoryProposal,
  monitoringSnapshot,
  provenanceEntriesFromPayload,
  type ProvenanceEntry,
} from "./sourceMonitoring.js";
import { recordDomainWorkEvent } from "../projectWork/domainWorkEvents.js";
import { withQueryableTransaction } from "../routeUtils/common.js";
import { RetrievalProjectionService } from "../retrieval/index.js";
import { memoryRetrievalRegistry } from "./retrievalAdapter.js";
import { assertProjectInSpace } from "../projects/access.js";
import { isContentAccessLevel, isContentVisibility } from "../access/contentAccessTypes.js";
import { recordAgentPersonaRevisionPointer } from "../activity/notificationPointers.js";

// The memory retrieval projection is a derived index. A projection failure must
// not roll back an accepted canonical memory write, but the reindex runs inside
// the apply transaction, so a thrown query would otherwise abort it. We isolate
// the reindex in a SAVEPOINT: on failure we roll back only the projection work
// and let the canonical apply commit. Mirrors the Knowledge apply hook.
async function reindexMemoryWithinApply(
  db: Queryable,
  spaceId: string,
  memoryIds: readonly string[],
): Promise<void> {
  await db.query("SAVEPOINT memory_retrieval_reindex");
  try {
    const projection = new RetrievalProjectionService(db, memoryRetrievalRegistry);
    for (const memoryId of memoryIds) {
      await projection.reindex(spaceId, "memory_entry", memoryId);
    }
    await db.query("RELEASE SAVEPOINT memory_retrieval_reindex");
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT memory_retrieval_reindex").catch(() => undefined);
    await db.query("RELEASE SAVEPOINT memory_retrieval_reindex").catch(() => undefined);
    process.stderr.write(
      `[memory.retrieval] reindex failed during proposal apply: ${String((error as Error)?.message ?? error)}\n`,
    );
  }
}

export class MemoryApplyError extends Error {
  readonly statusCode = 422;
}

/** Raised when a memory proposal needs a grant-derived egress apply capability
 * the server authority does not serve. Fails closed so it is never applied by
 * the ordinary Memory path. */
/**
 * A memory write an Agent may not make directly because it would change who
 * can see the memory, whose it is, or replace what a person wrote
 * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §1).
 *
 * The executor turns this into a proposal rather than a failure: the Agent
 * still gets to record what it learned, the person still decides anything
 * that widens reach.
 */
export class MemoryReachError extends Error {
  readonly code = "memory_reach_requires_proposal";
  constructor(readonly detail: string) {
    super(`This memory write changes reach and needs a person: ${detail}`);
    this.name = "MemoryReachError";
  }
}

export class MemoryApplyUnsupportedError extends Error {
  readonly statusCode = 409;
}

const MEMORY_APPLY_TYPES = new Set(["memory_create", "memory_update", "memory_archive"]);

const OWNER_SCOPED_VISIBILITIES = new Set(["private", "selected_users"]);

// Payload markers that make a proposal grant-derived, plus any run context
// that requires the separate egress-context apply path.
const GRANT_DERIVED_MARKERS = [
  "personal_context_derived",
  "egress_guard_required",
  "derived_from_personal_memory",
  "raw_private_memory_included",
  "personal_summary_persisted",
  "grant_id",
  "personal_memory_grant_ids",
] as const;

/** The active entry a direct revision replaces, plus who wrote it. */
export type DirectWriteTarget = AppliedMemoryRow & { created_by: string };

export interface DirectWriteInput {
  spaceId: string;
  actingUserId: string;
  agentId: string;
  runId: string;
  sessionId: string | null;
  projectId: string | null;
  command: Record<string, unknown>;
  /** Present for a revision. */
  target?: DirectWriteTarget | null;
  /** What the `agent` scope needs, resolved by the caller once per Run. */
  agentScope?: AgentWriteContext;
}

/**
 * The facts an agent-scope write is judged against, none of which come from
 * the prompt.
 *
 * `triggerOrigin` and `instructedByUserId` are the Run's own columns and decide
 * a persona write (ADR 0003 §5); `ownerUserId` is `agents.owner_user_id`, the
 * person a persona proposal is for and the person an agent-scope entry belongs
 * to. `roomId` is the Room this Run is speaking in, which becomes a note's
 * origin Room — null in a direct chat, where the audience is the owner alone.
 */
export interface AgentWriteContext {
  ownerUserId: string | null;
  /**
   * The **effective** origin — a delegated Run's root's, the same value the
   * policy gate uses. Reading the raw column instead would make one hop of
   * `agent.delegate` a prompt-reachable route around §5: the delegated Run
   * would be `delegation` here and attended there, so a person's turn could
   * apply a persona change directly by asking another Agent to ask.
   */
  triggerOrigin: string | null;
  instructedByUserId: string | null;
  roomId: string | null;
  /** Whether this Agent already has an active persona; a second is refused. */
  activePersonaExists?: boolean;
}

/**
 * The `memory_type` values that mean "this is the Agent's own", from ADR 0003
 * §4. Three note kinds plus the persona; the scope follows from the type
 * rather than from a second field the model would have to keep consistent
 * with it.
 */
export const AGENT_SCOPE_MEMORY_TYPES = new Set(["note", "decision", "lesson", "persona"]);
export const PERSONA_MEMORY_TYPE = "persona";

/**
 * What a persona write needs before it can be applied, decided from the Run's
 * trigger rather than from anything the turn said. `proposal_owner` and
 * `proposal_in_turn` are refusals the executor turns into the right kind of
 * proposal; `apply` is the unattended case ADR 0003 §5 lets through.
 */
export type PersonaDecision = "apply" | "proposal_in_turn" | "proposal_owner";

export function decidePersonaWrite(context: AgentWriteContext): PersonaDecision {
  // Not `manual` — an Agent concluding something about itself outside anyone's
  // turn. The notification and the one-step restore are what stand in for a
  // decision here, and ADR 0017 §1/§2 name this as their one exception.
  if (context.triggerOrigin !== "manual") return "apply";
  // A person in a turn asking for a change is exactly the input that must not
  // carry this reach: a persona is delivered in every Room the Agent sits in.
  // The owner decides in the turn; anyone else's request waits for the owner,
  // who is the only person who may accept it.
  return context.instructedByUserId && context.instructedByUserId === context.ownerUserId
    ? "proposal_in_turn"
    : "proposal_owner";
}

export interface ApplyProposal {
  id: string;
  space_id: string;
  proposal_type: string;
  status?: string;
  risk_level?: string | null;
  preview?: boolean;
  title: string | null;
  payload_json: Record<string, unknown> | null;
  project_folder_id: string | null;
  visibility?: string | null;
  created_by_user_id: string | null;
  owner_user_id?: string | null;
  created_by_agent_id?: string | null;
  created_by_run_id?: string | null;
  project_id: string | null;
  required_approver_role?: string | null;
}

export interface MemoryAcceptResult {
  memoryId: string;
  supersededMemoryId: string | null;
  payloadJson: Record<string, unknown>;
  scopeType: string;
  agentId: string | null;
}

export interface AppliedMemoryRow {
  id: string;
  space_id: string;
  scope_type: string;
  namespace: string | null;
  memory_type: string;
  title: string | null;
  content: string;
  status: string;
  visibility: string;
  access_level: string;
  sensitivity_level: string;
  owner_user_id: string | null;
  subject_user_id: string | null;
  project_id: string | null;
  source_trust: string | null;
  root_memory_id: string | null;
  supersedes_memory_id: string | null;
  memory_layer: string | null;
  version: number;
  agent_id: string | null;
  origin_room_id: string | null;
}

export interface MemoryApplyResult {
  memory: AppliedMemoryRow;
  supersededMemoryId: string | null;
}

const INSERT_COLUMNS = `id, space_id, scope_type, memory_type, content, status,
  created_at, updated_at, subject_user_id, owner_user_id,
  sensitivity_level, access_level, last_confirmed_at, namespace,
  title, visibility, confidence, importance, source_id,
  created_by, approved_by, version, access_count, tags, memory_layer,
  created_from_proposal_id, root_memory_id, supersedes_memory_id, source_trust, agent_id,
  project_id, origin_room_id`;

const RETURNING_COLUMNS = `id, space_id, scope_type, namespace, memory_type, title,
  content, status, visibility, access_level, sensitivity_level, owner_user_id, subject_user_id,
  project_id, source_trust,
  root_memory_id, supersedes_memory_id, memory_layer, version, agent_id, origin_room_id`;

/** Columns + values needed for one new active memory version. */
interface NewMemoryFields {
  scope: string;
  memoryType: string;
  content: string;
  visibility: string;
  accessLevel: string;
  sensitivity: string;
  namespace: string;
  title: string;
  ownerUserId: string | null;
  subjectUserId: string | null;
  projectId: string | null;
  agentId: string | null;
  /** The Room an agent-scope note was learned in; null everywhere else. */
  originRoomId?: string | null;
  memoryLayer: string | null;
  sourceTrust: string | null;
  rootMemoryId: string | null;
  supersedesMemoryId: string | null;
  createdBy: string;
  /** Null for a bounded direct write: nobody approved it in advance. */
  approvedBy: string | null;
  /** Null for a direct write — there was no proposal (ADR 0003 §2). */
  createdFromProposalId?: string | null;
  /**
   * Where this row sits in its chain. Every insert wrote a literal 1 before,
   * so a three-version memory read "v1, v1, v1" wherever the chain is shown —
   * which is most of what makes a superseded version identifiable.
   */
  version?: number;
}

export class PgMemoryApplyRepository {
  constructor(private readonly db: Queryable) {}

  static supportsType(proposalType: string): boolean {
    return MEMORY_APPLY_TYPES.has(proposalType);
  }

  /**
   * Apply a memory proposal without marking it accepted.
   *
   * The caller (proposal apply service) owns the single proposal status update
   * so the accept state machine has one writer. Runs inside the caller's
   * BEGIN/COMMIT. accept_context is fixed to `explicit_user_accept`.
   *
   * Fails closed (`MemoryApplyUnsupportedError`) for grant-derived cross-space
   * egress context; same-space run proposals are allowed.
   */
  async applyOnly(
    proposal: ApplyProposal,
    userId: string,
  ): Promise<MemoryAcceptResult & { finalPayload: Record<string, unknown> }> {
    if (!MEMORY_APPLY_TYPES.has(proposal.proposal_type)) {
      throw new MemoryApplyError(`unsupported proposal type: ${proposal.proposal_type}`);
    }
    this.assertNoEgressContext(proposal);

    const acceptContext = "explicit_user_accept";
    let payload: Record<string, unknown> = { ...(proposal.payload_json ?? {}) };
    // An Agent's own write that had to become a proposal (ADR 0003 §1)
    // carries only agent-inferred provenance, and the source-monitoring gate
    // refuses that as the sole basis for an active semantic memory. The thing
    // the gate is asking for is a person's confirmation, and accepting the
    // proposal *is* one — it simply was not written down anywhere the gate
    // could see. Recorded here, where the accept happens, rather than at
    // creation, where it would be a claim about something the person had not
    // yet done.
    //
    // Keyed on the fallback marker, not on "an Agent authored this": every
    // other agent-authored memory proposal carries its own provenance and
    // must keep facing the gate on that provenance's merits.
    if (payload[AGENT_DIRECT_WRITE_FALLBACK] === true) {
      payload = {
        ...payload,
        provenance_entries: mergeDistinctProvenanceEntries(
          provenanceEntriesFromPayload(payload),
          [userConfirmationEntry(userId, { action: "accept_memory_proposal", proposal_id: proposal.id })],
        ),
      };
    }

    const outcome = evaluateMemoryProposal({
      proposalType: proposal.proposal_type,
      payload,
      acceptContext,
    });
    if (outcome.action === "reject") throw new MemoryApplyError(outcome.message);
    if (outcome.action === "require_review") {
      payload = {
        ...payload,
        source_monitoring_result: {
          ...monitoringSnapshot(outcome),
          explicit_approval_context: acceptContext,
        },
      };
    }

    const result = await this.applyByType({ ...proposal, payload_json: payload }, userId);

    // Best-effort derived retrieval reindex. Runs inside the caller's transaction;
    // SAVEPOINT-isolated so a projection failure never rolls back the canonical write.
    const reindexIds = result.supersededMemoryId
      ? [result.memory.id, result.supersededMemoryId]
      : [result.memory.id];
    await reindexMemoryWithinApply(this.db, proposal.space_id, reindexIds);

    const finalPayload: Record<string, unknown> = { ...payload, resulting_memory_id: result.memory.id };
    return {
      memoryId: result.memory.id,
      supersededMemoryId: result.supersededMemoryId,
      payloadJson: finalPayload,
      finalPayload,
      scopeType: result.memory.scope_type,
      agentId: result.memory.agent_id,
    };
  }

  private async applyByType(proposal: ApplyProposal, userId: string): Promise<MemoryApplyResult> {
    switch (proposal.proposal_type) {
      case "memory_create":
        return this.applyCreate(proposal, userId);
      case "memory_update":
        return this.applyUpdate(proposal, userId);
      case "memory_archive":
        return this.applyArchive(proposal, userId);
      default:
        throw new MemoryApplyError(`unsupported proposal type: ${proposal.proposal_type}`);
    }
  }

  private assertNoEgressContext(proposal: ApplyProposal): void {
    const payload = proposal.payload_json ?? {};
    // Same-space run proposals (created_by_run_id / source_run_id) are allowed.
    // Only reject proposals that carry grant-derived cross-space egress markers.
    for (const marker of GRANT_DERIVED_MARKERS) {
      if (payload[marker]) {
        throw new MemoryApplyUnsupportedError(
          "grant-derived memory proposals are not served by the server authority yet",
        );
      }
    }
  }


  /** Apply a memory_create proposal: one new active memory + provenance. */
  async applyCreate(proposal: ApplyProposal, userId: string): Promise<MemoryApplyResult> {
    const payload = proposal.payload_json ?? {};
    const explicitVisibility = strOr(payload.target_visibility) ?? strOr(payload.visibility);
    const vis = lower(explicitVisibility ?? "private");
    const accessLevel = lower(strOr(payload.target_access_level) ?? strOr(payload.access_level) ?? "full");
    const sens = lower(strOr(payload.sensitivity_level) ?? "normal");
    assertContentPolicyFields(vis, accessLevel, sens);
    const content = strOr(payload.proposed_content) ?? strOr(payload.content) ?? "";
    const memType = strOr(payload.memory_type) ?? "semantic";
    const scope = memoryScope(strOr(payload.target_scope) ?? strOr(payload.scope_type) ?? "user");
    const namespace = strOr(payload.target_namespace) ?? strOr(payload.namespace) ?? "user.default";

    const acting = String(proposal.created_by_user_id ?? userId);
    const entries = provenanceEntriesFromPayload(payload);
    const ownerUserId = this.resolveOwner(strOr(payload.owner_user_id), vis, acting);
    const projectId = scope === "agent" ? null : await this.resolveProjectId(proposal, payload, null);
    assertMemoryPlacement(scope, vis, ownerUserId, projectId);

    const memId = await this.insertMemory(proposal, {
      scope,
      memoryType: memType,
      content,
      visibility: vis,
      accessLevel,
      sensitivity: sens,
      namespace,
      title: proposal.title ?? "",
      ownerUserId,
      subjectUserId: strOr(payload.subject_user_id),
      projectId,
      // For the `agent` scope the payload names the owning Agent, which is
      // more than provenance there; everywhere else the producing Agent is
      // whoever created the proposal.
      agentId: (scope === "agent" ? strOr(payload.agent_id) : null) ?? proposal.created_by_agent_id ?? null,
      originRoomId: scope === "agent" ? strOr(payload.origin_room_id) : null,
      memoryLayer: memoryLayer(payload),
      sourceTrust: dominantSourceTrust(entries),
      rootMemoryId: null,
      supersedesMemoryId: null,
      // An agent-scope entry the Agent drafted stays authored by the Agent
      // even when a person accepted it: `approved_by` records the accept, and
      // `created_by` is what `applyDirect` reads to decide whether the Agent
      // may revise its own entry later. Writing the approver's id here made
      // one accepted persona proposal turn the whole chain proposal-only
      // forever — ADR 0003 §5's third row could never fire again.
      createdBy: scope === "agent" && proposal.created_by_agent_id
        ? `agent:${proposal.created_by_agent_id}`
        : String(proposal.created_by_user_id ?? userId),
      approvedBy: String(userId),
    });

    const linkEntries = [
      ...entries,
      proposalProvenanceEntry(proposal.id, { proposal_type: proposal.proposal_type }),
    ];
    await writeProvenanceLinks(this.db, {
      spaceId: proposal.space_id,
      targetType: TARGET_MEMORY,
      targetId: memId.id,
      entries: linkEntries,
    });
    return {
      memory: memId,
      supersededMemoryId: null,
    };
  }

  /** Apply a memory_update proposal: new version row, supersede the old. */
  async applyUpdate(proposal: ApplyProposal, userId: string): Promise<MemoryApplyResult> {
    const payload = proposal.payload_json ?? {};
    const targetId = strOr(payload.target_memory_id);
    if (!targetId) {
      throw new MemoryApplyError("memory_update proposal is missing target_memory_id in payload");
    }
    const old = await this.getActive(targetId, proposal.space_id);
    if (!old) {
      throw new MemoryApplyError(
        `target memory '${targetId}' not found or not active in space '${proposal.space_id}'`,
      );
    }

    const vis = lower(
      strOr(payload.target_visibility) ?? strOr(payload.visibility) ?? old.visibility,
    );
    const sens = lower(strOr(payload.sensitivity_level) ?? old.sensitivity_level ?? "normal");
    const accessLevel = lower(
      strOr(payload.target_access_level) ?? strOr(payload.access_level) ?? old.access_level ?? "full",
    );
    assertContentPolicyFields(vis, accessLevel, sens);
    const content = strOr(payload.proposed_content) ?? strOr(payload.content) ?? old.content;
    const title = strOr(payload.proposed_title) ?? strOr(payload.title) ?? old.title ?? "";
    const scope = memoryScope(strOr(payload.target_scope) ?? old.scope_type);
    const namespace = strOr(payload.target_namespace) ?? old.namespace ?? "user.default";
    const memType = strOr(payload.memory_type) ?? old.memory_type;
    const rootId = old.root_memory_id ?? old.id;

    const entries = provenanceEntriesFromPayload(payload);
    const ownerUserId = this.resolveOwner(
      strOr(payload.owner_user_id) ?? old.owner_user_id,
      vis,
      userId,
    );
    const projectId = scope === "agent" ? null : await this.resolveProjectId(proposal, payload, old.project_id);
    assertMemoryPlacement(scope, vis, ownerUserId, projectId);

    // Same order as the direct path, and for the same reason: the head steps
    // down before its replacement is inserted, or the partial unique index on
    // an active persona refuses the new one.
    await this.markStatus(old.id, proposal.space_id, "superseded");
    const newMem = await this.insertMemory(proposal, {
      scope,
      memoryType: memType,
      content,
      visibility: vis,
      accessLevel,
      sensitivity: sens,
      namespace,
      title,
      ownerUserId,
      subjectUserId: strOr(payload.subject_user_id) ?? old.subject_user_id,
      projectId,
      // An agent-scope entry stays the Agent's it was written for: the
      // revision keeps `old.agent_id`, whatever the payload or the proposer
      // carried, so the version chain never crosses from one Agent to another.
      agentId: scope === "agent" ? old.agent_id : (proposal.created_by_agent_id ?? null),
      // A revision keeps the Room the note was learned in: the audience that
      // may receive it is a fact about where it came from, not about who
      // revised it.
      originRoomId: scope === "agent" ? (strOr(payload.origin_room_id) ?? old.origin_room_id) : null,
      memoryLayer: memoryLayer(payload) ?? old.memory_layer,
      sourceTrust: dominantSourceTrust(entries) ?? old.source_trust,
      rootMemoryId: rootId,
      supersedesMemoryId: old.id,
      version: Number(old.version ?? 1) + 1,
      createdBy: scope === "agent" && proposal.created_by_agent_id
        ? `agent:${old.agent_id}`
        : String(proposal.created_by_user_id ?? userId),
      approvedBy: String(userId),
    });

    await copyProvenanceToMemory(this.db, {
      spaceId: proposal.space_id,
      fromMemoryId: old.id,
      toMemoryId: newMem.id,
    });

    // Add payload provenance + the proposal entry, deduped against the copied set.
    const existing = await this.provenanceKeys(proposal.space_id, newMem.id);
    const toAdd: ProvenanceEntry[] = [];
    for (const e of provenanceEntriesFromPayload(payload)) {
      const k = provKey(e);
      if (k && !existing.has(k)) {
        toAdd.push(e);
        existing.add(k);
      }
    }
    const propEntry = proposalProvenanceEntry(proposal.id, { proposal_type: "memory_update" });
    const pk = provKey(propEntry);
    if (pk && !existing.has(pk)) toAdd.push(propEntry);
    if (toAdd.length > 0) {
      await writeProvenanceLinks(this.db, {
        spaceId: proposal.space_id,
        targetType: TARGET_MEMORY,
        targetId: newMem.id,
        entries: toAdd,
      });
    }

    await recordMemorySupersedesRelation(this.db, {
      spaceId: proposal.space_id,
      newMemoryId: newMem.id,
      oldMemoryId: old.id,
      proposalId: proposal.id,
    });
    return {
      memory: newMem,
      supersededMemoryId: old.id,
    };
  }

  /** Apply a memory_archive proposal: mark the target archived (soft delete). */
  async applyArchive(proposal: ApplyProposal, _userId: string): Promise<MemoryApplyResult> {
    const payload = proposal.payload_json ?? {};
    const targetId = strOr(payload.target_memory_id);
    if (!targetId) {
      throw new MemoryApplyError("memory_archive proposal is missing target_memory_id in payload");
    }
    const mem = await this.getActive(targetId, proposal.space_id);
    if (!mem) {
      throw new MemoryApplyError(
        `target memory '${targetId}' not found or not active in space '${proposal.space_id}'`,
      );
    }

    const archived = await this.markStatus(mem.id, proposal.space_id, "archived");

    const entries = mergeDistinctProvenanceEntries(provenanceEntriesFromPayload(payload), [
      proposalProvenanceEntry(proposal.id, {
        action: "memory_archive",
        proposal_type: "memory_archive",
      }),
    ]);
    if (entries.length > 0) {
      await writeProvenanceLinks(this.db, {
        spaceId: proposal.space_id,
        targetType: TARGET_MEMORY,
        targetId: mem.id,
        entries,
      });
    }
    return {
      memory: archived ?? mem,
      supersededMemoryId: null,
    };
  }

  /**
   * An Agent's own bounded memory write
   * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §2).
   *
   * It goes through this repository because the applier stays the only writer
   * of `memory_entries` — what changes is the authority, not the path. The row
   * records that an Agent wrote it (`created_by = agent:<id>`), that nobody
   * approved it (`approved_by = null`, rather than the false record naming a
   * person who never saw it) and that no proposal produced it. A revision is
   * always a new version, so the previous one survives and one action restores
   * it.
   *
   * Refuses anything that changes reach; the caller turns that refusal into a
   * proposal.
   */
  async applyDirect(input: DirectWriteInput): Promise<MemoryApplyResult> {
    const command = input.command;
    const rationale = strOr(command.rationale);
    if (!rationale) {
      throw new MemoryApplyError("a direct memory write must carry the rationale for writing it");
    }
    const old = input.target ?? null;
    // Which scope this write lands in follows from its type: the three note
    // kinds and the persona are the Agent's own (ADR 0003 §4), everything else
    // is about the person in the turn. A revision keeps the scope it is
    // revising, so an Agent cannot move an entry between the two.
    const memoryType = strOr(command.memory_type) ?? old?.memory_type ?? "semantic";
    const scope: MemoryScope = old
      ? memoryScope(old.scope_type)
      : (AGENT_SCOPE_MEMORY_TYPES.has(memoryType) ? "agent" : "user");
    // ADR 0003 §1: the four things that change reach. A revision inherits the
    // target's fields, so revising an entry that is already wider than private
    // is itself a reach-changing write.
    const visibility = lower(strOr(command.visibility) ?? old?.visibility ?? "private");
    const sensitivity = lower(strOr(command.sensitivity_level) ?? old?.sensitivity_level ?? "normal");
    if (visibility !== "private") throw new MemoryReachError(`its visibility is '${visibility}'`);
    if (sensitivity !== "normal") throw new MemoryReachError(`its sensitivity is '${sensitivity}'`);
    if (scope === "agent" && old && old.agent_id !== input.agentId) {
      // Not a reach question a proposal can settle: another Agent's own memory
      // is not this Agent's to revise under any approval, and a version chain
      // that crossed from one Agent to another would claim a continuity that
      // never happened — and could leave the first with no persona at all.
      throw new MemoryApplyError("that is another Agent's own memory, not yours to revise");
    }
    const agentWrite = scope === "agent" ? this.resolveAgentWrite(input, memoryType, old) : null;
    // No subject comes from the command: the tool schemas have no such field,
    // so an Agent cannot aim a write at another person by any route. What is
    // checked is the subject a revision inherits. An agent-scope entry is
    // about the Agent, so it has no subject at all.
    const subjectUserId = scope === "agent" ? null : (old?.subject_user_id ?? input.actingUserId);
    if (scope !== "agent" && subjectUserId !== input.actingUserId) {
      throw new MemoryReachError("it is about another person");
    }
    if (old && old.created_by !== `agent:${input.agentId}`) {
      // Not "an Agent wrote it" but "this Agent wrote it", which is what ADR
      // 0003 §2 and the tool's own description say. Another Agent's entry is
      // someone else's record of the same person, and overwriting it silently
      // would make the version chain claim a continuity that never happened.
      throw new MemoryReachError(
        old.created_by.startsWith("agent:")
          ? "it replaces what another Agent wrote"
          : "it replaces something a person wrote",
      );
    }

    const entries: ProvenanceEntry[] = [{
      source_type: "run",
      source_id: input.runId,
      // What it is: the Agent inferred this. Recorded rather than left null,
      // so a reader weighing a memory sees the same scale whether the write
      // went straight in or through a proposal.
      source_trust: "agent_inferred",
      evidence_json: {
        rationale,
        // Carried here rather than in a `session` provenance type: the
        // registry owns that vocabulary (B12F) and a session is not one of
        // its source entities. The circuit breaker counts on this field.
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
      },
    }];
    const proposalShape: ApplyProposal = {
      id: randomUUID(),
      space_id: input.spaceId,
      proposal_type: old ? "memory_update" : "memory_create",
      title: null,
      payload_json: null,
      project_folder_id: null,
      created_by_user_id: input.actingUserId,
      project_id: input.projectId,
    };
    // The version it replaces steps down first. Two versions of one chain must
    // never be active together anyway (§2), and for a persona the database says
    // so directly — `uq_memory_entries_active_persona` refuses the new head
    // while the old one still stands. Both statements are in one transaction,
    // so a failed insert leaves the old one active.
    if (old) await this.markStatus(old.id, input.spaceId, "superseded");
    const memory = await this.insertMemory(proposalShape, {
      scope,
      memoryType,
      content: strOr(command.content) ?? old?.content ?? "",
      visibility,
      accessLevel: lower(old?.access_level ?? "full"),
      sensitivity,
      namespace: old?.namespace ?? (scope === "agent" ? "agent.default" : "user.default"),
      title: strOr(command.title) ?? old?.title ?? "",
      ownerUserId: agentWrite ? agentWrite.ownerUserId : input.actingUserId,
      subjectUserId,
      originRoomId: agentWrite ? agentWrite.originRoomId : null,
      // User-scoped and unattached to the Project, even when a Project run
      // wrote it: what an Agent learns about the person is the person's, and
      // `ck_memory_entries_scope_placement` says a user-scoped entry carries
      // no Project. The Project still sees the write — the work event carries
      // the Project, the entry does not.
      projectId: old ? old.project_id : null,
      agentId: input.agentId,
      memoryLayer: memoryLayer(command) ?? old?.memory_layer ?? null,
      sourceTrust: dominantSourceTrust(entries) ?? old?.source_trust ?? null,
      rootMemoryId: old ? (old.root_memory_id ?? old.id) : null,
      supersedesMemoryId: old?.id ?? null,
      version: old ? Number(old.version ?? 1) + 1 : 1,
      createdBy: `agent:${input.agentId}`,
      approvedBy: null,
      createdFromProposalId: null,
    });
    await writeProvenanceLinks(this.db, {
      spaceId: input.spaceId,
      targetType: TARGET_MEMORY,
      targetId: memory.id,
      entries,
    });
    // The person's side of the bargain: what the Agent chose to remember is
    // in the Project's updates, with one action to take it back. A persona
    // write without a Project gets a private Inbox pointer to the same Memory
    // review/revert surface.
    const occurredAt = new Date().toISOString();
    if (input.projectId) {
      // A persona applied with nobody in the turn is the one write ADR 0003 §5
      // lets through unasked, and §3 makes that conditional on the owner
      // seeing it and being able to put the previous version back in one
      // action. That is what this row is: attributed to the Agent's **owner**,
      // because they are who it belongs to and who can reverse it, not to a
      // person in a turn there was none of.
      // Only a **revision** is `agent.persona_revised`: its undo is "put the
      // previous version back", and a first persona has none — offering that
      // button on a create is a control that can only refuse. The first one is
      // an ordinary remembering, archived like any other.
      const personaRevision = scope === "agent" && memoryType === PERSONA_MEMORY_TYPE && old !== null;
      await recordDomainWorkEvent(this.db, {
        spaceId: input.spaceId,
        projectId: input.projectId,
        subjectType: "memory_entry",
        subjectId: memory.id,
        // Attributed to the Agent — `recordDomainWorkEvent` resolves the actor
        // from the provenance below, and the Agent is who wrote it. The owner
        // is who the row is *for*, which the read model's ownership join
        // already decides.
        userId: input.actingUserId,
        eventKind: personaRevision
          ? "agent.persona_revised"
          : old ? "memory.revised" : "memory.remembered",
        occurredAt,
        idempotencySuffix: input.runId,
        data: {
          // A persona revision shows both sides, so both have to be the same
          // kind of thing — the text itself, not a title against a body.
          // `memory.revise` carries no title at all, so preferring one would
          // put the old entry's title opposite the new entry's content and
          // read as a change that did not happen.
          summary: personaRevision ? truncate(memory.content) : strOr(command.title) ?? truncate(memory.content),
          rationale,
          // What it replaced, so the owner can weigh the change without
          // leaving the feed for the version chain.
          ...(personaRevision ? { previous_summary: truncate(old.content) } : {}),
          ...(personaRevision ? { restores_memory_id: old.id } : {}),
        },
        provenance: { runId: input.runId, agentId: input.agentId },
      });
    } else if (scope === "agent" && memoryType === PERSONA_MEMORY_TYPE) {
      await recordAgentPersonaRevisionPointer(this.db, {
        spaceId: input.spaceId,
        ownerUserId: agentWrite!.ownerUserId,
        agentId: input.agentId,
        memoryId: memory.id,
        runId: input.runId,
        revision: old !== null,
        occurredAt,
      });
    }
    if (!old) return { memory, supersededMemoryId: null };

    // Deliberately not copying the previous version's provenance forward.
    // Each version keeps the rationale of the write that produced it, which
    // is what makes "why did this change" answerable; the older reason stays
    // readable on the older version, where it is true.
    await recordMemorySupersedesRelation(this.db, {
      spaceId: input.spaceId,
      newMemoryId: memory.id,
      oldMemoryId: old.id,
      proposalId: null,
    });
    await reindexMemoryWithinApply(this.db, input.spaceId, [memory.id, old.id]);
    return { memory, supersededMemoryId: old.id };
  }

  /**
   * The bounds an agent-scope write has on top of §2's, all read from the Run
   * and the Agent rather than from the turn
   * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §4,
   * §5). A refusal here is a `MemoryReachError`, which the executor turns into
   * the right kind of proposal rather than an error the Agent has to interpret.
   */
  private resolveAgentWrite(
    input: DirectWriteInput,
    memoryType: string,
    old: DirectWriteTarget | null,
  ): { ownerUserId: string; originRoomId: string | null } {
    const context = input.agentScope;
    if (!context) {
      throw new MemoryApplyError("an agent-scope memory write must carry the Run's trigger and the Agent's owner");
    }
    // An Agent with no owner has no `agent` scope: a private entry with no
    // owner cannot be stored at all, and §5's table cannot be evaluated
    // without one. The Space and Project Assistants are `space_shared` and
    // ownerless, and their writes stay in the `user` scope they use today.
    if (!context.ownerUserId) {
      throw new MemoryApplyError(
        "this Agent has no owner, so it has no memory of its own; record this about the person instead",
      );
    }
    if (memoryType === PERSONA_MEMORY_TYPE) {
      const decision = decidePersonaWrite(context);
      if (!old && context.activePersonaExists) {
        throw new MemoryApplyError(
          "you already have a persona; revise it with memory.revise instead of writing a second one",
        );
      }
      if (decision !== "apply") {
        throw new MemoryReachError(
          decision === "proposal_in_turn"
            ? "changing what you have become is the owner's decision, not something a turn applies"
            : "only this Agent's owner can change what it has become",
        );
      }
      // Delivered in every Room, so it has no origin Room to be filtered by.
      return { ownerUserId: context.ownerUserId, originRoomId: null };
    }
    // A note carries the Room it was learned in. Without one the conversation
    // is a direct chat, whose audience is the owner alone — so the acting
    // person has to be that owner, or the note would be learned from someone
    // whose conversation the owner never saw.
    const originRoomId = old ? old.origin_room_id : context.roomId;
    if (!originRoomId && input.actingUserId !== context.ownerUserId) {
      throw new MemoryReachError("it was learned outside any Room, from someone who is not this Agent's owner");
    }
    // A revision must happen where the note was learned. The audience filter
    // guards delivery; without this the write path walks straight past it —
    // a turn in a narrow Room revising a note whose origin Room is a wide one
    // puts this Room's content in front of that Room's audience, keeping an
    // `origin_room_id` that now says something false about where it came from.
    if (old && originRoomId !== context.roomId) {
      throw new MemoryReachError(
        "it was learned somewhere else, and revising it here would carry this conversation into that audience",
      );
    }
    return { ownerUserId: context.ownerUserId, originRoomId };
  }

  /**
   * A person archiving or restoring their own memory
   * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §3).
   *
   * The owner deciding what their own memory holds needs no approval from
   * anyone — the proposal that used to stand here was the person queueing a
   * request to themselves. Someone else's entry keeps the proposal route.
   *
   * Returns null when the entry is not the caller's, so the route can fall
   * back rather than reporting a memory they may not know exists.
   */
  async setOwnStatus(
    spaceId: string,
    userId: string,
    memoryId: string,
    status: "archived" | "active",
  ): Promise<AppliedMemoryRow | null> {
    // Called straight from a route on a pool, so it opens its own transaction
    // — the retrieval reindex runs in a SAVEPOINT and there would be nothing
    // to save a point in. Nesting-aware, so an apply path already inside one
    // joins it rather than opening a second.
    return withQueryableTransaction(this.db, (tx) => this.setOwnStatusLocked(tx, spaceId, userId, memoryId, status));
  }

  private async setOwnStatusLocked(
    db: Queryable,
    spaceId: string,
    userId: string,
    memoryId: string,
    status: "archived" | "active",
  ): Promise<AppliedMemoryRow | null> {
    // Ownership, and only ownership. Authorship was considered as a stand-in
    // for the ownerless case — a `space_shared` entry has no owner — and
    // rejected: those are exactly the entries other people read, so removing
    // one changes what a Space knows and belongs on the proposal path with
    // every other reach change. ADR 0003 §3 is about a person's own memory.
    const owned = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM memory_entries
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL AND owner_user_id = $3`,
      [memoryId, spaceId, userId],
    );
    const found = owned.rows[0];
    if (!found) return null;
    if (status === "archived") {
      if (found.status !== "active") {
        throw new MemoryApplyError(`this memory is ${found.status}, so it cannot be archived`);
      }
    } else if (found.status !== "archived" && found.status !== "superseded") {
      throw new MemoryApplyError(`this memory is ${found.status}, so it cannot be restored`);
    } else {
      // Restoring the version a revision replaced — which is what ADR 0003 §2
      // means by "one action restores it", once the newer head has been
      // archived. Refused while a newer version still stands, because the head
      // is what every reader resolves and two active rows on one chain have no
      // answer to "which one is it".
      //
      // Checked for an archived row too, not only a superseded one: archive
      // the head, restore the version it replaced, then restore the head, and
      // the chain has two live rows by a route that skipped the check.
      const head = await db.query<{ id: string }>(
        `SELECT e.id FROM memory_entries e
           JOIN memory_entries target ON target.id = $1 AND target.space_id = e.space_id
          WHERE e.space_id = $2 AND e.status = 'active' AND e.deleted_at IS NULL
            AND COALESCE(e.root_memory_id, e.id) = COALESCE(target.root_memory_id, target.id)
          LIMIT 1`,
        [memoryId, spaceId],
      );
      if (head.rows[0]) {
        throw new MemoryApplyError(
          "a newer version of this memory is active; archive it before restoring this one",
        );
      }
    }
    const updated = await this.markStatus(memoryId, spaceId, status, db);
    await reindexMemoryWithinApply(db, spaceId, [memoryId]);
    return updated;
  }

  /**
   * Putting back the version this one replaced, in one action.
   *
   * A persona is the one memory a person cannot simply archive: an Agent has
   * to have some persona, and archiving the head alone would leave it with
   * none. The Project's updates offer this as `restore_memory`; this is the
   * same reversal for a revision made outside any Project, which has no feed
   * to offer it from ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §3, §5).
   *
   * One transaction, because the intermediate state — a chain with no active
   * version — is one no reader should ever see.
   */
  async revertToPreviousVersion(
    spaceId: string,
    userId: string,
    memoryId: string,
  ): Promise<AppliedMemoryRow | null> {
    return withQueryableTransaction(this.db, async (tx) => {
      const head = await tx.query<{ supersedes_memory_id: string | null }>(
        `SELECT supersedes_memory_id FROM memory_entries
          WHERE id = $1 AND space_id = $2 AND owner_user_id = $3
            AND status = 'active' AND deleted_at IS NULL
          FOR UPDATE`,
        [memoryId, spaceId, userId],
      );
      const previousId = head.rows[0]?.supersedes_memory_id ?? null;
      if (!head.rows[0]) return null;
      if (!previousId) {
        throw new MemoryApplyError("this memory replaced nothing, so there is no earlier version to put back");
      }
      await this.setOwnStatusLocked(tx, spaceId, userId, memoryId, "archived");
      const restored = await this.setOwnStatusLocked(tx, spaceId, userId, previousId, "active");
      // Throwing rather than returning null: `setOwnStatusLocked` answers null
      // for a row that is not the caller's or is soft-deleted, and returning it
      // here would commit the archive and restore nothing — leaving an Agent
      // with no active persona at all, reported as "not found". The one state
      // this transaction exists to prevent.
      if (!restored) {
        throw new MemoryApplyError("the version this replaced is no longer there to put back");
      }
      return restored;
    });
  }

  /**
   * The active entry a direct revision would replace, if it is the caller's
   * own.
   *
   * Ownership is the gate, not readability: a direct revision writes a new
   * head owned by the acting person and supersedes what was there, so
   * applying it to an entry someone else owns would move their memory into
   * this person's name and take it off their page. The proposal path checks
   * visibility for the same reason (`getVisibleTargetMemory`); this path,
   * which needs more, checks more. Anything else falls through to
   * `MemoryReachError` and becomes a proposal.
   *
   * Locked, because the read and the supersede must see the same head: two
   * concurrent revisions of one entry would otherwise both pass and leave two
   * active rows on one chain.
   */
  async loadDirectWriteTarget(
    spaceId: string,
    userId: string,
    memoryId: string,
    /**
     * Also accept this Agent's own entries. An agent-scope row is owned by the
     * Agent's owner, who is not the acting person in an unattended Run and may
     * not be the person in a Room turn either, so ownership alone would refuse
     * an Agent revising what it wrote about itself.
     */
    agentId?: string,
  ): Promise<DirectWriteTarget | null> {
    const locked = await this.db.query<{ id: string; created_by: string | null }>(
      `SELECT id, created_by FROM memory_entries
        WHERE id = $1 AND space_id = $2
          -- The person's own entries, and this Agent's own — never another
          -- Agent's, even one the same person owns: an agent-scope row is the
          -- Agent's, and the owner's turn is not a way for one of their Agents
          -- to reach into another's memory.
          AND ((owner_user_id = $3 AND scope_type <> 'agent') OR (scope_type = 'agent' AND agent_id = $4))
          AND status = 'active' AND deleted_at IS NULL
        FOR UPDATE`,
      [memoryId, spaceId, userId, agentId ?? null],
    );
    const owned = locked.rows[0];
    if (!owned) return null;
    const found = await this.getActive(memoryId, spaceId);
    if (!found) return null;
    return { ...found, created_by: owned.created_by ?? "" };
  }

  // ------------------------------------------------------------------

  private resolveOwner(owner: string | null, visibility: string, actingUserId: string): string | null {
    let ownerUserId = owner;
    if (OWNER_SCOPED_VISIBILITIES.has(visibility) && ownerUserId == null) {
      ownerUserId = actingUserId;
    }
    if (visibility === "private" && ownerUserId == null) {
      throw new MemoryApplyError("owner_user_id is required for private visibility");
    }
    return ownerUserId;
  }

  private async insertMemory(
    proposal: ApplyProposal,
    f: NewMemoryFields,
  ): Promise<AppliedMemoryRow> {
    const now = new Date().toISOString();
    const result = await this.db.query<AppliedMemoryRow>(
      `INSERT INTO memory_entries (${INSERT_COLUMNS}) VALUES (
         $1, $2, $3, $4, $5, 'active',
         $6, $6, $7, $8,
         $9, $10, NULL, $11,
         $12, $13, 1.0, 0.5, NULL,
         $14, $15, $23, 0, NULL, $16,
         $17, $18, $19, $20, $21, $22, $24
       )
       RETURNING ${RETURNING_COLUMNS}`,
      [
        randomUUID(), // $1 id
        proposal.space_id, // $2
        f.scope, // $3 scope_type
        f.memoryType, // $4
        f.content, // $5
        now, // $6 created_at + updated_at
        f.subjectUserId, // $7
        f.ownerUserId, // $8
        f.sensitivity, // $9
        f.accessLevel, // $10
        f.namespace, // $11
        f.title, // $12
        f.visibility, // $13
        f.createdBy, // $14
        f.approvedBy, // $15
        f.memoryLayer, // $16
        f.createdFromProposalId === undefined ? proposal.id : f.createdFromProposalId, // $17
        f.rootMemoryId, // $18
        f.supersedesMemoryId, // $19
        f.sourceTrust, // $20
        f.agentId, // $21
        f.projectId, // $22
        f.version ?? 1, // $23
        f.originRoomId ?? null, // $24
      ],
    );
    return result.rows[0]!;
  }

  private async resolveProjectId(
    proposal: ApplyProposal,
    payload: Record<string, unknown>,
    fallbackProjectId: string | null,
  ): Promise<string | null> {
    const projectId = proposal.project_id ?? strOr(payload.project_id) ?? fallbackProjectId;
    try {
      await assertProjectInSpace(this.db, proposal.space_id, projectId);
    } catch (error) {
      if (error instanceof Error) throw new MemoryApplyError(error.message);
      throw error;
    }
    return projectId;
  }

  private async getActive(memoryId: string, spaceId: string): Promise<AppliedMemoryRow | null> {
    const res = await this.db.query<AppliedMemoryRow>(
      `SELECT ${RETURNING_COLUMNS}
         FROM memory_entries
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
      [memoryId, spaceId],
    );
    return res.rows[0] ?? null;
  }

  private async markStatus(
    memoryId: string,
    spaceId: string,
    status: string,
    db: Queryable = this.db,
  ): Promise<AppliedMemoryRow | null> {
    const res = await db.query<AppliedMemoryRow>(
      `UPDATE memory_entries
          SET status = $3, updated_at = $4
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL
        RETURNING ${RETURNING_COLUMNS}`,
      [memoryId, spaceId, status, new Date().toISOString()],
    );
    return res.rows[0] ?? null;
  }

  private async provenanceKeys(spaceId: string, memoryId: string): Promise<Set<string>> {
    const res = await this.db.query<{ source_type: string; source_id: string; source_trust: string | null }>(
      `SELECT source_type, source_id, source_trust
         FROM provenance_links
        WHERE space_id = $1 AND target_type = $2 AND target_id = $3`,
      [spaceId, TARGET_MEMORY, memoryId],
    );
    const keys = new Set<string>();
    for (const r of res.rows) keys.add(`${r.source_type} ${r.source_id} ${r.source_trust ?? ""}`);
    return keys;
  }
}

/** A one-line stand-in for an untitled memory in the Project's updates. */
function truncate(content: string): string {
  const line = content.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function strOr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function lower(value: string): string {
  return value.toLowerCase();
}

type MemoryScope = "user" | "project" | "agent";

function memoryScope(value: string): MemoryScope {
  const scope = lower(value);
  if (scope !== "user" && scope !== "project" && scope !== "agent") {
    throw new MemoryApplyError("memory scope must be user, project or agent");
  }
  return scope;
}

function assertMemoryPlacement(
  scope: MemoryScope,
  visibility: string,
  ownerUserId: string | null,
  projectId: string | null,
): void {
  if (scope === "agent") {
    // The Agent's own. Private and Project-free by construction: what an Agent
    // knows about itself and about a Room reaches a wider audience only by
    // promotion to Project Memory, which is a proposal (ADR 0003 §1, §4).
    if (projectId !== null) throw new MemoryApplyError("agent memory cannot carry a project_id");
    if (ownerUserId === null) throw new MemoryApplyError("agent memory requires the Agent's owner");
    if (visibility !== "private") throw new MemoryApplyError("agent memory is private to the Agent and its owner");
    return;
  }
  if (scope === "user") {
    if (projectId !== null) throw new MemoryApplyError("user memory cannot carry a project_id");
    if (ownerUserId === null) throw new MemoryApplyError("user memory requires owner_user_id");
    if (visibility === "space_shared") {
      throw new MemoryApplyError("space-shared learning belongs to project memory");
    }
    return;
  }
  if (projectId === null) throw new MemoryApplyError("project memory requires project_id");
  if (visibility !== "space_shared") {
    throw new MemoryApplyError("project memory must be space_shared");
  }
}

function assertContentPolicyFields(
  visibility: string,
  accessLevel: string,
  sensitivity: string,
): void {
  if (!isContentVisibility(visibility)) {
    throw new MemoryApplyError("invalid memory visibility");
  }
  if (!isContentAccessLevel(accessLevel)) {
    throw new MemoryApplyError("invalid memory access level");
  }
  if (sensitivity === "highly_restricted" && visibility !== "private") {
    throw new MemoryApplyError("highly restricted memory must be private");
  }
}

function memoryLayer(payload: Record<string, unknown>): string | null {
  const raw = strOr(payload.target_layer) ?? strOr(payload.memory_layer);
  return raw ? raw.toLowerCase() : null;
}

function provKey(e: ProvenanceEntry): string | null {
  if (typeof e.source_type !== "string" || typeof e.source_id !== "string") return null;
  const tr = typeof e.source_trust === "string" ? e.source_trust : "";
  return `${e.source_type} ${e.source_id} ${tr}`;
}
