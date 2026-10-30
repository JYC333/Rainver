import {
  BRIEFING_PROTOCOL_VERSION, type Briefing, type BriefingHighlight, type BriefingKind, type BriefingOverviewResponse,
} from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { HttpError, withQueryableTransaction, type Pool, type Queryable } from "../../routeUtils/common.js";
import { PgRunRepository } from "../../runs/repository.js";
import { RunBudgetExceededError } from "../../runs/budgetEnforcement.js";
import { PgJobQueueRepository } from "../../jobs/repository.js";
import { WorkContextService } from "../../runtimeContext/workContextService.js";
import { createManagedExecutionPolicy } from "../../policy/managedExecutionPolicy.js";
import { BRIEFING_LIMITS, contextSourceKey, requestHash, sha256, type BriefingContextEntry, type BriefingScopeAdapter } from "./contract.js";
import { authorizeVersion, comparisonClosure, inputDeps, visibleResult, type ComparisonEntry } from "./authorization.js";
import { selectExecution, sourceEgressAllowed, type BriefingExecution } from "./execution.js";
import { buildManifest, type PreviousVersion } from "./manifest.js";
import { PgBriefingRepository, type BriefingDeferredRequest, type BriefingRow } from "./repository.js";
import { briefingSummary, projectBriefing } from "./projection.js";
import { highlightDependencies } from "./result.js";

const BLOCKING_CODES: ReadonlySet<string> = new Set([
  "briefing_execution_setup_required", "briefing_budget_exhausted", "briefing_daily_limit", "briefing_writer_required",
]);

export { selectExecution, sourceEgressAllowed, type BriefingExecution } from "./execution.js";

export interface BriefingRequestInput {
  kind: BriefingKind;
  /** `daily`/`backfill`: the sealed digest day, its digest and end of day. */
  day?: { date: string; digestId: string | null; cutoff: string };
  execution: Partial<BriefingExecution>;
  /** `job`: a scheduled briefing the writer enabled; `manual`: a person's request now. */
  origin: "manual" | "job";
  /** The Automation whose budget a scheduled briefing also counts against. */
  automationId?: string | null;
  label: string;
}

/**
 * Generation, reads and cancellation of briefing versions for any scope.
 * Creation is one short transaction under the scope lock: freeze the
 * manifest, record the version, admit and enqueue one canonical Run. The
 * model runs outside it; the Run's terminal projection (`settlement.ts`)
 * settles the version. Reads never generate and never wait on a model.
 */
export class InformationBriefingService {
  constructor(private readonly db: Pool, private readonly config: ServerConfig) {}

  /**
   * One request, decided in one short transaction under the scope lock (see `decideRequest`).
   */
  async request(adapter: BriefingScopeAdapter, userId: string, input: BriefingRequestInput): Promise<{ created: boolean; briefing: Briefing }> {
    const outcome = await withQueryableTransaction(this.db, (tx) => decideRequest(tx, adapter, userId, input));
    return { created: outcome.created, briefing: await projectBriefing(this.db, new PgBriefingRepository(this.db), adapter, outcome.row) };
  }

  /**
   * The scheduled briefing of a sealed day. A refusal that a person must
   * resolve (no usable runtime, budget, daily limit, lost write access) is
   * recorded on the day as held (`blocked`) with its reason and request, and
   * retried in date order, not in a loop.
   */
  async requestDay(adapter: BriefingScopeAdapter, userId: string, input: BriefingRequestInput & { day: NonNullable<BriefingRequestInput["day"]> }) {
    try {
      return await this.request(adapter, userId, input);
    } catch (error) {
      const code = error instanceof HttpError ? (error.responseBody as { code?: string } | undefined)?.code : undefined;
      if (!code || !BLOCKING_CODES.has(code)) throw error;
      const row = await withQueryableTransaction(this.db, async (tx) => {
        const repository = new PgBriefingRepository(tx);
        await repository.lockScope(adapter.scope);
        const existing = await repository.findLiveDay(adapter.scope, input.day.date);
        if (existing) return existing;
        // A refused day is held only if it is in order now (the same check an idle request makes).
        await assertDayInOrder(repository, adapter, input.day.cutoff, (await repository.findInFlight(adapter.scope))?.id ?? null);
        const id = await repository.insertBlocked(adapter.scope, input.kind, input.day, userId, code, error instanceof Error ? error.message : code, deferredRequest(input));
        return (await repository.get(adapter.scope.spaceId, id))!;
      });
      return { created: false, briefing: await projectBriefing(this.db, new PgBriefingRepository(this.db), adapter, row) };
    }
  }

  async overview(adapter: BriefingScopeAdapter, viewerId: string, dailyEnabled: boolean): Promise<BriefingOverviewResponse> {
    if (!(await adapter.canRead(this.db, viewerId))) throw new HttpError(404, "Briefing not found");
    const repository = new PgBriefingRepository(this.db);
    const history = await repository.history(adapter.scope, BRIEFING_LIMITS.historyLength);
    const latest = history[0] ? await projectBriefing(this.db, repository, adapter, history[0]) : null;
    const published = await repository.latestPublished(adapter.scope);
    return {
      can_generate: await adapter.canGenerate(this.db, viewerId),
      daily_enabled: dailyEnabled,
      latest,
      latest_briefing: !published ? null : published.id === latest?.id ? latest : await projectBriefing(this.db, repository, adapter, published),
      history: history.map(briefingSummary),
    };
  }

  async get(adapter: BriefingScopeAdapter, viewerId: string, briefingId: string): Promise<Briefing> {
    if (!(await adapter.canRead(this.db, viewerId))) throw new HttpError(404, "Briefing not found");
    const repository = new PgBriefingRepository(this.db);
    const row = await repository.get(adapter.scope.spaceId, briefingId);
    if (!row || row.scope_key !== adapter.scope.key) throw new HttpError(404, "Briefing not found");
    return projectBriefing(this.db, repository, adapter, row);
  }

  /** Stops the current attempt through the canonical Run stop; its terminal projection records the cancellation. */
  async cancel(adapter: BriefingScopeAdapter, userId: string, briefingId: string): Promise<Briefing> {
    if (!(await adapter.canGenerate(this.db, userId))) throw new HttpError(403, "Cancelling this briefing requires write access", { code: "briefing_writer_required" });
    const repository = new PgBriefingRepository(this.db);
    const row = await repository.get(adapter.scope.spaceId, briefingId);
    if (!row || row.scope_key !== adapter.scope.key) throw new HttpError(404, "Briefing not found");
    if (row.status === "queued" && row.run_id) {
      const { buildRunOrchestration } = await import("../../runs/orchestrationFactory.js");
      await buildRunOrchestration(this.config).orchestration.cancelRun({
        run_id: row.run_id, space_id: row.space_id, requested_by_user_id: userId, reason: "Briefing cancelled",
      });
    }
    return projectBriefing(this.db, repository, adapter, (await repository.get(adapter.scope.spaceId, briefingId))!);
  }
}

/**
 * The previous published version as comparison for the next: its inputs
 * (pending ones are carried), the families already briefed, and those of its
 * highlights the whole audience may still read and whose every Source still
 * consents to this execution's model — never its text without its material.
 */
async function comparisonBase(
  db: Queryable,
  repository: PgBriefingRepository,
  adapter: BriefingScopeAdapter,
  published: BriefingRow,
  cutoff: string,
  execution: BriefingExecution,
): Promise<PreviousVersion> {
  const inputs = await repository.inputs(published.id);
  const authorization = await authorizeVersion(db, adapter, published, inputs, { egress: execution });
  const shown = visibleResult(published.result_json as Parameters<typeof visibleResult>[0], authorization.allowed);
  const familyOf = new Map(inputs.filter((input) => input.ref_key && input.family_key).map((input) => [input.ref_key!, input.family_key!]));
  // The closure of a previous highlight's text: what it cited there, and what that version inherited in turn.
  const depsOf = new Map(inputs.filter((input) => input.ref_kind === "source_item" && input.ref_key).map((input) => [input.ref_key!, inputDeps(input)]));
  const contextOf = new Map(published.context_json.map((entry) => [entry.key, entry.source as BriefingContextEntry["source"]]));
  const inherited = comparisonClosure(published.comparison_json as ComparisonEntry[]);
  const closureOf = (highlight: BriefingHighlight) => {
    const refs = highlightDependencies(highlight);
    const cited = refs.flatMap((ref) => (depsOf.has(ref) ? [depsOf.get(ref)!] : []));
    const unique = <T extends { id: string }>(rows: T[], key: (row: T) => string = (row) => row.id) => [...new Map(rows.map((row) => [key(row), row])).values()];
    return {
      deps: {
        items: unique([...inherited.deps.items, ...cited.flatMap((dep) => dep.items)]),
        annotations: unique([...inherited.deps.annotations, ...cited.flatMap((dep) => dep.annotations)]),
        signals: unique([...inherited.deps.signals, ...cited.flatMap((dep) => dep.signals)], (row) => `${row.kind}:${row.id}`),
      },
      context: unique([...inherited.context, ...refs.flatMap((ref) => (contextOf.has(ref) ? [contextOf.get(ref)!] : []))], contextSourceKey),
    };
  };
  return {
    id: published.id,
    cutoff_at: new Date(published.cutoff_at).toISOString(),
    context_hash: published.context_hash,
    inputs: await repository.previousInputs(published.id),
    known: await repository.knownFamilies(adapter.scope, cutoff),
    highlights: shown.highlights.map((highlight) => ({
      title: highlight.title,
      what_changed: highlight.what_changed,
      families: [...new Set(highlightDependencies(highlight).filter((ref) => familyOf.has(ref)).map((ref) => familyOf.get(ref)!))],
      ...closureOf(highlight as BriefingHighlight),
    })).filter((highlight) => highlight.families.length > 0),
  };
}

/**
 * A briefing Run reads only its frozen request. Its Work Context (scope: the
 * Run) is created with automatic retrieval off and nothing pinned, so the
 * requester's own Memory, Library or other private material can never join a
 * result shared with the audience. The dispatch guard refuses the Run if this
 * setup is later changed.
 */
async function closeAmbientContext(db: Queryable, spaceId: string, userId: string, runId: string, execution: BriefingExecution): Promise<void> {
  await new WorkContextService(db as Pool).create({ spaceId, userId }, {
    work_context_scope_id: runId,
    scope_kind: "root_task",
    project_id: null,
    project_folder_id: null,
    agent_id: execution.agent_id,
    runtime_ref: { type: "runtime_profile", id: execution.runtime_profile_id },
    pinned_refs: [],
    excluded_refs: [],
    retrieval_preferences: { enabled: false },
    continuity_preferences: {},
    base_version: null,
    reason: "Briefing Run: its frozen manifest is its only material (no automatic retrieval, nothing pinned)",
  });
}

/**
 * The request a version froze, read back from its last attempt's Run and
 * checked against the version's request hash. If it cannot be read back
 * exactly, the version is not retried under its old identity.
 */
async function frozenRequest(db: Queryable, row: BriefingRow): Promise<{ prompt: string; instruction: string }> {
  const run = row.run_id
    ? (await db.query<{ prompt: string | null; instruction: string | null }>(
      `SELECT prompt, instruction FROM runs WHERE space_id = $1 AND id = $2`, [row.space_id, row.run_id],
    )).rows[0]
    : undefined;
  if (!run || !row.request_hash || requestHash(run.prompt, run.instruction) !== row.request_hash) {
    throw new HttpError(409, "This briefing version can no longer be reproduced exactly", { code: "briefing_version_stale" });
  }
  return { prompt: run.prompt ?? "", instruction: run.instruction ?? "" };
}

/**
 * One request, decided under the scope lock:
 * - a live version of the same sealed day is returned;
 * - a sealed day that cannot start now — another version of the scope is
 *   being generated, or an earlier sealed day is still held — is held: a
 *   `blocked` day with its reason, its own cut-off and its deferred request.
 *   It never borrows the in-flight version as its result. Held days start in
 *   date order: when the scope's current version settles (its projection
 *   calls `resumeHeldDays`), on the next daily fire, or on an explicit retry;
 * - otherwise the current manifest is frozen against the latest published
 *   version; its business key is the substantive state (published chain
 *   position, input and context hashes, protocol, execution), never the
 *   request time. The same state returns the same version — a ready one
 *   (its `checked_at` bookkept), or a failed one retried with exactly the
 *   same frozen request. Changed state is a new version; a sealed day's
 *   earlier unsuccessful version stays as history beside it;
 * - no news and no changed context needs no model Run.
 */
async function decideRequest(tx: Queryable, adapter: BriefingScopeAdapter, userId: string, input: BriefingRequestInput): Promise<{ created: boolean; row: BriefingRow }> {

    const repository = new PgBriefingRepository(tx);
    if (!(await adapter.canGenerate(tx, userId))) throw new HttpError(403, "Generating this briefing requires write access", { code: "briefing_writer_required" });
    await repository.lockScope(adapter.scope);
    // A held day (recorded, not started) keeps its place: it is ordered only against other sealed days.
    let held = false;
    if (input.day) {
      const live = await repository.findLiveDay(adapter.scope, input.day.date);
      if (live && live.status !== "blocked") return { created: false, row: live };
      const inFlight = await repository.findInFlight(adapter.scope);
      const earlier = await repository.oldestPendingDay(adapter.scope, input.day.date);
      if (inFlight || earlier) {
        // Only a day that is in order now may be held: the version in flight is a temporary wait,
        // never an exemption from history already published after this day.
        if (!live) await assertDayInOrder(repository, adapter, input.day.cutoff, inFlight?.id ?? null);
        // One Run per scope, and sealed days in date order: hold this day with its reason and request.
        const row = live ?? (await repository.get(adapter.scope.spaceId, await repository.insertBlocked(
          adapter.scope, input.kind, input.day, userId,
          inFlight ? "briefing_scope_busy" : "briefing_earlier_day_pending",
          inFlight ? "Another briefing of this scope is being generated; this day starts when it ends." : "An earlier day is briefed first; this day starts after it.",
          deferredRequest(input),
        )))!;
        if (!inFlight && earlier) await startHeldDay(tx, adapter, earlier);
        return { created: false, row: (await repository.get(adapter.scope.spaceId, row.id))! };
      }
      if (live) {
        held = live.request_json !== null;
        await repository.removeBlocked(adapter.scope.spaceId, live.id);
      }
    }
    const inFlight = await repository.findInFlight(adapter.scope);
    if (inFlight) return { created: false, row: inFlight };
    const cutoff = input.day?.cutoff ?? new Date().toISOString();
    if (input.day) {
      // Versions form a chain in cutoff order; a sealed day earlier than the chain cannot be inserted behind it.
      // A held day was checked in order when it was held: since then only a later sealed day can precede it.
      if (held) {
        const latest = await repository.latestDayCutoff(adapter.scope);
        if (latest && Date.parse(latest) > Date.parse(cutoff)) throw historyBeforeLatest();
      } else {
        await assertDayInOrder(repository, adapter, cutoff, null);
      }
    }
    const execution = await selectExecution(tx, adapter.scope.spaceId, userId, input.execution);
    const published = await repository.latestPublished(adapter.scope, cutoff);
    const previous = published ? await comparisonBase(tx, repository, adapter, published, cutoff, execution) : null;
    const manifest = await buildManifest(tx, adapter, {
      cutoff,
      previous,
      label: input.label,
      egressAllowed: (connectionId) => sourceEgressAllowed(tx, adapter.scope.spaceId, connectionId, execution),
    });
    const requestKey = sha256([
      adapter.scope.key, input.day ? ["day", input.day.date] : input.kind, previous?.id ?? null,
      manifest.input_hash, manifest.context_hash, BRIEFING_PROTOCOL_VERSION, execution.agent_id, execution.runtime_profile_id,
    ]);
    const existing = await repository.findByRequestKey(adapter.scope, requestKey);
    if (existing && (existing.status === "ready" || existing.status === "queued")) {
      if (existing.status === "ready") await repository.touchChecked(adapter.scope.spaceId, existing.id);
      return { created: false, row: (await repository.get(adapter.scope.spaceId, existing.id))! };
    }
    if (!existing && !manifest.needs_run) {
      // Nothing to synthesize: say which nothing, without spending a model Run.
      const id = await repository.insert({
        scope: adapter.scope, kind: input.kind, periodDate: input.day?.date ?? null, digestId: input.day?.digestId ?? null,
        manifest, previousId: previous?.id ?? null, protocolVersion: BRIEFING_PROTOCOL_VERSION, requestKey,
        status: "ready", outcome: manifest.coverage.candidates === 0 && !previous ? "no_material" : "no_new_material",
        requestedByUserId: userId, agentId: execution.agent_id, runtimeProfileId: execution.runtime_profile_id,
      });
      return { created: true, row: (await repository.get(adapter.scope.spaceId, id))! };
    }
    if (existing && existing.attempt >= BRIEFING_LIMITS.maxAttemptsPerVersion) {
      throw new HttpError(409, "This briefing version used its attempts; it can be generated again once its material changes", { code: "briefing_attempts_exhausted" });
    }
    if (await repository.runsInLastDay(adapter.scope) >= BRIEFING_LIMITS.maxRunsPerScopePerDay) {
      throw new HttpError(429, "This briefing reached its daily generation limit", { code: "briefing_daily_limit" });
    }
    // A retry sends exactly the request the version froze (its previous attempt's, verified by hash), never a re-render.
    const frozen = existing ? await frozenRequest(tx, existing) : { prompt: manifest.prompt, instruction: manifest.instruction };
    const id = existing?.id ?? await repository.insert({
      scope: adapter.scope, kind: input.kind, periodDate: input.day?.date ?? null, digestId: input.day?.digestId ?? null,
      manifest, previousId: previous?.id ?? null, protocolVersion: BRIEFING_PROTOCOL_VERSION, requestKey,
      requestHash: requestHash(frozen.prompt, frozen.instruction),
      status: "queued", outcome: null, requestedByUserId: userId,
      agentId: execution.agent_id, runtimeProfileId: execution.runtime_profile_id,
    });
    const row = (await repository.get(adapter.scope.spaceId, id, true))!;
    let run;
    try {
      run = await new PgRunRepository(tx).createQueuedRunWithBudgetAdmission({
        execution_kind: "agent",
        space_id: adapter.scope.spaceId,
        user_id: userId,
        project_id: adapter.scope.projectId,
        agent_id: execution.agent_id,
        runtime_profile_id: execution.runtime_profile_id,
        runtime_profile_selection_source: "explicit",
        mode: "live",
        run_type: "agent",
        trigger_origin: input.origin,
        visibility: "private",
        capabilities_json: [],
        scenario_tool_allowance: [],
        prompt: frozen.prompt,
        instruction: frozen.instruction,
        contract_snapshot: {
          source: { kind: "direct", id: row.id },
          project_id: adapter.scope.projectId,
          workflow_input_json: { information_briefing: { id: row.id, attempt: row.attempt + 1, scope_key: adapter.scope.key } },
          structured_output_json: { schema: BRIEFING_PROTOCOL_VERSION },
          max_attempts: 1,
          max_duration_seconds: BRIEFING_LIMITS.runSeconds,
          risk_level: "low",
          ...(input.automationId ? { budget_sources: [{ source: { kind: "automation" as const, id: input.automationId } }] } : {}),
          // The briefing owns its failure (fail-fast, settled by its projection); only a
          // scheduled briefing a writer enabled carries a credential pre-authorization.
          policy_context_json: createManagedExecutionPolicy("information_briefing", input.origin === "job"),
        },
      });
    } catch (error) {
      if (error instanceof RunBudgetExceededError) throw new HttpError(429, error.message, { code: "briefing_budget_exhausted" });
      throw error;
    }
    await closeAmbientContext(tx, adapter.scope.spaceId, userId, run.id, execution);
    if (!(await repository.startAttempt(adapter.scope.spaceId, row.id, row.attempt, run.id))) {
      throw new HttpError(409, "This briefing changed while it was being started", { code: "briefing_changed" });
    }
    await new PgJobQueueRepository(tx).enqueue({
      job_type: "agent_run", space_id: adapter.scope.spaceId, user_id: userId, agent_id: execution.agent_id,
      payload: { run_id: run.id }, max_attempts: 1,
    });
    return { created: true, row: (await repository.get(adapter.scope.spaceId, row.id))! };
}

function historyBeforeLatest(): HttpError {
  return new HttpError(422, "A later briefing already exists; earlier days cannot be briefed after it", { code: "briefing_history_before_latest" });
}

/**
 * The history rule for a sealed day: no version of the scope (published, or
 * being generated other than `exceptId`) may have a later cut-off. Checked
 * before a day is generated and before a day is held, so holding never makes
 * an out-of-order day legitimate.
 */
async function assertDayInOrder(repository: PgBriefingRepository, adapter: BriefingScopeAdapter, cutoff: string, exceptId: string | null): Promise<void> {
  const latest = await repository.latestChainCutoff(adapter.scope, exceptId);
  if (latest && Date.parse(latest) > Date.parse(cutoff)) throw historyBeforeLatest();
}

function deferredRequest(input: BriefingRequestInput): BriefingDeferredRequest {
  return {
    origin: input.origin, automation_id: input.automationId ?? null, label: input.label,
    agent_id: input.execution.agent_id ?? null, runtime_profile_id: input.execution.runtime_profile_id ?? null,
  };
}

/** Starts a held day with its own deferred request; a refusal is recorded on the day, which stays held. */
async function startHeldDay(tx: Queryable, adapter: BriefingScopeAdapter, held: BriefingRow): Promise<void> {
  const request = held.request_json!;
  await tx.query("SAVEPOINT briefing_held_day");
  try {
    await decideRequest(tx, adapter, held.requested_by_user_id, {
      kind: held.kind,
      day: { date: held.period_date!, digestId: held.digest_id, cutoff: new Date(held.cutoff_at).toISOString() },
      execution: { agent_id: request.agent_id ?? undefined, runtime_profile_id: request.runtime_profile_id ?? undefined },
      origin: request.origin,
      automationId: request.automation_id,
      label: request.label,
    });
    await tx.query("RELEASE SAVEPOINT briefing_held_day");
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    await tx.query("ROLLBACK TO SAVEPOINT briefing_held_day");
    const code = (error.responseBody as { code?: string } | undefined)?.code ?? "briefing_request_failed";
    await new PgBriefingRepository(tx).updateBlocked(held.space_id, held.id, code, error.message);
  }
}

/**
 * After a version of the scope settles: while nothing else is being
 * generated, start held sealed days earliest first (one that needs no Run
 * completes at once and the next follows; one that starts a Run, or stays
 * held, ends the pass). Called by the briefing projection in
 * canonical settlement (replayed by recovery), so no other loop exists.
 */
export async function resumeHeldDays(db: Queryable, adapter: BriefingScopeAdapter): Promise<void> {
  await withQueryableTransaction(db, async (tx) => {
    const repository = new PgBriefingRepository(tx);
    await repository.lockScope(adapter.scope);
    // Each held day at most once: stop when one starts a Run, or stays held.
    for (const seen = new Set<string>(); ;) {
      if (await repository.findInFlight(adapter.scope)) return;
      const held = await repository.oldestPendingDay(adapter.scope);
      if (!held || seen.has(held.id)) return;
      seen.add(held.id);
      await startHeldDay(tx, adapter, held);
      if (await repository.get(adapter.scope.spaceId, held.id)) return;
    }
  });
}
