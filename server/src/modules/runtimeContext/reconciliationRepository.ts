import { createHash, randomUUID } from "node:crypto";
import type { ContextWindowPlan } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { Queryable } from "../routeUtils/common";

export class ContextWindowReconciliationRepository {
  constructor(private readonly db: Queryable) {}

  async recordPlan(input: {
    spaceId: string;
    invocationId: string;
    deliveryId: string;
    plan: ContextWindowPlan;
  }): Promise<void> {
    const now = new Date().toISOString();
    const planJson = JSON.stringify(input.plan);
    const planHash = createHash("sha256").update(planJson).digest("hex");
    const inserted = await this.db.query(
      `INSERT INTO context_window_reconciliations (
         id, space_id, invocation_id, delivery_id, model, model_catalog_version,
         tokenizer_version, planned_prompt_tokens, plan_hash, plan_json, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'planned',$11,$11)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING id`,
      [randomUUID(), input.spaceId, input.invocationId, input.deliveryId,
        input.plan.model, input.plan.model_catalog_version, input.plan.tokenizer_version,
        input.plan.planned_prompt_tokens, planHash, planJson, now],
    );
    if (inserted.rows[0]) return;
    const existing = await this.db.query<{ delivery_id: string | null; plan_hash: string }>(
      `SELECT delivery_id, plan_hash FROM context_window_reconciliations
        WHERE space_id=$1 AND invocation_id=$2 AND delivery_id=$3`,
      [input.spaceId, input.invocationId, input.deliveryId],
    );
    const row = existing.rows[0];
    if (!row || row.plan_hash !== planHash || row.delivery_id !== input.deliveryId) {
      throw new Error("Invocation already has a different context window plan");
    }
  }

  async reconcile(input: {
    spaceId: string;
    invocationId: string;
    deliveryId: string;
    actualPromptTokens: number;
  }): Promise<void> {
    if (!Number.isInteger(input.actualPromptTokens) || input.actualPromptTokens < 0) {
      throw new Error("Actual prompt tokens must be a non-negative integer");
    }
    const result = await this.db.query(
      `UPDATE context_window_reconciliations
          SET actual_prompt_tokens=$4,
              delta_tokens=$4-planned_prompt_tokens,
              status=CASE WHEN $4=planned_prompt_tokens THEN 'matched'
                          WHEN $4<planned_prompt_tokens THEN 'under' ELSE 'over' END,
              updated_at=$5
        WHERE space_id=$1 AND invocation_id=$2 AND delivery_id=$3 AND actual_prompt_tokens IS NULL
        RETURNING id`,
      [input.spaceId, input.invocationId, input.deliveryId, input.actualPromptTokens, new Date().toISOString()],
    );
    if (result.rows[0]) return;
    const existing = await this.db.query<{ actual_prompt_tokens: number | null }>(
      `SELECT actual_prompt_tokens FROM context_window_reconciliations
        WHERE space_id=$1 AND invocation_id=$2 AND delivery_id=$3`,
      [input.spaceId, input.invocationId, input.deliveryId],
    );
    if (existing.rows[0]?.actual_prompt_tokens === input.actualPromptTokens) return;
    throw new Error(existing.rows[0]
      ? "Context window plan was reconciled with a different token count"
      : "Context window plan is missing");
  }
}
