import type { Pool } from "pg";

/** An active memory row with the defaults the read/proposal tests assume; `over` wins. */
export async function insertMemoryEntry(
  pool: Pool,
  space: string,
  over: Record<string, unknown>,
  defaults: { visibility?: string } = {},
): Promise<void> {
  const cols: Record<string, unknown> = {
    id: over.id,
    space_id: space,
    scope_type: "user",
    memory_type: "fact",
    content: "memory content",
    status: "active",
    access_count: 0,
    visibility: defaults.visibility ?? "private",
    access_level: "full",
    sensitivity_level: "normal",
    confidence: 1,
    importance: 0.5,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
  const names = Object.keys(cols);
  const placeholders = names.map((n, i) => (n === "tags" ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const values = names.map((n) => (n === "tags" ? (cols[n] === undefined ? null : JSON.stringify(cols[n])) : cols[n]));
  await pool.query(`INSERT INTO memory_entries (${names.join(", ")}) VALUES (${placeholders.join(", ")})`, values);
}
