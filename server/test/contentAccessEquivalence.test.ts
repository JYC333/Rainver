import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { contentDecisionFromDb } from "../src/modules/access/contentAccessQuery";
import { decideContentAccess } from "../src/modules/access/contentAccessPolicy";
import { contentResourceDefinition } from "../src/modules/access/contentAccessRegistry";
import { contentAccessLevelSql, contentReadSql } from "../src/modules/access/contentAccessSql";
import type { ContentAccessGrant, OversightMode } from "../src/modules/access/contentAccessTypes";
import { memoryAccessDecision } from "../src/modules/memory/memoryReadAuth";
import { memorySensitivityReadSql } from "../src/modules/memory/memorySensitivitySql";

// The read predicate exists twice: once as SQL (contentAccessSql, used to filter
// rows in-database) and once as a pure function (decideContentAccess, used where
// a row is already loaded). This test seeds a real table across the visibility ×
// grant × Space-oversight-mode matrix and asserts both implementations agree on
// every case, so the two definitions cannot silently diverge.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "22222222-2222-4222-8222-222222222222";
const OTHER_SPACE = "33333333-3333-4333-8333-333333333333";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GRANTEE_FULL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GRANTEE_SUMMARY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INACTIVE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ADMIN = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CROSS_SPACE = "99999999-9999-4999-8999-999999999999";

const OVERSIGHT_MODES: readonly OversightMode[] = ["none", "summary", "content", "full"];
// Each case performs the complete real-Postgres visibility × grant matrix.
// Keep the timeout local to these integration cases rather than loosening the
// suite-wide default for unit tests.
const ACCESS_MATRIX_TIMEOUT_MS = 15_000;
const MEMBERSHIPS: readonly [string, "owner" | "admin" | "member", "active" | "removed"][] = [
  [OWNER, "owner", "active"],
  [MEMBER, "member", "active"],
  [GRANTEE_FULL, "member", "active"],
  [GRANTEE_SUMMARY, "member", "active"],
  [ADMIN, "admin", "active"],
  [INACTIVE, "member", "removed"],
];

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (err) {
    console.warn(
      `[content-access-equivalence] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedSpace(oversightMode: OversightMode): Promise<void> {
  await pool!.query(
    `TRUNCATE content_access_grants, artifacts, space_memberships, users, spaces CASCADE`,
  );
  for (const id of [...MEMBERSHIPS.map(([memberId]) => memberId), CROSS_SPACE]) {
    await pool!.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'User', 'active', now(), now())`,
      [id],
    );
  }
  await pool!.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, oversight_mode, created_at, updated_at)
     VALUES ($1, 'Access Space', 'household', $2, $3, now(), now())`,
    [SPACE, OWNER, oversightMode],
  );
  await pool!.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, oversight_mode, created_at, updated_at)
     VALUES ($1, 'Other Space', 'team', $2, 'none', now(), now())`,
    [OTHER_SPACE, OWNER],
  );
  for (const [id, role, status] of MEMBERSHIPS) {
    await pool!.query(
      `INSERT INTO space_memberships
         (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [randomUUID(), SPACE, id, role, status],
    );
  }
  await pool!.query(
    `INSERT INTO space_memberships
       (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
    [randomUUID(), OTHER_SPACE, CROSS_SPACE],
  );
}

/** Mirrors resolveOversightLevel: raw Space mode when the viewer is an active owner/admin, else 'none'. */
function expectedOversightLevel(spaceOversightMode: OversightMode, viewerId: string): OversightMode {
  const membership = MEMBERSHIPS.find(([id]) => id === viewerId);
  if (!membership) return "none";
  const [, role, status] = membership;
  if (status !== "active" || (role !== "owner" && role !== "admin")) return "none";
  return spaceOversightMode;
}

interface Fixture {
  visibility: "private" | "space_shared" | "selected_users";
  accessLevel: "full" | "summary";
}

async function seedArtifact(fixture: Fixture): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO artifacts
       (id, space_id, artifact_type, title, export_formats_json, visibility,
        access_level, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, 'note', 'Fixture', '[]'::jsonb, $3, $4, $5, now(), now())`,
    [id, SPACE, fixture.visibility, fixture.accessLevel, OWNER],
  );
  await insertGrant(id, GRANTEE_FULL, "full");
  await insertGrant(id, GRANTEE_SUMMARY, "summary");
  return id;
}

async function insertGrant(
  resourceId: string,
  granteeUserId: string,
  accessLevel: "full" | "summary",
): Promise<void> {
  await pool!.query(
    `INSERT INTO content_access_grants
       (id, space_id, resource_type, resource_id, grantee_user_id, granted_by_user_id,
        access_level, created_at, updated_at, revoked_at)
     VALUES ($1, $2, 'artifact', $3, $4, $5, $6, now(), now(), NULL)`,
    [randomUUID(), SPACE, resourceId, granteeUserId, OWNER, accessLevel],
  );
}

async function seedHighlyRestrictedMemory(): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO memory_entries
       (id, space_id, scope_type, memory_type, content, status, owner_user_id,
        sensitivity_level, visibility, access_level, confidence, importance,
        version, access_count, created_at, updated_at)
     VALUES ($1, $2, 'user', 'fact', 'Restricted fixture', 'active', $3,
             'highly_restricted', 'private', 'full', 1, 1, 1, 0, now(), now())`,
    [id, SPACE, OWNER],
  );
  return id;
}

async function memoryDecisionFromDb(userId: string, memoryId: string): Promise<"deny" | "summary" | "full"> {
  const definition = contentResourceDefinition("memory")!;
  const result = await pool!.query<{ effective_access_level: string }>(
    `SELECT ${contentAccessLevelSql({ definition, alias: "me", userExpr: "$3" })} AS effective_access_level
       FROM memory_entries me
      WHERE me.space_id = $1
        AND me.id = $2
        AND ${contentReadSql("memory", "me", "$3")}
        AND ${memorySensitivityReadSql("me", "$3")}`,
    [SPACE, memoryId, userId],
  );
  const level = result.rows[0]?.effective_access_level;
  return level === "full" || level === "summary" ? level : "deny";
}

const FIXTURES: Fixture[] = (["private", "space_shared", "selected_users"] as const).flatMap(
  (visibility) => (["full", "summary"] as const).map((accessLevel) => ({ visibility, accessLevel })),
);

const VIEWERS = [OWNER, MEMBER, GRANTEE_FULL, GRANTEE_SUMMARY, ADMIN, INACTIVE, CROSS_SPACE];
const GRANTS: ContentAccessGrant[] = [
  { grantee_user_id: GRANTEE_FULL, access_level: "full", revoked_at: null },
  { grantee_user_id: GRANTEE_SUMMARY, access_level: "summary", revoked_at: null },
];

describe("content access SQL/in-memory equivalence", () => {
  it.each(OVERSIGHT_MODES)(
    "agrees with the in-memory policy across the visibility matrix — oversight_mode=%s",
    async (oversightMode) => {
      if (!available || !pool) return;
      await seedSpace(oversightMode);
      for (const fixture of FIXTURES) {
        const id = await seedArtifact(fixture);
        for (const viewer of VIEWERS) {
          const isCrossSpaceViewer = viewer === CROSS_SPACE;
          const viewerSpaceId = isCrossSpaceViewer ? OTHER_SPACE : SPACE;
          const sqlDecision = await contentDecisionFromDb(pool, { spaceId: viewerSpaceId, userId: viewer }, "artifact", id);
          const memoryDecision = decideContentAccess(
            {
              id,
              space_id: SPACE,
              owner_user_id: OWNER,
              visibility: fixture.visibility,
              access_level: fixture.accessLevel,
            },
            {
              spaceId: viewerSpaceId,
              userId: viewer,
              activeSpaceMember: viewer !== INACTIVE && !isCrossSpaceViewer,
              scopeAllowed: true,
              oversightLevel: expectedOversightLevel(oversightMode, viewer),
            },
            GRANTS,
          );
          expect(
            sqlDecision,
            `oversight_mode=${oversightMode} visibility=${fixture.visibility} access_level=${fixture.accessLevel} viewer=${viewer}`,
          ).toBe(memoryDecision);
        }
      }
    },
    ACCESS_MATRIX_TIMEOUT_MS,
  );

  it("merges an admin's summary grant with full oversight using widest-wins", async () => {
    if (!available || !pool) return;
    await seedSpace("full");
    const id = await seedArtifact({ visibility: "selected_users", accessLevel: "summary" });
    await insertGrant(id, ADMIN, "summary");

    const sqlDecision = await contentDecisionFromDb(pool, { spaceId: SPACE, userId: ADMIN }, "artifact", id);
    const memoryDecision = decideContentAccess(
      {
        id,
        space_id: SPACE,
        owner_user_id: OWNER,
        visibility: "selected_users",
        access_level: "summary",
      },
      {
        spaceId: SPACE,
        userId: ADMIN,
        activeSpaceMember: true,
        scopeAllowed: true,
        oversightLevel: "full",
      },
      [...GRANTS, { grantee_user_id: ADMIN, access_level: "summary", revoked_at: null }],
    );

    expect(memoryDecision).toBe("full");
    expect(sqlDecision).toBe(memoryDecision);
  });

  it.each(OVERSIGHT_MODES)(
    "keeps highly_restricted memory owner-only unless oversight_mode=%s",
    async (oversightMode) => {
      if (!available || !pool) return;
      await seedSpace(oversightMode);
      const id = await seedHighlyRestrictedMemory();
      const adminSqlDecision = await memoryDecisionFromDb(ADMIN, id);
      const expectedAdminDecision = oversightMode === "full" ? "full" : "deny";
      const adminMemoryDecision = memoryAccessDecision(
        {
          id,
          space_id: SPACE,
          deleted_at: null,
          sensitivity_level: "highly_restricted",
          visibility: "private",
          access_level: "full",
          owner_user_id: OWNER,
          scope_type: "user",
          project_folder_id: null,
        },
        {
          spaceId: SPACE,
          userId: ADMIN,
          oversightLevel: expectedOversightLevel(oversightMode, ADMIN),
        },
      );

      expect(adminMemoryDecision).toBe(expectedAdminDecision);
      expect(adminSqlDecision).toBe(adminMemoryDecision);
      expect(await memoryDecisionFromDb(OWNER, id)).toBe("full");
    },
    ACCESS_MATRIX_TIMEOUT_MS,
  );
});
