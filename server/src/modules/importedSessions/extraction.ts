/**
 * Turning imported CLI history into something a Project can act on.
 *
 * The extraction contract is the Runtime Context semantic checkpoint's: the
 * same system prompt and the same strict output schema, so there is one
 * definition of what "a checkpoint of this work" means and not a second one
 * that drifts. What is *not* reused is that extractor's metering, which
 * resolves a Work Context Setup — imported history has no work context scope,
 * and inventing one to satisfy a lookup would be contorting the mechanism to
 * fit rather than reusing it.
 *
 * Two rules the output has to obey, both from the plan and both load-bearing:
 *
 * - Only sessions the person marked shared feed this. The Brief has no
 *   per-object visibility, so a private session's content would reach every
 *   Project member through it (ADR 0013 decisions 16–17). The choice was
 *   made, knowingly, when the session was imported.
 * - Nothing here writes anything. Extraction produces two proposals and stops
 *   (ADR 0003): a Project Brief draft for an owner to publish, and a packet of
 *   candidate project-layer memories to accept or reject one by one.
 */

import { randomUUID } from "node:crypto";
import {
  SemanticCheckpointExtractionSchema,
  type SemanticCheckpointExtraction,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { HttpError, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { completeProviderText } from "../providers/invocation/invocation.js";
import { resolveProviderCommandStore } from "../providers/commands/store.js";
import { assertProjectWriter } from "../projects/access.js";
import { ProjectDefinitionProposalService } from "../projects/projectDefinitionProposalService.js";
import { ProjectKernelService } from "../projects/kernelService.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import { SEMANTIC_CHECKPOINT_SYSTEM_PROMPT } from "../runtimeContext/continuity/semanticExtractor.js";

const TASK = "importedSessions.history.extract";
export const IMPORTED_HISTORY_PACKET_PROPOSAL_TYPE = "imported_history_memory_packet";
/**
 * How many records one extraction reads.
 *
 * A month of a real folder's history is thousands of records; the window
 * planner is not in this path, so the bound is explicit. Records not covered
 * stay unextracted and are picked up by the next run, which is why this is a
 * batch size rather than a truncation.
 */
const MAX_RECORDS_PER_EXTRACTION = 400;
/**
 * And by size, because a count is not a budget: one message may be 64 KB
 * (`AMBIENT_TEXT_MAX_BYTES`), so 400 of them can exceed any model's window.
 * A batch that overruns throws identically on every retry, and the selection
 * is deterministic, so without this a folder could become permanently
 * unextractable.
 */
const MAX_CHARACTERS_PER_EXTRACTION = 400_000;

export interface ExtractionOutcome {
  /** Null when there was nothing new to read, or nothing worth proposing. */
  brief_proposal_id: string | null;
  memory_packet_proposal_id: string | null;
  records_covered: number;
  sessions_covered: number;
  decisions: number;
  facts: number;
  /** Records still waiting after this batch. */
  records_remaining: number;
}

interface PendingRecord {
  id: string;
  imported_session_id: string;
  kind: string;
  sequence: number;
  text: string | null;
  tool_name: string | null;
  tool_status: string | null;
  tool_input: string | null;
  session_title: string | null;
  adapter_type: string;
  vendor_updated_at: string | null;
}

/**
 * Adds constraints to whatever the caller is already carrying, line by line.
 *
 * De-duplicated because extraction runs repeatedly over one Project and plain
 * concatenation would grow the Brief without bound, restating what is already
 * there. Returns nothing when there is nothing new, so a caller merging into
 * an existing payload does not overwrite it with an unchanged value.
 */
function mergedConstraints(
  existing: string | null,
  added: SemanticCheckpointExtraction["constraints"],
): { constraints?: string } {
  const lines = existing ? existing.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  const fresh = added.map((entry) => entry.text.trim()).filter((text) => text && !lines.includes(text));
  if (fresh.length === 0) return {};
  return { constraints: [...lines, ...fresh].join("\n") };
}

export class ImportedHistoryExtractionService {
  constructor(private readonly db: Queryable, private readonly config: ServerConfig) {}

  /** What an extraction would read right now, for the button that offers to run one. */
  async pending(identity: SpaceUserIdentity, projectId: string): Promise<{ records: number; sessions: number }> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    // Swept here and not only in `extract()`: the count is what decides
    // whether the button that runs an extraction is shown at all. A batch left
    // claimed by a process that died would report zero pending, hide the
    // button, and take with it the only path that would have released it.
    await this.releaseStaleClaims(identity.spaceId, projectId);
    const result = await this.db.query<{ records: string; sessions: string }>(
      `SELECT count(*)::text AS records, count(DISTINCT r.imported_session_id)::text AS sessions
         FROM imported_session_records r
         JOIN imported_sessions s ON s.id = r.imported_session_id
        WHERE r.space_id = $1 AND s.project_id = $2
          AND r.extracted_in IS NULL AND s.visibility = 'space_shared'`,
      [identity.spaceId, projectId],
    );
    return {
      records: Number(result.rows[0]?.records ?? "0"),
      sessions: Number(result.rows[0]?.sessions ?? "0"),
    };
  }

  /**
   * Reads one batch of unextracted records and proposes what it found.
   *
   * Records are marked extracted whether or not the model found anything in
   * them, because "read and produced nothing" is a real outcome and re-reading
   * them forever would spend the person's model budget on the same silence.
   */
  async extract(
    identity: SpaceUserIdentity,
    projectId: string,
    /**
     * Narrows the batch to one folder's history. The batch is otherwise
     * Project-wide and oldest-first, so an import of three sessions into a
     * Project already holding a backlog would spend its extraction on
     * unrelated history and leave the three unread — which is the opposite of
     * what the person who just pressed import was promised.
     */
    workspaceLocationId?: string,
  ): Promise<ExtractionOutcome> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const checkpointId = randomUUID();
    await this.releaseStaleClaims(identity.spaceId, projectId);
    // Claiming *is* the read mark, taken atomically before the model is
    // called. Two extractions — a scheduled one and a pressed button, or a
    // double click — therefore take disjoint batches instead of both paying
    // for the same records and putting two proposals about one batch on an
    // attention list that has to stay short enough to read. An advisory lock
    // would not do this: it is per connection, and on a pool the second
    // caller can be handed the connection that already holds it.
    const records = await this.claimRecords(identity.spaceId, projectId, checkpointId, workspaceLocationId);
    if (records.length === 0) {
      return {
        brief_proposal_id: null,
        memory_packet_proposal_id: null,
        records_covered: 0,
        sessions_covered: 0,
        decisions: 0,
        facts: 0,
        records_remaining: 0,
      };
    }

    let extraction: SemanticCheckpointExtraction;
    try {
      extraction = await this.runExtractor(identity, projectId, records);
    } catch (error) {
      // Released, not left claimed: a batch marked read but never proposed is
      // invisible to every future extraction, and on the automatic path
      // invisible to the person as well.
      await this.releaseClaim(checkpointId);
      throw error;
    }
    const decisions = extraction.decisions;
    const constraints = extraction.constraints;
    const facts = extraction.facts.filter((fact) => fact.fact_status === "asserted");

    // Proposals and the read marks commit together. Marking first would let a
    // failed proposal leave 400 records flagged read and never proposed —
    // invisible to every future extraction, and on the automatic path
    // invisible to the person as well.
    let written: { briefProposalId: string | null; packetProposalId: string | null };
    try {
      written = await withQueryableTransaction(this.db, async (tx) => {
        const briefProposalId = decisions.length + constraints.length === 0
          ? null
          : await this.proposeBrief(tx, identity, projectId, { goals: extraction.goals, decisions, constraints });
        // Everything that could not become a Brief — no goal on either side —
        // is kept as memory candidates rather than discarded. The records have
        // been read and paid for; losing what was found in them is the one
        // outcome worse than not extracting at all.
        const orphaned = briefProposalId === null ? [...decisions, ...constraints] : [];
        const packetProposalId = facts.length === 0 && orphaned.length === 0
          ? null
          : await this.proposeMemoryPacket(tx, identity, projectId, facts, orphaned, records, checkpointId);
        return { briefProposalId, packetProposalId };
      });
      // Finalized only once the proposals exist: until this runs the batch is
      // a claim, and a claim is recoverable.
      await this.db.query(
        `UPDATE imported_session_records SET extracted_in = $2 WHERE extracted_in = $1`,
        [`claim:${checkpointId}`, checkpointId],
      );
    } catch (error) {
      await this.releaseClaim(checkpointId);
      throw error;
    }

    return {
      brief_proposal_id: written.briefProposalId,
      memory_packet_proposal_id: written.packetProposalId,
      records_covered: records.length,
      sessions_covered: new Set(records.map((record) => record.imported_session_id)).size,
      decisions: decisions.length,
      facts: facts.length,
      records_remaining: (await this.pending(identity, projectId)).records,
    };
  }

  /**
   * Takes a batch and marks it read in one statement.
   *
   * The size bound is applied after the claim rather than inside it, so the
   * claim stays a single atomic statement; the overflow is released
   * immediately and picked up by the next batch.
   */
  private async claimRecords(
    spaceId: string,
    projectId: string,
    checkpointId: string,
    workspaceLocationId?: string,
  ): Promise<PendingRecord[]> {
    const result = await this.db.query<PendingRecord>(
      `WITH batch AS (
         SELECT r.id
           FROM imported_session_records r
           JOIN imported_sessions s ON s.id = r.imported_session_id
          WHERE r.space_id = $1 AND s.project_id = $2
            AND r.extracted_in IS NULL
            -- Shared only. A private session's content would otherwise reach
            -- every Project member through a Brief that has no visibility of
            -- its own.
            AND s.visibility = 'space_shared'
            AND ($5::varchar IS NULL OR s.workspace_location_id = $5)
          ORDER BY s.vendor_updated_at ASC NULLS LAST, r.imported_session_id, r.sequence ASC
          LIMIT $3
          FOR UPDATE OF r SKIP LOCKED
       )
       UPDATE imported_session_records r
          SET extracted_in = $4, extracted_at = now()
         FROM batch, imported_sessions s
        WHERE r.id = batch.id AND s.id = r.imported_session_id
       RETURNING r.id, r.imported_session_id, r.kind, r.sequence, r.text, r.tool_name,
                 r.tool_status, r.tool_input, s.title AS session_title, s.adapter_type,
                 to_char(s.vendor_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS vendor_updated_at`,
      [spaceId, projectId, MAX_RECORDS_PER_EXTRACTION, `claim:${checkpointId}`, workspaceLocationId ?? null],
    );
    // `RETURNING` gives no order, and `sequence` restarts at zero in every
    // session — sorting on it alone interleaves the sessions turn by turn and
    // hands the model a scattered slice of many transcripts instead of whole
    // ones, which is the opposite of what it is being asked to read.
    result.rows.sort((left, right) =>
      (left.vendor_updated_at ?? "").localeCompare(right.vendor_updated_at ?? "")
      || left.imported_session_id.localeCompare(right.imported_session_id)
      || left.sequence - right.sequence);
    const batch: PendingRecord[] = [];
    let characters = 0;
    for (const record of result.rows) {
      const size = (record.text?.length ?? 0) + (record.tool_input?.length ?? 0) + (record.tool_name?.length ?? 0);
      // Always take at least one, so a single oversized record is read (and
      // trimmed by the model's own limits) rather than blocking the queue
      // behind it forever.
      if (batch.length > 0 && characters + size > MAX_CHARACTERS_PER_EXTRACTION) break;
      batch.push(record);
      characters += size;
    }
    if (batch.length < result.rows.length) {
      const overflow = result.rows.slice(batch.length).map((record) => record.id);
      await this.db.query(
        `UPDATE imported_session_records SET extracted_in = NULL WHERE id = ANY($1::text[])`,
        [overflow],
      );
    }
    return batch;
  }

  /** Puts a claimed batch back, so a failure never costs the records it was reading. */
  private async releaseClaim(checkpointId: string): Promise<void> {
    await this.db.query(
      `UPDATE imported_session_records SET extracted_in = NULL, extracted_at = NULL WHERE extracted_in = $1`,
      [`claim:${checkpointId}`],
    ).catch(() => undefined);
  }

  /**
   * Releases claims whose extraction never finished.
   *
   * The claim and the proposals commit separately — the model call sits
   * between them and must not be inside a transaction — so a process that
   * dies in that window leaves records claimed forever. Compensation, not
   * atomicity, and worth saying plainly: the window is one model call wide,
   * and anything still claimed well past that is not coming back.
   */
  private async releaseStaleClaims(spaceId: string, projectId: string): Promise<void> {
    await this.db.query(
      `UPDATE imported_session_records r
          SET extracted_in = NULL, extracted_at = NULL
         FROM imported_sessions s
        WHERE s.id = r.imported_session_id
          AND r.space_id = $1 AND s.project_id = $2
          AND r.extracted_in LIKE 'claim:%'
          AND r.extracted_at < now() - interval '30 minutes'`,
      [spaceId, projectId],
    ).catch(() => undefined);
  }

  /**
   * Calls the model with the checkpoint contract.
   *
   * `input_kind` tells it what it is reading: several external transcripts of
   * work already done, not the increment of a conversation in progress.
   * Without that the same prompt reads the material as the current turn and
   * describes finished work as pending.
   */
  private async runExtractor(
    identity: SpaceUserIdentity,
    projectId: string,
    records: readonly PendingRecord[],
  ): Promise<SemanticCheckpointExtraction> {
    const dates = records.map((record) => record.vendor_updated_at).filter((value): value is string => !!value).sort();
    const material = records.map((record) => ({
      canonical_ref: { type: "imported_session_record", id: record.id },
      session: record.session_title ?? record.imported_session_id,
      runtime: record.adapter_type,
      kind: record.kind,
      text: record.text,
      tool: record.tool_name ? { name: record.tool_name, status: record.tool_status, input: record.tool_input } : null,
    }));
    const completion = await completeProviderText(resolveProviderCommandStore(this.config), identity.spaceId, {
      provider_id: "",
      model: null,
      system: SEMANTIC_CHECKPOINT_SYSTEM_PROMPT,
      user: JSON.stringify({
        input_kind: "imported_session_history",
        coverage: {
          sessions: new Set(records.map((record) => record.imported_session_id)).size,
          records: records.length,
          runtimes: [...new Set(records.map((record) => record.adapter_type))],
          from: dates[0] ?? null,
          to: dates[dates.length - 1] ?? null,
        },
        previous_checkpoint: null,
        selected_event_delta: material,
      }),
      max_tokens: 4_000,
      task: TASK,
      // No retrieval egress policy, like every other bounded provider task
      // here: that policy constrains indexed *source* content by its
      // connection's rules, and this is the person's own transcripts, which
      // they imported and marked shared themselves.
      metering: { subject_user_id: identity.userId, project_id: projectId },
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(completion.text);
    } catch {
      throw new HttpError(502, "The extractor did not return usable JSON");
    }
    const validated = SemanticCheckpointExtractionSchema.safeParse(parsed);
    if (!validated.success) {
      throw new HttpError(502, `The extractor's output did not match the checkpoint contract: ${validated.error.issues[0]?.message ?? "invalid"}`);
    }
    // Refs the model invented are dropped rather than trusted: a citation that
    // does not resolve is worse than none, because the reader cannot tell.
    const known = new Set(records.map((record) => record.id));
    const keep = <T extends { source_refs: Array<{ id: string }> }>(entries: T[]): T[] => entries
      // Each ref is checked, not merely each entry: an entry citing one real
      // record and one invented id would otherwise keep the invented one, and
      // a citation that cannot be opened is worse than none because the reader
      // cannot tell which is which.
      .map((entry) => ({ ...entry, source_refs: entry.source_refs.filter((ref) => known.has(ref.id)) }))
      .filter((entry) => entry.source_refs.length > 0);
    return {
      ...validated.data,
      decisions: keep(validated.data.decisions),
      constraints: keep(validated.data.constraints),
      facts: keep(validated.data.facts),
    };
  }

  /**
   * A Brief draft for the Project owner to publish.
   *
   * Goes through the Project's own definition proposal so there is one
   * approval path to the active Brief, and so the existing definition carries
   * forward untouched where this extraction has nothing to say. The goal is
   * only written when the Project has none: history says how work went, not
   * what the Project is for.
   */
  private async proposeBrief(
    db: Queryable,
    identity: SpaceUserIdentity,
    projectId: string,
    input: {
      goals: SemanticCheckpointExtraction["goals"];
      decisions: SemanticCheckpointExtraction["decisions"];
      constraints: SemanticCheckpointExtraction["constraints"];
    },
  ): Promise<string | null> {
    const active = await new ProjectKernelService(db).getActiveBriefVersion(identity, projectId);
    // A Project with no goal gets one proposed, from what the extraction
    // actually read and with the records it came from cited — never a
    // placeholder, because the next Run reads the goal as the Project's
    // purpose. With no goal from either side there is nothing to define, and
    // the caller keeps the decisions as memory candidates rather than losing
    // them.
    const existingGoal = typeof active?.goal === "string" ? active.goal.trim() : "";
    const goal = existingGoal || input.goals[0]?.text?.trim() || "";
    if (!goal) return null;
    const existingDecisions = Array.isArray(active?.confirmed_decisions) ? active.confirmed_decisions : [];
    // Strings, because that is what `confirmed_decisions` is everywhere —
    // protocol schema, Brief write request, and web type. An object here parses
    // fine into the proposal and then fails 422 at acceptance, which is a
    // proposal nobody can ever accept. The citations ride in `source_refs`,
    // which does take objects.
    const decisions = input.decisions.map((entry) => entry.text);
    // One extraction's Brief proposal per Project at a time. `FOR UPDATE`
    // below cannot lock a proposal that does not exist yet, so two overlapping
    // extractions would each find nothing pending and each create one —
    // restoring exactly the silent-loss this merge exists to prevent. The key
    // is the one the Project's own definition path already uses, and it is
    // re-entrant within a transaction, so nesting cannot deadlock.
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`project-definition-propose:${identity.spaceId}:${projectId}`],
    );

    // Merge into a Brief proposal already waiting rather than opening a second
    // one. Each proposal carries a *complete* replacement for
    // `confirmed_decisions`, so two pending ones silently drop each other's
    // work: accepting the first publishes its list, accepting the second
    // overwrites it. The agent path avoids this with its own reuse guard,
    // which is keyed on an agent id this caller does not have.
    //
    // Deliberately not scoped to this user. A Project with two paired machines
    // has two people extracting into it — the case this feature exists for —
    // and a per-user query finds nothing, creates a second proposal, and loses
    // the first person's decisions exactly as before. What is merged is
    // additive (decisions, constraints, citations); the goal is untouched.
    const pending = await db.query<{ id: string; payload_json: Record<string, unknown> }>(
      `SELECT id, payload_json FROM proposals
        WHERE space_id = $1 AND project_id = $2 AND proposal_type = 'project_brief_publish'
          AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE`,
      [identity.spaceId, projectId],
    );
    const waiting = pending.rows[0];
    if (waiting) {
      const payload = waiting.payload_json ?? {};
      const priorDecisions = Array.isArray(payload.confirmed_decisions) ? payload.confirmed_decisions as string[] : [];
      const priorRefs = Array.isArray(payload.source_refs) ? payload.source_refs : [];
      const merged = {
        ...payload,
        confirmed_decisions: [...priorDecisions, ...decisions.filter((text) => !priorDecisions.includes(text))],
        source_refs: [...priorRefs, ...input.goals.flatMap((entry) => entry.source_refs), ...input.decisions.flatMap((entry) => entry.source_refs)],
        // Built on what the waiting proposal already holds, not on the active
        // Brief: the whole premise of merging is that the proposal has not
        // been accepted, so the active Brief does not yet contain the earlier
        // extraction's constraints and computing from it would overwrite them.
        ...mergedConstraints(
          typeof payload.constraints === "string" ? payload.constraints : null,
          input.constraints,
        ),
      };
      await db.query(
        `UPDATE proposals SET payload_json = $2::jsonb, updated_at = now() WHERE id = $1`,
        [waiting.id, JSON.stringify(merged)],
      );
      return waiting.id;
    }

    const body: Record<string, unknown> = {
      goal,
      ...mergedConstraints(typeof active?.constraints === "string" ? active.constraints : null, input.constraints),
    };
    const { proposal } = await new ProjectDefinitionProposalService(db).proposeDefinition(
      identity,
      projectId,
      body,
      {
        // Passed as an explicit argument rather than a body key: the same
        // service backs an agent-callable action whose input schema is
        // passthrough, and a body key would let an agent replace a Project's
        // confirmed decisions — including emptying them — as a side effect.
        confirmedDecisions: [...existingDecisions, ...decisions.filter((text) => !existingDecisions.includes(text))],
        sourceRefs: [
          ...(Array.isArray(active?.source_refs) ? active.source_refs : []),
          ...input.goals.flatMap((entry) => entry.source_refs),
          ...input.decisions.flatMap((entry) => entry.source_refs),
        ],
      },
    );
    return String((proposal as { id: string }).id);
  }

  /**
   * One packet holding every candidate memory, not one proposal each.
   *
   * A Project's attention list has to stay short enough to read (ADR 0011
   * decision 6); a dozen separate memory proposals from one import would bury
   * everything else on it. Accepting the packet creates the child
   * `memory_create` proposals, which is where the actual review happens —
   * nothing here writes memory (ADR 0003).
   */
  private async proposeMemoryPacket(
    db: Queryable,
    identity: SpaceUserIdentity,
    projectId: string,
    facts: SemanticCheckpointExtraction["facts"],
    orphanedDecisions: SemanticCheckpointExtraction["decisions"],
    records: readonly PendingRecord[],
    checkpointId: string,
  ): Promise<string> {
    const bySession = new Map(records.map((record) => [record.id, record.imported_session_id]));
    const candidates = [...facts, ...orphanedDecisions].map((entry) => ({
      text: entry.text,
      source_record_ids: entry.source_refs.map((ref) => ref.id).filter((id) => bySession.has(id)),
      source_session_ids: [...new Set(
        entry.source_refs.map((ref) => bySession.get(ref.id)).filter((id): id is string => !!id),
      )],
    }));
    const row = await insertProposalRow(db, {
      spaceId: identity.spaceId,
      proposalType: IMPORTED_HISTORY_PACKET_PROPOSAL_TYPE,
      title: `${candidates.length} thing${candidates.length === 1 ? "" : "s"} learned from imported CLI history`,
      summary: candidates.slice(0, 3).map((candidate) => candidate.text).join(" · "),
      payload: {
        operation: IMPORTED_HISTORY_PACKET_PROPOSAL_TYPE,
        project_id: projectId,
        checkpoint_id: checkpointId,
        candidates,
      },
      rationale:
        "Candidate project memories extracted from imported CLI history. Accepting this packet creates one memory proposal per candidate; it writes no memory itself.",
      createdByUserId: identity.userId,
      ownerUserId: identity.userId,
      // Visible to the Project, reviewed by the person who ran the
      // extraction. Deliberately not `review_scope: "space_ops"`: that gate is
      // a Space setting that is off unless an admin turns it on, so declaring
      // it would leave the packet reviewable by nobody. The person who asked
      // for the extraction is a Project writer and the host's owner, and they
      // are the right reviewer for what their own import produced.
      visibility: "space_shared",
      riskLevel: "medium",
      projectId,
    });
    return row.id;
  }
}
