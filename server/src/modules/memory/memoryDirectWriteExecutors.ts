import {
  MemoryProposalCreateCommandSchema,
  MemoryProposalUpdateCommandSchema,
  type SystemActionId,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { HttpError, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { RunRecord } from "../runs/repository.js";
import { MemoryReachError, PgMemoryApplyRepository } from "./memoryApplyRepository.js";
import { PgMemoryProposalRepository } from "./proposalRepository.js";

/**
 * Memory's Agent tool surface — `memory.remember` and `memory.revise`
 * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §2).
 *
 * Until these existed no Agent could write memory from a conversation at all:
 * the surface carried only `memory.retrieval.*`, and the pipelines that draft
 * memory proposals have produced none on this instance. The person was never
 * the bottleneck on what an Agent remembers — nothing was, and it did not
 * learn.
 *
 * A write that stays private, normal-sensitivity and about the person in the
 * turn applies directly, as a new version carrying its run and rationale. A
 * revision that would reach past that — replacing what a person wrote, or an
 * entry already shared — becomes a proposal rather than an error, so the
 * Agent still records what it learned and the person still decides what
 * widens.
 */
export function registerMemoryDirectWriteExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);
  const actingUserId = run.instructed_by_user_id!;

  // Read once per Run, lazily: an Agent whose memory policy says
  // `requires_proposal` is described on its own page as unable to write
  // memory directly, and until now nothing enforced that. Direct writing is
  // the default; this is the per-Agent way to turn it off.
  let proposalOnly: Promise<boolean> | null = null;
  const isProposalOnly = () => {
    // The version the Run is executing, not the Agent's current one: a policy
    // edited mid-turn must not change what this turn is allowed to do.
    proposalOnly ??= db.query<{ requires: boolean | null }>(
      `SELECT (memory_policy_json->>'requires_proposal')::boolean AS requires
         FROM agent_versions WHERE id = $1 AND space_id = $2`,
      [run.agent_version_id, run.space_id],
    ).then((r) => r.rows[0]?.requires === true);
    return proposalOnly;
  };

  const proposeCreate = async (tx: Queryable, command: Record<string, unknown>, reason: string) => {
    const visibility = typeof command.visibility === "string" ? command.visibility : "private";
    // Placement, not preference: `assertMemoryPlacement` refuses a
    // user-scoped entry that carries a Project or is space-shared, and
    // refuses a project-scoped one that does not. A proposal built the other
    // way is accepted into a queue and then fails forever at apply, which is
    // worse than refusing here.
    const shared = visibility === "space_shared";
    if (shared && !run.project_id) {
      throw new HttpError(
        422,
        "Memory shared with the Space belongs to a Project, and this conversation has none. "
        + "Remember it privately, or ask the person to run this in a Project.",
      );
    }
    const proposal = await new PgMemoryProposalRepository(tx, config).createMemoryProposal(
      run.space_id,
      actingUserId,
      // Parsed rather than cast: the command schema fills the defaults the
      // repository expects, and a value that would not survive validation
      // should fail here rather than reach the proposal payload.
      MemoryProposalCreateCommandSchema.parse({
        operation: "create",
        content: String(command.content ?? ""),
        type: typeof command.memory_type === "string" ? command.memory_type : "semantic",
        title: typeof command.title === "string" ? command.title : String(command.content ?? "").slice(0, 80),
        visibility,
        sensitivity_level: typeof command.sensitivity_level === "string" ? command.sensitivity_level : "normal",
        scope: shared ? "project" : "user",
        project_id: shared ? run.project_id : null,
        owner_user_id: shared ? null : actingUserId,
      }),
      { agentId: run.agent_id, runId: run.id, rationale: String(command.rationale ?? "") },
    );
    return {
      modelResult: {
        ok: true,
        tool: "memory.remember",
        outcome: "proposed",
        proposal_id: proposal.id,
        reason: `${reason} It is waiting for the person; nothing is stored yet.`,
      },
      summary: { tool_name: "memory.remember", ok: true, outcome: "proposed", proposal_id: proposal.id },
    };
  };

  const base = () => ({
    spaceId: run.space_id,
    actingUserId,
    agentId: run.agent_id,
    runId: run.id,
    sessionId: run.session_id ?? null,
    projectId: run.project_id ?? null,
  });

  executors.set("memory.remember" as SystemActionId, async (input) => {
    const command = input as Record<string, unknown>;
    return withQueryableTransaction(db, async (tx) => {
      await assertSessionNotLooping(tx, config, run);
      if (await isProposalOnly()) {
        return proposeCreate(tx, command, "This Agent writes memory only by proposal.");
      }
      try {
        const result = await new PgMemoryApplyRepository(tx).applyDirect({ ...base(), command });
        return {
          modelResult: { ok: true, tool: "memory.remember", outcome: "remembered", memory_id: result.memory.id },
          summary: { tool_name: "memory.remember", ok: true, memory_id: result.memory.id },
        };
      } catch (error) {
        if (!(error instanceof MemoryReachError)) throw error;
        // Not a failure to report back as one: what the Agent asked for is
        // recorded, and only the decision that widens reach is the person's.
        return proposeCreate(tx, command, `This needs the person because ${error.detail}.`);
      }
    });
  });

  executors.set("memory.revise" as SystemActionId, async (input) => {
    const command = input as Record<string, unknown>;
    const memoryId = String(command.memory_id);
    return withQueryableTransaction(db, async (tx) => {
      await assertSessionNotLooping(tx, config, run);
      const repository = new PgMemoryApplyRepository(tx);
      const proposeRevision = async (reason: string) => {
        const proposal = await new PgMemoryProposalRepository(tx, config).updateMemoryProposal(
          run.space_id,
          actingUserId,
          memoryId,
          MemoryProposalUpdateCommandSchema.parse({
            operation: "update",
            target_memory_id: memoryId,
            content: String(command.content ?? ""),
          }),
          // The rationale is the Agent's, so the proposal records it and the
          // Agent rather than a user confirmation the person never gave.
          { agentId: run.agent_id, runId: run.id, rationale: String(command.rationale ?? "") },
        );
        return {
          modelResult: {
            ok: true,
            tool: "memory.revise",
            outcome: "proposed",
            proposal_id: proposal.id,
            reason: `${reason} It is waiting for the person.`,
          },
          summary: { tool_name: "memory.revise", ok: true, outcome: "proposed", proposal_id: proposal.id },
        };
      };
      if (await isProposalOnly()) return proposeRevision("This Agent revises memory only by proposal.");
      const target = await repository.loadDirectWriteTarget(run.space_id, actingUserId, memoryId);
      // Not this person's to revise in place — which includes "does not
      // exist", deliberately: answering differently would tell an Agent
      // whether a memory id it guessed belongs to someone else.
      if (!target) return proposeRevision("this memory is not the person's own to revise directly");
      try {
        const result = await repository.applyDirect({ ...base(), command, target });
        return {
          modelResult: {
            ok: true,
            tool: "memory.revise",
            outcome: "revised",
            memory_id: result.memory.id,
            superseded_memory_id: result.supersededMemoryId,
          },
          summary: { tool_name: "memory.revise", ok: true, memory_id: result.memory.id },
        };
      } catch (error) {
        if (!(error instanceof MemoryReachError)) throw error;
        return proposeRevision(`This revision needs the person because ${error.detail}.`);
      }
    });
  });
}

/**
 * The circuit breaker of ADR 0003 §2.
 *
 * Not a budget on how much an Agent may remember — memory's risks are reach
 * and quality, and both are governed elsewhere. It detects a fault: writing
 * an anomalous number of entries is looping, and the answer is to stop and be
 * looked at, never to hand a person a hundred rows to approve. Where there is
 * no session — a conversation outside a Room has none — the Run is the
 * boundary, because a surface with no counter at all is the one thing this
 * must not be.
 */
async function assertSessionNotLooping(db: Queryable, config: ServerConfig, run: RunRecord): Promise<void> {
  // A conversation with no Room has no session — a group carrying one without
  // a Room is refused — so counting only by session would leave the surface
  // that reaches those Agents unbounded, which is the one thing this exists to
  // prevent. Where there is no session the Run is the loop's boundary.
  const scope = run.session_id
    ? { column: "p.evidence_json->>'session_id'", value: run.session_id, sessions: true }
    : { column: "p.source_id", value: run.id, sessions: false };
  // Both branches count. A loop that asks for space-shared memory, or one
  // running under a `requires_proposal` Agent, produces proposals instead of
  // entries — and an unbounded pile of those is the hundred rows to approve
  // this exists to prevent, not an escape from it.
  //
  // Only what still stands is counted: a revision supersedes the version it
  // replaced, so ordinary correction does not walk toward the limit, and
  // archiving what an over-eager session wrote is what lets it write again.
  //
  // Counted per person within the session, not per session. A Room
  // conversation is one session shared by its members (`user_id` is null on
  // it and every member's turn carries the same id), so a session-wide count
  // would let one member's memories consume another's budget — and the reset
  // is archiving, which only the owner can do, so the other member could not
  // clear what stopped them. It also keeps this count identical to the one
  // the attention adapter shows the person.
  const written = await db.query<{ total: string }>(
    `SELECT (
       (SELECT count(*) FROM memory_entries m
          JOIN provenance_links p
            ON p.space_id = m.space_id AND p.target_type = 'memory' AND p.target_id = m.id
           AND p.source_type = 'run' AND ${scope.column} = $2
         WHERE m.space_id = $1 AND m.created_from_proposal_id IS NULL AND m.status = 'active'
           AND m.owner_user_id = $3)
       + (SELECT count(*) FROM proposals pr
           JOIN runs r ON r.id = pr.created_by_run_id AND r.space_id = pr.space_id
          WHERE pr.space_id = $1 AND pr.status = 'pending'
            AND ${scope.sessions ? "r.session_id = $2" : "r.id = $2"}
            AND pr.proposal_type IN ('memory_create', 'memory_update')
            AND pr.created_by_user_id = $3)
     )::text AS total`,
    [run.space_id, scope.value, run.instructed_by_user_id],
  );
  if (Number(written.rows[0]?.total ?? 0) >= config.memoryDirectWritesPerSession) {
    throw new HttpError(
      429,
      `This ${scope.sessions ? "session" : "turn"} has already written ${config.memoryDirectWritesPerSession} memories, `
      + "so its memory writing is paused. Tell the person what you were trying to record; do not retry.",
    );
  }
}
