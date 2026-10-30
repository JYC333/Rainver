import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { OWNER, SPACE, briefingWorld, manual, output, outputValue } from "./support/briefingFixture.js";
import { settleBriefingRun } from "../src/modules/informationDigest/briefing/settlement.js";
import { canonicalRunOutput } from "../src/modules/runs/orchestrationResults.js";
import { sanitizeEvidenceJson } from "../src/modules/runs/evidenceRedaction.js";

// Where settlement finds the model's reply in a terminal Run's canonical
// output (`canonicalRunOutput`, sanitized again by the terminal writer):
// a result's own text, the structured object the contract declared, a
// structured result, then the summary — never a summary cut short.
const db = useTestDatabase(import.meta.filename, { max: 10 });
const w = briefingWorld(db);
beforeEach(async () => { if (db.available) await w.seed(); });

/** Settles the version's Run with exactly this canonical output, as the terminal writer stores it. */
async function settleWith(canonical: unknown) {
  await w.material("Reply channel material");
  const requested = await w.service().request(w.adapter(), OWNER, manual);
  const run = await w.runOf(requested.briefing.id);
  await w.finishRun(run.id, "");
  await db.pool.query(`UPDATE runs SET output_json=$2::jsonb WHERE id=$1`, [run.id, JSON.stringify(sanitizeEvidenceJson(canonical))]);
  await settleBriefingRun(db.pool, (await w.runs().getRun(SPACE, run.id))!);
  return w.rowOf(requested.briefing.id);
}

describe("A briefing reply is read from the channel that kept it whole", () => {
  it("publishes a valid structured result behind a prose summary", async (ctx) => {
    if (!db.available) return ctx.skip();
    const row = await settleWith(canonicalRunOutput({ success: true, outputText: "Completed the requested briefing.", outputJson: outputValue() }));
    expect(row).toMatchObject({ status: "ready", outcome: "briefing" });
  });

  it("keeps the reply's declared structured object whole through the terminal sanitize, while the summary is capped", async (ctx) => {
    if (!db.available) return ctx.skip();
    const value = outputValue();
    value.highlights = Array.from({ length: 8 }, (_, index) => ({ ...value.highlights[0]!, title: `Highlight ${index}`,
      statements: Array.from({ length: 8 }, () => ({ kind: "fact" as const, text: "Synthetic fact. ".repeat(35), refs: ["S1"] })) }));
    const reply = output(value);
    const canonical = canonicalRunOutput({ success: true, outputText: reply, outputJson: { runtime_key: "claude_code" }, structuredSchema: "information_briefing.v1" });
    const stored = sanitizeEvidenceJson(canonical) as { summary: string; result: { structured_output: unknown } };
    expect(stored.summary.endsWith("...[truncated]")).toBe(true);
    expect(stored.result.structured_output).toEqual(value);
    // Without the declared schema nothing is extracted: the channel is the contract's, not a guess.
    expect((canonicalRunOutput({ success: true, outputText: reply, outputJson: {} }).result as Record<string, unknown>).structured_output).toBeUndefined();
    expect(await settleWith(canonical)).toMatchObject({ status: "ready", outcome: "briefing" });
  });

  it("still reads a result's own output text, and refuses a cut summary as truncated rather than invalid", async (ctx) => {
    if (!db.available) return ctx.skip();
    expect(await settleWith(canonicalRunOutput({ success: true, outputText: "ignored", outputJson: { output_text: output(outputValue()) } })))
      .toMatchObject({ status: "ready", outcome: "briefing" });
    await w.age(1);
    expect(await settleWith(canonicalRunOutput({ success: true, outputText: "Long prose. ".repeat(4_000), outputJson: {}, structuredSchema: "information_briefing.v1" })))
      .toMatchObject({ status: "failed", error_code: "briefing_output_truncated" });
  });
});
