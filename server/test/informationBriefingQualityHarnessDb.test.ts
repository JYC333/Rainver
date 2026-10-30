import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { MEMBER, OWNER, briefingWorld, manual, output, outputValue } from "./support/briefingFixture.js";
import { randomUUID } from "node:crypto";
import { QUALITY_CASES, QUALITY_DELTA, QUALITY_PERSONAL, QUALITY_RUBRIC, type QualityItem } from "./support/briefingQualityCorpus.js";
import { AGENT, CONNECTION, PROFILE, PROJECT, SPACE } from "./support/briefingFixture.js";
import { personalBriefingScope } from "../src/modules/informationDigest/briefing/personalScope.js";
import { PERSONAL_BRIEFING_LABEL } from "../src/modules/informationDigest/briefing/routes.js";
import { ReadingPreferences } from "../src/modules/informationDigest/readingPreferences.js";
import { settleBriefingRun } from "../src/modules/informationDigest/briefing/settlement.js";

// The repeatable entry for judging briefing quality on a fixed synthetic
// corpus (`support/briefingQualityCorpus.ts`), through the real request path:
// candidates, families, manifest, prompt and instruction, and — for a reply —
// the real parse, validation and publication. It calls no model.
//
// - Without replies it checks the request is built as the cases need, and
//   writes each request with its ref map, expectations and the human rubric
//   to BRIEFING_QUALITY_OUT (default /tmp/rainver-briefing-quality), marked
//   NOT EVALUATED.
// - With replies from an authorized real-model run in BRIEFING_QUALITY_REPLIES
//   (`baseline.txt`, `delta.txt`, `personal.txt`: the model's final reply to
//   the written request), it runs each through the real settlement and records
//   whether it meets the contract in that case's `contract.json`. Meeting the contract is not quality: a person scores the
//   rubric. A fixture reply here is never a quality result.
const db = useTestDatabase(import.meta.filename, { max: 10 });
const w = briefingWorld(db);
const OUT = process.env.BRIEFING_QUALITY_OUT ?? "/tmp/rainver-briefing-quality";
const REPLIES = process.env.BRIEFING_QUALITY_REPLIES ?? null;

beforeEach(async () => { if (db.available) await w.seed(); });

async function seed(item: QualityItem, owner = OWNER): Promise<string> {
  const id = await w.material(item.title, { uri: item.uri, publishedHoursAgo: item.hoursAgo, addedHoursAgo: item.hoursAgo, owner });
  await db.pool.query(`UPDATE source_item_annotations SET summary=$2 WHERE source_item_id=$1`, [id, item.summary]);
  await db.pool.query(`UPDATE source_items SET excerpt=$2 WHERE id=$1`, [id, item.summary]);
  return id;
}

const reply = async (name: string) => {
  const path = REPLIES ? join(REPLIES, `${name}.txt`) : null;
  return path && existsSync(path) ? readFile(path, "utf8") : null;
};

/** Writes one request for a reviewer: exactly what the model receives, which S/C ref is which corpus item, and how to score it. */
async function writeRequest(name: string, briefingId: string, items: Map<string, QualityItem>, expectations: string[], status: string, out = OUT) {
  const dir = join(out, name);
  await mkdir(dir, { recursive: true });
  // A contract result from an earlier run is not this run's: only this case's own file is removed.
  await rm(join(dir, "contract.json"), { force: true });
  const run = await w.runOf(briefingId);
  const row = await w.rowOf(briefingId);
  const inputs = await w.inputsOf(briefingId);
  const refs = inputs.filter((input) => input.ref_key).map((input) => ({
    ref: input.ref_key, status: input.status, delta_class: input.delta_class, corpus: items.get(input.source_item_id)?.key ?? "(not in corpus)",
  }));
  await writeFile(join(dir, "prompt.txt"), run.prompt ?? "");
  await writeFile(join(dir, "instruction.txt"), run.instruction ?? "");
  await writeFile(join(dir, "refs.json"), JSON.stringify({ material: refs, context: row.context_json.map((entry: { key: string; label: string }) => ({ ref: entry.key, label: entry.label })) }, null, 2));
  await writeFile(join(dir, "evaluation.md"), [
    `# Briefing quality — ${name}`, "", `Status: ${status}`, "",
    "## What a good briefing does", ...expectations.map((line) => `- ${line}`), "",
    "## Score each highlight (a person, not the model)", ...QUALITY_RUBRIC.map((line) => `- [ ] ${line}`), "",
    "Contract checks (refs exist, facts cite material, impact cites context, novelty matches the server's delta classes) prove structure only, not support or grouping.",
  ].join("\n"));
}

/**
 * Runs a supplied reply through the real settlement of its version and records
 * the contract result beside the request. The same for every case.
 */
async function settleAndRecord(name: string, briefingId: string, text: string, out = OUT) {
  await settleBriefingRun(db.pool, await w.finishRun((await w.runOf(briefingId)).id, text));
  const row = await w.rowOf(briefingId);
  await mkdir(join(out, name), { recursive: true });
  await writeFile(join(out, name, "contract.json"), JSON.stringify({ status: row.status, outcome: row.outcome, error_code: row.error_code, error_message: row.error_message }, null, 2));
  return row;
}

/** The personal cross-topic request: one item through two lenses, another topic, the reader's own focus. */
async function personalRequest() {
  const items = new Map<string, QualityItem>();
  const shared = await seed(QUALITY_PERSONAL.shared);
  const battery = await seed(QUALITY_PERSONAL.otherTopic);
  items.set(shared, QUALITY_PERSONAL.shared);
  items.set(battery, QUALITY_PERSONAL.otherTopic);
  await follow(shared, QUALITY_PERSONAL.topics[0]);
  await follow(battery, QUALITY_PERSONAL.topics[1]);
  await new ReadingPreferences(db.pool).set({ spaceId: SPACE, userId: OWNER }, PROJECT, true);
  const requested = await w.service().request(personalBriefingScope(SPACE, OWNER), OWNER, { ...manual, label: PERSONAL_BRIEFING_LABEL });
  return { items, shared, battery, id: requested.briefing.id, status: requested.briefing.status };
}

describe("Briefing quality corpus: the real request, and an authorized reply's contract check", () => {
  it("builds the baseline and delta requests the cases need, and records any supplied real reply's contract result", async (ctx) => {
    if (!db.available) return ctx.skip();
    const items = new Map<string, QualityItem>();
    for (const item of QUALITY_CASES.flatMap((entry) => entry.items)) items.set(await seed(item), item);
    const baseline = await w.service().request(w.adapter(), OWNER, manual);
    expect(baseline.briefing.status).toBe("queued");
    const inputs = await w.inputsOf(baseline.briefing.id);
    const refOf = (key: string) => inputs.find((input) => items.get(input.source_item_id)?.key === key);
    // Same event, two URLs: two inputs — grouping them is the model's job, judged by a person.
    expect(refOf("launch_a")?.ref_key).toBeTruthy();
    expect(refOf("launch_b")?.ref_key).toBeTruthy();
    expect(refOf("launch_a")?.family_key).not.toBe(refOf("launch_b")?.family_key);
    // Both sides of the contradiction, the unrelated item and the impact case are all in front of the model.
    for (const key of ["delay", "on_time", "unrelated", "standard"]) expect(refOf(key)?.status).toBe("included");
    const prompt = (await w.runOf(baseline.briefing.id)).prompt ?? "";
    for (const item of items.values()) expect(prompt).toContain(item.summary);
    expect((await w.rowOf(baseline.briefing.id)).context_json.map((entry: { kind: string }) => entry.kind)).toContain("project_goal");

    const realBaseline = await reply("baseline");
    await writeRequest("baseline", baseline.briefing.id, items, QUALITY_CASES.map((entry) => `${entry.id}: ${entry.expectation}`),
      realBaseline ? "REPLY SUPPLIED — contract result below; quality NOT YET SCORED" : "NOT EVALUATED — no authorized real-model reply");
    // A baseline must be published before the delta request exists. Without a real reply the
    // harness publishes a structural placeholder: it makes the delta request, and it is no result.
    const baselineRow = realBaseline
      ? await settleAndRecord("baseline", baseline.briefing.id, realBaseline)
      : (await settleBriefingRun(db.pool, await w.finishRun((await w.runOf(baseline.briefing.id)).id, output(outputValue()))), await w.rowOf(baseline.briefing.id));
    expect(baselineRow.status).toBe(realBaseline ? baselineRow.status : "ready");
    if (baselineRow.status !== "ready") return; // a real reply that broke the contract: recorded above

    // An hour passes; then new captures arrive.
    await w.age(1);
    // The same story captured again, by another member (one active item per URL per owner).
    items.set(await seed(QUALITY_DELTA.repeat, MEMBER), QUALITY_DELTA.repeat);
    items.set(await seed(QUALITY_DELTA.update), QUALITY_DELTA.update);
    const delta = await w.service().request(w.adapter(), OWNER, manual);
    expect(delta.briefing).toMatchObject({ status: "queued", comparison: "delta" });
    const deltaInputs = await w.inputsOf(delta.briefing.id);
    const deltaOf = (key: string) => deltaInputs.find((input) => items.get(input.source_item_id)?.key === key);
    // The repeat capture joins its family (capture-level dedupe); the update is new material.
    expect(delta.briefing.coverage.merged_duplicates + delta.briefing.coverage.unchanged_since_previous).toBeGreaterThan(0);
    expect(["new_publication", "newly_found"]).toContain(deltaOf("price")?.delta_class);
    const realDelta = realBaseline ? await reply("delta") : null;
    await writeRequest("delta", delta.briefing.id, items, [QUALITY_DELTA.expectation],
      !realBaseline ? "NOT EVALUATED — built on a structural placeholder baseline; do not score"
        : realDelta ? "REPLY SUPPLIED — contract result below; quality NOT YET SCORED" : "NOT EVALUATED — no authorized real-model reply");
    if (realDelta) await settleAndRecord("delta", delta.briefing.id, realDelta);
  });

  it("builds the personal cross-topic request: one item through two lenses, another topic, the reader's own focus as context", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { items, shared, battery, id, status } = await personalRequest();
    expect(status).toBe("queued");
    const inputs = await w.inputsOf(id);
    const lensesOf = (item: string) => (inputs.find((input) => input.source_item_id === item)?.analysis_json.lenses ?? []).map((lens: { kind: string }) => lens.kind).sort();
    expect(lensesOf(shared)).toEqual(expect.arrayContaining(["corpus", "following"]));
    expect(lensesOf(battery)).toContain("following");
    expect((await w.rowOf(id)).context_json.map((entry: { kind: string; label: string }) => entry.label).sort())
      .toEqual(QUALITY_PERSONAL.topics.map((topic) => `Following: ${topic}`).sort());
    const realPersonal = await reply("personal");
    await writeRequest("personal", id, items, [QUALITY_PERSONAL.expectation],
      realPersonal ? "REPLY SUPPLIED — contract result in contract.json; quality NOT YET SCORED" : "NOT EVALUATED — no authorized real-model reply");
    if (realPersonal) await settleAndRecord("personal", id, realPersonal);
  });

  // Wiring of the reply entry itself, with synthetic replies into a fresh directory: it shows the
  // personal case is settled and recorded like the others. It says nothing about quality.
  it.for([
    { reply: () => output(outputValue()), expected: { status: "ready", outcome: "briefing" } },
    { reply: () => "Not a briefing at all.", expected: { status: "failed", error_code: "briefing_output_invalid" } },
  ])("records a supplied personal reply's real contract result ($expected.status)", async ({ reply: text, expected }, ctx) => {
    if (!db.available) return ctx.skip();
    const out = await mkdtemp(join(tmpdir(), "rainver-briefing-quality-wiring-"));
    try {
      const { items, id } = await personalRequest();
      await writeRequest("personal", id, items, [QUALITY_PERSONAL.expectation], "SYNTHETIC WIRING CHECK — not a model reply, do not score", out);
      await writeFile(join(out, "personal", "contract.json"), "stale");
      await writeRequest("personal", id, items, [QUALITY_PERSONAL.expectation], "SYNTHETIC WIRING CHECK — not a model reply, do not score", out);
      expect(existsSync(join(out, "personal", "contract.json"))).toBe(false);
      expect(await settleAndRecord("personal", id, text(), out)).toMatchObject(expected);
      expect(JSON.parse(await readFile(join(out, "personal", "contract.json"), "utf8"))).toMatchObject(expected);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

/** A personal Following topic of the owner, selecting `item` through its own Source binding. */
async function follow(item: string, topic: string) {
  const goal = randomUUID(), binding = randomUUID();
  await db.pool.query(
    `INSERT INTO source_goals (id,space_id,owner_user_id,project_id,agent_id,runtime_profile_id,intent_json,budget_json,status,updated_at)
     VALUES ($1,$2,$3,NULL,$4,$5,$6::jsonb,'{}','running',now() - interval '2 hours')`,
    [goal, SPACE, OWNER, AGENT, PROFILE, JSON.stringify({ intent: topic })],
  );
  await db.pool.query(`INSERT INTO source_goal_bindings (id,space_id,goal_id,source_connection_id,spec_json) VALUES ($1,$2,$3,$4,'{}')`, [binding, SPACE, goal, CONNECTION]);
  await db.pool.query(
    `INSERT INTO source_goal_items (id,space_id,goal_id,source_item_id,source_connection_id,binding_id,version_id,first_goal_run_id,last_goal_run_id,selection_status,selection_reason,delivery_kind,associated_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'v','r','r','important',$7,'new_publication',now() - interval '1 hour',now() - interval '1 hour')`,
    [randomUUID(), SPACE, goal, item, CONNECTION, binding, `Why ${topic} matters`],
  );
}
