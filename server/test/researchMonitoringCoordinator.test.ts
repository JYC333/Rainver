import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config";
import { ResearchMonitoringCoordinator } from "../src/modules/research/queryPlanning/monitoringCoordinator";
import type { Queryable } from "../src/modules/routeUtils/common";

describe("ResearchMonitoringCoordinator", () => {
  it("records late observations but never adapts a strategy that is no longer active", async () => {
    const statements: string[] = [];
    const db = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("INSERT INTO research_query_performance_observations")) return { rows: [], rowCount: 1 };
        if (sql.includes("FROM research_query_strategy_activations")) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected query: ${sql}`);
      },
    } as Queryable;

    const result = await new ResearchMonitoringCoordinator(db, {} as ServerConfig).recordAndMaybePropose({
      identity: { spaceId: "space", userId: "user" },
      projectId: "project",
      strategyId: "retired-strategy",
      scanSummaryId: "late-scan",
      observedAt: "2026-07-20T12:00:00.000Z",
      newCandidateCount: 0,
      relevantCount: 0,
      maybeCount: 0,
      excludedCount: 0,
    });

    expect(result).toEqual({
      proposal_id: null,
      direction: null,
      reason: "The observed query strategy is no longer active.",
    });
    expect(statements).toHaveLength(2);
  });
});
