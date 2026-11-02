import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { CONNECTION, MEMBER, NEWCOMER, OWNER, PROJECT, SPACE, briefingWorld, manual, output, outputValue } from "./support/briefingFixture.js";
import { assertBriefingDispatch, settleBriefingRun } from "../src/modules/informationDigest/briefing/settlement.js";
import { buildManifest } from "../src/modules/informationDigest/briefing/manifest.js";
import type { BriefingCandidate, BriefingSignalDep } from "../src/modules/informationDigest/briefing/contract.js";

const db = useTestDatabase(import.meta.filename);
const w = briefingWorld(db);
const { adapter, service, config, material, finishRun, rowOf, runOf, inputsOf, age } = w;
const CONSENTING = { allow_external_model_egress: true, allow_local_provider_egress: true };
const PRIVATE_CONNECTION = "bf000000-0000-4000-8000-0000000000d1";
const PRIVATE_CHANNEL = "bf000000-0000-4000-8000-0000000000d2";

beforeEach(async () => { if (db.available) await w.seed(); });

/** A Source both Project readers follow but only its owner may read once narrowed: model egress stays allowed. */
async function privateSource() {
  await w.addSource(PRIVATE_CONNECTION, PRIVATE_CHANNEL, "Owner's analysis feed", CONSENTING);
  await db.pool.query(`UPDATE source_connections SET visibility='private' WHERE id=$1`, [PRIVATE_CONNECTION]);
}

/** Publishes the first version with one highlight whose text rests on S1 and the given Task's C ref. */
async function publishOnTask(task: string, text: string) {
  const first = await service().request(adapter(), OWNER, manual);
  const taskKey = (await rowOf(first.briefing.id)).context_json.find((entry: { source: { id: string } }) => entry.source.id === task).key;
  const value = outputValue();
  value.highlights[0] = { ...value.highlights[0]!, what_changed: text, refs: ["S1", taskKey] };
  await settleBriefingRun(db.pool, await finishRun((await runOf(first.briefing.id)).id, output(value)));
  return first.briefing.id;
}

/** A synthetic output that relies only on the comparison: it cites a real background ref, nothing invented. */
async function answerFromBackground(briefingId: string, text: string) {
  const background = (await inputsOf(briefingId)).find((input) => input.delta_class === "background")!;
  const value = outputValue({}, "ongoing");
  value.overview = { text, refs: [background.ref_key] };
  value.highlights[0] = { ...value.highlights[0]!, novelty: "ongoing", what_changed: text, refs: [background.ref_key], statements: [{ kind: "fact", text, refs: [background.ref_key] }], impact: { assessment: "insufficient_context", text: "Unknown.", context_refs: [] } };
  await settleBriefingRun(db.pool, await finishRun((await runOf(briefingId)).id, output(value)));
}

describe("Comparison texts keep the dependency closure of the version they came from", () => {
  it("carries a still-shared done Task's closure into the next version, and stops dispatch, publication and reads once it is withdrawn", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Report");
    const task = await w.task("Picking cell");
    await publishOnTask(task, "OLD_TASK_SECRET");
    // Done but still shared with the Project: no longer open context, still a legitimate basis for comparison.
    await db.pool.query(`UPDATE tasks SET status='done', updated_at=now() WHERE id=$1`, [task]);
    await age(1);
    await material("New report", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    const next = await service().request(adapter(), OWNER, manual);
    const run = await runOf(next.briefing.id);
    expect(run.prompt).toContain("OLD_TASK_SECRET");
    const row = await rowOf(next.briefing.id);
    expect(row.context_json.some((entry: { source: { id: string } }) => entry.source.id === task)).toBe(false);
    expect(row.comparison_json).toEqual([expect.objectContaining({ context: expect.arrayContaining([expect.objectContaining({ type: "task", id: task })]) })]);
    await expect(assertBriefingDispatch(config(), run, db.pool)).resolves.toBeUndefined();

    // Withdrawn after freezing: the next version is not dispatched...
    await db.pool.query(`UPDATE tasks SET project_id=NULL, visibility='private', updated_at=now() WHERE id=$1`, [task]);
    await expect(assertBriefingDispatch(config(), run, db.pool)).rejects.toMatchObject({ statusCode: 403, code: "briefing_access_changed" });
    // ...and an answer that cites only the real background ref is not published or shown.
    await answerFromBackground(next.briefing.id, "OLD_TASK_SECRET");
    expect(await rowOf(next.briefing.id)).toMatchObject({ status: "failed", error_code: "briefing_access_changed" });
    const read = await service().get(adapter(), MEMBER, next.briefing.id);
    expect(read).toMatchObject({ overview: null, highlights: [] });
    expect(JSON.stringify(read)).not.toContain("OLD_TASK_SECRET");
  });

  it("does not offer a previous highlight whose context was withdrawn before the next version was frozen", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Report");
    const task = await w.task("Picking cell");
    await publishOnTask(task, "OLD_TASK_SECRET");
    await db.pool.query(`UPDATE tasks SET project_id=NULL, visibility='private', updated_at=now() WHERE id=$1`, [task]);
    await age(1);
    await material("New report", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    const next = await service().request(adapter(), OWNER, manual);
    expect((await runOf(next.briefing.id)).prompt).not.toContain("OLD_TASK_SECRET");
    expect((await rowOf(next.briefing.id)).comparison_json).toEqual([]);
    await expect(assertBriefingDispatch(config(), await runOf(next.briefing.id), db.pool)).resolves.toBeUndefined();
  });

  it("keeps the closure across two generations: a third version inherits the first version's Task through the second", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Report");
    const task = await w.task("Picking cell");
    const first = await publishOnTask(task, "OLD_TASK_SECRET");
    await db.pool.query(`UPDATE tasks SET status='done', updated_at=now() WHERE id=$1`, [task]);
    await age(1);
    await material("Second report", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    const second = await service().request(adapter(), OWNER, manual);
    // The second version rewords the old text under its own background ref: the Task is still behind it.
    await answerFromBackground(second.briefing.id, "Reworded OLD_TASK_SECRET");
    expect((await rowOf(second.briefing.id)).status).toBe("ready");
    await age(1);
    await material("Third report", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    const third = await service().request(adapter(), OWNER, manual);
    const thirdRow = await rowOf(third.briefing.id);
    expect((await runOf(third.briefing.id)).prompt).toContain("Reworded OLD_TASK_SECRET");
    expect(thirdRow.comparison_json).toEqual([expect.objectContaining({
      previous_briefing_id: second.briefing.id,
      context: expect.arrayContaining([expect.objectContaining({ type: "task", id: task })]),
    })]);
    // Withdrawn now: every generation that rests on it stops or hides, the original as well.
    await db.pool.query(`UPDATE tasks SET project_id=NULL, visibility='private', updated_at=now() WHERE id=$1`, [task]);
    await expect(assertBriefingDispatch(config(), await runOf(third.briefing.id), db.pool)).rejects.toMatchObject({ code: "briefing_access_changed" });
    expect(await service().get(adapter(), MEMBER, second.briefing.id)).toMatchObject({ visibility: "withheld", overview: null });
    expect((await service().get(adapter(), MEMBER, first)).highlights).toEqual([]);
  });
});

describe("Analyses and scope judgments are shared only through Sources the whole audience may read", () => {
  it("never sends an annotation or Corpus reason collected through a Source other members cannot read, though the item is public", async (ctx) => {
    if (!db.available) return ctx.skip();
    await privateSource();
    const item = await material("Public material", { reason: "Public corpus reason" });
    await db.pool.query(`UPDATE source_item_annotations SET source_channel_id=$2, summary='PRIVATE_ANALYSIS_SECRET' WHERE source_item_id=$1`, [item, PRIVATE_CHANNEL]);
    const other = await material("Other public material", { reason: "Plain reason" });
    await db.pool.query(`UPDATE project_corpus_items SET source_connection_id=$2, reason='PRIVATE_CORPUS_REASON' WHERE source_item_id=$1`, [other, PRIVATE_CONNECTION]);
    const requested = await service().request(adapter(), OWNER, manual);
    const run = await runOf(requested.briefing.id);
    expect(run.prompt).toContain("Public material");
    expect(run.prompt).toContain("Public corpus reason");
    expect(run.prompt).not.toContain("PRIVATE_ANALYSIS_SECRET");
    expect(run.prompt).not.toContain("PRIVATE_CORPUS_REASON");
    expect(JSON.stringify((await inputsOf(requested.briefing.id)).map((input) => input.analysis_json.deps))).not.toContain(PRIVATE_CONNECTION);
    // Its egress consent was never the question: the Source is still allowed to reach the model.
    expect((await db.pool.query(`SELECT consent_json FROM source_connections WHERE id=$1`, [PRIVATE_CONNECTION])).rows[0].consent_json).toMatchObject(CONSENTING);
    await expect(assertBriefingDispatch(config(), run, db.pool)).resolves.toBeUndefined();
  });

  it("re-checks every collecting Source at dispatch, publication and read: a new member, an archived or narrowed Source", async (ctx) => {
    if (!db.available) return ctx.skip();
    await w.addSource(PRIVATE_CONNECTION, PRIVATE_CHANNEL, "Analysis feed", CONSENTING);
    const item = await material("Public material");
    await db.pool.query(`UPDATE source_item_annotations SET source_channel_id=$2, summary='SHARED_ANALYSIS' WHERE source_item_id=$1`, [item, PRIVATE_CHANNEL]);
    const requested = await service().request(adapter(), OWNER, manual);
    const run = await runOf(requested.briefing.id);
    expect(run.prompt).toContain("SHARED_ANALYSIS");
    await expect(assertBriefingDispatch(config(), run, db.pool)).resolves.toBeUndefined();
    // A newcomer follows the item's Source but not the analysis Source.
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'viewer','active',now(),now())`, [randomUUID(), SPACE, PROJECT, NEWCOMER]);
    await w.subscribe(NEWCOMER, new Date(Date.now() - 2 * 86_400_000).toISOString());
    await expect(assertBriefingDispatch(config(), run, db.pool)).rejects.toMatchObject({ statusCode: 403, code: "briefing_access_changed" });
    await w.subscribe(NEWCOMER, new Date(Date.now() - 2 * 86_400_000).toISOString(), PRIVATE_CHANNEL);
    await expect(assertBriefingDispatch(config(), run, db.pool)).resolves.toBeUndefined();
    await settleBriefingRun(db.pool, await finishRun(run.id, output({ overview: { text: "Per SHARED_ANALYSIS", refs: ["S1"] } })));
    expect(await service().get(adapter(), MEMBER, requested.briefing.id)).toMatchObject({ visibility: "visible" });
    // Narrowed to its owner: the published text resting on it is withheld for everyone.
    await db.pool.query(`UPDATE source_connections SET visibility='private' WHERE id=$1`, [PRIVATE_CONNECTION]);
    expect(await service().get(adapter(), MEMBER, requested.briefing.id)).toMatchObject({ visibility: "withheld", overview: null });
    await db.pool.query(`UPDATE source_connections SET visibility='space_shared', status='archived' WHERE id=$1`, [PRIVATE_CONNECTION]);
    expect(JSON.stringify(await service().get(adapter(), OWNER, requested.briefing.id))).not.toContain("SHARED_ANALYSIS");
  });

  it("applies the same collecting-Source gate to every kind of scope judgment (Following, monitoring decision, Corpus) and to analysis", async (ctx) => {
    if (!db.available) return ctx.skip();
    await privateSource();
    const shared = CONNECTION;
    const now = new Date().toISOString();
    const signal = (kind: BriefingSignalDep["kind"], connection: string, text: string) => ({
      lens: { kind: kind === "goal_item" ? "following" as const : kind === "decision" ? "monitoring" as const : "corpus" as const, label: `${kind} lens` },
      text, activity_at: now, change_at: null,
      dep: { kind, id: randomUUID(), item_id: "x", connection_id: connection, revision: "r", at: now },
    });
    const item = await material("Public material", { analysed: false });
    const candidate: BriefingCandidate = {
      source_item_id: item, family_key: `item:${item}`, content_revision: "r", connection_id: shared, title: "Public material",
      source_domain: "news.test", occurred_at: now, first_seen_at: now, activity_at: now, change_at: null, unverified: false,
      summary: "PRIVATE_SUMMARY", excerpt: null,
      annotation: { id: randomUUID(), item_id: item, connection_id: PRIVATE_CONNECTION, revision: "r", at: now },
      signals: [
        signal("goal_item", PRIVATE_CONNECTION, "PRIVATE_FOLLOWING"), signal("decision", PRIVATE_CONNECTION, "PRIVATE_DECISION"),
        signal("corpus_item", PRIVATE_CONNECTION, "PRIVATE_CORPUS"), signal("decision", shared, "SHARED_DECISION"),
      ],
    };
    const manifest = await buildManifest(db.pool, { ...adapter(), candidates: async () => ({ rows: [candidate], not_shared_ids: [] }) }, {
      cutoff: now, previous: null, label: "Project", egressAllowed: async () => true,
    });
    expect(manifest.prompt).toContain("SHARED_DECISION");
    for (const secret of ["PRIVATE_SUMMARY", "PRIVATE_FOLLOWING", "PRIVATE_DECISION", "PRIVATE_CORPUS", "goal_item lens", "corpus_item lens"]) expect(manifest.prompt).not.toContain(secret);
    expect(manifest.inputs[0]!.deps.signals.map((dep) => dep.connection_id)).toEqual([shared]);
    expect(manifest.inputs[0]!.deps.annotations).toEqual([]);
  });
});
