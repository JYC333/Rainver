import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { AGENT, CHANNEL, CONNECTION, MEMBER, OWNER, PROFILE, PROJECT, SPACE, briefingWorld, manual, output, outputValue } from "./support/briefingFixture.js";
import { personalBriefingScope } from "../src/modules/informationDigest/briefing/personalScope.js";
import { PERSONAL_BRIEFING_LABEL } from "../src/modules/informationDigest/briefing/routes.js";
import { ReadingPreferences } from "../src/modules/informationDigest/readingPreferences.js";
import { settleBriefingRun } from "../src/modules/informationDigest/briefing/settlement.js";
import { PgBriefingRepository } from "../src/modules/informationDigest/briefing/repository.js";
import { PENDING_INPUT_STATUSES } from "../src/modules/informationDigest/briefing/manifest.js";
import { BRIEFING_LIMITS } from "../src/modules/informationDigest/briefing/contract.js";

// Material a version recorded as still to be briefed (here: refused by its
// Source's model consent) is carried into later versions even when no
// version has published a briefing yet, and even once it lies outside the
// next baseline window — through the scope's own gates, once, and never
// again after a version briefed it.
const db = useTestDatabase(import.meta.filename, { max: 10 });
const w = briefingWorld(db);
const DENY_ALL = `'{"allow_external_model_egress":false,"allow_local_provider_egress":false}'::jsonb`;
const ALLOW_ALL = `'{"allow_external_model_egress":true,"allow_local_provider_egress":true}'::jsonb`;
const consent = (value: string) => db.pool.query(`UPDATE source_connections SET consent_json=${value} WHERE id=$1`, [CONNECTION]);

beforeEach(async () => {
  if (!db.available) return;
  await w.seed();
  // The scope and its Source existed before the sealed day below.
  for (const table of ["projects", "project_brief_versions", "source_connections", "source_channels", "source_channel_user_subscriptions"]) {
    await db.pool.query(`UPDATE ${table} SET created_at = now() - interval '20 days'`);
  }
});

/**
 * A real sealed Project Digest day (UTC day bounds) whose cut-off is 15 days
 * ago, and a backfill of it in which the one piece of material — collected
 * and analysed 16 days ago, still in the Project's active Corpus — is refused
 * by its Source: a ready version with no Run and nothing published.
 */
async function refusedSealedDay(count = 1, options: { followingOnly?: boolean } = {}) {
  const cutoff = new Date(`${new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`).toISOString();
  const start = new Date(Date.parse(cutoff) - 86_400_000).toISOString();
  const digest = randomUUID();
  await db.pool.query(
    `INSERT INTO information_digests (id,space_id,digest_type,project_id,digest_date,period_start_utc,period_end_utc,generation_kind,created_at,updated_at)
     VALUES ($1,$2,'project',$3,$4,$5,$6,'backfill',now(),now())`,
    [digest, SPACE, PROJECT, start.slice(0, 10), start, cutoff],
  );
  const items: string[] = [];
  for (let n = 0; n < count; n += 1) {
    items.push(await w.material(count === 1 ? "PENDING_FROM_SEALED_DAY" : `PENDING_FROM_SEALED_DAY_${n}`, { addedHoursAgo: 16 * 24, publishedHoursAgo: 16 * 24 }));
  }
  // Reached through a Project Following alone, with no Corpus entry to fall back on.
  if (options.followingOnly) {
    for (const item of items) await followInProject(item);
    await db.pool.query(`DELETE FROM project_corpus_items WHERE source_item_id = ANY($1::varchar[])`, [items]);
  }
  await consent(DENY_ALL);
  const sealed = await w.service().request(w.adapter(), OWNER, { ...manual, kind: "backfill", day: { date: start.slice(0, 10), digestId: digest, cutoff } });
  expect(sealed.briefing).toMatchObject({ status: "ready", outcome: "no_new_material" });
  expect(sealed.briefing.coverage.egress_refused).toBe(count);
  expect(await w.count("runs")).toBe(0);
  return { item: items[0]!, items, sealed: sealed.briefing.id };
}

/** A Project Following selecting `item` since 16 days ago, as `important`, through the fixture Source. */
async function followInProject(item: string) {
  const goal = randomUUID(), binding = randomUUID();
  await db.pool.query(
    `INSERT INTO source_goals (id,space_id,owner_user_id,project_id,agent_id,runtime_profile_id,intent_json,budget_json,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'{"intent":"Synthetic Following"}','{}','running',now() - interval '20 days',now() - interval '20 days')`,
    [goal, SPACE, OWNER, PROJECT, AGENT, PROFILE],
  );
  await db.pool.query(`INSERT INTO source_goal_bindings (id,space_id,goal_id,source_connection_id,spec_json) VALUES ($1,$2,$3,$4,'{}')`, [binding, SPACE, goal, CONNECTION]);
  await db.pool.query(
    `INSERT INTO source_goal_items (id,space_id,goal_id,source_item_id,source_connection_id,binding_id,version_id,first_goal_run_id,last_goal_run_id,selection_status,selection_reason,delivery_kind,associated_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'v','r','r','important','Synthetic reason','baseline',now() - interval '16 days',now() - interval '16 days')`,
    [randomUUID(), SPACE, goal, item, CONNECTION, binding],
  );
  return goal;
}

const pendingNow = (limit: number) => new PgBriefingRepository(db.pool).pendingSince(w.adapter().scope, new Date().toISOString(), PENDING_INPUT_STATUSES, limit);

/** Publishes a version's Run with a synthetic reply citing `ref` (fixture output, not a model). */
async function publish(briefingId: string, ref: string) {
  // A delta's carried items are newly found: its reply calls them new.
  const novelty = (await w.rowOf(briefingId)).comparison === "delta" ? "new" : "baseline";
  const value = outputValue({}, novelty);
  value.highlights[0]!.novelty = novelty;
  value.overview = { text: "Scale overview", refs: [ref] };
  value.highlights[0] = { ...value.highlights[0]!, refs: [ref], statements: [{ kind: "fact", text: "Scale fact", refs: [ref] }] };
  await settleBriefingRun(db.pool, await w.finishRun((await w.runOf(briefingId)).id, output(value)));
  const row = await w.rowOf(briefingId);
  expect(row, `${row.error_code}: ${row.error_message}`).toMatchObject({ status: "ready", outcome: "briefing" });
}

/** `count` analysed Corpus items `hoursAgo` old, as `material()` makes them, in set-based statements. */
async function bulkMaterial(count: number, hoursAgo: number): Promise<string[]> {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const ids = (await db.pool.query<{ id: string }>(
    `INSERT INTO source_items (id,space_id,owner_user_id,visibility,connection_id,item_type,title,source_uri,canonical_uri,reading_initial_hash,source_domain,occurred_at,first_seen_at,last_seen_at,content_state,retention_policy,excerpt,metadata_json,created_at,updated_at)
     SELECT gen_random_uuid()::text,$1,$2,'space_shared',$3,'feed_entry','Bulk report '||n,'https://news.test/bulk/'||n,'https://news.test/bulk/'||n,'h0','news.test',$4,$4,$4,'excerpt_saved','summary_only','Bulk report '||n||' excerpt','{}'::jsonb,$4,$4
       FROM generate_series(1,$5) n RETURNING id`,
    [SPACE, OWNER, CONNECTION, at, count],
  )).rows.map((row) => row.id);
  await db.pool.query(
    `INSERT INTO source_channel_item_links (id,space_id,source_channel_id,source_item_id,status,matched_at,created_at,updated_at)
     SELECT gen_random_uuid()::text,$1,$2,id,'active',$3,$3,$3 FROM unnest($4::varchar[]) id`,
    [SPACE, CHANNEL, at, ids],
  );
  await db.pool.query(
    `INSERT INTO source_item_annotations (id,space_id,source_item_id,source_channel_id,status,domain_key,depth,genre,summary,topic_candidates_json,stance_polarity,stance_confidence,attempt_count,annotated_at,created_at,updated_at)
     SELECT gen_random_uuid()::text,$1,id,$2,'succeeded','robotics','analysis','news','Bulk summary','[]'::jsonb,'neutral',0,1,$3,$3,$3 FROM unnest($4::varchar[]) id`,
    [SPACE, CHANNEL, at, ids],
  );
  await db.pool.query(
    `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,source_connection_id,role,status,triage_status,triage_confirmed_by_user,read_status,reason,metadata_json,created_at,updated_at)
     SELECT gen_random_uuid()::text,$1,$2,id,$3,'candidate','active','new',false,'unread',NULL,'{}',$4,$4 FROM unnest($5::varchar[]) id`,
    [SPACE, PROJECT, CONNECTION, at, ids],
  );
  return ids;
}

const inputOf = async (briefingId: string, item: string) => (await w.inputsOf(briefingId)).find((input) => input.source_item_id === item);

describe("Pending material of unpublished versions is carried, re-authorized, once", () => {
  it("carries a refused item of a sealed no-run day into the next version once its Source consents, through a Run to a published briefing", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { item } = await refusedSealedDay();
    await consent(ALLOW_ALL);
    const current = await w.service().request(w.adapter(), OWNER, manual);
    expect(current.created).toBe(true);
    expect(current.briefing.status).toBe("queued");
    expect(current.briefing.coverage.carried_from_previous).toBe(1);
    expect(await inputOf(current.briefing.id, item)).toMatchObject({ status: "included" });
    expect(await w.count("runs")).toBe(1);
    expect((await w.runOf(current.briefing.id)).prompt).toContain("PENDING_FROM_SEALED_DAY");
    // The Run's answer, citing it, is published and readable.
    const ref = (await inputOf(current.briefing.id, item))!.ref_key as string;
    const value = outputValue({}, "baseline");
    value.overview = { text: "Carried overview", refs: [ref] };
    value.highlights[0] = { ...value.highlights[0]!, refs: [ref], statements: [{ kind: "fact", text: "Carried fact", refs: [ref] }] };
    await settleBriefingRun(db.pool, await w.finishRun((await w.runOf(current.briefing.id)).id, output(value)));
    const published = await w.service().overview(w.adapter(), OWNER, false);
    expect(published.latest_briefing).toMatchObject({ id: current.briefing.id, outcome: "briefing" });
    expect(published.latest_briefing!.evidence.map((entry) => entry.source_item_id)).toContain(item);

    // Briefed now: the next requests do not report it again, and repeating one changes nothing.
    const next = await w.service().request(w.adapter(), OWNER, manual);
    expect(next.briefing.outcome).toBe("no_new_material");
    expect(next.briefing.coverage.carried_from_previous).toBe(0);
    expect(await w.count("runs")).toBe(1);
    const again = await w.service().request(w.adapter(), OWNER, manual);
    expect(again).toMatchObject({ created: false, briefing: { id: next.briefing.id } });
  });

  it("keeps a still-refused item pending across several no-run versions without spending a Run, and carries it when consent returns", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { item } = await refusedSealedDay();
    const first = await w.service().request(w.adapter(), OWNER, manual);
    expect(await inputOf(first.briefing.id, item)).toMatchObject({ status: "egress_refused" });
    expect(first.briefing.coverage.complete).toBe(false);
    // Nothing changed: the same check, not a new version.
    expect(await w.service().request(w.adapter(), OWNER, manual)).toMatchObject({ created: false, briefing: { id: first.briefing.id } });
    expect(await w.count("runs")).toBe(0);
    await consent(ALLOW_ALL);
    const restored = await w.service().request(w.adapter(), OWNER, manual);
    expect(await inputOf(restored.briefing.id, item)).toMatchObject({ status: "included" });
    expect(await w.count("runs")).toBe(1);
  });

  it("does not carry an item that left the scope, however it was recorded", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { item } = await refusedSealedDay();
    await consent(ALLOW_ALL);
    // It left the Project's Corpus: the scope no longer offers it.
    await db.pool.query(`UPDATE project_corpus_items SET status='archived' WHERE source_item_id=$1`, [item]);
    const current = await w.service().request(w.adapter(), OWNER, manual);
    // Carried once, not offered: recorded withdrawn, which resolves it — never sent, never carried again.
    expect(await inputOf(current.briefing.id, item)).toMatchObject({ ref_key: null, analysis_json: expect.objectContaining({ withdrawn: true }) });
    expect(current.briefing.coverage.carried_from_previous).toBe(0);
    expect(current.briefing.coverage.truncated).toBe(0);
    expect(await w.count("runs")).toBe(0);
    expect((await pendingNow(10)).itemIds).toEqual([]);
  });

  it("carries 200 of 205 pending items at real scale, keeps the other 5 pending in their own record, and carries them after the next publication", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { items } = await refusedSealedDay(205);
    await consent(ALLOW_ALL);
    // Two of them left the scope since: they are re-authorized out, whichever turn they are carried in.
    const withdrawn = items.slice(100, 102);
    await db.pool.query(`UPDATE project_corpus_items SET status='archived' WHERE source_item_id = ANY($1::varchar[])`, [withdrawn]);
    const pending = await pendingNow(BRIEFING_LIMITS.maxCarry);
    expect(pending.itemIds).toHaveLength(200);
    expect(pending.overflow).toBe(5);
    const rest = (await pendingNow(1000)).itemIds.slice(200);
    expect(rest).toHaveLength(5);

    const first = await w.service().request(w.adapter(), OWNER, manual);
    const inputs = await w.inputsOf(first.briefing.id);
    const rowOf = (id: string) => inputs.find((input) => input.source_item_id === id);
    const sent = inputs.filter((input) => input.status === "included");
    const carried = pending.itemIds.filter((id) => !withdrawn.includes(id));
    expect(first.briefing.coverage.carried_from_previous).toBe(carried.length);
    expect(sent).toHaveLength(BRIEFING_LIMITS.maxInputs);
    for (const id of carried) expect(["included", "truncated"]).toContain(rowOf(id)?.status);
    for (const id of withdrawn) expect(rowOf(id)?.status ?? "absent").not.toBe("included");
    // The 5 beyond this carry are not copied: their own record keeps them pending, and they are counted as left out.
    for (const id of rest) expect(rowOf(id)).toBeUndefined();
    const leftPending = inputs.filter((input) => input.status === "truncated" && !input.analysis_json.withdrawn).length;
    expect(first.briefing.coverage.truncated).toBe(leftPending + 5);
    expect(first.briefing.coverage.complete).toBe(false);
    const run = await w.runOf(first.briefing.id);
    expect((run.prompt ?? "").length + (run.instruction ?? "").length).toBeLessThanOrEqual(BRIEFING_LIMITS.promptChars);
    expect(await w.count("runs")).toBe(1);

    await publish(first.briefing.id, sent[0]!.ref_key as string);
    const second = await w.service().request(w.adapter(), OWNER, manual);
    const next = await w.inputsOf(second.briefing.id);
    // Oldest first: the 5 that waited are carried now, ahead of what the first version left pending again.
    for (const id of rest) {
      const row = next.find((input) => input.source_item_id === id);
      if (withdrawn.includes(id)) expect(row?.analysis_json.withdrawn).toBe(true);
      else expect(["included", "truncated"]).toContain(row?.status);
    }
    for (const input of sent) {
      const again = next.find((row) => row.source_item_id === input.source_item_id);
      if (again?.status === "included") expect(again.delta_class).toBe("background");
    }
    for (const id of withdrawn) for (const version of [inputs, next]) expect(version.find((row) => row.source_item_id === id)?.status ?? "absent").not.toBe("included");
    expect(next.filter((input) => input.status === "included" && input.delta_class !== "background")).toHaveLength(BRIEFING_LIMITS.maxInputs);
    expect(await w.count("runs")).toBe(2);
  });

  it("loses none of 1205 pending items across two publications: each carry takes the oldest still unresolved", async (ctx) => {
    if (!db.available) return ctx.skip();
    const cutoff = new Date(`${new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`).toISOString();
    const start = new Date(Date.parse(cutoff) - 86_400_000).toISOString();
    const digest = randomUUID();
    await db.pool.query(
      `INSERT INTO information_digests (id,space_id,digest_type,project_id,digest_date,period_start_utc,period_end_utc,generation_kind,created_at,updated_at)
       VALUES ($1,$2,'project',$3,$4,$5,$6,'backfill',now(),now())`,
      [digest, SPACE, PROJECT, start.slice(0, 10), start, cutoff],
    );
    await bulkMaterial(1205, 16 * 24);
    await consent(DENY_ALL);
    const sealed = await w.service().request(w.adapter(), OWNER, { ...manual, kind: "backfill", day: { date: start.slice(0, 10), digestId: digest, cutoff } });
    expect(sealed.briefing.coverage.egress_refused).toBe(1205);
    await consent(ALLOW_ALL);
    const all = (await pendingNow(2000)).itemIds;
    expect(all).toHaveLength(1205);
    // The ids a 200 + 1000 bound would have reached last.
    const last = all.slice(1200);

    const first = await w.service().request(w.adapter(), OWNER, manual);
    const firstInputs = await w.inputsOf(first.briefing.id);
    const firstCarried = new Set(firstInputs.filter((input) => !input.analysis_json.withdrawn).map((input) => input.source_item_id));
    expect(first.briefing.coverage.carried_from_previous).toBe(200);
    expect(first.briefing.coverage.truncated).toBe(160 + 1005);
    await publish(first.briefing.id, firstInputs.find((input) => input.status === "included")!.ref_key as string);

    const second = await w.service().request(w.adapter(), OWNER, manual);
    const secondInputs = await w.inputsOf(second.briefing.id);
    const secondCarried = secondInputs.filter((input) => input.delta_class !== "background").map((input) => input.source_item_id);
    expect(second.briefing.coverage.carried_from_previous).toBe(200);
    // The next 200 oldest — not the 160 the first version left pending again.
    expect(secondCarried.filter((id) => firstCarried.has(id))).toEqual([]);
    await publish(second.briefing.id, secondInputs.find((input) => input.status === "included" && input.delta_class !== "background")!.ref_key as string);

    // Two publications later nothing was dropped: all but the 80 sent are still pending, the last 5 included.
    const remaining = new Set((await pendingNow(2000)).itemIds);
    expect(remaining.size).toBe(1205 - 2 * BRIEFING_LIMITS.maxInputs);
    for (const id of last) expect(remaining.has(id)).toBe(true);
    expect(await w.count("runs")).toBe(2);
  });
});

/** The current attempt's Run ends without a published briefing, through canonical settlement. */
async function endAttempt(briefingId: string, status: "failed" | "cancelled") {
  await settleBriefingRun(db.pool, await w.finishRun((await w.runOf(briefingId)).id, "synthetic attempt end", status));
  expect(await w.rowOf(briefingId)).toMatchObject({ status });
}

describe("An attempt that admitted pending material but did not publish has not processed it", () => {
  it("retries the same version's frozen request after a failure, idempotently, until a publication clears the carry", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { item } = await refusedSealedDay();
    await consent(ALLOW_ALL);
    const admitted = await w.service().request(w.adapter(), OWNER, manual);
    expect(await inputOf(admitted.briefing.id, item)).toMatchObject({ status: "included" });
    const frozen = (await w.runOf(admitted.briefing.id)).prompt;
    await endAttempt(admitted.briefing.id, "failed");

    // Still pending: not "no material", but the same version again, with the request it froze.
    const retried = await w.service().request(w.adapter(), OWNER, manual);
    expect(retried.briefing).toMatchObject({ id: admitted.briefing.id, status: "queued" });
    expect(await w.rowOf(admitted.briefing.id)).toMatchObject({ attempt: 2 });
    expect(await w.count("runs")).toBe(2);
    expect((await w.runOf(admitted.briefing.id)).prompt).toBe(frozen);
    expect(frozen).toContain("PENDING_FROM_SEALED_DAY");
    // Repeating while it runs is the same attempt.
    expect(await w.service().request(w.adapter(), OWNER, manual)).toMatchObject({ created: false, briefing: { id: admitted.briefing.id } });
    expect(await w.count("runs")).toBe(2);

    // Published at last: the material is briefed and no longer carried.
    const ref = (await inputOf(admitted.briefing.id, item))!.ref_key as string;
    const value = outputValue({}, "baseline");
    value.overview = { text: "Carried overview", refs: [ref] };
    value.highlights[0] = { ...value.highlights[0]!, refs: [ref], statements: [{ kind: "fact", text: "Carried fact", refs: [ref] }] };
    await settleBriefingRun(db.pool, await w.finishRun((await w.runOf(admitted.briefing.id)).id, output(value)));
    expect(await w.rowOf(admitted.briefing.id)).toMatchObject({ status: "ready", outcome: "briefing" });
    const next = await w.service().request(w.adapter(), OWNER, manual);
    expect(next.briefing).toMatchObject({ outcome: "no_new_material" });
    expect(next.briefing.coverage.carried_from_previous).toBe(0);
    expect(await w.count("runs")).toBe(2);
  });

  it("keeps the material pending after a cancelled attempt and retries it, within the version's attempt budget", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { item } = await refusedSealedDay();
    await consent(ALLOW_ALL);
    const admitted = await w.service().request(w.adapter(), OWNER, manual);
    await endAttempt(admitted.briefing.id, "cancelled");
    const pending = await new PgBriefingRepository(db.pool).pendingSince(w.adapter().scope, new Date().toISOString(), PENDING_INPUT_STATUSES, 200);
    expect(pending.itemIds).toContain(item);
    const retried = await w.service().request(w.adapter(), OWNER, manual);
    expect(retried.briefing).toMatchObject({ id: admitted.briefing.id, status: "queued" });
    expect(await inputOf(retried.briefing.id, item)).toMatchObject({ status: "included" });
    // Every attempt ending unpublished: the budget ends in a stated refusal, not a silent "no material".
    await endAttempt(admitted.briefing.id, "failed");
    expect((await w.service().request(w.adapter(), OWNER, manual)).briefing).toMatchObject({ id: admitted.briefing.id, status: "queued" });
    await endAttempt(admitted.briefing.id, "failed");
    await expect(w.service().request(w.adapter(), OWNER, manual)).rejects.toMatchObject({ statusCode: 409, responseBody: expect.objectContaining({ code: "briefing_attempts_exhausted" }) });
    expect(await w.count("runs")).toBe(3);
  });
});

describe("A carried item the audience cannot read now is pending; only an item that left the scope is withdrawn", () => {
  const sourceVisibility = (visibility: string) => db.pool.query(`UPDATE source_connections SET visibility=$2 WHERE id=$1`, [CONNECTION, visibility]);

  it("keeps a Following item pending while its collecting Source is private to the audience, sends nothing, and delivers it once the Source is shared again", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { item } = await refusedSealedDay(1, { followingOnly: true });
    await consent(ALLOW_ALL);
    await sourceVisibility("private");
    const refused = await w.service().request(w.adapter(), OWNER, manual);
    const input = await inputOf(refused.briefing.id, item);
    expect(input).toMatchObject({ status: "not_shared", ref_key: null });
    expect(input.analysis_json.withdrawn).toBeUndefined();
    expect(refused.briefing.coverage).toMatchObject({ not_shared_with_audience: 1, complete: false, included: 0 });
    expect(await w.count("runs")).toBe(0);
    expect((await pendingNow(10)).itemIds).toEqual([item]);

    await sourceVisibility("space_shared");
    const restored = await w.service().request(w.adapter(), OWNER, manual);
    expect(restored.briefing.status).toBe("queued");
    expect(await inputOf(restored.briefing.id, item)).toMatchObject({ status: "included" });
    expect((await w.runOf(restored.briefing.id)).prompt).toContain("PENDING_FROM_SEALED_DAY");
  });

  it("does the same for an item made private itself: the control, reached by the item gate", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { item } = await refusedSealedDay(1, { followingOnly: true });
    await consent(ALLOW_ALL);
    await db.pool.query(`UPDATE source_items SET visibility='private' WHERE id=$1`, [item]);
    const refused = await w.service().request(w.adapter(), OWNER, manual);
    expect(await inputOf(refused.briefing.id, item)).toMatchObject({ status: "not_shared" });
    expect(await w.count("runs")).toBe(0);
    await db.pool.query(`UPDATE source_items SET visibility='space_shared' WHERE id=$1`, [item]);
    const restored = await w.service().request(w.adapter(), OWNER, manual);
    expect(await inputOf(restored.briefing.id, item)).toMatchObject({ status: "included" });
  });

  it.for([
    { how: "its Goal was deleted", leave: `UPDATE source_goals SET status='deleted' WHERE id IN (SELECT goal_id FROM source_goal_items WHERE source_item_id=$1)` },
    { how: "its Goal no longer selects it", leave: `UPDATE source_goal_items SET selection_status='not_selected' WHERE source_item_id=$1` },
    { how: "it was deleted", leave: `UPDATE source_items SET deleted_at=now() WHERE id=$1` },
  ])("withdraws an item for good when $how, also while its Source is private", async ({ leave }, ctx) => {
    if (!db.available) return ctx.skip();
    const { item } = await refusedSealedDay(1, { followingOnly: true });
    await consent(ALLOW_ALL);
    await sourceVisibility("private");
    await db.pool.query(leave, [item]);
    const left = await w.service().request(w.adapter(), OWNER, manual);
    expect(await inputOf(left.briefing.id, item)).toMatchObject({ ref_key: null, analysis_json: expect.objectContaining({ withdrawn: true }) });
    expect(left.briefing.coverage).toMatchObject({ not_shared_with_audience: 0, truncated: 0, complete: true });
    expect((await pendingNow(10)).itemIds).toEqual([]);
    await sourceVisibility("space_shared");
    const after = await w.service().request(w.adapter(), OWNER, manual);
    expect(await inputOf(after.briefing.id, item)).toBeUndefined();
    expect(await w.count("runs")).toBe(0);
  });

  it("does not let items refused now hold the carry: they go to the back, and the next oldest are carried", async (ctx) => {
    if (!db.available) return ctx.skip();
    const cutoff = new Date(`${new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`).toISOString();
    const start = new Date(Date.parse(cutoff) - 86_400_000).toISOString();
    const digest = randomUUID();
    await db.pool.query(
      `INSERT INTO information_digests (id,space_id,digest_type,project_id,digest_date,period_start_utc,period_end_utc,generation_kind,created_at,updated_at)
       VALUES ($1,$2,'project',$3,$4,$5,$6,'backfill',now(),now())`,
      [digest, SPACE, PROJECT, start.slice(0, 10), start, cutoff],
    );
    await bulkMaterial(205, 16 * 24);
    await consent(DENY_ALL);
    await w.service().request(w.adapter(), OWNER, { ...manual, kind: "backfill", day: { date: start.slice(0, 10), digestId: digest, cutoff } });
    await consent(ALLOW_ALL);
    const all = (await pendingNow(1000)).itemIds;
    const refused = all.slice(0, 200), rest = all.slice(200);
    await db.pool.query(`UPDATE source_items SET visibility='private' WHERE id = ANY($1::varchar[])`, [refused]);
    const first = await w.service().request(w.adapter(), OWNER, manual);
    expect(first.briefing.coverage).toMatchObject({ not_shared_with_audience: 200, included: 0, complete: false });
    expect(await w.count("runs")).toBe(0);
    const second = await w.service().request(w.adapter(), OWNER, manual);
    for (const id of rest) expect(await inputOf(second.briefing.id, id)).toMatchObject({ status: "included" });
    expect(await w.count("runs")).toBe(1);
  });

  it("keeps a personal reader's opted-in Project material pending while they lost the Project, and withdraws it when they opt out", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The reader is an ordinary member of the Project here, so they can lose it.
    await db.pool.query(`UPDATE projects SET owner_user_id=$2 WHERE id=$1`, [PROJECT, MEMBER]);
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'viewer','active',now(),now())`, [randomUUID(), SPACE, PROJECT, OWNER]);
    const personal = personalBriefingScope(SPACE, OWNER);
    const request = { ...manual, label: PERSONAL_BRIEFING_LABEL };
    const preferences = new ReadingPreferences(db.pool);
    await preferences.set({ spaceId: SPACE, userId: OWNER }, PROJECT, true);
    const item = await w.material("PERSONAL_PROJECT_MATERIAL");
    // Not subscribed to its channel: the Project is the reader's only route to it.
    await db.pool.query(`UPDATE source_channel_user_subscriptions SET status='muted' WHERE user_id=$1`, [OWNER]);
    await consent(DENY_ALL);
    const first = await w.service().request(personal, OWNER, request);
    expect(await inputOf(first.briefing.id, item)).toMatchObject({ status: "egress_refused" });
    await consent(ALLOW_ALL);

    // Access to the Project lost, the opt-in kept: not shareable now, not left.
    await db.pool.query(`UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2`, [PROJECT, OWNER]);
    const lost = await w.service().request(personal, OWNER, request);
    const input = await inputOf(lost.briefing.id, item);
    expect(input).toMatchObject({ status: "not_shared", ref_key: null });
    expect(input.analysis_json.withdrawn).toBeUndefined();
    expect(await w.count("runs")).toBe(0);

    // Back in the Project: delivered.
    await db.pool.query(`UPDATE project_members SET status='active' WHERE project_id=$1 AND user_id=$2`, [PROJECT, OWNER]);
    const back = await w.service().request(personal, OWNER, request);
    expect(await inputOf(back.briefing.id, item)).toMatchObject({ status: "included" });
    await settleBriefingRun(db.pool, await w.finishRun((await w.runOf(back.briefing.id)).id, "synthetic failure", "failed"));

    // The person leaves that Project's Reading: an explicit choice, for good.
    await preferences.set({ spaceId: SPACE, userId: OWNER }, PROJECT, false);
    const out = await w.service().request(personal, OWNER, request);
    expect(await inputOf(out.briefing.id, item)).toMatchObject({ analysis_json: expect.objectContaining({ withdrawn: true }) });
    expect(await new PgBriefingRepository(db.pool).pendingSince(personal.scope, new Date().toISOString(), PENDING_INPUT_STATUSES, 10)).toEqual({ itemIds: [], overflow: 0 });
  });
});
