import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config";
import { resolveProviderCommandStore } from "../src/modules/providers/commands/store";
import { useTestDatabase } from "./support/testDatabase";

const SPACE = "72000000-0000-4000-8000-000000000001";
const USER = "72000000-0000-4000-8000-000000000002";
const PROVIDER = "72000000-0000-4000-8000-000000000003";


const db = useTestDatabase(__filename);

beforeAll(async () => {
  if (!db.available) return;
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Provider task','personal',now(),now())`, [SPACE]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',now(),now())`, [USER]);
  await db.pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,'owner','active',now(),now())`,
    [randomUUID(), SPACE, USER],
  );
});

describe("Provider task audit persistence", () => {
  it("creates distinct immutable control/delivery/snapshot/Usage refs and closes the snapshot", async () => {
    if (!db.available) return;
    const store = resolveProviderCommandStore({
      databaseUrl: db.connectionUri,
      agentSpaceHome: "/tmp/provider-task-audit-test",
    } as ServerConfig);
    const first = await store.beginProviderTaskAttempt!({
      space_id: SPACE,
      task: "retrieval_synthesis",
      owner_domain: "retrieval",
      provider_id: PROVIDER,
      model: "test-model",
      input_fingerprint: "a".repeat(64),
      metering: {
        space_id: SPACE,
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        subject_user_id: USER,
      },
    });
    const second = await store.beginProviderTaskAttempt!({
      space_id: SPACE,
      task: "retrieval_synthesis",
      owner_domain: "retrieval",
      provider_id: PROVIDER,
      model: "test-model",
      input_fingerprint: "a".repeat(64),
      metering: {
        space_id: SPACE,
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        subject_user_id: USER,
      },
    });
    expect(first.delivery_id).not.toBe(second.delivery_id);
    expect(first.invocation_snapshot_id).not.toBe(second.invocation_snapshot_id);
    await store.completeProviderTaskAttempt!(first, { status: "accepted" });
    await store.completeProviderTaskAttempt!(second, { status: "failed", error_code: "provider_timeout" });

    const rows = await db.pool.query<{
      delivery_id: string;
      status: string;
      error_code: string | null;
      control_id: string;
      usage_source_id: string;
    }>(
      `SELECT delivery.id AS delivery_id,snapshot.status,snapshot.error_code,
              delivery.control_id,delivery.usage_source_id
         FROM provider_task_deliveries delivery
         JOIN provider_task_snapshots snapshot ON snapshot.delivery_id=delivery.id
        WHERE delivery.space_id=$1 ORDER BY delivery.created_at,delivery.id`,
      [SPACE],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ delivery_id: first.delivery_id, status: "accepted", error_code: null, control_id: first.control_id, usage_source_id: first.usage_source_id }),
      expect.objectContaining({ delivery_id: second.delivery_id, status: "failed", error_code: "provider_timeout", control_id: second.control_id, usage_source_id: second.usage_source_id }),
    ]));
  });
});
