import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { waitForLockWaiter } from "./support/lockWait.js";
import {
  AGENT, CONNECTION, MEMBER, NEWCOMER, OWNER, PROFILE, PROJECT, SPACE,
  briefingWorld, manual, output, outputValue,
} from "./support/briefingFixture.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { informationDigestModule } from "../src/modules/informationDigest/index.js";

import { personalBriefingScope } from "../src/modules/informationDigest/briefing/personalScope.js";
import { InformationBriefingService } from "../src/modules/informationDigest/briefing/service.js";
import { assertBriefingDispatch, settleBriefingRun } from "../src/modules/informationDigest/briefing/settlement.js";
import { buildManifest } from "../src/modules/informationDigest/briefing/manifest.js";
import { BRIEFING_LIMITS, type BriefingCandidate } from "../src/modules/informationDigest/briefing/contract.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PostRunFinalizationService } from "../src/modules/runs/finalizationService.js";
import { runSettlement } from "../src/modules/runs/runSettlement.js";
import { PgAutomationRepository } from "../src/modules/automations/repository.js";
import { automationTargetHandlerRegistry } from "../src/modules/automations/targetRegistry.js";
import { registerInformationDigestAutomationTarget } from "../src/modules/informationDigest/automationTarget.js";
import { setDailyBriefing } from "../src/modules/informationDigest/briefing/schedule.js";

const db = useTestDatabase(import.meta.filename);
const w = briefingWorld(db);
const { adapter, service, config, material, annotate, finishRun, rowOf, runOf, inputsOf, count, age } = w;

afterEach(() => __setAuthIdentityForTests(null));
beforeEach(async () => { if (db.available) await w.seed(); });

/** Requests, then publishes the given output for, a manual version. */
async function publish(text = output()) {
  const requested = await service().request(adapter(), OWNER, manual);
  await settleBriefingRun(db.pool, await finishRun((await runOf(requested.briefing.id)).id, text));
  return requested.briefing.id;
}

describe("Project briefing (shared kernel, real PostgreSQL)", () => {
  it("runs request → frozen manifest → canonical Run → canonical settlement → re-authorized read, then a delta version", async (ctx) => {
    if (!db.available) return ctx.skip();
    const first = await material("Gripper launch report", { uri: "https://news.test/gripper", publishedHoursAgo: 4, addedHoursAgo: 3 });
    // The same capture saved again by another member: one input, not two confirmations.
    const repost = await material("Gripper launch (repost)", { uri: "https://news.test/gripper", owner: MEMBER, publishedHoursAgo: 4, addedHoursAgo: 3 });
    await material("Pending analysis", { analysed: false, publishedHoursAgo: 4, addedHoursAgo: 3 });

    // A viewer may read but not generate.
    await expect(service().request(adapter(), MEMBER, manual)).rejects.toMatchObject({ statusCode: 403 });
    const requested = await service().request(adapter(), OWNER, manual);
    expect(requested).toMatchObject({ created: true, briefing: { status: "queued", comparison: "baseline", kind: "manual" } });
    const row = await rowOf(requested.briefing.id);
    expect(row.coverage_json).toMatchObject({ included: 1, merged_duplicates: 1, not_ready: 1, complete: false });
    const run = await runOf(requested.briefing.id);
    expect(run).toMatchObject({ agent_id: AGENT, requested_runtime_profile_id: PROFILE, status: "queued", visibility: "private" });
    expect(run.prompt).toContain("[S1]");
    expect(run.prompt).toContain("<untrusted_material>");
    expect(run.prompt).toContain("[C1] Project goal: Ship a warehouse picking robot by Q3");
    expect(run.prompt).not.toContain("Pending analysis");
    // Both members of the family are dependencies of S1, not only the item whose title is shown.
    expect((await inputsOf(requested.briefing.id)).find((input) => input.ref_key === "S1").analysis_json.deps.items.map((dep: { id: string }) => dep.id).sort())
      .toEqual([first, repost].sort());
    expect(await count(`jobs WHERE job_type='agent_run' AND payload_json->>'run_id'='${run.id}'`)).toBe(1);
    // A second identical request — double click or two tabs — reuses it.
    expect(await service().request(adapter(), OWNER, manual)).toMatchObject({ created: false, briefing: { id: requested.briefing.id } });
    await expect(assertBriefingDispatch(config(), run, db.pool)).resolves.toBeUndefined();

    // Canonical settlement projects the terminal Run.
    const done = await finishRun(run.id, output());
    await new PostRunFinalizationService(new PgRunRepository(db.pool), undefined, undefined, undefined, runSettlement(config(), db.pool)).finalize(done.id, SPACE);
    const ready = await service().get(adapter(), MEMBER, requested.briefing.id);
    expect(ready).toMatchObject({
      status: "ready", outcome: "briefing", visibility: "visible",
      overview: { refs: ["S1"] },
      highlights: [{ title: "Gripper launch", source_domains: 1, rests_on_unverified: false, impact: { context_refs: ["C1"] } }],
      context: expect.arrayContaining([{ key: "C1", kind: "project_goal", label: "Project goal" }]),
    });
    expect(ready.evidence.map((entry) => entry.source_item_id)).toEqual([expect.stringMatching(new RegExp(`^(${first}|${repost})$`))]);
    expect(ready.evidence[0]).toMatchObject({ key: "S1", delta_class: "baseline", unverified: false });

    // Nothing changed: no Run, a no-new-material check.
    const runsBefore = await count("runs");
    const unchanged = await service().request(adapter(), OWNER, manual);
    expect(unchanged.briefing).toMatchObject({ status: "ready", outcome: "no_new_material", comparison: "delta", previous_briefing_id: requested.briefing.id });
    expect(await count("runs")).toBe(runsBefore);

    // An hour passes: new material plus the late analysis of the pending item make a delta version.
    await age(1);
    const fresh = await material("Competitor recalls arm", { publishedHoursAgo: 0.1, addedHoursAgo: 0.05 });
    const older = await material("Old trade article found now", { publishedHoursAgo: 24 * 30, addedHoursAgo: 0.05 });
    const pendingId = (await db.pool.query(`SELECT id FROM source_items WHERE title='Pending analysis'`)).rows[0].id;
    await annotate(pendingId, "Pending analysis summary");
    const delta = await service().request(adapter(), OWNER, manual);
    // The chain runs through the published version, not through the "nothing new" check.
    expect(delta.briefing).toMatchObject({ status: "queued", comparison: "delta", previous_briefing_id: requested.briefing.id });
    const inputs = await inputsOf(delta.briefing.id);
    const classOf = (id: string) => inputs.find((input) => input.analysis_json.item_ids.includes(id))?.delta_class;
    expect(classOf(fresh)).toBe("new_publication");
    expect(classOf(older)).toBe("newly_found");
    // The item pending last time was not dropped by the moved cut-off.
    expect(inputs.find((input) => input.source_item_id === pendingId)).toMatchObject({ status: "included" });
    // The previously briefed family comes along only as comparison background, never as news.
    expect(classOf(first)).toBe("background");
    expect((await rowOf(delta.briefing.id)).coverage_json).toMatchObject({ background: 1, unchanged_since_previous: 1, context_changed: false });
  });

  it("checks novelty, facts and impact against the manifest, and never publishes an invalid or stale attempt", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Gripper launch report");
    const requested = await service().request(adapter(), OWNER, manual);
    const runId = (await rowOf(requested.briefing.id)).run_id;
    // "new" in a first briefing, a fact without material, an impact without context: refused, not published.
    const bad = output({ highlights: [{ ...outputValue().highlights[0]!, novelty: "new", statements: [{ kind: "fact", text: "x", refs: ["C1"] }] }] });
    await settleBriefingRun(db.pool, await finishRun(runId, bad));
    let read = await service().get(adapter(), OWNER, requested.briefing.id);
    expect(read).toMatchObject({ status: "failed", error_code: "briefing_output_invalid", overview: null, highlights: [] });
    // A retry is a new attempt of the same version, with a new Run and the identical frozen request.
    const retried = await service().request(adapter(), OWNER, manual);
    expect(retried).toMatchObject({ created: true, briefing: { id: requested.briefing.id, status: "queued" } });
    const second = await rowOf(requested.briefing.id);
    expect(second.attempt).toBe(2);
    expect(second.run_id).not.toBe(runId);
    const firstRun = (await new PgRunRepository(db.pool).getRun(SPACE, runId))!;
    expect((await runOf(requested.briefing.id)).prompt).toBe(firstRun.prompt);
    // The first attempt's late, now-valid reply changes nothing.
    await db.pool.query(`UPDATE runs SET output_json=$2::jsonb WHERE id=$1`, [runId, JSON.stringify({ schema_version: "run_output.v1", result: { output_text: output() } })]);
    await settleBriefingRun(db.pool, (await new PgRunRepository(db.pool).getRun(SPACE, runId))!);
    await expect(assertBriefingDispatch(config(), (await new PgRunRepository(db.pool).getRun(SPACE, runId))!, db.pool)).rejects.toMatchObject({ statusCode: 409, code: "briefing_superseded" });
    read = await service().get(adapter(), OWNER, requested.briefing.id);
    expect(read.status).toBe("queued");
    // The current attempt settles it; a replay of that settlement is a no-op.
    const current = await finishRun(second.run_id, output());
    await settleBriefingRun(db.pool, current);
    await settleBriefingRun(db.pool, current);
    read = await service().get(adapter(), OWNER, requested.briefing.id);
    expect(read).toMatchObject({ status: "ready", outcome: "briefing" });
  });

  it("re-authorizes on every read: a revoked Source or a new member without access hides the units that depend on it", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Gripper launch report");
    const id = await publish();
    expect(await service().get(adapter(), MEMBER, id)).toMatchObject({ visibility: "visible" });
    // A newcomer joins the Project without access to the Source: the shared result must not show it to anyone.
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'viewer','active',now(),now())`, [randomUUID(), SPACE, PROJECT, NEWCOMER]);
    const withheld = await service().get(adapter(), OWNER, id);
    expect(withheld).toMatchObject({ visibility: "withheld", overview: null, highlights: [], evidence: [], context: [] });
    expect(JSON.stringify(withheld)).not.toContain("gripper shipped");
    await w.subscribe(NEWCOMER, new Date(Date.now() - 86_400_000 * 2).toISOString());
    expect(await service().get(adapter(), NEWCOMER, id)).toMatchObject({ visibility: "visible" });
    // An outsider cannot read it at all.
    await db.pool.query(`DELETE FROM project_members WHERE user_id=$1`, [NEWCOMER]);
    await expect(service().get(adapter(), NEWCOMER, id)).rejects.toMatchObject({ statusCode: 404 });
    // Revoking the Source item hides everything that rests on it.
    await db.pool.query(`UPDATE source_items SET deleted_at=now() WHERE space_id=$1`, [SPACE]);
    expect(await service().get(adapter(), OWNER, id)).toMatchObject({ visibility: "withheld", evidence: [] });
  });

  it("refuses dispatch once material is no longer shared, and never sends a Source that refuses this model", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Gripper launch report");
    const requested = await service().request(adapter(), OWNER, manual);
    const run = await runOf(requested.briefing.id);
    await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}'::jsonb WHERE id=$1`, [CONNECTION]);
    await expect(assertBriefingDispatch(config(), run, db.pool)).rejects.toMatchObject({ statusCode: 403, code: "briefing_access_changed" });
    // A later version freezes the refusal: the item is reported and carried, never sent.
    await settleBriefingRun(db.pool, await finishRun(run.id, "", "failed"));
    await material("Another report");
    const next = await service().request(adapter(), OWNER, manual);
    expect(next.briefing).toMatchObject({ status: "ready", outcome: "no_new_material" });
    expect(next.briefing.coverage).toMatchObject({ egress_refused: 2, included: 0, complete: false });
  });

  it("serializes concurrent requests into one version and one Run", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Gripper launch report");
    const results = await Promise.all([1, 2, 3].map(() => service().request(adapter(), OWNER, manual)));
    expect(new Set(results.map((result) => result.briefing.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await count("runs")).toBe(1);
  });

  it("serves both scopes with the same kernel; each adapter states its own audience", async (ctx) => {
    if (!db.available) return ctx.skip();
    const shared = await material("Shared report");
    // A personal Following item the owner may read; the Project member may not see the owner's private topic.
    const goal = randomUUID(), binding = randomUUID();
    await db.pool.query(`INSERT INTO source_goals (id,space_id,owner_user_id,project_id,agent_id,runtime_profile_id,intent_json,budget_json,status) VALUES ($1,$2,$3,NULL,$4,$5,'{"intent":"Personal robotics"}','{}','running')`, [goal, SPACE, OWNER, AGENT, PROFILE]);
    await db.pool.query(`INSERT INTO source_goal_bindings (id,space_id,goal_id,source_connection_id,spec_json) VALUES ($1,$2,$3,$4,'{}')`, [binding, SPACE, goal, CONNECTION]);
    await db.pool.query(
      `INSERT INTO source_goal_items (id,space_id,goal_id,source_item_id,source_connection_id,binding_id,version_id,first_goal_run_id,last_goal_run_id,selection_status,selection_reason,delivery_kind,associated_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'v','r','r','important','Directly about grippers','new_publication',now() - interval '1 hour',now() - interval '1 hour')`,
      [randomUUID(), SPACE, goal, shared, CONNECTION, binding],
    );
    const options = { cutoff: new Date().toISOString(), previous: null, label: "scope", egressAllowed: async () => true };
    const personal = await buildManifest(db.pool, personalBriefingScope(SPACE, OWNER), options);
    const project = await buildManifest(db.pool, adapter(), options);
    // Same kernel and classification; different lenses and audience.
    // The personal view also sees it through the reader's own subscription.
    expect(personal.inputs.map((input) => [input.lead!.source_item_id, input.delta_class, input.lenses.map((lens) => lens.kind).sort()]))
      .toEqual([[shared, "baseline", ["following", "subscription"]]]);
    expect(project.inputs.map((input) => [input.lead!.source_item_id, input.delta_class, input.lenses.map((lens) => lens.kind)]))
      .toEqual([[shared, "baseline", ["corpus"]]]);
    // A personal briefing's only context is the reader's own stated topics.
    expect(personal.context.map((entry) => [entry.kind, entry.label])).toEqual([["personal_focus", "Following: Personal robotics"]]);
    expect(project.context.map((entry) => entry.kind)).toEqual(["project_goal", "project_constraints"]);
    expect(await personalBriefingScope(SPACE, OWNER).canRead(db.pool, MEMBER)).toBe(false);
    expect(await adapter().audience(db.pool)).toEqual(expect.arrayContaining([OWNER, MEMBER]));
    // The personal audience is its owner alone: material only they can read still counts for them.
    await db.pool.query(`DELETE FROM source_channel_user_subscriptions WHERE user_id=$1`, [MEMBER]);
    expect((await buildManifest(db.pool, personalBriefingScope(SPACE, OWNER), options)).inputs).toHaveLength(1);
    expect((await buildManifest(db.pool, adapter(), options)).inputs.map((input) => input.status)).toEqual(["not_shared"]);
  });

  it("serves the HTTP surface: readers read, writers generate, GET never generates", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Gripper launch report");
    const app = await buildModuleServer(config(), [informationDigestModule]);
    try {
      const url = `/api/v1/spaces/${SPACE}/projects/${PROJECT}/information-briefings`;
      __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });
      const empty = await app.inject({ method: "GET", url });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toMatchObject({ can_generate: false, latest: null, latest_briefing: null, history: [] });
      expect(await count("information_briefings")).toBe(0);
      expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(403);
      __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
      const created = await app.inject({ method: "POST", url, payload: {} });
      expect(created.statusCode).toBe(201);
      expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(200);
      const overview = (await app.inject({ method: "GET", url })).json();
      expect(overview).toMatchObject({ can_generate: true, latest: { status: "queued", run_status: "queued" }, latest_briefing: null, history: [{ version: 1 }] });
      const cancelled = await app.inject({ method: "POST", url: `${url}/${created.json().briefing.id}/cancel` });
      expect(cancelled.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rides the Project's own daily digest Automation: one day, one version, a blocked day stated, history kept in order", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Gripper launch report", { publishedHoursAgo: 40, addedHoursAgo: 30 });
    const automation = await new PgAutomationRepository(db.pool).create({
      spaceId: SPACE, ownerUserId: OWNER, agentId: AGENT, projectId: PROJECT, name: "Project daily digest", triggerType: "schedule",
      configJson: { target_type: "information_digest", scope: "project", operation: "daily", project_id: PROJECT, cron: "0 7 * * *", timezone: "UTC" },
      preflightSnapshot: { executable: true, target_type: "information_digest" },
    });
    // Only a writer may enable it, on their own validated Agent.
    await expect(setDailyBriefing(db.pool, adapter(), MEMBER, { daily_enabled: true })).rejects.toMatchObject({ statusCode: 403 });
    expect(await setDailyBriefing(db.pool, adapter(), OWNER, { daily_enabled: true })).toMatchObject({ enabled: true, user_id: OWNER, agent_id: AGENT });
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
    await fire();
    const day = (await db.pool.query(`SELECT * FROM information_briefings`)).rows;
    expect(day).toEqual([expect.objectContaining({ kind: "daily", status: "queued", requested_by_user_id: OWNER, agent_id: AGENT, comparison: "baseline" })]);
    const digest = (await db.pool.query(`SELECT id, period_end_utc FROM information_digests WHERE project_id=$1`, [PROJECT])).rows[0];
    expect(day[0].digest_id).toBe(digest.id);
    expect(new Date(day[0].cutoff_at).toISOString()).toBe(new Date(digest.period_end_utc).toISOString());
    const run = (await new PgRunRepository(db.pool).getRun(SPACE, day[0].run_id))!;
    expect(run.contract_snapshot_json).toMatchObject({
      budget_sources: expect.arrayContaining([expect.objectContaining({ source: { kind: "automation", id: automation.id } })]),
      policy_context_json: { managed_execution: "information_briefing", credential_pre_authorized: true, failure_policy: "fail_fast" },
    });
    expect((await db.pool.query(`SELECT native_result_json FROM automation_runs WHERE automation_id=$1`, [automation.id])).rows[0].native_result_json)
      .toMatchObject({ briefing: { briefing_id: day[0].id, status: "queued" } });
    // A replayed fire of the same slot reuses the sealed day's version.
    await fire();
    expect(await count("information_briefings")).toBe(1);
    expect(await count("runs")).toBe(1);
    await settleBriefingRun(db.pool, await finishRun(run.id, output()));

    // A later day whose execution is gone is recorded as blocked, and becomes a real version once fixed.
    const later = { date: "2099-01-01", digestId: digest.id, cutoff: new Date().toISOString() };
    const dayInput = { kind: "daily" as const, day: later, execution: {}, origin: "job" as const, label: "the Project" };
    await db.pool.query(`UPDATE agents SET status='archived' WHERE id=$1`, [AGENT]);
    expect((await service().requestDay(adapter(), OWNER, dayInput)).briefing).toMatchObject({ status: "blocked", error_code: "briefing_execution_setup_required" });
    await db.pool.query(`UPDATE agents SET status='active' WHERE id=$1`, [AGENT]);
    expect((await service().requestDay(adapter(), OWNER, dayInput)).briefing).toMatchObject({ status: "ready", outcome: "no_new_material", period_date: "2099-01-01" });
    // A day earlier than the latest briefed one cannot be inserted behind it.
    await expect(service().request(adapter(), OWNER, { ...dayInput, kind: "backfill", day: { ...later, date: "2000-01-01", cutoff: "2000-01-02T00:00:00.000Z" } }))
      .rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("Sealed days held behind another version", () => {
  it("holds the day a scheduled fire meets while a manual version runs, starts it when that ends, and keeps days in date order", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Gripper launch report", { publishedHoursAgo: 40, addedHoursAgo: 30 });
    const automation = await new PgAutomationRepository(db.pool).create({
      spaceId: SPACE, ownerUserId: OWNER, agentId: AGENT, projectId: PROJECT, name: "Project daily digest", triggerType: "schedule",
      configJson: { target_type: "information_digest", scope: "project", operation: "daily", project_id: PROJECT, cron: "0 7 * * *", timezone: "UTC" },
      preflightSnapshot: { executable: true, target_type: "information_digest" },
    });
    await setDailyBriefing(db.pool, adapter(), OWNER, { daily_enabled: true });
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

    // A writer's manual briefing is running when the day is sealed.
    const manualVersion = await service().request(adapter(), OWNER, manual);
    const fired = await fire();
    const digest = (await db.pool.query(`SELECT id, digest_date, period_end_utc FROM information_digests WHERE project_id=$1`, [PROJECT])).rows[0];
    const held = (await db.pool.query(`SELECT * FROM information_briefings WHERE period_date=$1`, [digest.digest_date])).rows;
    // The day is held, observably, with its own date, cut-off and reason; the manual version is not taken as its result.
    expect(held).toEqual([expect.objectContaining({
      kind: "daily", status: "blocked", error_code: "briefing_scope_busy", digest_id: digest.id, run_id: null,
      request_json: expect.objectContaining({ origin: "job", automation_id: automation.id }),
    })]);
    expect(new Date(held[0].cutoff_at).toISOString()).toBe(new Date(digest.period_end_utc).toISOString());
    expect(fired).toMatchObject({ digest_id: digest.id });
    expect((await db.pool.query(`SELECT native_result_json FROM automation_runs WHERE automation_id=$1`, [automation.id])).rows[0].native_result_json)
      .toMatchObject({ briefing: { briefing_id: held[0].id, status: "blocked", error_code: "briefing_scope_busy" } });
    expect(await count("runs")).toBe(1);
    expect((await service().get(adapter(), MEMBER, held[0].id))).toMatchObject({ status: "blocked", error_code: "briefing_scope_busy", period_date: digest.digest_date });

    // The manual version ends through canonical settlement: the held day starts with its own request and budget source.
    await finalize((await runOf(manualVersion.briefing.id)).id, output());
    expect(await rowOf(manualVersion.briefing.id)).toMatchObject({ status: "ready", kind: "manual" });
    const day = (await db.pool.query(`SELECT * FROM information_briefings WHERE period_date=$1 AND status IN ('queued','ready','blocked')`, [digest.digest_date])).rows;
    expect(day).toEqual([expect.objectContaining({ kind: "daily", status: "queued", digest_id: digest.id, requested_by_user_id: OWNER })]);
    expect(new Date(day[0].cutoff_at).toISOString()).toBe(new Date(digest.period_end_utc).toISOString());
    // Its comparison is what was published by its own cut-off, not the later manual version.
    expect(day[0].previous_briefing_id).toBeNull();
    const dayRun = await runOf(day[0].id);
    expect(dayRun.contract_snapshot_json).toMatchObject({
      budget_sources: expect.arrayContaining([expect.objectContaining({ source: { kind: "automation", id: automation.id } })]),
      policy_context_json: { credential_pre_authorized: true },
    });
    expect(await count("runs")).toBe(2);
    // A replayed fire of the same slot reuses the day's version: no second Run, no second day.
    await fire();
    expect(await count("runs")).toBe(2);
    expect(await count(`information_briefings WHERE period_date='${digest.digest_date}'`)).toBe(1);
    await finalize(dayRun.id, output());
    expect(await rowOf(day[0].id)).toMatchObject({ status: "ready", outcome: "briefing" });

    // Two later days meet a running version: both are held, then start one after another, earliest first.
    await age(1);
    await material("Later report", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    const blocker = await service().request(adapter(), OWNER, manual);
    // Sealed days end in date order: each day's cut-off is its own end of day.
    const base = Date.now();
    const dayInput = (date: string) => ({
      kind: "daily" as const, day: { date, digestId: null, cutoff: new Date(base + (date === "2099-01-01" ? 0 : 1_000)).toISOString() },
      execution: {}, origin: "job" as const, automationId: automation.id, label: "the Project",
    });
    expect((await service().requestDay(adapter(), OWNER, dayInput("2099-01-02"))).briefing).toMatchObject({ status: "blocked", error_code: "briefing_scope_busy" });
    expect((await service().requestDay(adapter(), OWNER, dayInput("2099-01-01"))).briefing).toMatchObject({ status: "blocked", error_code: "briefing_scope_busy" });
    // The running version is a later manual one; once it ends, the held days still start (no "history before latest").
    await finalize((await runOf(blocker.briefing.id)).id, output({}, "new"));
    const live = async (date: string) => (await db.pool.query(`SELECT status, outcome, version FROM information_briefings WHERE period_date=$1 AND status IN ('queued','ready','blocked')`, [date])).rows[0];
    const [first, second] = [await live("2099-01-01"), await live("2099-01-02")];
    // Nothing new since the manual version: both days complete without a Run, the earlier one first.
    expect(first).toMatchObject({ status: "ready", outcome: "no_new_material" });
    expect(second).toMatchObject({ status: "ready", outcome: "no_new_material" });
    expect(first.version).toBeLessThan(second.version);
    expect(await count("runs")).toBe(3);
  });
});

describe("Sealed days: history order is checked before a day is held", () => {
  it("refuses the same out-of-order backfill whether the scope is idle or busy, and leaves no day to resume", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("First report", { addedHoursAgo: 12, publishedHoursAgo: 13 });
    await publish();
    // A real sealed Project digest of an old day, never briefed; a later version is already published.
    const digestId = "10000000-0000-4000-8000-000000000001";
    await db.pool.query(
      `INSERT INTO information_digests (id,space_id,digest_type,project_id,digest_date,timezone,period_start_utc,period_end_utc,created_at,updated_at)
       VALUES ($1,$2,'project',$3,'2000-01-01','UTC','2000-01-01T00:00:00Z','2000-01-02T00:00:00Z',now(),now())`,
      [digestId, SPACE, PROJECT],
    );
    const old = { ...manual, kind: "backfill" as const, day: { date: "2000-01-01", digestId, cutoff: "2000-01-02T00:00:00.000Z" } };
    const scheduled = { ...old, kind: "daily" as const, origin: "job" as const };
    const historyError = { statusCode: 422, responseBody: expect.objectContaining({ code: "briefing_history_before_latest" }) };
    // Idle.
    await expect(service().request(adapter(), OWNER, old)).rejects.toMatchObject(historyError);
    // Busy: another version in flight is a temporary wait, not an exemption.
    await age(1);
    await material("Second report", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    const second = await service().request(adapter(), OWNER, manual);
    expect(second.briefing.status).toBe("queued");
    await expect(service().request(adapter(), OWNER, old)).rejects.toMatchObject(historyError);
    await expect(service().requestDay(adapter(), OWNER, scheduled)).rejects.toMatchObject(historyError);
    // A refusal that would otherwise hold the day (no usable runtime) does not hold an out-of-order day either.
    await db.pool.query(`UPDATE agents SET status='archived' WHERE id=$1`, [AGENT]);
    await expect(service().requestDay(adapter(), OWNER, scheduled)).rejects.toMatchObject(historyError);
    await db.pool.query(`UPDATE agents SET status='active' WHERE id=$1`, [AGENT]);
    expect(await count(`information_briefings WHERE period_date='2000-01-01'`)).toBe(0);
    // The busy version ends through settlement: nothing old is resumed, and the old day stays refused.
    await settleBriefingRun(db.pool, await finishRun((await runOf(second.briefing.id)).id, output({}, "new")));
    expect(await rowOf(second.briefing.id)).toMatchObject({ status: "ready" });
    expect(await count(`information_briefings WHERE period_date='2000-01-01'`)).toBe(0);
    await expect(service().request(adapter(), OWNER, old)).rejects.toMatchObject(historyError);
  });
});

describe("Briefing storage keeps its tenant references", () => {
  it("never deletes a referenced digest from under a briefing day or nulls its Space; the Project's own deletion removes both", async (ctx) => {
    if (!db.available) return ctx.skip();
    const digestId = "10000000-0000-4000-8000-0000000000f1";
    await db.pool.query(
      `INSERT INTO information_digests (id,space_id,digest_type,project_id,digest_date,timezone,period_start_utc,period_end_utc,created_at,updated_at)
       VALUES ($1,$2,'project',$3,'2026-10-29','UTC','2026-10-29T00:00:00Z','2026-10-30T00:00:00Z',now(),now())`,
      [digestId, SPACE, PROJECT],
    );
    const day = await service().request(adapter(), OWNER, { ...manual, kind: "daily", origin: "job", day: { date: "2026-10-29", digestId, cutoff: "2026-10-30T00:00:00.000Z" } });
    expect(await rowOf(day.briefing.id)).toMatchObject({ digest_id: digestId, space_id: SPACE });
    // The digest a day was built from is not deleted on its own, and the briefing keeps its Space.
    await expect(db.pool.query(`DELETE FROM information_digests WHERE id=$1`, [digestId])).rejects.toMatchObject({ code: "23503", constraint: "information_briefings_digest_fkey" });
    expect(await rowOf(day.briefing.id)).toMatchObject({ digest_id: digestId, space_id: SPACE });
    // A digest of another Space can never be referenced.
    const otherSpace = "bf000000-0000-4000-8000-0000000000f2", otherProject = "bf000000-0000-4000-8000-0000000000f3", otherDigest = "bf000000-0000-4000-8000-0000000000f4";
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Other','team',now(),now())`, [otherSpace]);
    await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,settings_json,created_at,updated_at) VALUES ($1,$2,NULL,'Other','active','{}',now(),now())`, [otherProject, otherSpace]);
    await db.pool.query(
      `INSERT INTO information_digests (id,space_id,digest_type,project_id,digest_date,timezone,period_start_utc,period_end_utc,created_at,updated_at)
       VALUES ($1,$2,'project',$3,'2026-10-29','UTC','2026-10-29T00:00:00Z','2026-10-30T00:00:00Z',now(),now())`,
      [otherDigest, otherSpace, otherProject],
    );
    await expect(db.pool.query(`UPDATE information_briefings SET digest_id=$2 WHERE id=$1`, [day.briefing.id, otherDigest]))
      .rejects.toMatchObject({ code: "23503", constraint: "information_briefings_digest_fkey" });
    // Deleting the Project removes the digest and the briefing day together through their cascades.
    await db.pool.query(`DELETE FROM projects WHERE id=$1`, [PROJECT]);
    expect(await count(`information_digests WHERE id='${digestId}'`)).toBe(0);
    expect(await count(`information_briefings WHERE id='${day.briefing.id}'`)).toBe(0);
  });
});

describe("Briefing versions: frozen inputs, reuse and change detection", () => {
  it("lets only the current attempt settle, whichever of a late settlement and a retry takes the row first", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Report");
    const first = await service().request(adapter(), OWNER, manual);
    const failed = await finishRun((await runOf(first.briefing.id)).id, "", "failed");
    // Settlement first, then the retry: a replay of the old settlement cannot touch the new attempt.
    await settleBriefingRun(db.pool, failed);
    await service().request(adapter(), OWNER, manual);
    const second = await rowOf(first.briefing.id);
    await settleBriefingRun(db.pool, failed);
    expect(await rowOf(first.briefing.id)).toMatchObject({ status: "queued", attempt: 2, run_id: second.run_id });
    const failedAgain = await finishRun(second.run_id, "", "failed");
    await settleBriefingRun(db.pool, failedAgain);

    // Retry first: it holds the version row while the old attempt's settlement waits on it, then commits.
    const holder = await db.pool.connect();
    let late: Promise<void> | undefined;
    try {
      await holder.query("BEGIN");
      await new InformationBriefingService(holder as never, config()).request(adapter(), OWNER, manual);
      const retryRun = (await holder.query(`SELECT run_id FROM information_briefings WHERE id=$1`, [first.briefing.id])).rows[0].run_id;
      let settled = false;
      late = settleBriefingRun(db.pool, failedAgain).finally(() => { settled = true; });
      await waitForLockWaiter(db.pool, { settled: () => settled });
      expect(settled).toBe(false);
      expect((await db.pool.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid)) > 0`)).rows[0].n).toBeGreaterThan(0);
      await holder.query("COMMIT");
      await late;
      expect(await rowOf(first.briefing.id)).toMatchObject({ status: "queued", attempt: 3, run_id: retryRun });
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await late;
    }
  });


  it("retries an unsuccessful sealed day only with the identical frozen request; a changed summary or body is a new version beside it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const id = await material("Report");
    const day = { ...manual, kind: "daily" as const, day: { date: "2026-10-29", digestId: null, cutoff: new Date().toISOString() } };
    const first = await service().request(adapter(), OWNER, day);
    const original = await rowOf(first.briefing.id);
    const firstPrompt = (await runOf(first.briefing.id)).prompt;
    await settleBriefingRun(db.pool, await finishRun(original.run_id, "", "failed"));
    // Nothing changed: the same version is retried with exactly the request it froze.
    const same = await service().request(adapter(), OWNER, day);
    expect(same.briefing.id).toBe(first.briefing.id);
    expect((await rowOf(first.briefing.id))).toMatchObject({ attempt: 2, input_hash: original.input_hash });
    expect((await runOf(first.briefing.id)).prompt).toBe(firstPrompt);
    await settleBriefingRun(db.pool, await finishRun((await rowOf(first.briefing.id)).run_id, "", "failed"));

    // The analysis was rewritten under the same id: the old version cannot be reproduced, so the day gets a new one.
    await db.pool.query(`UPDATE source_item_annotations SET summary='NEW_ANNOTATION_TEXT', updated_at=now() WHERE source_item_id=$1`, [id]);
    const summaryChanged = await service().request(adapter(), OWNER, day);
    expect(summaryChanged.briefing.id).not.toBe(first.briefing.id);
    expect((await runOf(summaryChanged.briefing.id)).prompt).toContain("NEW_ANNOTATION_TEXT");
    // The unsuccessful version stays as history, with the hash and revision of what it actually sent.
    expect(await rowOf(first.briefing.id)).toMatchObject({ status: "failed", input_hash: original.input_hash });
    expect((await rowOf(summaryChanged.briefing.id)).input_hash).not.toBe(original.input_hash);
    const before = (await inputsOf(first.briefing.id))[0].content_revision;
    expect((await inputsOf(summaryChanged.briefing.id))[0].content_revision).not.toBe(before);

    // The body changes while that version waits: dispatch refuses it instead of sending text it never froze.
    await db.pool.query(`UPDATE source_items SET content_hash='changed', reading_body_revision=reading_body_revision+1 WHERE id=$1`, [id]);
    await expect(assertBriefingDispatch(config(), await runOf(summaryChanged.briefing.id), db.pool))
      .rejects.toMatchObject({ statusCode: 409, code: "briefing_inputs_changed" });
    await settleBriefingRun(db.pool, await finishRun((await rowOf(summaryChanged.briefing.id)).run_id, "", "failed"));
    const bodyChanged = await service().request(adapter(), OWNER, day);
    expect(new Set([first.briefing.id, summaryChanged.briefing.id, bodyChanged.briefing.id]).size).toBe(3);
    expect((await inputsOf(bodyChanged.briefing.id))[0].analysis_json.deps.items[0].revision).toBe("changed:1");
    await expect(assertBriefingDispatch(config(), await runOf(bodyChanged.briefing.id), db.pool)).resolves.toBeUndefined();
    // Exactly one live version for the day.
    expect(await count(`information_briefings WHERE period_date='2026-10-29' AND status IN ('queued','ready','blocked')`)).toBe(1);
  });

  it("reuses one stable check when nothing changed, across serial and concurrent clients, and keeps the last briefing readable", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Report");
    const published = await publish();
    const serial: Awaited<ReturnType<ReturnType<typeof service>["request"]>>[] = [];
    for (let i = 0; i < 3; i += 1) serial.push(await service().request(adapter(), OWNER, manual));
    expect(serial.map((result) => result.created)).toEqual([true, false, false]);
    expect(new Set(serial.map((result) => result.briefing.id)).size).toBe(1);
    expect(serial[0]!.briefing).toMatchObject({ outcome: "no_new_material", previous_briefing_id: published });
    expect(serial[2]!.briefing.checked_at).not.toBeNull();
    const concurrent = await Promise.all([1, 2, 3].map(() => service().request(adapter(), OWNER, manual)));
    expect(concurrent.every((result) => result.briefing.id === serial[0]!.briefing.id && !result.created)).toBe(true);
    expect(await count("information_briefings")).toBe(2);
    expect(await count("runs")).toBe(1);
    // The latest version is the check; the last real briefing stays readable beside it.
    const overview = await service().overview(adapter(), MEMBER, false);
    expect(overview).toMatchObject({ latest: { id: serial[0]!.briefing.id, outcome: "no_new_material" }, latest_briefing: { id: published, outcome: "briefing" } });
    expect(overview.latest_briefing?.overview?.text).toBe("Two reports describe the same gripper launch.");

    // A second writer's request interleaved with the first under the scope lock gets the same answer.
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`information-briefing:${SPACE}:project:${PROJECT}`]);
      let settled = false;
      const waiting = service().request(adapter(), OWNER, manual).finally(() => { settled = true; });
      await waitForLockWaiter(db.pool, { settled: () => settled, lockType: "advisory" });
      expect(settled).toBe(false);
      await holder.query("COMMIT");
      expect(await waiting).toMatchObject({ created: false, briefing: { id: serial[0]!.briefing.id } });
    } finally {
      holder.release();
    }
  });

  it("finds a revised body or analysis of briefed material with no new scope activity, and carries what the audience could not read until it can", async (ctx) => {
    if (!db.available) return ctx.skip();
    const id = await material("Report");
    // An item on a Source the viewer does not follow: not shared with the whole Project yet.
    await w.addSource("bf000000-0000-4000-8000-000000000001", "bf000000-0000-4000-8000-000000000002", "Narrow feed", { allow_external_model_egress: true, allow_local_provider_egress: true });
    await db.pool.query(`DELETE FROM source_channel_user_subscriptions WHERE user_id=$1 AND source_channel_id=$2`, [MEMBER, "bf000000-0000-4000-8000-000000000002"]);
    const narrow = await material("Narrow report", { connection: "bf000000-0000-4000-8000-000000000001", channel: "bf000000-0000-4000-8000-000000000002" });
    const published = await publish();
    expect((await inputsOf(published)).find((input) => input.source_item_id === narrow)).toMatchObject({ status: "not_shared" });
    await age(48);
    // Two quiet checks: nothing new, and the unreadable item is still carried, not forgotten.
    for (let i = 0; i < 2; i += 1) expect((await service().request(adapter(), OWNER, manual)).briefing.outcome).toBe("no_new_material");

    // The retained body of briefed material changes; its Corpus membership does not.
    await db.pool.query(`UPDATE source_items SET content_hash='new_body', reading_body_revision=reading_body_revision+1, reading_body_changed_at=now() WHERE id=$1`, [id]);
    const revised = await service().request(adapter(), OWNER, manual);
    expect(revised.briefing.status).toBe("queued");
    expect((await inputsOf(revised.briefing.id)).find((input) => input.source_item_id === id)).toMatchObject({ status: "included", delta_class: "revised" });
    await settleBriefingRun(db.pool, await finishRun((await runOf(revised.briefing.id)).id, output({}, "update")));

    // The analysis of it is rewritten in place (same id): also a revision, found the same way.
    await age(1);
    await db.pool.query(`UPDATE source_item_annotations SET summary='Rewritten analysis', updated_at=now() WHERE source_item_id=$1`, [id]);
    const reanalysed = await service().request(adapter(), OWNER, manual);
    expect((await inputsOf(reanalysed.briefing.id)).find((input) => input.source_item_id === id)).toMatchObject({ delta_class: "revised" });
    await settleBriefingRun(db.pool, await finishRun((await runOf(reanalysed.briefing.id)).id, output({}, "update")));

    // Access is restored: the long-carried item arrives as news, though its own activity is days old.
    await age(1);
    await w.subscribe(MEMBER, new Date(Date.now() - 86_400_000).toISOString(), "bf000000-0000-4000-8000-000000000002");
    const restored = await service().request(adapter(), OWNER, manual);
    expect(restored.briefing.status).toBe("queued");
    expect((await inputsOf(restored.briefing.id)).find((input) => input.source_item_id === narrow)).toMatchObject({ status: "included", delta_class: "newly_found" });
  });

  it("reassesses impact when only the Project context changed, with the still-shared briefed material as background", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Gripper launch report");
    const published = await publish();
    const runsBefore = await count("runs");
    // Unchanged context: nothing to reassess.
    expect((await service().request(adapter(), OWNER, manual)).briefing.outcome).toBe("no_new_material");
    expect(await count("runs")).toBe(runsBefore);

    const next = randomUUID();
    await db.pool.query(
      `INSERT INTO project_brief_versions (id,space_id,project_id,version,goal,constraints,project_status,status,created_at)
       VALUES ($1,$2,$3,'2','NEW_PROJECT_GOAL: pick frozen food','Budget under 50k','active','published',now())`,
      [next, SPACE, PROJECT],
    );
    await db.pool.query(`UPDATE projects SET active_brief_version_id=$2 WHERE id=$1`, [PROJECT, next]);
    const reassessed = await service().request(adapter(), OWNER, manual);
    expect(reassessed.briefing).toMatchObject({ status: "queued", previous_briefing_id: published, coverage: { context_changed: true, background: 1 } });
    const run = await runOf(reassessed.briefing.id);
    expect(run.prompt).toContain("NEW_PROJECT_GOAL");
    expect(run.prompt).toContain("Gripper launch report");
    expect(run.instruction).toContain("project context changed");
    expect((await inputsOf(reassessed.briefing.id)).map((input) => input.delta_class)).toEqual(["background"]);
    // Background is never news: "new" over it is refused; "ongoing" is the reassessment.
    const asNew = await finishRun(run.id, output({}, "new"));
    await settleBriefingRun(db.pool, asNew);
    expect(await rowOf(reassessed.briefing.id)).toMatchObject({ status: "failed", error_code: "briefing_output_invalid" });
    await service().request(adapter(), OWNER, manual);
    await settleBriefingRun(db.pool, await finishRun((await runOf(reassessed.briefing.id)).id, output({}, "ongoing")));
    expect(await service().get(adapter(), MEMBER, reassessed.briefing.id)).toMatchObject({ status: "ready", highlights: [{ novelty: "ongoing" }] });

  });

  it("compares new material with the previous briefing's still-shared highlights and their material, never with text whose material is gone", async (ctx) => {
    if (!db.available) return ctx.skip();
    const old = await material("OLD_EVENT_UNIQUE_BACKGROUND");
    await publish(output({ overview: { text: "PREVIOUS_OVERVIEW_TEXT", refs: ["S1"] }, highlights: [{ ...outputValue().highlights[0]!, title: "PREVIOUS_HIGHLIGHT", what_changed: "PREVIOUS_WHAT_CHANGED" }] }));
    await age(1);
    await material("New URL repeating the launch", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    const next = await service().request(adapter(), OWNER, manual);
    const run = await runOf(next.briefing.id);
    expect(run.prompt).toContain("<previous_briefing>");
    expect(run.prompt).toContain("PREVIOUS_HIGHLIGHT");
    expect(run.prompt).toContain("PREVIOUS_WHAT_CHANGED");
    expect(run.prompt).toContain("OLD_EVENT_UNIQUE_BACKGROUND");
    // The overview prose itself is never replayed as dependency-free text.
    expect(run.prompt).not.toContain("PREVIOUS_OVERVIEW_TEXT");
    const inputs = await inputsOf(next.briefing.id);
    const background = inputs.find((input) => input.source_item_id === old)!;
    expect(background.delta_class).toBe("background");
    expect(run.prompt).toMatch(new RegExp(`PREVIOUS_WHAT_CHANGED \\[${background.ref_key}\\]`));
    // A new URL that only repeats the old event: "ongoing" is valid; "new" resting on background alone is not.
    const newRef = inputs.find((input) => input.delta_class === "new_publication")!.ref_key;
    const repeat = { ...outputValue().highlights[0]!, refs: [newRef, background.ref_key], statements: [{ kind: "fact" as const, text: "Reported again.", refs: [newRef] }] };
    await settleBriefingRun(db.pool, await finishRun(run.id, output({ overview: { text: "Nothing new.", refs: [newRef] }, highlights: [{ ...repeat, novelty: "update" }] })));
    expect(await rowOf(next.briefing.id)).toMatchObject({ status: "failed", error_code: "briefing_output_invalid" });
    await service().request(adapter(), OWNER, manual);
    await settleBriefingRun(db.pool, await finishRun((await runOf(next.briefing.id)).id, output({ overview: { text: "Nothing new.", refs: [newRef] }, highlights: [{ ...repeat, novelty: "ongoing" }] })));
    expect((await rowOf(next.briefing.id)).status).toBe("ready");

    // Once the old material is no longer shared, its highlight is not offered as comparison at all.
    await age(1);
    await db.pool.query(`UPDATE source_items SET deleted_at=now() WHERE id=$1`, [old]);
    await material("Third report", { addedHoursAgo: 0 });
    const third = await runOf((await service().request(adapter(), OWNER, manual)).briefing.id);
    expect(third.prompt).not.toContain("OLD_EVENT_UNIQUE_BACKGROUND");
    expect(third.prompt).not.toContain("PREVIOUS_WHAT_CHANGED");
  });

  it("holds the whole request (prompt + instruction) to its hard budget, shortening then truncating and carrying, with every sent ref present", async (ctx) => {
    if (!db.available) return ctx.skip();
    const now = new Date().toISOString();
    const candidate = (i: number): BriefingCandidate => ({
      source_item_id: `item-${String(i).padStart(2, "0")}`, family_key: `family-${String(i).padStart(2, "0")}`, content_revision: "r", connection_id: null,
      title: "T".repeat(300), source_domain: "example.test", occurred_at: now, first_seen_at: now, activity_at: now, change_at: null,
      unverified: false, summary: "S".repeat(600), excerpt: "E".repeat(400), annotation: null,
      signals: ["A", "B", "C"].map((letter, index) => ({
        lens: { kind: "following" as const, label: "L".repeat(80) }, text: letter.repeat(280), activity_at: now, change_at: null,
        dep: { kind: "goal_item" as const, id: `${i}-${index}`, item_id: `item-${i}`, connection_id: null, revision: "x", at: null },
      })),
    });
    const big = { ...adapter(), candidates: async () => ({ rows: Array.from({ length: 45 }, (_, i) => candidate(i)), not_shared_ids: [] }) };
    const manifest = await buildManifest(db.pool, big, { cutoff: now, previous: null, label: "Project", egressAllowed: async () => true });
    expect(manifest.prompt.length + manifest.instruction.length).toBeLessThanOrEqual(BRIEFING_LIMITS.promptChars);
    const sent = manifest.inputs.filter((input) => input.ref_key);
    const truncated = manifest.inputs.filter((input) => input.status === "truncated");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length + truncated.length).toBe(45);
    expect(manifest.coverage).toMatchObject({ included: sent.length, truncated: truncated.length, complete: false });
    sent.forEach((input, index) => {
      expect(input.ref_key).toBe(`S${index + 1}`);
      expect(manifest.prompt).toContain(input.block!);
    });
    // Truncated material is carried to the next version, never silently lost.
    expect(truncated.every((input) => input.item_ids.length === 1 && input.block === null)).toBe(true);

  });
});
