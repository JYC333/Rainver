// Measurement harness for ③ Run IO (not part of the canonical suite).
// Copy to server/test/zzRunIoPerf.tmp.test.ts and run from server/ (delete the copy afterwards):
//   RUN_IO_EVENTS=20000 RUN_IO_MIX=uniform node node_modules/vitest/vitest.mjs run test/zzRunIoPerf.tmp.test.ts
// Real PostgreSQL (shared test container, own cloned database). Synthetic Run:
// N events, ~1 KiB metadata each; mix `uniform` = 11 logical : 9 operational
// types round-robin, `operational` = 4 operational events per logical one.
//
// Every seeded id and timestamp is fixed, so an `/io` body is a function of
// the code alone: its `responseSha256` compares builds byte for byte. A
// `/trace` body also carries a value that changes on every run (two runs of
// one build hash differently), so its hash only compares requests within one
// run; compare `/trace` by size and event count. Row counts are
// the rows the driver returned for `run_events` statements (`rows.length`),
// and their size is the JSON text of those rows — not bytes PostgreSQL read
// or sent. With RUN_IO_CAPTURE=1 each Artifact-list statement is classified
// (probe / count / page / count+page) and EXPLAIN ANALYZEd once per route.
import pg from "pg";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runsModule } from "../src/modules/runs/index.js";
import { __setRunsIdentityForTests } from "../src/modules/runs/routes.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { seedRun, seedSpaceMember } from "./support/domainSeeds.js";
import { useTestDatabase } from "./support/testDatabase.js";

const SPACE = "11111111-1111-4111-8111-1111111111b1", OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1", MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const RUN = "55555555-5555-4555-8555-5555555555b1";
const STAMP = "2026-01-01T00:00:00.000Z";
const N = Number(process.env.RUN_IO_EVENTS ?? 20000), MIX = process.env.RUN_IO_MIX ?? "uniform", REPEAT = Number(process.env.RUN_IO_REPEAT ?? 10);
const LOGICAL = ["assistant_message_completed", "tool_call_started", "tool_call_completed", "tool_call_failed", "approval_requested", "approval_resolved", "artifact_produced", "output_validation_completed", "warning", "error", "state_transition"];
const OPERATIONAL = ["context_compiled", "runtime_selected", "policy_checked", "adapter_invoked", "adapter_completed", "action_invoked", "action_completed", "validation_started", "provider_compacted"];
const db = useTestDatabase(import.meta.filename, { max: 4 });
let app: Awaited<ReturnType<typeof buildModuleServer>>;
beforeAll(async () => {
  if (!db.available) return;
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Team','household',$2,$2)`, [SPACE, STAMP]);
  await seedSpaceMember(db.pool, { space: SPACE, user: OWNER, role: "owner", now: STAMP });
  await seedSpaceMember(db.pool, { space: SPACE, user: MEMBER, role: "member", now: STAMP });
  await seedRun(db.pool, { id: RUN, space: SPACE, owner: OWNER, agent: "33333333-3333-4333-8333-3333333333b1", version: "44444444-4444-4444-8444-4444444444b1", now: STAMP });
  await db.pool.query(`UPDATE runs SET access_level='summary' WHERE id=$1`, [RUN]);
  const types = MIX === "uniform" ? [...LOGICAL, ...OPERATIONAL] : LOGICAL.flatMap((t, i) => [t, ...OPERATIONAL.slice(0, 4).map((_, k) => OPERATIONAL[(i + k) % OPERATIONAL.length]!)]);
  await db.pool.query(`INSERT INTO run_events (id, space_id, run_id, event_index, event_type, status, summary, metadata_json, created_at)
    SELECT 'evt-' || lpad(g::text, 8, '0'), $1, $2, g, ($3::text[])[1 + g % cardinality($3::text[])], 'succeeded', 'event ' || g,
           jsonb_build_object('index', g, 'detail', repeat(md5(g::text), 30)), $4::timestamptz + make_interval(secs => g)
      FROM generate_series(0, $5 - 1) g`, [SPACE, RUN, types, STAMP, N]);
  for (let i = 0; i < Number(process.env.RUN_IO_ARTIFACTS ?? 0); i++) {
    await db.pool.query(`INSERT INTO artifacts (id, space_id, run_id, owner_user_id, artifact_type, title, content, export_formats_json, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'markdown', $5, 'body', '[]'::jsonb, $6::timestamptz + make_interval(secs => $7), $6)`, [`artifact-${i}`, SPACE, RUN, OWNER, `Artifact ${i}`, STAMP, i]);
  }
  await db.pool.query(`ANALYZE run_events`);
  await db.pool.query(`ANALYZE artifacts`);
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [runsModule]);
});
afterAll(async () => { __setRunsIdentityForTests(null); await app?.close(); });

/** Which Artifact-list statement this is, by its shape (current and earlier builds). */
function artifactStatementKind(text: string): string | null {
  if (!/FROM artifacts a\b/.test(text)) return null;
  if (/WITH visible AS/.test(text)) return "count+page";
  if (/^\s*SELECT 1 FROM artifacts a\b/.test(text)) return "probe";
  if (/SELECT count\(a\.id\)/.test(text)) return "count";
  if (/ORDER BY a\.created_at DESC/.test(text)) return "page";
  return "other";
}

it("measures /io and /trace", async () => {
  if (!db.available) throw new Error("PostgreSQL unavailable");
  const original = pg.Pool.prototype.query;
  let sql = { statements: 0, rows: 0, jsonBytes: 0 };
  let route = "";
  const captured = new Map<string, { route: string; kind: string; text: string; values: unknown }>();
  const artifactStatements: Record<string, Record<string, number>> = {};
  (pg.Pool.prototype as unknown as { query: unknown }).query = function (this: unknown, ...args: unknown[]) {
    const result = (original as (...a: unknown[]) => unknown).apply(this, args);
    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
    const kind = artifactStatementKind(text);
    if (kind) {
      const counts = (artifactStatements[route] ??= {});
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (process.env.RUN_IO_CAPTURE && !captured.has(`${route}:${kind}`)) captured.set(`${route}:${kind}`, { route, kind, text, values: args[1] });
    }
    if (/FROM run_events/.test(text) && result && typeof (result as Promise<unknown>).then === "function") {
      void (result as Promise<{ rows: unknown[] }>).then((r) => { sql.statements++; sql.rows += r.rows.length; sql.jsonBytes += JSON.stringify(r.rows).length }, () => {});
    }
    return result;
  };
  const out: Record<string, unknown> = { events: N, mix: MIX, repeat: REPEAT, artifacts: Number(process.env.RUN_IO_ARTIFACTS ?? 0) };
  try {
    for (const [name, path, user] of (process.env.RUN_IO_ROUTES ? JSON.parse(process.env.RUN_IO_ROUTES) : [["io_full", "io", OWNER], ["io_summary", "io", MEMBER], ["trace_full", "trace", OWNER]]) as Array<[string,string,string]>) {
      __setRunsIdentityForTests({ spaceId: SPACE, userId: user });
      route = `${name}:warm`;
      await app.inject({ method: "GET", url: `/api/v1/runs/${RUN}/${path}` });
      route = name;
      const times: number[] = []; let bytes = 0; let events = 0; const hashes = new Set<string>(); sql = { statements: 0, rows: 0, jsonBytes: 0 };
      for (let i = 0; i < REPEAT; i++) {
        const t0 = performance.now(); const res = await app.inject({ method: "GET", url: `/api/v1/runs/${RUN}/${path}` }); times.push(performance.now() - t0)
        if (res.statusCode !== 200) throw new Error(`${name} ${res.statusCode}`); bytes = res.body.length; events = ((res.json() as { events?: unknown[] }).events ?? []).length
        hashes.add(createHash("sha256").update(res.body).digest("hex"));
      }
      times.sort((a, b) => a - b)
      out[name] = { medianMs: Number(times[Math.floor(times.length / 2)]!.toFixed(1)), minMs: Number(times[0]!.toFixed(1)), maxMs: Number(times.at(-1)!.toFixed(1)),
        responseBytes: bytes, responseEvents: events, responseSha256: hashes.size === 1 ? [...hashes][0] : [...hashes],
        runEventsStatementsPerRequest: sql.statements / REPEAT, runEventsDriverRowsPerRequest: sql.rows / REPEAT,
        runEventsDriverRowJsonBytesPerRequest: Math.round(sql.jsonBytes / REPEAT),
        artifactStatementsPerRequest: Object.fromEntries(Object.entries(artifactStatements[name] ?? {}).map(([kind, n]) => [kind, n / REPEAT])) };
    }
  } finally { (pg.Pool.prototype as unknown as { query: unknown }).query = original }
  if (process.env.RUN_IO_CAPTURE) {
    const client = await db.pool.connect()
    const plans: unknown[] = [];
    try {
      for (const q of captured.values()) {
        if (q.route.endsWith(":warm")) continue;
        const plan = await client.query(`EXPLAIN (ANALYZE, SUMMARY, FORMAT JSON) ${q.text}`, q.values as unknown[])
        const top = (plan.rows[0] as { "QUERY PLAN": Array<{ "Planning Time": number; "Execution Time": number }> })["QUERY PLAN"][0]!
        plans.push({ route: q.route, kind: q.kind, chars: q.text.length, planningMs: top["Planning Time"], executionMs: top["Execution Time"] });
        if (process.env.RUN_IO_SQL_OUT) writeFileSync(`${process.env.RUN_IO_SQL_OUT}.${q.route}.${q.kind}.sql`, q.text);
      }
    } finally { client.release() }
    out.artifactPlans = plans;
  }
  console.log("RUN_IO_PERF", JSON.stringify(out));
  if (process.env.RUN_IO_OUT) writeFileSync(process.env.RUN_IO_OUT, JSON.stringify(out, null, 2));
});
