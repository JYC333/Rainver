import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { PgSpaceRepository, type SpaceFailure, type SpaceResult } from "../src/modules/spaces/repository";

let repo: PgSpaceRepository | undefined;

const db = useTestDatabase(__filename);

beforeAll(async () => {
  if (!db.available) return;
  repo = new PgSpaceRepository(db.pool);
});

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Creator', 'active', now(), now())`,
    [id],
  );
  return id;
}

function isFailure(value: SpaceResult | SpaceFailure): value is SpaceFailure {
  return "statusCode" in value;
}

describe("PgSpaceRepository.createSpace — immutable and defaulted Space policy", () => {
  it("accepts a valid oversight_mode and stores it", async () => {
    if (!db.available || !repo) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Full Oversight Team", type: "team", oversight_mode: "full" });

    expect(isFailure(result)).toBe(false);
    expect(result).toMatchObject({
      oversight_mode: "full",
      egress_notifications_enabled: true,
      role: "owner",
    });
    const row = await db.pool.query(
      `SELECT oversight_mode, egress_notifications_enabled FROM spaces WHERE id = $1`,
      [(result as SpaceResult).id],
    );
    expect(row.rows[0]).toEqual({
      oversight_mode: "full",
      egress_notifications_enabled: true,
    });
  });

  it("defaults oversight_mode to 'none' when omitted", async () => {
    if (!db.available || !repo) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Default Team", type: "team" });

    expect(isFailure(result)).toBe(false);
    expect(result).toMatchObject({ oversight_mode: "none" });
  });

  it("rejects an unknown oversight_mode with 422 and creates no row", async () => {
    if (!db.available || !repo || !db.pool) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Bad Team", type: "team", oversight_mode: "godmode" });

    expect(result).toMatchObject({ statusCode: 422 });
    const rows = await db.pool.query("SELECT id FROM spaces WHERE name = 'Bad Team'");
    expect(rows.rowCount).toBe(0);
  });

  it("still rejects explicit personal-type creation regardless of oversight_mode", async () => {
    if (!db.available || !repo) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Sneaky Personal", type: "personal", oversight_mode: "full" });

    expect(result).toMatchObject({ statusCode: 400 });
  });
});
