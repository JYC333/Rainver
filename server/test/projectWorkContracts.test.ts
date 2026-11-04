import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERSON_ONLY_TASK_STATUSES,
  PROJECT_WORK_EVENT_KINDS,
  TASK_STATUSES,
} from "@rainver/protocol";
import { DEFAULT_COLUMNS } from "../src/modules/tasks/taskRepositoryRows.js";
import { ARCHIVED_CARD_STATUSES, COLUMN_FOR_STATUS } from "../src/modules/projectWork/boardReadModel.js";
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
  // the closed-set enforcement. Do not leave only the format check. Any
  // token that matches the format would then be accepted.
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

  it("draws every Task status on exactly one lane, or archives it", () => {
    const lanes = new Set(DEFAULT_COLUMNS.map((column) => column.status_key));
    for (const status of TASK_STATUSES) {
      const drawnOn = COLUMN_FOR_STATUS[status] ?? status;
      const archived = ARCHIVED_CARD_STATUSES.includes(status);
      expect(lanes.has(drawnOn) || archived, `${status} → ${drawnOn}`).toBe(true);
      expect(lanes.has(drawnOn) && archived, `${status} both drawn and archived`).toBe(false);
    }
    for (const overlay of Object.keys(COLUMN_FOR_STATUS)) {
      expect(TASK_STATUSES, `${overlay} is not a Task status`).toContain(overlay);
    }
    // The database constraints name the same set, in `tasks` and `board_columns`.
    const schema = readFileSync(join(process.cwd(), "src", "db", "schema", "tasks.ts"), "utf8");
    const lists = [...schema.matchAll(/status(?:_key)? IN \(([^)]*)\)/g)].map((m) =>
      m[1]!.split(",").map((item) => item.trim().replace(/^'|'$/g, "")).sort(),
    );
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toEqual([...TASK_STATUSES].sort());
  });

  it("accepts only when the evaluation accepted and the declared outputs exist", () => {
    expect(outcomeForRun("succeeded", "accept", true, [])).toMatchObject({
      flow: "done",
      reason: "accepted",
    });
    expect(outcomeForRun("degraded", "accept", true, [])).toMatchObject({ flow: "done" });
  });

  it("holds a successful Run whose evaluation did not accept it", () => {
    // The evaluation already computes this recommendation on every
    // finalization. Settlement must read it. A Run the evaluator called
    // `retry` must not close its Task as done.
    for (const recommendation of ["review", "retry", "needs_evidence", null]) {
      expect(outcomeForRun("succeeded", recommendation, true, []), String(recommendation))
        .toMatchObject({ flow: "waiting_for_review" });
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
    // Task would stop reaching a person, and every test would stay green.
    // Do not let the chain's status list drift from the CHECK constraint.
    const schema = readFileSync(join(import.meta.dirname, "../src/db/schema/tasks.ts"), "utf8");
    const check = /check\("ck_tasks_status", sql`status IN \(([^)]*)\)`\)/.exec(schema);
    expect(check).not.toBeNull();
    const allowed = [...check![1]!.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    for (const status of PERSON_ONLY_TASK_STATUSES) {
      expect(allowed).toContain(status);
    }
  });
});
