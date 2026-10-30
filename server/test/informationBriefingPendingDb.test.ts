import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { CONNECTION, OWNER, PROJECT, SPACE, briefingWorld, manual, output, outputValue } from "./support/briefingFixture.js";
import { settleBriefingRun } from "../src/modules/informationDigest/briefing/settlement.js";
import { PgBriefingRepository } from "../src/modules/informationDigest/briefing/repository.js";
import { buildManifest, PENDING_INPUT_STATUSES } from "../src/modules/informationDigest/briefing/manifest.js";

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
async function refusedSealedDay() {
  const cutoff = new Date(`${new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`).toISOString();
  const start = new Date(Date.parse(cutoff) - 86_400_000).toISOString();
  const digest = randomUUID();
  await db.pool.query(
    `INSERT INTO information_digests (id,space_id,digest_type,project_id,digest_date,period_start_utc,period_end_utc,generation_kind,created_at,updated_at)
     VALUES ($1,$2,'project',$3,$4,$5,$6,'backfill',now(),now())`,
    [digest, SPACE, PROJECT, start.slice(0, 10), start, cutoff],
  );
  const item = await w.material("PENDING_FROM_SEALED_DAY", { addedHoursAgo: 16 * 24, publishedHoursAgo: 16 * 24 });
  await consent(DENY_ALL);
  const sealed = await w.service().request(w.adapter(), OWNER, { ...manual, kind: "backfill", day: { date: start.slice(0, 10), digestId: digest, cutoff } });
  expect(sealed.briefing).toMatchObject({ status: "ready", outcome: "no_new_material" });
  expect(sealed.briefing.coverage.egress_refused).toBe(1);
  expect(await w.count("runs")).toBe(0);
  return { item, sealed: sealed.briefing.id };
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
    expect(await inputOf(current.briefing.id, item)).toBeUndefined();
    expect(current.briefing.coverage.carried_from_previous).toBe(0);
    expect(await w.count("runs")).toBe(0);
  });

  it("bounds the carry and counts what did not fit as left out, not silently dropped", async (ctx) => {
    if (!db.available) return ctx.skip();
    await w.material("First");
    await w.material("Second");
    await consent(DENY_ALL);
    const refused = await w.service().request(w.adapter(), OWNER, manual);
    expect(refused.briefing.coverage.egress_refused).toBe(2);
    const scope = w.adapter().scope;
    const pending = await new PgBriefingRepository(db.pool).pendingSince(scope, null, new Date().toISOString(), PENDING_INPUT_STATUSES, 1);
    expect(pending.itemIds).toHaveLength(1);
    expect(pending.overflow).toBe(1);
    await consent(ALLOW_ALL);
    const manifest = await buildManifest(db.pool, w.adapter(), {
      cutoff: new Date().toISOString(), previous: null, pending, label: "Project", egressAllowed: async () => true,
    });
    expect(manifest.coverage.truncated).toBeGreaterThanOrEqual(1);
    expect(manifest.coverage.complete).toBe(false);
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
    const pending = await new PgBriefingRepository(db.pool).pendingSince(w.adapter().scope, null, new Date().toISOString(), PENDING_INPUT_STATUSES, 200);
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
