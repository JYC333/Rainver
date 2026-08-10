import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import { ContextWindowReconciliationRepository } from "../src/modules/runtimeContext";
import { revalidateExecutionDestination } from "../src/modules/runtimeContext/productionAcquisition";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE_ID = "10000000-0000-4000-8000-000000000001";
const INVOCATION_ID = "10000000-0000-4000-8000-000000000002";
const PROVIDER_SPACE_ID = "10000000-0000-4000-8000-000000000003";
const PROVIDER_ID = "10000000-0000-4000-8000-000000000004";
const DELIVERY_ID = "10000000-0000-4000-8000-000000000006";
const RETRY_DELIVERY_ID = "10000000-0000-4000-8000-000000000007";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[runtime-context-planner-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query("TRUNCATE context_window_reconciliations, spaces CASCADE");
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Runtime Context', 'personal', now(), now())`,
    [SPACE_ID],
  );
});

describe("Runtime Context token reconciliation", () => {
  it("revalidates a subscription CLI against its immutable adapter authority", async () => {
    if (!available || !pool) return;
    const control = {
      space_id: SPACE_ID,
      egress: {
        destination_type: "local_cli" as const,
        destination_id: "codex_cli",
        sensitivity_ceiling: "highly_restricted" as const,
        external_egress_allowed: true,
        allowed_provider_ids: [],
      },
    };
    await expect(revalidateExecutionDestination(pool, control, "codex_cli"))
      .resolves.toBe("external_provider");
    await expect(revalidateExecutionDestination(pool, control, "opencode"))
      .rejects.toThrow("not authorized by the control snapshot");
  });

  it("revalidates an adapter-compatible upstream through a cross-space provider grant", async () => {
    if (!available || !pool) return;
    await pool.query(
      `INSERT INTO spaces (id, name, type, created_at, updated_at)
       VALUES ($1, 'Provider Home', 'personal', now(), now())`,
      [PROVIDER_SPACE_ID],
    );
    await pool.query(
      `INSERT INTO model_providers (
         id, space_id, name, provider_type, base_url, enabled,
         capabilities_json, config_json, created_at, updated_at
       ) VALUES ($1,$2,'Shared Provider','ollama','http://localhost:11434',TRUE,
         '{}'::jsonb,'{"openai_compatible_base_url":"http://localhost:8080/v1"}'::jsonb,now(),now())`,
      [PROVIDER_ID, PROVIDER_SPACE_ID],
    );
    await pool.query(
      `INSERT INTO model_provider_space_grants (
         id, provider_id, space_id, enabled, is_default, created_at, updated_at
       ) VALUES ('10000000-0000-4000-8000-000000000005',$1,$2,TRUE,FALSE,now(),now())`,
      [PROVIDER_ID, SPACE_ID],
    );

    await expect(revalidateExecutionDestination(pool, {
      space_id: SPACE_ID,
      egress: {
        destination_type: "model_provider",
        destination_id: PROVIDER_ID,
        sensitivity_ceiling: "highly_restricted",
        external_egress_allowed: true,
        allowed_provider_ids: [PROVIDER_ID],
      },
    }, "opencode")).resolves.toBe("local_provider");
  });

  it("persists the immutable plan and reconciles provider-reported prompt tokens once", async () => {
    if (!available || !pool) return;
    const repository = new ContextWindowReconciliationRepository(pool);
    await repository.recordPlan({
      spaceId: SPACE_ID,
      invocationId: INVOCATION_ID,
      deliveryId: DELIVERY_ID,
      plan: {
        model: "gpt-5.6",
        model_catalog_version: "model-catalog.test",
        tokenizer_version: "tokenizer.test",
        total_window_tokens: 10_000,
        reserved_output_tokens: 1_000,
        provider_overhead_tokens: 100,
        planned_prompt_tokens: 600,
        allocations: { current_input: 600 },
        decisions: [{ item_id: "message", decision: "included", reason: "required", planned_tokens: 600 }],
        overflow_blockers: [],
      },
    });
    await repository.recordPlan({
      spaceId: SPACE_ID,
      invocationId: INVOCATION_ID,
      deliveryId: DELIVERY_ID,
      plan: {
        model: "gpt-5.6",
        model_catalog_version: "model-catalog.test",
        tokenizer_version: "tokenizer.test",
        total_window_tokens: 10_000,
        reserved_output_tokens: 1_000,
        provider_overhead_tokens: 100,
        planned_prompt_tokens: 600,
        allocations: { current_input: 600 },
        decisions: [{ item_id: "message", decision: "included", reason: "required", planned_tokens: 600 }],
        overflow_blockers: [],
      },
    });
    await expect(repository.recordPlan({
      spaceId: SPACE_ID,
      invocationId: INVOCATION_ID,
      deliveryId: DELIVERY_ID,
      plan: {
        model: "gpt-5.6",
        model_catalog_version: "model-catalog.test",
        tokenizer_version: "tokenizer.test",
        total_window_tokens: 10_000,
        reserved_output_tokens: 1_000,
        provider_overhead_tokens: 100,
        planned_prompt_tokens: 601,
        allocations: { current_input: 601 },
        decisions: [{ item_id: "message", decision: "included", reason: "required", planned_tokens: 601 }],
        overflow_blockers: [],
      },
    })).rejects.toThrow("different context window plan");
    await repository.reconcile({ spaceId: SPACE_ID, invocationId: INVOCATION_ID, deliveryId: DELIVERY_ID, actualPromptTokens: 625 });
    await expect(repository.reconcile({
      spaceId: SPACE_ID,
      invocationId: INVOCATION_ID,
      deliveryId: DELIVERY_ID,
      actualPromptTokens: 625,
    })).resolves.toBeUndefined();
    const row = (await pool.query(
      `SELECT planned_prompt_tokens, actual_prompt_tokens, delta_tokens, status
         FROM context_window_reconciliations WHERE space_id=$1 AND invocation_id=$2`,
      [SPACE_ID, INVOCATION_ID],
    )).rows[0];
    expect(row).toMatchObject({
      planned_prompt_tokens: 600,
      actual_prompt_tokens: 625,
      delta_tokens: 25,
      status: "over",
    });
    await expect(repository.reconcile({
      spaceId: SPACE_ID,
      invocationId: INVOCATION_ID,
      deliveryId: DELIVERY_ID,
      actualPromptTokens: 620,
    })).rejects.toThrow("different token count");
    await repository.recordPlan({
      spaceId: SPACE_ID,
      invocationId: INVOCATION_ID,
      deliveryId: RETRY_DELIVERY_ID,
      plan: {
        model: "gpt-5.6",
        model_catalog_version: "model-catalog.test",
        tokenizer_version: "tokenizer.test",
        total_window_tokens: 10_000,
        reserved_output_tokens: 1_000,
        provider_overhead_tokens: 100,
        planned_prompt_tokens: 601,
        allocations: { current_input: 601 },
        decisions: [{ item_id: "message", decision: "included", reason: "required", planned_tokens: 601 }],
        overflow_blockers: [],
      },
    });
    await repository.reconcile({
      spaceId: SPACE_ID,
      invocationId: INVOCATION_ID,
      deliveryId: RETRY_DELIVERY_ID,
      actualPromptTokens: 601,
    });
    expect((await pool.query(
      `SELECT delivery_id,status FROM context_window_reconciliations
        WHERE space_id=$1 AND invocation_id=$2 ORDER BY delivery_id`,
      [SPACE_ID, INVOCATION_ID],
    )).rows).toEqual([
      { delivery_id: DELIVERY_ID, status: "over" },
      { delivery_id: RETRY_DELIVERY_ID, status: "matched" },
    ]);
  });
});
