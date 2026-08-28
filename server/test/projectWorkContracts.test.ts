import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERSON_ONLY_TASK_STATUSES,
  PROJECT_WORK_EVENT_KINDS,
  WORK_LOOP_STAGE_KEYS,
  WORK_LOOP_STAGE_LABELS,
  stageTransitionKind,
  workLoopStageLabel,
} from "@rainver/protocol";
import {
  hasWorkEventKindDeclaration,
  registeredWorkEventKinds,
} from "../src/modules/projectWork/eventKinds.js";
import { assertWorkEventKind } from "../src/modules/projectWork/eventWriter.js";
import {
  declaredRequiredOutputs,
  outcomeForRun,
} from "../src/modules/projectWork/settlement.js";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const SRC = join(import.meta.dirname, "..", "src");

describe("project work event vocabulary", () => {
  // The column carries a format check only, so the registry is the whole of
  // the closed-set enforcement. A demoted constraint with nothing asking the
  // registry would be strictly worse than the constraint it replaced.
  it("declares every kind the protocol vocabulary carries", () => {
    for (const kind of PROJECT_WORK_EVENT_KINDS) {
      expect(hasWorkEventKindDeclaration(kind), kind).toBe(true);
    }
  });

  it("declares no kind outside the protocol vocabulary", () => {
    const declared = registeredWorkEventKinds().map((definition) => definition.kind);
    expect([...declared].sort()).toEqual([...PROJECT_WORK_EVENT_KINDS].sort());
  });

  it("keeps every declared subject a registered entity", () => {
    for (const definition of registeredWorkEventKinds()) {
      for (const subject of definition.subjects) {
        expect(() => assertWorkEventKind(definition.kind, subject)).not.toThrow();
      }
    }
  });

  it("rejects an unknown kind and a kind written about the wrong subject", () => {
    expect(() => assertWorkEventKind("task.invented", "task")).toThrow(/Unknown/);
    expect(() => assertWorkEventKind("project.reported", "task")).toThrow(/does not accept/);
    expect(() => assertWorkEventKind("task.created", "unicorn")).toThrow(/does not accept/);
  });

  it("is the only place that writes a project work event", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.endsWith(join("projectWork", "eventWriter.ts")))
      .filter((file) => /INSERT\s+INTO\s+project_work_events/i.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("keeps the loop-stage CHECK agreeing with the protocol constant", () => {
    const baseline = readFileSync(
      join(import.meta.dirname, "..", "migrations", "0001_baseline.sql"),
      "utf8",
    );
    const match = /CONSTRAINT "ck_task_loop_states_stage" CHECK \(current_stage_key IN \(([^)]*)\)\)/
      .exec(baseline);
    expect(match, "stage CHECK not found in the runtime baseline").not.toBeNull();
    const inCheck = [...(match?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(inCheck).toEqual([...WORK_LOOP_STAGE_KEYS]);
  });
});

describe("work loop stages", () => {
  // The five stages are a system constant; a Mode changes what they are
  // called and nothing else. A missing label would silently fall back to a
  // key, which reads as a bug in whichever Project happens to use that Mode.
  it("labels every stage in every mode", () => {
    for (const [mode, labels] of Object.entries(WORK_LOOP_STAGE_LABELS)) {
      for (const stage of WORK_LOOP_STAGE_KEYS) {
        expect(labels[stage], `${mode}/${stage}`).toBeTruthy();
      }
    }
    expect(workLoopStageLabel("research", "verify")).toBe("Evaluate");
    expect(workLoopStageLabel("delivery", "verify")).toBe("Verify");
  });

  it("classifies a move without restricting it", () => {
    expect(stageTransitionKind(null, "frame")).toBe("advance");
    expect(stageTransitionKind("frame", "plan")).toBe("advance");
    // Skipping is allowed and recorded as a skip, because a Task that does not
    // need a plan should not have to pretend it made one.
    expect(stageTransitionKind("frame", "act")).toBe("skip");
    // Verification that fails because the method was wrong belongs back at
    // plan; the ordering classifies that rather than forbidding it.
    expect(stageTransitionKind("verify", "plan")).toBe("regress");
    expect(stageTransitionKind("verify", "verify")).toBe("reopen");
  });
});

describe("run settlement decision", () => {
  it("accepts only when the evaluation accepted and the declared outputs exist", () => {
    expect(outcomeForRun("succeeded", "accept", true, [])).toMatchObject({
      flow: "done",
      reason: "accepted",
      stage: "conclude",
    });
    expect(outcomeForRun("degraded", "accept", true, [])).toMatchObject({ flow: "done" });
  });

  it("holds a successful Run whose evaluation did not accept it", () => {
    // The evaluation already computes this recommendation on every
    // finalization; the old projection simply never read it, so a Run the
    // evaluator called `retry` still closed its Task as done.
    for (const recommendation of ["review", "retry", "needs_evidence", null]) {
      expect(outcomeForRun("succeeded", recommendation, true, []), String(recommendation))
        .toMatchObject({ flow: "waiting_for_review", stage: "verify" });
    }
  });

  it("holds a successful Run with no evaluation at all", () => {
    expect(outcomeForRun("succeeded", null, false, [])).toMatchObject({
      flow: "waiting_for_review",
      reason: "evaluation_missing",
    });
  });

  it("holds an accepted Run that is missing a declared output", () => {
    expect(outcomeForRun("succeeded", "accept", true, ["report"])).toMatchObject({
      flow: "waiting_for_review",
      reason: "required_outputs_missing",
      missingOutputs: ["report"],
    });
  });

  it("routes failure, cancellation and supervisor review to a person", () => {
    expect(outcomeForRun("failed", null, false, [])).toMatchObject({
      flow: "waiting_for_review",
      reason: "run_failed",
    });
    expect(outcomeForRun("cancelled", null, false, [])).toMatchObject({
      flow: "waiting_for_review",
      reason: "run_cancelled",
    });
    expect(outcomeForRun("waiting_for_review", null, false, [])).toMatchObject({
      flow: "waiting_for_review",
      reason: "supervisor_review",
    });
  });

  it("leaves the loop stage alone when no result was produced", () => {
    // Failure and cancellation produce nothing to verify. Moving the stage
    // anyway would claim the work reached a phase it never reached; where it
    // goes next is a decision a person or an agent makes.
    for (const status of ["failed", "cancelled", "waiting_for_review"]) {
      expect(outcomeForRun(status, null, false, []).stage, status).toBeNull();
    }
  });
});

describe("declared required outputs", () => {
  it("reads strings and typed objects, and ignores anything else", () => {
    expect(declaredRequiredOutputs(["Report", " diff "])).toEqual(["report", "diff"]);
    expect(declaredRequiredOutputs([{ artifact_type: "Report" }, { type: "diff" }, { name: "log" }]))
      .toEqual(["report", "diff", "log"]);
    expect(declaredRequiredOutputs(["report", "REPORT"])).toEqual(["report"]);
    expect(declaredRequiredOutputs(null)).toEqual([]);
    expect(declaredRequiredOutputs("report")).toEqual([]);
    expect(declaredRequiredOutputs([{}, 7, ""])).toEqual([]);
  });

  it("pins the person-only statuses to the ones the Task table allows", () => {
    // If `waiting_for_review` were renamed in the CHECK constraint, the
    // responsibility chain's `NOT IN (...)` would match nothing, an Agent-held
    // Task would stop reaching a person again, and every test would stay
    // green — the defect the chain exists to prevent, reintroduced silently.
    const schema = readFileSync(join(import.meta.dirname, "../src/db/schema/tasks.ts"), "utf8");
    const check = /check\("ck_tasks_status", sql`status IN \(([^)]*)\)`\)/.exec(schema);
    expect(check).not.toBeNull();
    const allowed = [...check![1]!.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    for (const status of PERSON_ONLY_TASK_STATUSES) {
      expect(allowed).toContain(status);
    }
  });
});
