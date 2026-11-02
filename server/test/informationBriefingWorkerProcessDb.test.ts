import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { HOST, OWNER, SPACE, briefingWorld, manual, output, outputValue } from "./support/briefingFixture.js";
import { RuntimeContextPolicyRepository } from "../src/modules/policy/runtimeContextPolicyRepository.js";
import { buildServerDist, isCancelled, isFrame, isPrompted, settledCommands, startWorkerProcess, until, type WorkerProcess } from "./support/briefingWorkerHarness.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";

// Briefing Runs through real jobs-worker processes (`support/briefingWorkerProcess.ts`):
// the server's own `startJobsWorker` against this isolated database, claiming
// the briefing's `agent_run` job, running the production orchestrator and its
// dispatch guards, preparing the real Delivery and dispatching it to a
// synthetic Host over the daemon wire frames. Workers are killed and
// restarted as processes; no running instance is touched and no model called.
const db = useTestDatabase(import.meta.filename, { max: 10 });
const w = briefingWorld(db);
let home: string;
const workers: WorkerProcess[] = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "rainver-briefing-worker-"));
  buildServerDist();
}, 600_000);
afterAll(async () => { if (home) await rm(home, { recursive: true, force: true }); });
beforeEach(async () => {
  if (!db.available) return;
  await w.seed();
  await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`, [SPACE, OWNER]);
  await new RuntimeContextPolicyRepository(db.pool).write({ spaceId: SPACE, userId: OWNER }, "space", SPACE, { base_version_id: null, policy: { constraints: {}, preferences: {} }, reason: "Isolated synthetic default policy" });
});
afterEach(async () => { for (const worker of workers.splice(0)) await worker.kill(); });

const spawn = async () => {
  const worker = await startWorkerProcess({ databaseUrl: db.connectionUri, home, hostId: HOST });
  workers.push(worker);
  return worker;
};
const versionOf = (id: string) => w.rowOf(id);
const deliveries = async (runId: string) => Number((await db.pool.query(`SELECT count(*) FROM invocation_deliveries WHERE invocation_id=$1`, [runId])).rows[0].count);
const attempts = async (runId: string) => (await db.pool.query(`SELECT attempt_number, status, launch_id FROM run_attempts WHERE run_id=$1 ORDER BY attempt_number`, [runId])).rows;
const answerAll = output(outputValue());
/**
 * A dead worker stops renewing its job's heartbeat; once that is older than
 * the reclaim threshold (600 s, `jobs/workerRuntime.ts`) recovery takes the
 * job back. The test moves that persisted heartbeat back instead of waiting
 * ten minutes — the only time it shifts.
 */
const expireLease = (runId: string) =>
  db.pool.query(`UPDATE jobs SET heartbeat_at = now() - interval '11 minutes', updated_at = now() - interval '11 minutes' WHERE payload_json->>'run_id' = $1`, [runId]);
const settledVersion = (id: string) => until(() => versionOf(id), (row) => row.status !== "queued", "the version settling", 250);
/** The user asks again: the same frozen version, a new attempt. */
async function retry(id: string) {
  const again = await w.service().request(w.adapter(), OWNER, manual);
  expect(again.briefing).toMatchObject({ id, status: "queued" });
  return w.runOf(id);
}

describe("Briefing Runs on real jobs-worker processes", () => {
  it("generates and publishes a briefing end to end through the worker, the guards, the Delivery and the Host frames", async (ctx) => {
    if (!db.available) return ctx.skip();
    await w.material("WORKER_PROCESS_MATERIAL");
    const requested = await w.service().request(w.adapter(), OWNER, manual);
    const worker = await spawn();
    worker.send({ cmd: "policy", prompt: { answer: output(outputValue()) } });
    const run = await w.runOf(requested.briefing.id);
    await worker.next(isFrame("launch", run.id));
    const settled = await until(() => versionOf(requested.briefing.id), (row) => row.status !== "queued", "the version settling");
    expect(settled).toMatchObject({ status: "ready", outcome: "briefing" });
    expect((await w.runs().getRun(SPACE, run.id))?.status).toBe("succeeded");
    expect(await deliveries(run.id)).toBe(1);
  });

  it("recovers a worker killed mid-Run: the restarted worker reclaims the job, stops the old Host attempt and fails the version; a retry publishes and the old attempt's late completion changes nothing", async (ctx) => {
    if (!db.available) return ctx.skip();
    await w.material("WORKER_PROCESS_MATERIAL");
    const requested = await w.service().request(w.adapter(), OWNER, manual);
    const run = await w.runOf(requested.briefing.id);
    const first = await spawn();
    const old = await first.next(isPrompted(run.id));
    await first.kill();
    expect((await w.runs().getRun(SPACE, run.id))?.status).toBe("running");
    expect(await versionOf(requested.briefing.id)).toMatchObject({ status: "queued" });

    await expireLease(run.id);
    const second = await spawn();
    second.send({ cmd: "policy", prompt: { answer: answerAll }, terminate: "ack" });
    // Recovery stops the old launch first and settles only on the Host's confirmation.
    expect((await second.next(isFrame("terminate", run.id))).frame).toMatchObject({ launch_id: old.launchId, force: true });
    expect(await settledVersion(requested.briefing.id)).toMatchObject({ status: "failed", error_code: "orphaned", attempt: 1 });
    expect(await attempts(run.id)).toEqual([expect.objectContaining({ attempt_number: 1, status: "orphaned", launch_id: old.launchId })]);

    const again = await retry(requested.briefing.id);
    await second.next(isFrame("launch", again.id));
    expect(await settledVersion(requested.briefing.id)).toMatchObject({ status: "ready", outcome: "briefing", attempt: 2 });
    // The killed attempt's Host reports at last: it matches no open launch.
    second.send({ cmd: "complete", runId: run.id, launchId: old.launchId, exitCode: 0 });
    await settledCommands(second);
    expect(await versionOf(requested.briefing.id)).toMatchObject({ status: "ready", outcome: "briefing", attempt: 2 });
    expect((await w.runs().getRun(SPACE, run.id))?.status).toBe("orphaned");
  });

  it("settles a version whose job a worker claimed and died with before starting it, and lets a retry publish", async (ctx) => {
    if (!db.available) return ctx.skip();
    await w.material("WORKER_PROCESS_MATERIAL");
    const requested = await w.service().request(w.adapter(), OWNER, manual);
    const run = await w.runOf(requested.briefing.id);
    // The state a crash right after the claim leaves, made by the canonical claim of a worker that is gone.
    const claimed = await new PgJobQueueRepository(db.pool).claimNext("crashed-worker", ["agent_run"]);
    expect(claimed?.payload_json).toMatchObject({ run_id: run.id });
    await expireLease(run.id);
    expect((await w.runs().getRun(SPACE, run.id))?.status).toBe("queued");
    const worker = await spawn();
    worker.send({ cmd: "policy", prompt: { answer: answerAll } });
    // The briefing's job allows one attempt: recovery ends the Run it never started, and finalizes it,
    // so the version fails and its scope is free — not a version left queued behind a dead job.
    expect(await settledVersion(requested.briefing.id)).toMatchObject({ status: "failed", attempt: 1 });
    expect((await w.runs().getRun(SPACE, run.id))).toMatchObject({ status: "failed", error_json: expect.objectContaining({ error_code: "run_abandoned" }) });
    expect(await deliveries(run.id)).toBe(0);
    const again = await retry(requested.briefing.id);
    await worker.next(isFrame("launch", again.id));
    expect(await settledVersion(requested.briefing.id)).toMatchObject({ status: "ready", outcome: "briefing", attempt: 2 });
  });

  it("keeps a stop whose Host acknowledgement is lost as cancelling, and settles it cancelled when a restarted worker's stop is acknowledged", async (ctx) => {
    if (!db.available) return ctx.skip();
    await w.material("WORKER_PROCESS_MATERIAL");
    const requested = await w.service().request(w.adapter(), OWNER, manual);
    const run = await w.runOf(requested.briefing.id);
    const first = await spawn();
    first.send({ cmd: "policy", terminate: "drop" });
    const launched = await first.next(isPrompted(run.id));
    first.send({ cmd: "cancel", runId: run.id, spaceId: SPACE, userId: OWNER });
    expect((await first.next(isCancelled)).result).toMatchObject({ status: "cancelling", error_code: "cancel_confirmation_timeout" });
    expect(await versionOf(requested.briefing.id)).toMatchObject({ status: "queued" });
    await first.kill();

    await expireLease(run.id);
    const second = await spawn();
    expect((await second.next(isFrame("terminate", run.id))).frame).toMatchObject({ launch_id: launched.launchId, force: true });
    expect(await settledVersion(requested.briefing.id)).toMatchObject({ status: "cancelled", error_code: "briefing_cancelled" });
    expect((await w.runs().getRun(SPACE, run.id))?.status).toBe("cancelled");
    expect(await attempts(run.id)).toEqual([expect.objectContaining({ status: "cancelled" })]);
  });

  it("settles a stop acknowledged late as cancelled, and the attempt's output after it publishes nothing", async (ctx) => {
    if (!db.available) return ctx.skip();
    await w.material("WORKER_PROCESS_MATERIAL");
    const requested = await w.service().request(w.adapter(), OWNER, manual);
    const run = await w.runOf(requested.briefing.id);
    const worker = await spawn();
    worker.send({ cmd: "policy", terminate: "drop" });
    const launched = await worker.next(isPrompted(run.id));
    worker.send({ cmd: "cancel", runId: run.id, spaceId: SPACE, userId: OWNER });
    expect((await worker.next(isCancelled)).result).toMatchObject({ status: "cancelling" });
    worker.send({ cmd: "complete", runId: run.id, launchId: launched.launchId, exitCode: 143 });
    expect(await settledVersion(requested.briefing.id)).toMatchObject({ status: "cancelled" });
    // The runtime still answers its held prompt afterwards: nothing is listening for that launch.
    worker.send({ cmd: "answer", runId: run.id, text: answerAll });
    await settledCommands(worker);
    expect(await versionOf(requested.briefing.id)).toMatchObject({ status: "cancelled", result_json: null });
    expect((await w.runs().getRun(SPACE, run.id))?.status).toBe("cancelled");
  });

  it("continues a Run across a Host disconnect and reconnect within the grace window, and publishes once", async (ctx) => {
    if (!db.available) return ctx.skip();
    await w.material("WORKER_PROCESS_MATERIAL");
    const requested = await w.service().request(w.adapter(), OWNER, manual);
    const run = await w.runOf(requested.briefing.id);
    const worker = await spawn();
    await worker.next(isPrompted(run.id));
    worker.send({ cmd: "disconnect" });
    worker.send({ cmd: "reconnect" });
    worker.send({ cmd: "answer", runId: run.id, text: answerAll });
    expect(await settledVersion(requested.briefing.id)).toMatchObject({ status: "ready", outcome: "briefing", attempt: 1 });
    expect(await attempts(run.id)).toEqual([expect.objectContaining({ attempt_number: 1, status: "succeeded" })]);
    expect(await deliveries(run.id)).toBe(1);
  });

  it("publishes a valid reply longer than the Run summary keeps, through the structured channel, and fails closed on a long invalid one or long prose", async (ctx) => {
    if (!db.available) return ctx.skip();
    await w.material("WORKER_PROCESS_MATERIAL");
    const long = (refs: string[]) => {
      const value = outputValue();
      value.highlights = Array.from({ length: 8 }, (_, index) => ({ ...value.highlights[0]!, title: `Highlight ${index}`,
        statements: Array.from({ length: 8 }, () => ({ kind: "fact" as const, text: "Synthetic fact. ".repeat(35), refs })) }));
      return output(value);
    };
    const valid = long(["S1"]);
    expect(valid.length).toBeGreaterThan(32_000);
    const worker = await spawn();
    const outcome = async (answer: string) => {
      const requested = await w.service().request(w.adapter(), OWNER, manual);
      worker.send({ cmd: "policy", prompt: { answer } });
      const row = await settledVersion(requested.briefing.id);
      const run = (await w.runs().getRun(SPACE, row.run_id!))!;
      return { row, summary: String((run.output_json as { summary?: string }).summary ?? "") };
    };
    const published = await outcome(valid);
    // The summary is the evidence redactor's capped text; the briefing came whole through `result.structured_output`.
    expect(published.summary.endsWith("...[truncated]")).toBe(true);
    expect(published.row).toMatchObject({ status: "ready", outcome: "briefing" });
    expect((published.row.result_json as { highlights: unknown[] }).highlights).toHaveLength(8);

    await w.age(1);
    await w.material("SECOND_MATERIAL", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    // As long, but citing material the request never had: the structured object is kept, and validation refuses it.
    const invalid = await outcome(long(["S9"]));
    expect(invalid.row).toMatchObject({ status: "failed", error_code: "briefing_output_invalid" });

    await w.age(1);
    await w.material("THIRD_MATERIAL", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    // Long prose with no briefing in it: the cut summary is not taken for the reply.
    const prose = await outcome("Long prose. ".repeat(4_000));
    expect(prose.row).toMatchObject({ status: "failed", error_code: "briefing_output_truncated" });
  });
});
