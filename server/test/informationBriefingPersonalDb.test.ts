import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import {
  AGENT, CHANNEL, CONNECTION, MEMBER, NEWCOMER, OWNER, PROFILE, PROJECT, SPACE,
  briefingWorld, output, outputValue,
} from "./support/briefingFixture.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { informationDigestModule } from "../src/modules/informationDigest/index.js";
import { ReadingPreferences } from "../src/modules/informationDigest/readingPreferences.js";
import { personalBriefingScope } from "../src/modules/informationDigest/briefing/personalScope.js";
import { buildManifest } from "../src/modules/informationDigest/briefing/manifest.js";
import { assertBriefingDispatch, settleBriefingRun } from "../src/modules/informationDigest/briefing/settlement.js";
import { setDailyBriefing } from "../src/modules/informationDigest/briefing/schedule.js";
import { PERSONAL_BRIEFING_LABEL } from "../src/modules/informationDigest/briefing/routes.js";
import { PgAutomationRepository } from "../src/modules/automations/repository.js";
import { automationTargetHandlerRegistry } from "../src/modules/automations/targetRegistry.js";
import { registerInformationDigestAutomationTarget } from "../src/modules/informationDigest/automationTarget.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PostRunFinalizationService } from "../src/modules/runs/finalizationService.js";
import { runSettlement } from "../src/modules/runs/runSettlement.js";

const db = useTestDatabase(import.meta.filename);
const w = briefingWorld(db);
const { service, config, material, annotate, finishRun, rowOf, runOf, inputsOf, count, age } = w;
const personal = () => personalBriefingScope(SPACE, OWNER);
const mine = { kind: "manual" as const, execution: {}, origin: "manual" as const, label: PERSONAL_BRIEFING_LABEL };
const OTHER_PROJECT = "bf000000-0000-4000-8000-0000000000e1";
const OTHER_CHANNEL = "bf000000-0000-4000-8000-0000000000e2";

afterEach(() => __setAuthIdentityForTests(null));
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["settings", "interest_topics", "interest_profiles"], { cascade: true });
  await w.seed();
});

const optIn = (projectId: string, enabled = true, userId = OWNER) => new ReadingPreferences(db.pool).set({ spaceId: SPACE, userId }, projectId, enabled);

/** An item a subscribed channel delivered (no Project Corpus), analysed unless said otherwise. */
async function delivered(title: string, options: { channel?: string; analysed?: boolean; uri?: string; addedHoursAgo?: number; publishedHoursAgo?: number } = {}) {
  const id = randomUUID();
  const added = new Date(Date.now() - (options.addedHoursAgo ?? 1) * 3_600_000).toISOString();
  const published = new Date(Date.now() - (options.publishedHoursAgo ?? 2) * 3_600_000).toISOString();
  const channel = options.channel ?? CHANNEL;
  const connection = (await db.pool.query(`SELECT source_connection_id FROM source_channels WHERE id=$1`, [channel])).rows[0].source_connection_id;
  await db.pool.query(
    `INSERT INTO source_items (id,space_id,owner_user_id,visibility,connection_id,item_type,title,source_uri,canonical_uri,reading_initial_hash,source_domain,occurred_at,first_seen_at,last_seen_at,content_state,retention_policy,excerpt,metadata_json,created_at,updated_at)
     VALUES ($1,$2,$3,'space_shared',$4,'feed_entry',$5,$6,$6,'h0',$10,$7,$8,$8,'excerpt_saved','summary_only',$9,'{}'::jsonb,$8,$8)`,
    [id, SPACE, OWNER, connection, title, options.uri ?? `https://news.test/${id}`, published, added, `${title} excerpt`, new URL(options.uri ?? "https://news.test/").hostname],
  );
  await db.pool.query(`INSERT INTO source_channel_item_links (id,space_id,source_channel_id,source_item_id,status,matched_at,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`, [randomUUID(), SPACE, channel, id, added]);
  if (options.analysed !== false) await annotate(id, `${title} summary`, added, channel);
  return id;
}

/** A Following topic owned by `owner` (personal unless `projectId`), selecting `item`. */
async function follow(item: string, topic: string, options: { owner?: string; projectId?: string | null; reason?: string } = {}) {
  const goal = randomUUID(), binding = randomUUID();
  await db.pool.query(
    `INSERT INTO source_goals (id,space_id,owner_user_id,project_id,agent_id,runtime_profile_id,intent_json,budget_json,status,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'{}','running',now() - interval '2 hours')`,
    [goal, SPACE, options.owner ?? OWNER, options.projectId ?? null, AGENT, PROFILE, JSON.stringify({ intent: topic })],
  );
  await db.pool.query(`INSERT INTO source_goal_bindings (id,space_id,goal_id,source_connection_id,spec_json) VALUES ($1,$2,$3,$4,'{}')`, [binding, SPACE, goal, CONNECTION]);
  await db.pool.query(
    `INSERT INTO source_goal_items (id,space_id,goal_id,source_item_id,source_connection_id,binding_id,version_id,first_goal_run_id,last_goal_run_id,selection_status,selection_reason,delivery_kind,associated_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'v','r','r','important',$7,'new_publication',now() - interval '1 hour',now() - interval '1 hour')`,
    [randomUUID(), SPACE, goal, item, CONNECTION, binding, options.reason ?? `Why ${topic} matters`],
  );
  return goal;
}

/** A channel only the other member follows (the owner still owns its Source, so its items stay readable to them). */
async function memberOnlyChannel() {
  if ((await db.pool.query(`SELECT 1 FROM source_channels WHERE id=$1`, [OTHER_CHANNEL])).rowCount) return;
  await w.addSource("bf000000-0000-4000-8000-0000000000e3", OTHER_CHANNEL, "Member-only feed", { allow_external_model_egress: true, allow_local_provider_egress: true });
  await db.pool.query(`DELETE FROM source_channel_user_subscriptions WHERE user_id=$1 AND source_channel_id=$2`, [OWNER, OTHER_CHANNEL]);
}

/** A second Project the owner may read (as a viewer), with a Corpus item reached through no subscription of theirs. */
async function otherProject(title: string) {
  await memberOnlyChannel();
  await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,settings_json,created_at,updated_at) VALUES ($1,$2,$3,'Warehouse','active','{}',now(),now())`, [OTHER_PROJECT, SPACE, MEMBER]);
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'viewer','active',now(),now())`, [randomUUID(), SPACE, OTHER_PROJECT, OWNER]);
  const item = await delivered(title, { channel: OTHER_CHANNEL });
  await db.pool.query(
    `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,source_connection_id,role,status,triage_status,triage_confirmed_by_user,read_status,reason,metadata_json,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'candidate','active','new',false,'unread','Warehouse corpus reason','{}',now() - interval '1 hour',now())`,
    [randomUUID(), SPACE, OTHER_PROJECT, item, CONNECTION],
  );
  return item;
}

/** A reply for a personal briefing with no stated topic: it cites material only. */
function mineOutput(overrides: Parameters<typeof outputValue>[0] = {}, novelty: Parameters<typeof outputValue>[1] = "baseline") {
  const value = outputValue(overrides, novelty);
  value.highlights = value.highlights.map((highlight) => ({
    ...highlight,
    impact: { assessment: "insufficient_context" as const, text: "No stated focus covers this.", context_refs: [] },
    statements: [{ kind: "fact" as const, text: "Reported.", refs: highlight.refs }],
  }));
  return output(value);
}

const manifest = (scope = personal()) => buildManifest(db.pool, scope, { cutoff: new Date().toISOString(), previous: null, label: "personal", egressAllowed: async () => true });

describe("Personal briefing: what a reader's own Reading draws on, and nothing else", () => {
  it("selects own Following, own subscriptions and opted-in readable Projects; never another person's topics, an unselected Project or another Space", async (ctx) => {
    if (!db.available) return ctx.skip();
    const followed = await delivered("Own Following report");
    await follow(followed, "Soft grippers");
    await delivered("Subscribed analysed report");
    const corpus = await material("Opted-in Project corpus report", { reason: "Robotics corpus reason" });
    await otherProject("Unselected Project report");
    const othersTopic = await delivered("Other member topic report");
    await follow(othersTopic, "MEMBER_PRIVATE_TOPIC", { owner: MEMBER, reason: "MEMBER_PRIVATE_REASON" });
    await delivered("Member-only subscription report", { channel: OTHER_CHANNEL });

    // Before opting in, the Project is readable but not part of personal Reading.
    let built = await manifest();
    expect(built.prompt).not.toContain("Robotics corpus reason");
    expect(built.prompt).not.toContain('Project "Robotics"');
    await optIn(PROJECT);
    built = await manifest();
    for (const text of ["Own Following report", "Subscribed analysed report", "Opted-in Project corpus report", 'Project "Robotics": Corpus', "Robotics corpus reason", "Soft grippers"]) expect(built.prompt).toContain(text);
    for (const text of ["Unselected Project report", "Warehouse corpus reason", "MEMBER_PRIVATE_TOPIC", "MEMBER_PRIVATE_REASON", "Member-only subscription report"]) expect(built.prompt).not.toContain(text);
    // The other member's topic material is still in my subscriptions: it comes through that lens, not through their topic.
    expect(built.inputs.find((input) => input.lead?.source_item_id === othersTopic)?.lenses.map((lens) => lens.kind)).toEqual(["subscription"]);
    expect(built.inputs.find((input) => input.lead?.source_item_id === corpus)?.lenses).toEqual(expect.arrayContaining([{ kind: "corpus", label: 'Project "Robotics": Corpus' }]));
    // Only my own stated focus is context; cold start (no topics) is fine too.
    expect(built.context.map((entry) => [entry.kind, entry.label])).toEqual([["personal_focus", "Following: Soft grippers"]]);
    expect((await manifest(personalBriefingScope(SPACE, NEWCOMER))).context).toEqual([]);

    // Another Space is never read, even for the same person.
    const otherSpace = "bf000000-0000-4000-8000-0000000000e9";
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Elsewhere','team',now(),now())`, [otherSpace]);
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), otherSpace, OWNER]);
    const elsewhere = await manifest(personalBriefingScope(otherSpace, OWNER));
    expect(elsewhere.inputs).toEqual([]);
    expect(elsewhere.context).toEqual([]);
  });

  it("keeps one input per reading family with every view of it, and lets one highlight group different reports of one event", async (ctx) => {
    if (!db.available) return ctx.skip();
    await optIn(PROJECT);
    // One capture reached through my topic, my subscription and the Project Corpus.
    const item = await material("Gripper launch", { uri: "https://news.test/launch", reason: "Corpus view" });
    await follow(item, "Soft grippers", { reason: "Topic view" });
    // Another outlet's report of the same event: a separate input (different capture).
    await delivered("Gripper launch, other outlet", { uri: "https://other.test/launch" });
    const requested = await service().request(personal(), OWNER, mine);
    const inputs = await inputsOf(requested.briefing.id);
    const launch = inputs.find((input) => input.source_item_id === item)!;
    expect(launch.analysis_json.lenses.map((lens: { kind: string }) => lens.kind).sort()).toEqual(["corpus", "following", "subscription"]);
    expect(inputs.filter((input) => input.ref_key)).toHaveLength(2);
    const run = await runOf(requested.briefing.id);
    expect(run.prompt).toContain("Topic view");
    expect(run.prompt).toContain("Corpus view");
    // A synthesis that groups both reports into one highlight is expressible and validated (not a claim a real model does it).
    const value = outputValue();
    value.highlights[0] = { ...value.highlights[0]!, refs: ["S1", "S2"], statements: [{ kind: "fact", text: "Two outlets report the launch.", refs: ["S1", "S2"] }], impact: { assessment: "affects", text: "Bears on my topic.", context_refs: ["C1"] } };
    await settleBriefingRun(db.pool, await finishRun(run.id, output(value)));
    const read = await service().get(personal(), OWNER, requested.briefing.id);
    expect(read).toMatchObject({ status: "ready", scope_type: "personal", highlights: [{ refs: ["S1", "S2"], source_domains: 2 }], context: [{ kind: "personal_focus" }] });
  });
});

describe("Personal briefing: withdrawal through the kernel's one authorization rule", () => {
  it("withdraws what came through a Project when the reader opts out, loses access, or the Project is deleted — at dispatch, publication and read", async (ctx) => {
    if (!db.available) return ctx.skip();
    const projectItem = await otherProject("Warehouse report");
    await optIn(OTHER_PROJECT);
    const requested = await service().request(personal(), OWNER, mine);
    const run = await runOf(requested.briefing.id);
    expect(run.prompt).toContain("Warehouse corpus reason");
    const key = (await inputsOf(requested.briefing.id)).find((input) => input.source_item_id === projectItem).ref_key;
    // Opting out before dispatch stops the Run; opting back in admits it again.
    await optIn(OTHER_PROJECT, false);
    await expect(assertBriefingDispatch(config(), run, db.pool)).rejects.toMatchObject({ statusCode: 403, code: "briefing_access_changed" });
    await optIn(OTHER_PROJECT, true);
    await expect(assertBriefingDispatch(config(), run, db.pool)).resolves.toBeUndefined();
    await settleBriefingRun(db.pool, await finishRun(run.id, mineOutput({ overview: { text: "WAREHOUSE_DERIVED", refs: [key] }, highlights: [] })));
    expect(await service().get(personal(), OWNER, requested.briefing.id)).toMatchObject({ visibility: "visible", overview: { text: "WAREHOUSE_DERIVED" } });
    // Opted out after publication: the derived overview, labels and evidence are withheld.
    await optIn(OTHER_PROJECT, false);
    let read = await service().get(personal(), OWNER, requested.briefing.id);
    expect(read).toMatchObject({ visibility: "withheld", overview: null, evidence: [] });
    expect(JSON.stringify(read)).not.toContain("Warehouse");
    await optIn(OTHER_PROJECT, true);
    expect((await service().get(personal(), OWNER, requested.briefing.id)).visibility).toBe("visible");
    // Removed from the Project: withdrawn although the preference is still on.
    await db.pool.query(`UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2`, [OTHER_PROJECT, OWNER]);
    read = await service().get(personal(), OWNER, requested.briefing.id);
    expect(read).toMatchObject({ visibility: "withheld", overview: null });
    await db.pool.query(`UPDATE project_members SET status='active' WHERE project_id=$1 AND user_id=$2`, [OTHER_PROJECT, OWNER]);
    expect((await service().get(personal(), OWNER, requested.briefing.id)).visibility).toBe("visible");
    // The Project is deleted.
    await db.pool.query(`UPDATE projects SET deleted_at=now() WHERE id=$1`, [OTHER_PROJECT]);
    expect(await service().get(personal(), OWNER, requested.briefing.id)).toMatchObject({ visibility: "withheld", overview: null });
  });

  it("carries a Project-derived highlight into the next version only with its closure, and withdraws that version when the Project leaves Reading", async (ctx) => {
    if (!db.available) return ctx.skip();
    await otherProject("Warehouse report");
    await optIn(OTHER_PROJECT);
    const first = await service().request(personal(), OWNER, mine);
    await settleBriefingRun(db.pool, await finishRun((await runOf(first.briefing.id)).id, mineOutput({ highlights: [{ ...outputValue().highlights[0]!, what_changed: "WAREHOUSE_HIGHLIGHT" }] })));
    expect((await rowOf(first.briefing.id)).status).toBe("ready");
    await age(1);
    await delivered("New subscribed report", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    const next = await service().request(personal(), OWNER, mine);
    const run = await runOf(next.briefing.id);
    expect(run.prompt).toContain("WAREHOUSE_HIGHLIGHT");
    await expect(assertBriefingDispatch(config(), run, db.pool)).resolves.toBeUndefined();
    await optIn(OTHER_PROJECT, false);
    await expect(assertBriefingDispatch(config(), run, db.pool)).rejects.toMatchObject({ code: "briefing_access_changed" });
    // Opted out before the next version is frozen: the old highlight is not offered at all.
    await settleBriefingRun(db.pool, await finishRun(run.id, "", "failed"));
    const after = await runOf((await service().request(personal(), OWNER, mine)).briefing.id);
    expect(after.prompt).not.toContain("WAREHOUSE_HIGHLIGHT");
  });
});

describe("Personal briefing: versions, privacy and the daily schedule", () => {
  it("reads deltas, no-new checks and late analysis through the same kernel, and stays private to its owner and apart from the Project's", async (ctx) => {
    if (!db.available) return ctx.skip();
    await delivered("First report");
    const pending = await delivered("Waiting for analysis", { analysed: false });
    const first = await service().request(personal(), OWNER, mine);
    expect((await rowOf(first.briefing.id)).coverage_json).toMatchObject({ included: 1, not_ready: 1 });
    await settleBriefingRun(db.pool, await finishRun((await runOf(first.briefing.id)).id, mineOutput()));
    expect((await rowOf(first.briefing.id)).status).toBe("ready");
    // Nothing new: one reusable check, no Run.
    const runs = await count("runs");
    const check = await service().request(personal(), OWNER, mine);
    expect(check.briefing.outcome).toBe("no_new_material");
    expect((await service().request(personal(), OWNER, mine)).briefing.id).toBe(check.briefing.id);
    expect(await count("runs")).toBe(runs);
    // The late analysis arrives: the carried item is now news.
    await age(1);
    await annotate(pending, "Late analysis");
    const delta = await service().request(personal(), OWNER, mine);
    expect((await inputsOf(delta.briefing.id)).find((input) => input.source_item_id === pending)).toMatchObject({ status: "included" });

    // Private to its owner, and separate from the Project briefing.
    await expect(service().get(personal(), MEMBER, first.briefing.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service().get(personalBriefingScope(SPACE, MEMBER), MEMBER, first.briefing.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service().get(w.adapter(), OWNER, first.briefing.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await service().overview(w.adapter(), OWNER, false)).history).toEqual([]);
    const app = await buildModuleServer(config(), [informationDigestModule]);
    try {
      const url = `/api/v1/spaces/${SPACE}/information-briefings/personal`;
      __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });
      // The member's own personal briefing: empty, and they cannot reach the owner's version.
      expect((await app.inject({ method: "GET", url })).json()).toMatchObject({ can_generate: true, latest: null, history: [] });
      expect((await app.inject({ method: "GET", url: `${url}/${first.briefing.id}` })).statusCode).toBe(404);
      __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
      const overview = (await app.inject({ method: "GET", url })).json();
      expect(overview).toMatchObject({ can_generate: true, latest: { id: delta.briefing.id, scope_type: "personal" }, latest_briefing: { id: first.briefing.id } });
      expect(overview.history).toHaveLength(3);
    } finally {
      await app.close();
    }
  });

  it("rides the reader's personal daily digest Automation, holding the day behind a running manual version and resuming it after", async (ctx) => {
    if (!db.available) return ctx.skip();
    await delivered("Yesterday's report", { addedHoursAgo: 30, publishedHoursAgo: 31 });
    const automation = await new PgAutomationRepository(db.pool).create({
      spaceId: SPACE, ownerUserId: OWNER, agentId: AGENT, projectId: null, name: "Personal daily digest", triggerType: "schedule",
      configJson: { target_type: "information_digest", scope: "personal", operation: "daily", cron: "0 7 * * *", timezone: "UTC" },
      preflightSnapshot: { executable: true, target_type: "information_digest" },
    });
    // Only its owner may enable it.
    await expect(setDailyBriefing(db.pool, personalBriefingScope(SPACE, MEMBER), MEMBER, { daily_enabled: true })).rejects.toMatchObject({ statusCode: 409 });
    expect(await setDailyBriefing(db.pool, personal(), OWNER, { daily_enabled: true })).toMatchObject({ enabled: true, user_id: OWNER });
    registerInformationDigestAutomationTarget();
    const handler = automationTargetHandlerRegistry.get("information_digest")!;
    const fire = async () => {
      const row = (await new PgAutomationRepository(db.pool).get(SPACE, automation.id))!;
      return await handler.execute({
        config: config(), repo: new PgAutomationRepository(db.pool), host: {} as never, automation: { ...row, next_run_at: new Date().toISOString() },
        fireInput: { spaceId: SPACE, automationId: automation.id, actorUserId: OWNER, triggerType: "schedule" }, triggerType: "schedule",
        responsibility: { triggerOrigin: "automation", instructedByUserId: OWNER }, preflightSnapshot: {}, advanceSchedule: false,
      } as never) as Record<string, unknown>;
    };
    const finalize = async (runId: string, text: string) => {
      const done = await finishRun(runId, text);
      await new PostRunFinalizationService(new PgRunRepository(db.pool), undefined, undefined, undefined, runSettlement(config(), db.pool)).finalize(done.id, SPACE);
    };
    const running = await service().request(personal(), OWNER, mine);
    await fire();
    const digest = (await db.pool.query(`SELECT id, digest_date, period_end_utc FROM information_digests WHERE digest_type='personal' AND owner_user_id=$1`, [OWNER])).rows[0];
    const held = (await db.pool.query(`SELECT * FROM information_briefings WHERE period_date=$1`, [digest.digest_date])).rows;
    expect(held).toEqual([expect.objectContaining({ scope_type: "personal", kind: "daily", status: "blocked", error_code: "briefing_scope_busy", digest_id: digest.id })]);
    await finalize((await runOf(running.briefing.id)).id, mineOutput());
    const day = (await db.pool.query(`SELECT * FROM information_briefings WHERE period_date=$1 AND status IN ('queued','ready','blocked')`, [digest.digest_date])).rows[0];
    expect(day).toMatchObject({ scope_type: "personal", kind: "daily", digest_id: digest.id, requested_by_user_id: OWNER });
    expect(new Date(day.cutoff_at).toISOString()).toBe(new Date(digest.period_end_utc).toISOString());
    // A replayed fire changes nothing.
    const before = await count("runs");
    await fire();
    expect(await count("runs")).toBe(before);
    expect(await count(`information_briefings WHERE period_date='${digest.digest_date}'`)).toBe(1);
  });
});
