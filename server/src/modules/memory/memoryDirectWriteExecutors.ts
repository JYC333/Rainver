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
import { effectiveRunTrigger } from "../systemActions/effectiveRunTrigger.js";
import {
  AGENT_SCOPE_MEMORY_TYPES,
  decidePersonaWrite,
  MemoryReachError,
  PERSONA_MEMORY_TYPE,
  PgMemoryApplyRepository,
  type AgentWriteContext,
  type DirectWriteTarget,
} from "./memoryApplyRepository.js";
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
  // Null on an unattended Run. Everything about a person needs one — a
  // user-scope entry is *about* the acting person, and a proposal is
  // attributed to them — so those refuse below with a reason. The persona
  // write ADR 0003 §5 lets an unattended Run make needs none: it is about the
  // Agent, and its owner is who the entry belongs to.
  const actingUserId = run.instructed_by_user_id ?? null;
  const requireActingUser = (what: string): string => {
    if (actingUserId) return actingUserId;
    throw new HttpError(
      422,
      `${what} needs a person in the conversation, and nobody asked for this run. `
      + "Only what you have learned about yourself can be recorded from here.",
    );
  };

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
    const memoryType = typeof command.memory_type === "string" ? command.memory_type : "semantic";
    const visibility = typeof command.visibility === "string" ? command.visibility : "private";
    // The Agent's own, and staying its own. A persona in a `manual` turn is the
    // case ADR 0003 §5 sends here: the owner decides it in the turn, anyone
    // else's request waits for the owner, and only the owner may accept either.
    //
    // A note the Agent asked to share is the other case, and it does **not**
    // come here: agent-scope content reaches a wider audience only by being
    // promoted to Project Memory (§4), so it falls through to the Project
    // proposal below — with the Room it was learned in carried as provenance,
    // because the owner deciding it should be able to see where it came from.
    if (AGENT_SCOPE_MEMORY_TYPES.has(memoryType) && visibility === "private") {
      return proposeAgentScopeCreate(tx, command, memoryType, reason);
    }
    if (memoryType === PERSONA_MEMORY_TYPE) {
      throw new HttpError(
        422,
        "What you have become is yours and stays private. If this is something the Project should know, "
        + "record it as a lesson and ask for it to be shared.",
      );
    }
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
      requireActingUser("Proposing a memory about the person"),
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
        owner_user_id: shared ? null : requireActingUser("Proposing a memory about the person"),
        // Where the Agent learned it, when what it is promoting is one of its
        // own notes. Provenance for the person deciding, not a reach the
        // Project entry carries: a Project memory is the Project's audience.
        origin_room_id: AGENT_SCOPE_MEMORY_TYPES.has(memoryType)
          ? (await resolveAgentScope()).roomId
          : null,
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

  const proposeAgentScopeCreate = async (
    tx: Queryable,
    command: Record<string, unknown>,
    memoryType: string,
    reason: string,
  ) => {
    const scope = await resolveAgentScope();
    if (!scope.ownerUserId) {
      throw new HttpError(
        422,
        "This Agent has no owner, so it has no memory of its own. Record what you learned about the person instead.",
      );
    }
    const persona = memoryType === PERSONA_MEMORY_TYPE;
    // The same reach test the applier runs (`resolveAgentWrite`). A note with
    // no origin Room was learned in a direct chat, whose audience is the owner
    // alone; proposing one from someone else's chat would put that
    // conversation in front of the owner as something to accept, which is the
    // disclosure the applier refuses.
    if (!persona && !scope.roomId && actingUserId !== scope.ownerUserId) {
      throw new HttpError(
        422,
        "This was learned outside any Room, in a conversation this Agent's owner did not see. Nothing was recorded.",
      );
    }
    const proposal = await new PgMemoryProposalRepository(tx, config).createMemoryProposal(
      run.space_id,
      // The Agent's owner, not the person in the turn: this entry is the
      // Agent's, and on an unattended Run there is no person in the turn.
      scope.ownerUserId,
      MemoryProposalCreateCommandSchema.parse({
        operation: "create",
        content: String(command.content ?? ""),
        type: memoryType,
        title: typeof command.title === "string" ? command.title : String(command.content ?? "").slice(0, 80),
        visibility: "private",
        sensitivity_level: "normal",
        scope: "agent",
        project_id: null,
        owner_user_id: scope.ownerUserId,
        agent_id: run.agent_id,
        origin_room_id: persona ? null : scope.roomId,
      }),
      {
        agentId: run.agent_id,
        runId: run.id,
        rationale: String(command.rationale ?? ""),
        instructedByUserId: actingUserId,
      },
    );
    // Told apart so the surfaces can be: the owner's own turn decides it
    // there, anyone else's leaves a pending proposal the Room shows them
    // nothing about.
    const decidedInTurn = persona
      && decidePersonaWrite(scope) === "proposal_in_turn";
    return {
      modelResult: {
        ok: true,
        tool: "memory.remember",
        outcome: "proposed",
        proposal_id: proposal.id,
        reason: decidedInTurn
          ? `${reason} It is in front of the person now; nothing is stored until they accept.`
          : `${reason} It is waiting for this Agent's owner; nothing is stored yet.`,
      },
      summary: {
        tool_name: "memory.remember",
        ok: true,
        outcome: "proposed",
        proposal_id: proposal.id,
        ...(persona ? { persona_decision: decidedInTurn ? "in_turn" : "owner" } : {}),
      },
    };
  };

  // Read once per dispatcher: `agents.owner_user_id` and the Room this Run
  // speaks in
  // are what an agent-scope write is judged against, and neither may come from
  // the turn. The trigger columns come off the Run itself, which the prompt
  // cannot reach at all.
  let agentScope: Promise<AgentWriteContext> | null = null;
  const resolveAgentScope = (): Promise<AgentWriteContext> => agentScope ??= loadAgentScope();
  const loadAgentScope = async (): Promise<AgentWriteContext> => {
    const owner = await db.query<{ owner_user_id: string | null }>(
      `SELECT owner_user_id FROM agents WHERE id = $1 AND space_id = $2`,
      [run.agent_id, run.space_id],
    );
    const room = run.session_id
      ? await db.query<{ room_id: string | null }>(
          `SELECT room_id FROM sessions WHERE id = $1 AND space_id = $2`,
          [run.session_id, run.space_id],
        )
      : null;
    // The **root** Run's trigger, not this one's. A delegated Run carries
    // `delegation` while the person who set it going is one hop up, and
    // reading the raw columns would let a turn apply a persona change directly
    // by asking one Agent to ask another. The policy gate resolves the origin
    // the same way, so the two cannot disagree about the same Run.
    const trigger = await effectiveRunTrigger(db, run);
    return {
      ownerUserId: owner.rows[0]?.owner_user_id ?? null,
      triggerOrigin: trigger.origin,
      instructedByUserId: trigger.instructedByUserId,
      roomId: room?.rows[0]?.room_id ?? null,
      activePersonaExists: await hasActivePersona(db, run),
    };
  };

  /** A second active persona is refused readably rather than by a unique index. */
  const hasActivePersona = async (queryable: Queryable, record: RunRecord): Promise<boolean> => {
    const row = await queryable.query<{ id: string }>(
      `SELECT id FROM memory_entries
        WHERE space_id = $1 AND agent_id = $2 AND scope_type = 'agent'
          AND memory_type = 'persona' AND status = 'active' AND deleted_at IS NULL
        LIMIT 1`,
      [record.space_id, record.agent_id],
    );
    return Boolean(row.rows[0]);
  };

  /**
   * ADR 0003 §5's "at most one persona change per Run", counted from both
   * applied provenance and pending proposals. A manual Run must not evade the
   * bound merely because its first change is waiting for the owner.
   *
   * Not a variable: a host-bound conversation builds a fresh dispatcher for
   * every tool call (`runs/cliToolTransport.ts`), so anything held in this
   * closure resets between calls and the bound never fired on the one surface
   * this whole plan is about.
   */
  const personaWritesInThisRun = async (queryable: Queryable): Promise<number> => {
    const row = await queryable.query<{ total: string }>(
      `SELECT (
         (SELECT count(*)
            FROM memory_entries m
            JOIN provenance_links p
              ON p.space_id = m.space_id AND p.target_type = 'memory' AND p.target_id = m.id
             AND p.source_type = 'run' AND p.source_id = $2
           WHERE m.space_id = $1 AND m.scope_type = 'agent' AND m.memory_type = 'persona')
         +
         (SELECT count(*)
            FROM proposals proposal
           WHERE proposal.space_id = $1
             AND proposal.created_by_run_id = $2
             AND proposal.proposal_type IN ('memory_create', 'memory_update')
             AND proposal.payload_json->>'memory_type' = 'persona')
       )::text AS total`,
      [run.space_id, run.id],
    );
    return Number(row.rows[0]?.total ?? 0);
  };

  const base = async () => ({
    spaceId: run.space_id,
    // The applier uses this for a user-scope write's owner and subject; an
    // agent-scope write takes its owner from the Agent instead, so an
    // unattended Run reaches the applier with an empty acting user and is
    // refused there unless what it is writing is the Agent's own.
    actingUserId: actingUserId ?? "",
    agentId: run.agent_id,
    runId: run.id,
    sessionId: run.session_id ?? null,
    projectId: run.project_id ?? null,
    agentScope: await resolveAgentScope(),
  });

  /** Whose budget this write counts against — see `assertSessionNotLooping`. */
  const countUnderUserId = async (memoryType: string): Promise<string> => {
    if (AGENT_SCOPE_MEMORY_TYPES.has(memoryType)) {
      const scope = await resolveAgentScope();
      if (scope.ownerUserId) return scope.ownerUserId;
    }
    return requireActingUser("Writing memory");
  };

  executors.set("memory.remember" as SystemActionId, async (input) => {
    const command = input as Record<string, unknown>;
    return withQueryableTransaction(db, async (tx) => {
      const requestedType = typeof command.memory_type === "string" ? command.memory_type : "semantic";
      await assertSessionNotLooping(tx, config, run, await countUnderUserId(requestedType));
      if (requestedType === PERSONA_MEMORY_TYPE && await personaWritesInThisRun(tx) > 0) {
        throw new HttpError(
          429,
          "You have already changed what you have become once in this run. "
          + "Say what else you would change and leave it there; do not retry.",
        );
      }
      if (await isProposalOnly()) {
        return proposeCreate(tx, command, "This Agent writes memory only by proposal.");
      }
      try {
        const result = await new PgMemoryApplyRepository(tx).applyDirect({ ...(await base()), command });
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
      const repository = new PgMemoryApplyRepository(tx);
      const proposeRevision = async (reason: string, target: DirectWriteTarget | null) => {
        // Who the proposal is for. A revision of the Agent's own memory is the
        // Agent's owner's to decide — the person in the turn may be anyone in
        // the Room, and an unattended Run has none at all. Everything else is
        // for the person the entry is about.
        const decider = target?.scope_type === "agent"
          ? ((await resolveAgentScope()).ownerUserId ?? requireActingUser("Proposing a revision"))
          : requireActingUser("Proposing a revision");
        const proposal = await new PgMemoryProposalRepository(tx, config).updateMemoryProposal(
          run.space_id,
          decider,
          memoryId,
          MemoryProposalUpdateCommandSchema.parse({
            operation: "update",
            target_memory_id: memoryId,
            content: String(command.content ?? ""),
          }),
          // The rationale is the Agent's, so the proposal records it and the
          // Agent rather than a user confirmation the person never gave.
          {
            agentId: run.agent_id,
            runId: run.id,
            rationale: String(command.rationale ?? ""),
            instructedByUserId: actingUserId,
          },
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
      const target = await repository.loadDirectWriteTarget(run.space_id, actingUserId ?? "", memoryId, run.agent_id);
      await assertSessionNotLooping(tx, config, run, await countUnderUserId(target?.memory_type ?? "semantic"));
      // At most one persona revision per Run (ADR 0003 §5). A loop that keeps
      // rewriting what it has become would otherwise produce a version chain
      // nobody can read and a notification nobody can act on, and the version
      // chain is what makes a persona reversible in one step.
      if (target?.memory_type === PERSONA_MEMORY_TYPE && await personaWritesInThisRun(tx) > 0) {
        throw new HttpError(
          429,
          "You have already changed what you have become once in this run. "
          + "Say what else you would change and leave it there; do not retry.",
        );
      }
      if (await isProposalOnly()) {
        return proposeRevision("This Agent revises memory only by proposal.", target);
      }
      // Not this person's to revise in place — which includes "does not
      // exist", deliberately: answering differently would tell an Agent
      // whether a memory id it guessed belongs to someone else.
      if (!target) return proposeRevision("this memory is not the person's own to revise directly", null);
      try {
        const result = await repository.applyDirect({ ...(await base()), command, target });
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
        return proposeRevision(`This revision needs the person because ${error.detail}.`, target);
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
async function assertSessionNotLooping(
  db: Queryable,
  config: ServerConfig,
  run: RunRecord,
  /**
   * Who the count is attributed to. The person in the turn for a user-scope
   * write, and the **Agent's owner** for an agent-scope one: the owner is who
   * archives those entries, which is the only way to clear the breaker, and an
   * unattended Run has no person in the turn to count against at all
   * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §2).
   */
  countUnderUserId: string,
): Promise<void> {
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
    [run.space_id, scope.value, countUnderUserId],
  );
  if (Number(written.rows[0]?.total ?? 0) >= config.memoryDirectWritesPerSession) {
    throw new HttpError(
      429,
      `This ${scope.sessions ? "session" : "turn"} has already written ${config.memoryDirectWritesPerSession} memories, `
      + "so its memory writing is paused. Tell the person what you were trying to record; do not retry.",
    );
  }
}
