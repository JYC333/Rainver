import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { loadConfig } from "../src/config";
import { PgCustomSourceHandlerRepository } from "../src/modules/sources/customSources/customSourceHandlerRepository";
import { HttpError } from "../src/modules/routeUtils/common";

// Real-PostgreSQL integration tests for PgCustomSourceHandlerRepository.
// Repository-level tests with a fake Queryable cannot catch the SQL bugs
// that only surface on the real schema (CHECK constraints, the
// space_id + source_connection_id same-space gate, FK behavior). These run
// the actual SQL against a throwaway Postgres (testcontainers) loaded with
// test/fixtures/sourceCustomSourceHandlersSchema.sql.
//
// Skips gracefully when Docker is unavailable so `npm test` runs everywhere.

const SCHEMA = readFileSync(
  join(process.cwd(), "test/fixtures/sourceCustomSourceHandlersSchema.sql"),
  "utf8",
);

const SPACE_A = "space-a";
const SPACE_B = "space-b";
const CUSTOM_SOURCE_SPACE_POLICY_SETTINGS_KEY = "source.custom_source.space_policy";
const CUSTOM_SOURCE_INSTANCE_RUNNER_SETTINGS_KEY = "source.custom_source.runner";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let repo: PgCustomSourceHandlerRepository | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename, { empty: true });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(SCHEMA);
    repo = new PgCustomSourceHandlerRepository(pool, loadConfig({}));
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[source-custom-source-handler-repository] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE source_handler_runs, source_handler_versions, source_connections,
              settings, space_memberships, proposals`,
  );
});

async function insertMembership(spaceId: string, userId: string, role: string): Promise<void> {
  await pool!.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', now(), now())`,
    [randomUUID(), spaceId, userId, role],
  );
}

async function insertConnection(spaceId: string, id: string): Promise<void> {
  await pool!.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status,
       capture_policy, trust_level, consent_json, policy_json, config_json,
       created_at, updated_at
     ) VALUES ($1, $2, 'mapping-1', 'user-1', $3, 'active',
       'reference_only', 'normal', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
    [id, spaceId, `Test source ${id}`],
  );
}

const POLICY_ENVELOPE = {
  allowed_network_origins: ["https://example.com"],
  capture_policy: "extract_text",
  retention_policy: "full_text",
  language: "typescript_node",
  limits: { timeout_ms: 30000, max_download_bytes: 1024, max_output_bytes: 1024, max_files: 5, max_items: 10, max_evidence_items: 10, log_max_bytes: 1024 },
};

async function insertHandlerVersion(
  spaceId: string,
  connectionId: string,
  id: string,
  versionNumber: number,
  status: string,
): Promise<void> {
  await pool!.query(
    `INSERT INTO source_handler_versions (
       id, space_id, source_connection_id, version_number, language, entrypoint,
       manifest_json, policy_envelope_json, checksum, status, created_at
     ) VALUES ($1, $2, $3, $4, 'typescript_node', 'index.js', '{}'::jsonb, $5::jsonb, 'sha256:x', $6, now())`,
    [id, spaceId, connectionId, versionNumber, JSON.stringify(POLICY_ENVELOPE), status],
  );
}

describe("PgCustomSourceHandlerRepository (real Postgres)", () => {
  it("requireConnection gates by space — a connection in space B is invisible to space A", async () => {
    if (!available || !repo) return;
    const connId = randomUUID();
    await insertConnection(SPACE_B, connId);
    await expect(repo!.listHandlerVersions({ spaceId: SPACE_A, userId: "u" }, connId, { limit: 10, offset: 0 }))
      .rejects.toThrow(HttpError);
  });

  it("listHandlerVersions returns only versions for the requested connection, newest first", async () => {
    if (!available || !repo) return;
    const connId = randomUUID();
    const otherConnId = randomUUID();
    await insertConnection(SPACE_A, connId);
    await insertConnection(SPACE_A, otherConnId);
    const v1 = randomUUID();
    const v2 = randomUUID();
    const otherV1 = randomUUID();
    await insertHandlerVersion(SPACE_A, connId, v1, 1, "superseded");
    await insertHandlerVersion(SPACE_A, connId, v2, 2, "active");
    await insertHandlerVersion(SPACE_A, otherConnId, otherV1, 1, "active");

    const result = await repo!.listHandlerVersions({ spaceId: SPACE_A, userId: "u" }, connId, { limit: 10, offset: 0 });
    expect(result.items.map((i: { id: string }) => i.id)).toEqual([v2, v1]);
  });

  it("getHandlerVersion 404s when the version belongs to a different connection", async () => {
    if (!available || !repo) return;
    const connId = randomUUID();
    const otherConnId = randomUUID();
    await insertConnection(SPACE_A, connId);
    await insertConnection(SPACE_A, otherConnId);
    const versionId = randomUUID();
    await insertHandlerVersion(SPACE_A, otherConnId, versionId, 1, "active");

    const result = await repo!.getHandlerVersion({ spaceId: SPACE_A, userId: "u" }, connId, versionId);
    expect(result).toBeNull();
  });

  it("getHandlerSummary reports the active version pinned via source_connections.active_handler_version_id", async () => {
    if (!available || !repo) return;
    const connId = randomUUID();
    await insertConnection(SPACE_A, connId);
    const v1 = randomUUID();
    await insertHandlerVersion(SPACE_A, connId, v1, 1, "active");
    await pool!.query(`UPDATE source_connections SET active_handler_version_id = $1 WHERE id = $2`, [v1, connId]);

    const summary = await repo!.getHandlerSummary({ spaceId: SPACE_A, userId: "u" }, connId);
    expect(summary.active_handler_version?.id).toBe(v1);
    expect(summary.latest_handler_run).toBeNull();
  });

  it("getSettings returns system defaults when no space policy row exists, and the configured row otherwise", async () => {
    if (!available || !repo) return;
    const defaults = await repo!.getSettings({ spaceId: SPACE_A, userId: "u" });
    expect(defaults.space.credentialed_sources_allowed).toBe(false);
    expect(defaults.space.download_bytes_max).toBe(5_242_880);
    expect(defaults.space.created_at).toBeNull();
    expect(defaults.instance.runner_enabled).toBe(true);
    expect(defaults.instance).not.toHaveProperty("download_bytes_max");
    const defaultEffective = await repo!.getEffectiveSettings({ spaceId: SPACE_A, userId: "u" });
    expect(defaultEffective.runner.download_bytes_max).toBe(5_242_880);

    await pool!.query(
      `INSERT INTO settings (
         id, scope_type, scope_id, settings_key, settings_json, created_at, updated_at
       ) VALUES ($1, 'space', $2, $3, $4::jsonb, now(), now())`,
      [
        randomUUID(),
        SPACE_A,
        CUSTOM_SOURCE_SPACE_POLICY_SETTINGS_KEY,
        JSON.stringify({
          creator_roles: ["owner"],
          default_capture_policy: "reference_only",
          default_retention_policy: "full_text",
          allowed_domains: ["example.com"],
          download_bytes_max: 2_097_152,
          credentialed_sources_allowed: true,
          same_envelope_repair_auto_apply: true,
        }),
      ],
    );
    const configured = await repo!.getSettings({ spaceId: SPACE_A, userId: "u" });
    expect(configured.space.creator_roles).toEqual(["owner", "admin"]);
    expect(configured.space.credentialed_sources_allowed).toBe(true);
    expect(configured.space.download_bytes_max).toBe(2_097_152);
    expect(configured.space.created_at).not.toBeNull();
    expect(configured.instance).not.toHaveProperty("download_bytes_max");
    const effective = await repo!.getEffectiveSettings({ spaceId: SPACE_A, userId: "u" });
    expect(effective.runner.download_bytes_max).toBe(2_097_152);
  });

  it("updateInstanceRunnerSettings upserts the singleton runner toggle", async () => {
    if (!available || !repo) return;
    const disabled = await repo!.updateInstanceRunnerSettings({ spaceId: SPACE_A, userId: "admin-1" }, {
      runner_enabled: false,
    });
    expect(disabled.runner_enabled).toBe(false);

    const defaultRead = await repo!.getInstanceRunnerSettings();
    expect(defaultRead.runner_enabled).toBe(false);
    expect(defaultRead).not.toHaveProperty("download_bytes_max");

    const enabled = await repo!.updateInstanceRunnerSettings({ spaceId: SPACE_A, userId: "admin-2" }, {
      runner_enabled: true,
    });
    expect(enabled.runner_enabled).toBe(true);

    const rows = await pool!.query<{ n: string; updated_by_user_id: string | null }>(
      `SELECT count(*)::text AS n, max(updated_by_user_id) AS updated_by_user_id
         FROM settings
        WHERE scope_type = 'instance' AND scope_id = 'instance' AND settings_key = $1`,
      [CUSTOM_SOURCE_INSTANCE_RUNNER_SETTINGS_KEY],
    );
    expect(rows.rows[0]).toMatchObject({ n: "1", updated_by_user_id: "admin-2" });
  });

  it("updateSpacePolicy requires owner/admin and upserts normalized product policy", async () => {
    if (!available || !repo) return;
    await insertMembership(SPACE_A, "member-1", "member");
    await expect(
      repo!.updateSpacePolicy({ spaceId: SPACE_A, userId: "member-1" }, {
        allowed_domains: ["example.com"],
      }),
    ).rejects.toThrow(HttpError);

    await insertMembership(SPACE_A, "admin-1", "admin");
    const updated = await repo!.updateSpacePolicy({ spaceId: SPACE_A, userId: "admin-1" }, {
      creator_roles: ["reviewer"],
      default_capture_policy: "reference_only",
      default_retention_policy: "summary_only",
      allowed_domains: ["https://Example.com/articles", "*.docs.example.com", "example.com"],
      download_bytes_max: 1_048_576,
      credentialed_sources_allowed: true,
      same_envelope_repair_auto_apply: true,
    });

    expect(updated).toMatchObject({
      creator_roles: ["owner", "admin", "reviewer"],
      default_capture_policy: "reference_only",
      default_retention_policy: "summary_only",
      allowed_domains: ["example.com", "docs.example.com"],
      download_bytes_max: 1_048_576,
      credentialed_sources_allowed: true,
      same_envelope_repair_auto_apply: true,
    });

    const row = await pool!.query<{
      updated_by_user_id: string | null;
      settings_json: {
        creator_roles: string[];
        allowed_domains: string[];
        download_bytes_max: number;
      };
    }>(
      `SELECT updated_by_user_id, settings_json
         FROM settings
        WHERE scope_type = 'space' AND scope_id = $1 AND settings_key = $2`,
      [SPACE_A, CUSTOM_SOURCE_SPACE_POLICY_SETTINGS_KEY],
    );
    expect(row.rows[0]).toMatchObject({
      updated_by_user_id: "admin-1",
      settings_json: {
        creator_roles: ["owner", "admin", "reviewer"],
        allowed_domains: ["example.com", "docs.example.com"],
        download_bytes_max: 1_048_576,
      },
    });
  });
});
