import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { seedRun } from "./domainSeeds.js";

/** A real Agent Run/Attempt, using the canonical Agent/Profile fixture. */
export async function seedAttentionRun(pool: Pool, input: {
  space: string;
  owner: string;
  status?: string;
  now?: string;
}): Promise<string> {
  const id = randomUUID();
  const status = input.status ?? "succeeded";
  const now = input.now ?? new Date().toISOString();
  await seedRun(pool, {
    id,
    space: input.space,
    owner: input.owner,
    agent: randomUUID(),
    version: randomUUID(),
    now
  });
  await pool.query(`UPDATE runs SET status=$2::text,
    ended_at=CASE WHEN $2='succeeded' THEN $3::timestamptz END WHERE id=$1`, [id, status, now]);
  await pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,ended_at,created_at,updated_at)
    VALUES($1,$2,$3,1,$4::text,CASE WHEN $4='succeeded' THEN $5::timestamptz END,$5,$5)`, [randomUUID(), input.space, id, status, now]);
  return id;
}
