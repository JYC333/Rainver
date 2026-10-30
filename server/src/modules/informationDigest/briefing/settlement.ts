import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import { HttpError, withQueryableTransaction, type Queryable } from "../../routeUtils/common.js";
import type { RunRecord } from "../../runs/repository.js";
import { RunPreparationError } from "../../runs/orchestrationErrors.js";
import { runOutputResult } from "../../runs/orchestrationResults.js";
import { runFinalizationReconcilerRegistry } from "../../runs/finalizationReconcilerRegistry.js";
import { authorizeVersion, visibleResult } from "./authorization.js";
import type { BriefingEgress } from "./execution.js";
import { runDestination } from "../../runtimeContext/runDestination.js";
import { requestHash, type BriefingScopeAdapter } from "./contract.js";
import { projectBriefingScope } from "./projectScope.js";
import { personalBriefingScope } from "./personalScope.js";
import { PgBriefingRepository, type BriefingRow } from "./repository.js";
import { BriefingOutputError, parseBriefingOutput, validateBriefing, type ManifestRef } from "./result.js";
import { resumeHeldDays } from "./service.js";
import { isMeaningfulChange, notifyMeaningfulChange } from "./notifications.js";

/** The version and attempt a Run executes, from its immutable contract. */
export function briefingRunContext(run: { contract_snapshot_json?: unknown }): { id: string; attempt: number; scope_key: string } | null {
  const value = (run.contract_snapshot_json as { workflow_input_json?: { information_briefing?: unknown } } | null)?.workflow_input_json?.information_briefing;
  if (!value || typeof value !== "object") return null;
  const { id, attempt, scope_key: scopeKey } = value as Record<string, unknown>;
  return typeof id === "string" && typeof attempt === "number" && typeof scopeKey === "string" ? { id, attempt, scope_key: scopeKey } : null;
}

export function adapterForRow(row: Pick<BriefingRow, "space_id" | "scope_type" | "project_id" | "owner_user_id">): BriefingScopeAdapter {
  return row.scope_type === "project"
    ? projectBriefingScope(row.space_id, row.project_id!)
    : personalBriefingScope(row.space_id, row.owner_user_id!);
}

/**
 * A refused dispatch. It is a preparation failure with the briefing's own
 * code, so the terminal Run (and through settlement the version) records why,
 * and the Supervisor's managed fail-fast rule leaves it terminal.
 */
export class BriefingDispatchError extends RunPreparationError {
  constructor(readonly statusCode: 403 | 409, code: string, message: string) {
    super(code, message);
    this.name = "BriefingDispatchError";
  }
}

const TERMINAL = new Set(["succeeded", "degraded", "failed", "cancelled", "orphaned"]);

/**
 * Before the model is invoked (the orchestrator calls this before running,
 * after runtime preparation and right before the adapter): the Run is still
 * this version's current attempt; its requester may still generate it; its
 * Work Context still adds nothing beyond the frozen request; every dependency
 * of every included input and context entry is still readable by the whole
 * current audience and every Source behind them still consents to this
 * model; and nothing it froze has changed since. Anything else stops the Run
 * before it reads a word, and the version fails with that reason.
 *
 * "This model" is where the Run will actually send it. Once the Run is bound
 * to its adapter (`runtime_key`, and a ModelProvider when it calls one), that
 * binding fixes the destination (`runtimeContext/runDestination.ts`, the
 * classification the Delivery's egress authority uses) and the live runtime
 * Profile it was routed from no longer counts: it may have been edited since.
 * Only before binding is the candidate Profile what is checked. The Delivery
 * of the Run's request then repeats the check under its locks, on the
 * destination it is authorized for (`runtimeContext/gateway.ts`).
 */
export async function assertBriefingDispatch(config: ServerConfig, run: RunRecord, pool?: Queryable): Promise<void> {
  if (!briefingRunContext(run)) return;
  const db = pool ?? getDbPool(config.databaseUrl!);
  const egress: BriefingEgress = run.runtime_key
    ? { destination: await boundDestination(db, run) }
    : { agent_id: run.agent_id!, runtime_profile_id: run.requested_runtime_profile_id ?? run.runtime_profile_id! };
  await assertBriefingVersionDispatchable(db, run, egress);
}

/** The bound Run's destination; a binding that no longer resolves (its ModelProvider grant gone) is the briefing's refusal. */
async function boundDestination(db: Queryable, run: RunRecord) {
  try {
    return await runDestination(db, run.space_id, run);
  } catch (error) {
    if (error instanceof HttpError) throw new BriefingDispatchError(409, "briefing_access_changed", error.message);
    throw error;
  }
}

/** The Run fields a briefing dispatch is checked against. */
export type BriefingDispatchRun = Pick<RunRecord, "id" | "space_id" | "prompt" | "instruction" | "contract_snapshot_json" | "root_run_id">;

/**
 * The checks of `assertBriefingDispatch` for an already known egress target:
 * shared by the dispatch guard and the Delivery of the Run's request, so both
 * hold the version to one rule.
 */
export async function assertBriefingVersionDispatchable(db: Queryable, run: BriefingDispatchRun, egress: BriefingEgress): Promise<void> {
  const context = briefingRunContext(run);
  if (!context) return;
  const repository = new PgBriefingRepository(db);
  const row = await repository.get(run.space_id, context.id);
  if (!row || row.run_id !== run.id || row.status !== "queued") {
    throw new BriefingDispatchError(409, "briefing_superseded", "This briefing attempt is no longer current");
  }
  if (!row.request_hash || requestHash(run.prompt, run.instruction) !== row.request_hash) {
    throw new BriefingDispatchError(409, "briefing_inputs_changed", "This Run's request is not the one its briefing version froze");
  }
  const adapter = adapterForRow(row);
  if (!(await adapter.canGenerate(db, row.requested_by_user_id))) {
    throw new BriefingDispatchError(403, "briefing_access_changed", "The requester can no longer generate this briefing");
  }
  await assertNoAmbientContext(db, run);
  const authorization = await authorizeVersion(db, adapter, row, await repository.inputs(row.id), { egress, revisions: true });
  if (authorization.refs.some((ref) => !authorization.allowed.has(ref))) {
    throw new BriefingDispatchError(403, "briefing_access_changed", "Material or context in this briefing is no longer shared with its whole audience, or no longer allowed to reach this model");
  }
  if (authorization.changed.size > 0 || authorization.outdated) {
    throw new BriefingDispatchError(409, "briefing_inputs_changed", "Material, analysis or context changed after this briefing was frozen; request it again for a new version");
  }
}

/** The Run's Work Context must still be the closed one the briefing created: no retrieval, nothing pinned. */
async function assertNoAmbientContext(db: Queryable, run: Pick<RunRecord, "space_id" | "id" | "root_run_id">): Promise<void> {
  const setup = (await db.query<{ retrieval_off: boolean; pinned: number }>(
    `SELECT (retrieval_preferences_json->>'enabled') = 'false' AS retrieval_off,
            jsonb_array_length(COALESCE(pinned_refs_json, '[]'::jsonb)) AS pinned
       FROM work_context_setups
      WHERE space_id = $1 AND work_context_scope_id = $2
      ORDER BY version DESC LIMIT 1`,
    [run.space_id, run.root_run_id ?? run.id],
  )).rows[0];
  if (!setup || !setup.retrieval_off || setup.pinned > 0) {
    throw new BriefingDispatchError(403, "briefing_context_widened", "This briefing Run's context was opened beyond its frozen request");
  }
}

/**
 * Terminal projection of a briefing Run, run by canonical settlement (and
 * replayed by recovery until it completes). Only the version's current
 * attempt may settle it: a superseded attempt's late Run, or a second
 * replay, changes nothing. A Run still waiting (for review, a Host, a quota
 * window) is not terminal and settles nothing. A successful Run is published
 * only when its output passes the manifest's validation and, under the same
 * authorization rule as dispatch and reads, its overview still rests on what
 * the whole audience may read.
 */
export async function settleBriefingRun(db: Queryable, run: RunRecord): Promise<void> {
  const context = briefingRunContext(run);
  if (!context) return;
  const scope = await settleVersion(db, run, context);
  // The scope is free again: a sealed day held behind this version starts now (in its own transaction).
  if (scope) await resumeHeldDays(db, scope);
}

async function settleVersion(db: Queryable, run: RunRecord, context: NonNullable<ReturnType<typeof briefingRunContext>>): Promise<BriefingScopeAdapter | null> {
  return withQueryableTransaction(db, async (tx) => {
    const repository = new PgBriefingRepository(tx);
    const row = await repository.get(run.space_id, context.id, true);
    if (!row) return null;
    const adapter = adapterForRow(row);
    if (row.run_id !== run.id || row.status !== "queued") return adapter;
    const current = (await tx.query<Pick<RunRecord, "status" | "output_json" | "error_json" | "error_message">>(
      `SELECT status, output_json, error_json, error_message FROM runs WHERE space_id = $1 AND id = $2`,
      [run.space_id, run.id],
    )).rows[0];
    if (!current || !TERMINAL.has(current.status)) return null;
    if (current.status === "cancelled") {
      await repository.settle(row.space_id, row.id, run.id, { status: "cancelled", errorCode: "briefing_cancelled" });
      return adapter;
    }
    if (current.status !== "succeeded" && current.status !== "degraded") {
      const error = (current.error_json ?? {}) as { error_code?: unknown };
      await repository.settle(row.space_id, row.id, run.id, {
        status: "failed",
        errorCode: typeof error.error_code === "string" ? error.error_code.slice(0, 64) : "briefing_run_failed",
        errorMessage: current.error_message,
      });
      return adapter;
    }
    const inputs = await repository.inputs(row.id);
    const refs: ManifestRef[] = inputs.filter((input) => input.ref_key && input.status === "included").map((input) => ({
      key: input.ref_key!,
      kind: input.ref_kind,
      delta_class: input.delta_class as ManifestRef["delta_class"],
      unverified: input.analysis_json.unverified === true,
      source_domain: (input.analysis_json.source_domain as string | null | undefined) ?? null,
    }));
    let validated;
    try {
      const output = runOutputResult(current.output_json);
      const text = typeof output.output_text === "string" ? output.output_text : JSON.stringify(output);
      validated = validateBriefing(parseBriefingOutput(text), refs, row.comparison);
    } catch (error) {
      if (!(error instanceof BriefingOutputError)) throw error;
      await repository.settle(row.space_id, row.id, run.id, { status: "failed", errorCode: error.code, errorMessage: error.message });
      return adapter;
    }
    const authorization = await authorizeVersion(tx, adapter, row, inputs);
    if (visibleResult(validated, authorization.allowed).withheld) {
      await repository.settle(row.space_id, row.id, run.id, {
        status: "failed", errorCode: "briefing_access_changed",
        errorMessage: "Material or context behind the overview is no longer shared with the whole audience.",
      });
      return adapter;
    }
    const published = await repository.settle(row.space_id, row.id, run.id, { status: "ready", result: validated as unknown as Record<string, unknown> });
    // Only this transition notifies: a replay, a late attempt or a failure never reaches here with `published`.
    if (published && isMeaningfulChange(row, validated, authorization.allowed)) await notifyMeaningfulChange(tx, adapter, row);
    return adapter;
  });
}

export function registerBriefingSettlement(): void {
  runFinalizationReconcilerRegistry.register("information_briefing", { reconcile: (db, run) => settleBriefingRun(db, run) }, "informationDigest");
}
