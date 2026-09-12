import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { loadConfig } from "../src/config.js";
import {
  authorizeCredentialSpend,
  CredentialSpendDeniedError,
  type CredentialSpendRun,
} from "../src/modules/policy/credentialSpend.js";
import { resolveProviderCommandStore } from "../src/modules/providers/commands/store.js";
import { completeProviderText } from "../src/modules/providers/invocation/invocation.js";
import { dailyReportSpend } from "../src/modules/dailyReports/service.js";
import { PgDailyReportSettingsRepository } from "../src/modules/dailyReports/repository.js";

const SPACE = "c5c5c5c5-0000-4000-8000-000000000001";
const OWNER = "c5c5c5c5-0000-4000-8000-000000000002";
const PROJECT = "c5c5c5c5-0000-4000-8000-000000000003";
const AGENT = "c5c5c5c5-0000-4000-8000-000000000004";
const VERSION = "c5c5c5c5-0000-4000-8000-000000000005";

const db = useTestDatabase(import.meta.filename);
const config = () => loadConfig({ SERVER_DATABASE_URL: db.connectionUri });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["policy_decision_records", "automation_credential_grants", "automation_runs", "automations", "runs", "agent_versions", "agents", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function insertRun(origin: string, root: string | null = null): Promise<CredentialSpendRun> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       owner_user_id, root_run_id, parent_run_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'agent',$5,'queued','live',$6,$7,$7,now(),now())`,
    [id, SPACE, AGENT, VERSION, origin, OWNER, root],
  );
  return { id, space_id: SPACE, parent_run_id: root, trigger_origin: origin, contract_snapshot_json: null };
}

/** An Automation that fired `runId`, and the id of its active credential grant. */
async function automationFired(runId: string): Promise<{ grant: string }> {
  const automation = randomUUID();
  await db.pool.query(
    `INSERT INTO automations (id, space_id, owner_user_id, agent_id, name, trigger_type, status, config_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'Nightly','schedule','active','{}'::jsonb,now(),now())`,
    [automation, SPACE, OWNER, AGENT],
  );
  await db.pool.query(
    `INSERT INTO automation_runs (id, automation_id, run_id, triggered_by_user_id, trigger_type, created_at)
     VALUES ($1,$2,$3,$4,'schedule',now())`,
    [randomUUID(), automation, runId, OWNER],
  );
  const grant = randomUUID();
  await db.pool.query(
    `INSERT INTO automation_credential_grants (id, space_id, automation_id, granted_by_user_id, status, created_at)
     VALUES ($1,$2,$3,$4,'active',now())`,
    [grant, SPACE, automation, OWNER],
  );
  return { grant };
}

async function revoke(grant: string): Promise<void> {
  await db.pool.query(
    `UPDATE automation_credential_grants SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $2 WHERE id = $1`,
    [grant, OWNER],
  );
}

function spend(basis: Parameters<typeof authorizeCredentialSpend>[1]["basis"]) {
  return authorizeCredentialSpend(config(), { space_id: SPACE, provider_id: null, basis });
}

describe("credential spend authority", () => {
  it("lets a person spend and records the decision", async () => {
    if (!db.available) return;
    const authorization = await spend({ kind: "person", user_id: OWNER });

    expect(authorization.trigger_origin).toBe("manual");
    const record = await db.pool.query<{ decision: string; actor_type: string; actor_id: string; policy_rule_id: string }>(
      `SELECT decision, actor_type, actor_id, policy_rule_id FROM policy_decision_records WHERE id = $1`,
      [authorization.policy_decision_record_id],
    );
    expect(record.rows[0]).toEqual({
      decision: "allow",
      actor_type: "user",
      actor_id: OWNER,
      policy_rule_id: "credential_same_space_manual_allow",
    });
  });

  it("lets an Automation Run spend only while its Automation holds a grant, read at spend time", async () => {
    if (!db.available) return;
    const run = await insertRun("automation");
    await expect(spend({ kind: "run", run })).rejects.toBeInstanceOf(CredentialSpendDeniedError);

    const { grant } = await automationFired(run.id);
    await expect(spend({ kind: "run", run })).resolves.toMatchObject({ trigger_origin: "automation" });

    // Revoked while the Run was queued: the grant stamped at fire no longer
    // decides anything, so the next spend is refused.
    await revoke(grant);
    await expect(spend({ kind: "run", run })).rejects.toBeInstanceOf(CredentialSpendDeniedError);
  });

  it("decides a delegated child on its root, not on its own origin", async () => {
    if (!db.available) return;
    const personRoot = await insertRun("manual");
    const attendedChild = await insertRun("delegation", personRoot.id);
    await expect(spend({ kind: "run", run: attendedChild })).resolves.toMatchObject({ trigger_origin: "manual" });

    const automationRoot = await insertRun("automation");
    const { grant } = await automationFired(automationRoot.id);
    const unattendedChild = await insertRun("delegation", automationRoot.id);
    await expect(spend({ kind: "run", run: unattendedChild })).resolves.toMatchObject({ trigger_origin: "automation" });
    await revoke(grant);
    await expect(spend({ kind: "run", run: unattendedChild })).rejects.toBeInstanceOf(CredentialSpendDeniedError);
  });

  it("spends a scheduled daily report only while its setting is on, refusing before any key is resolved", async () => {
    if (!db.available) return;
    const settings = new PgDailyReportSettingsRepository(db.pool);
    const setting = await settings.update(SPACE, OWNER, { enabled: true });
    const store = resolveProviderCommandStore(config());
    const resolveKey = vi.spyOn(store, "getInvocationTarget");
    const report = () => completeProviderText(store, SPACE, {
      provider_id: "",
      system: "Summarize.",
      user: "captures",
      task: "daily_report",
      metering: { subject_user_id: OWNER },
      spend: dailyReportSpend(db.pool, { spaceId: SPACE, userId: OWNER, setting, triggerOrigin: "automation" }),
    });

    // Allowed: it goes on to resolve a key, and fails only because this Space
    // has no provider to resolve.
    await expect(report()).rejects.not.toBeInstanceOf(CredentialSpendDeniedError);
    expect(resolveKey).toHaveBeenCalled();

    resolveKey.mockClear();
    await settings.update(SPACE, OWNER, { enabled: false });
    await expect(report()).rejects.toBeInstanceOf(CredentialSpendDeniedError);
    expect(resolveKey).not.toHaveBeenCalled();
  });

  it("lets the person who asked for a daily report spend whatever the setting says", async () => {
    if (!db.available) return;
    const setting = await new PgDailyReportSettingsRepository(db.pool).update(SPACE, OWNER, { enabled: false });
    const basis = dailyReportSpend(db.pool, { spaceId: SPACE, userId: OWNER, setting, triggerOrigin: "manual" });
    await expect(spend(basis)).resolves.toMatchObject({ trigger_origin: "manual" });
  });
});
