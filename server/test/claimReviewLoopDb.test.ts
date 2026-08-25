import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { buildClaimTrajectory, scanClaimContradictions } from "../src/modules/knowledge/claimReviewLoop";

// Real-PostgreSQL coverage for the Slice E claim review loop. FakeDb unit tests
// can't catch SQL-facing bugs in CLAIM_COLUMNS/CLAIM_FROM joins or the readable
// space-object visibility gate, so this exercises the real queries.

const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUBJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[claim-review-loop-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["claim_sources", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "claims", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  for (const id of [VIEWER, OTHER]) {
    await pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'User', 'active', now(), now())`,
      [id],
    );
  }
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Claim Review Loop Space', 'household', $2, now(), now())`,
    [SPACE, VIEWER],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, VIEWER],
  );
  // Subject the seeded claims point at (claims.subject_object_id has an FK to
  // space_objects).
  await pool.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, summary, visibility, owner_user_id, created_by_user_id, created_at, updated_at) VALUES ($1, $2, 'knowledge_item', 'Subject', 'Subject', 'space_shared', $3, $3, now(), now())`,
    [SUBJECT, SPACE, VIEWER],
  );
});

interface InsertClaimInput {
  id: string;
  claimText: string;
  subjectObjectId?: string | null;
  subjectText?: string | null;
  claimKind?: string;
  status?: string;
  visibility?: string;
  ownerUserId?: string | null;
  confidence?: number;
  resolutionState?: string;
  createdAt?: string;
}

async function insertClaim(input: InsertClaimInput): Promise<void> {
  const createdAt = input.createdAt ?? "2026-01-01T00:00:00.000Z";
  const owner = input.ownerUserId === undefined ? VIEWER : input.ownerUserId;
  await pool!.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, summary, visibility, owner_user_id, created_by_user_id, created_at, updated_at) VALUES ($1, $2, 'claim', $3, left($4, 200), $5, $6, $6, $7::timestamptz, $7::timestamptz)`,
    [input.id, SPACE, input.claimText.slice(0, 60), input.claimText, input.visibility ?? "space_shared", owner, createdAt],
  );
  await pool!.query(
    `INSERT INTO claims (
       object_id, space_id, status, subject_object_id, subject_text, claim_kind,
       claim_text, normalized_claim_hash, confidence, confidence_method,
       resolution_state, valid_from, metadata_json
     ) VALUES ($1, $2, $10, $3, $4, $5, $6, md5($6), $7, 'human_confirmed', $8, $9::timestamptz, '{}'::jsonb)`,
    [
      input.id,
      SPACE,
      input.subjectObjectId === undefined ? SUBJECT : input.subjectObjectId,
      input.subjectText ?? null,
      input.claimKind ?? "fact",
      input.claimText,
      input.confidence ?? 0.5,
      input.resolutionState ?? "unreviewed",
      createdAt,
      input.status ?? "active",
    ],
  );
}

async function insertSourceConnection(input: { id: string; connectorId: string; ownerUserId: string }): Promise<void> {
  await pool!.query(
    `INSERT INTO source_connectors (
       id, connector_key, display_name, connector_type, ingestion_mode, status,
       capabilities_json, created_at, updated_at
     ) VALUES ($1, $2, 'Test connector', 'external_url', 'manual', 'active', '{}'::jsonb, now(), now())`,
    [input.connectorId, `test-${input.connectorId}`],
  );
  await pool!.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, 'Test provider', 'generic', 'test', 'active', '{}'::jsonb, now(), now())`,
    [input.connectorId, `test-${input.connectorId}`],
  );
  await pool!.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
     VALUES ($1,$1,$1,'active',0,'{}'::jsonb,now(),now())`,
    [input.connectorId],
  );
  const consent = {
    schema_version: 1,
    owner_user_id: input.ownerUserId,
    allowed_reader_user_ids: [],
    allowed_agent_ids: [],
    allow_space_admins: false,
    allow_local_provider_egress: true,
    allow_external_model_egress: true,
  };
  const policy = {
    schema_version: 1,
    source_egress_class: "external_provider_allowed",
  };
  await pool!.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status,
       capture_policy, trust_level, topic_hints_json, consent_json, policy_json,
       config_json, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'Denied source', 'active',
       'reference_only', 'normal', '[]'::jsonb, $5::jsonb, $6::jsonb,
       '{}'::jsonb, now(), now()
     )`,
    [input.id, SPACE, input.connectorId, input.ownerUserId, JSON.stringify(consent), JSON.stringify(policy)],
  );
}

async function insertClaimSource(input: { id: string; claimId: string; sourceConnectionId: string }): Promise<void> {
  await pool!.query(
    `INSERT INTO claim_sources (
       id, space_id, claim_id, source_connection_id, evidence_role,
       source_trust, confidence, metadata_json, created_by_user_id, created_at
     ) VALUES ($1, $2, $3, $4, 'supports', 'normal', 0.8, '{}'::jsonb, $5, now())`,
    [input.id, SPACE, input.claimId, input.sourceConnectionId, VIEWER],
  );
}

describe("Slice E claim review loop (real Postgres)", () => {
  it("builds trajectory signals over visible claims about a subject", async () => {
    if (!available || !pool) return;
    await insertClaim({ id: "c1", claimText: "Plan ships in Q1.", status: "superseded", confidence: 0.4, createdAt: "2026-01-01T00:00:00.000Z" });
    await insertClaim({ id: "c2", claimText: "Plan ships in Q2.", status: "active", confidence: 0.9, createdAt: "2026-02-01T00:00:00.000Z" });

    const result = await buildClaimTrajectory(pool, { spaceId: SPACE, userId: VIEWER, subjectObjectId: SUBJECT, limit: 100 });
    expect(result.points.map((p) => p.claim_id)).toEqual(["c1", "c2"]);
    const kinds = result.signals.map((s) => s.kind);
    expect(kinds).toContain("supersession");
    expect(kinds).toContain("confidence_shift");
  });

  it("filters trajectory claims whose source policy denies the viewer", async () => {
    if (!available || !pool) return;
    const connectionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await insertClaim({ id: "c1", claimText: "Plan ships in Q1.", createdAt: "2026-01-01T00:00:00.000Z" });
    await insertClaim({ id: "c2", claimText: "Plan ships in Q2.", createdAt: "2026-02-01T00:00:00.000Z" });
    await insertSourceConnection({
      id: connectionId,
      connectorId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ownerUserId: OTHER,
    });
    await insertClaimSource({ id: "claim-source-denied", claimId: "c2", sourceConnectionId: connectionId });

    const result = await buildClaimTrajectory(pool, { spaceId: SPACE, userId: VIEWER, subjectObjectId: SUBJECT, limit: 100 });

    expect(result.points.map((point) => point.claim_id)).toEqual(["c1"]);
    expect(result.canonical_write_performed).toBe(false);
  });

  it("scan flags a negation contradiction and excludes claims the viewer cannot read", async () => {
    if (!available || !pool) return;
    await insertClaim({ id: "a", claimText: "The backup job runs every night." });
    await insertClaim({ id: "b", claimText: "The backup job does not run every night." });
    // Same subject + contradicting, but private to OTHER -> the viewer must not
    // see it, so no extra pairing leaks a hidden claim.
    await insertClaim({ id: "hidden", claimText: "The backup job never runs.", visibility: "private", ownerUserId: OTHER });

    const report = await scanClaimContradictions(pool, { spaceId: SPACE, userId: VIEWER, limit: 200, maxFindings: 40 });
    expect(report.candidates_examined).toBe(2);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.signal).toBe("negation");
    expect(report.findings[0]!.proposed_action).toMatchObject({ link_type: "contradicts" });
  });
});
