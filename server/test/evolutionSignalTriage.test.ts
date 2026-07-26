import { describe, expect, it } from "vitest";
import type { QueryResult, Queryable } from "../src/modules/routeUtils/common";
import { EvolutionRepository } from "../src/modules/evolution/repository";

class TriageDb implements Queryable {
  readonly calls: string[] = [];
  private status = "new";
  private note: string | null = null;

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.calls.push(sql);
    if (sql.startsWith("UPDATE evolution_signals")) {
      this.status = String(params[2]);
      this.note = params[6] === null ? this.note : String(params[6]);
      return { rows: [], rowCount: 1 };
    }
    return {
      rows: [{
        id: "signal-1",
        space_id: "space-1",
        target_id: "target-1",
        target_name: "Task task-1",
        target_type: "project_folder",
        capability_key: null,
        signal_type: "run_finalization_failed",
        source_type: "run",
        source_id: "run-1",
        severity: "error",
        summary: "Run failed.",
        payload_json: {},
        triage_status: this.status,
        triaged_at: "2026-07-11T00:00:00.000Z",
        triaged_by_user_id: "user-1",
        triage_note: this.note,
        created_at: "2026-07-11T00:00:00.000Z",
      } as Row],
      rowCount: 1,
    };
  }
}

describe("evolution signal triage", () => {
  it("updates and dismisses a space-owned signal without touching system signals", async () => {
    const db = new TriageDb();
    const repo = new EvolutionRepository(db);
    const identity = { spaceId: "space-1", userId: "user-1" };

    const acknowledged = await repo.updateSignalTriage(identity, "signal-1", {
      triage_status: "acknowledged",
      triage_note: "Investigate in the next review.",
    });
    expect(acknowledged).toMatchObject({ triage_status: "acknowledged", triaged_by_user_id: "user-1" });

    const dismissed = await repo.dismissSignal(identity, "signal-1", { triage_note: "Not actionable." });
    expect(dismissed).toMatchObject({ triage_status: "dismissed", triage_note: "Not actionable." });
    expect(db.calls.filter((sql) => sql.startsWith("UPDATE evolution_signals"))).toHaveLength(2);
    expect(db.calls.every((sql) => !sql.includes("es.space_id IS NULL"))).toBe(true);
  });
});
