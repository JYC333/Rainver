import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { admitSourceRequest, admitSourceRequestGroups, coolDownSourceRequests, sourceQuotaGroup } from "../src/modules/sources/sourceRequestQuota.js";
const db = useTestDatabase(import.meta.filename);
const group = () => sourceQuotaGroup(randomUUID(), "provider-endpoint");

describe("service account request admission", () => {
  it("shares hard limits across concurrent workers and all windows", async () => {
    const key = group();
    const admissions = await Promise.all(Array.from({ length: 30 }, () => admitSourceRequest(db.pool, key, [{ window: "minute", limit: 20 }, { window: "day", limit: 7 }])));
    expect(admissions.filter(r => r.allowed)).toHaveLength(7);
    const state = await db.pool.query(`SELECT windows_json FROM source_request_quota_state WHERE group_key=$1`, [key]);
    expect(state.rows[0].windows_json.minute.used).toBe(7);
    expect(state.rows[0].windows_json.day.used).toBe(7);
  });
  it("retains omitted restrictions and UTC reset boundaries across new callers", async () => {
    const key = group();
    expect((await admitSourceRequest(db.pool, key, [{ window: "day", limit: 1 }])).allowed).toBe(true);
    expect((await admitSourceRequest(db.pool, key, [{ window: "minute", limit: 10 }])).allowed).toBe(false);
    const result = await db.pool.query(`SELECT windows_json FROM source_request_quota_state WHERE group_key=$1`, [key]);
    expect(new Date(result.rows[0].windows_json.day.reset).toISOString()).toMatch(/T00:00:00.000Z$/);
  });
  it("persists and never shortens Retry-After across callers", async () => {
    const key = group();
    await coolDownSourceRequests(db.pool, key, "3600");
    const first = await admitSourceRequest(db.pool, key, [{ window: "day", limit: 10 }]);
    await coolDownSourceRequests(db.pool, key, "1");
    expect(await admitSourceRequest(db.pool, key, [{ window: "day", limit: 10 }])).toEqual(first);
    expect(first.allowed).toBe(false);
  });
  it("expires old windows without deleting successful request history in active windows", async () => {
    const key = group();
    await admitSourceRequest(db.pool, key, [{ window: "minute", limit: 1 }, { window: "day", limit: 3 }]);
    await db.pool.query(`UPDATE source_request_quota_state SET windows_json=jsonb_set(windows_json,'{minute,reset}','0') WHERE group_key=$1`, [key]);
    expect((await admitSourceRequest(db.pool, key, [{ window: "minute", limit: 1 }, { window: "day", limit: 3 }])).allowed).toBe(true);
    expect((await db.pool.query(`SELECT windows_json FROM source_request_quota_state WHERE group_key=$1`, [key])).rows[0].windows_json.day.used).toBe(2);
  });
});

it("shares account daily limits across endpoints and debits endpoint limits atomically", async () => {
  const account = group(), endpointA = group(), endpointB = group();
  const send = (endpoint:string) => admitSourceRequestGroups(db.pool,[{key:account,windows:[{window:"day",limit:3}]},{key:endpoint,windows:[{window:"minute",limit:2}]}]);
  const results = await Promise.all(Array.from({length:20},(_,i)=>send(i%2 ? endpointA:endpointB)));
  expect(results.filter(r=>r.allowed)).toHaveLength(3);
  const {rows} = await db.pool.query(`SELECT group_key, windows_json FROM source_request_quota_state WHERE group_key=ANY($1::text[])`,[[account,endpointA,endpointB]]);
  expect(rows.find(r=>r.group_key===account).windows_json.day.used).toBe(3);
  expect(rows.filter(r=>r.group_key!==account).reduce((sum,r)=>sum+r.windows_json.minute.used,0)).toBe(3);
});

it("honors an HTTP-date cooldown and treats a missing header conservatively", async () => {
  const key = group(); const until = new Date(Date.now()+120_000); until.setUTCMilliseconds(0);
  await coolDownSourceRequests(db.pool,key,until.toUTCString());
  const admission=await admitSourceRequest(db.pool,key,[{window:"minute",limit:10}]);
  expect(admission).toEqual({allowed:false,retryAt:until.toISOString()});
  const other=group(); await coolDownSourceRequests(db.pool,other,null);
  expect((await admitSourceRequest(db.pool,other,[{window:"minute",limit:10}])).allowed).toBe(false);
});
it("does not rewrite an unchanged cooldown refusal",async()=>{
 const key=group();await coolDownSourceRequests(db.pool,key,"120");
 const policy=[{window:"minute" as const,limit:10}];await admitSourceRequest(db.pool,key,policy);
 const before=(await db.pool.query(`SELECT xmin::text FROM source_request_quota_state WHERE group_key=$1`,[key])).rows[0].xmin;
 expect((await admitSourceRequest(db.pool,key,policy)).allowed).toBe(false);
 expect((await db.pool.query(`SELECT xmin::text FROM source_request_quota_state WHERE group_key=$1`,[key])).rows[0].xmin).toBe(before);
});

describe("Cooldown clock: one DB sample for the whole write", () => {
  const stored = async (keys: string[]) => (await db.pool.query<{ group_key: string; micros: string }>(
    `SELECT group_key, (extract(epoch FROM cooldown_until) * 1000000)::bigint::text AS micros FROM source_request_quota_state WHERE group_key = ANY($1::text[])`, [keys],
  )).rows;
  const dbNowMs = async () => new Date((await db.pool.query<{ now: Date }>(`SELECT clock_timestamp() AS now`)).rows[0]!.now).getTime();

  it("stores an in-range HTTP date exactly, to the microsecond, for one group and for several", async () => {
    for (let round = 0; round < 25; round += 1) {
      const until = new Date(Date.now() + 120_000 + round * 1000); until.setUTCMilliseconds(0);
      const keys = [group(), group(), group()];
      const returned = await coolDownSourceRequests(db.pool, keys, until.toUTCString());
      expect(returned).toBe(until.toISOString());
      for (const row of await stored(keys)) expect(row.micros).toBe(String(until.getTime() * 1000));
    }
  });

  it("gives every group of one write the same instant for a relative or fallback cooldown", async () => {
    for (const header of ["120", null, "not a date"]) {
      const keys = [group(), group(), group(), group()];
      await coolDownSourceRequests(db.pool, keys, header);
      expect(new Set((await stored(keys)).map((row) => row.micros)).size).toBe(1);
    }
  });

  it("keeps the bounds: 1 s at least, 24 h at most, 60 s when missing or invalid, and never shortens", async () => {
    const until = async (header: string | null, key = group()) => {
      const before = await dbNowMs();
      const at = new Date(await coolDownSourceRequests(db.pool, key, header)).getTime();
      return { before, after: await dbNowMs(), at };
    };
    const within = ({ before, after, at }: { before: number; after: number; at: number }, seconds: number) => {
      expect(at).toBeGreaterThanOrEqual(before + seconds * 1000);
      expect(at).toBeLessThanOrEqual(after + seconds * 1000 + 1);
    };
    within(await until("0"), 1);
    within(await until(new Date(Date.now() - 3_600_000).toUTCString()), 1);
    within(await until(new Date(Date.now() + 3 * 86_400_000).toUTCString()), 86_400);
    within(await until("999999"), 86_400);
    within(await until(null), 60);
    within(await until("soon"), 60);

    const key = group();
    const long = await coolDownSourceRequests(db.pool, key, "3600");
    const date = new Date(Date.now() + 120_000); date.setUTCMilliseconds(0);
    expect(await coolDownSourceRequests(db.pool, key, date.toUTCString())).toBe(long);
    expect(await coolDownSourceRequests(db.pool, key, "1")).toBe(long);
  });
});
