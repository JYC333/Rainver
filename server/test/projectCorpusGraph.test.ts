import { describe, expect, it } from "vitest";
import type { Queryable, SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { resolveGraphProjectionOptions } from "../src/modules/graph/projectionBuilder.js";
import { GraphProjectionRepository } from "../src/modules/graph/projectionRepository.js";

class CapturingDb implements Queryable {
  readonly queries: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    this.queries.push({ sql, params });
    return { rows: [] as Row[], rowCount: 1 };
  }
}

const identity: SpaceUserIdentity = { spaceId: "space-1", userId: "user-1" };

describe("project corpus graph foundation", () => {
  it("applies the academic citation lens as bounded graph filters", () => {
    expect(resolveGraphProjectionOptions({
      mode: "global",
      lensId: "academic_citation_v1",
      limit: 300,
      includeClusters: true,
    })).toMatchObject({
      nodeKinds: ["source", "person", "organization"],
      edgeKinds: ["cites", "authored_by", "affiliated_with"],
    });

    expect(resolveGraphProjectionOptions({
      mode: "global",
      lensId: "academic_citation_v1",
      nodeKinds: ["note", "source"],
      edgeKinds: ["same_as", "cites"],
      limit: 300,
      includeClusters: true,
    })).toMatchObject({
      nodeKinds: ["source"],
      edgeKinds: ["cites"],
    });
  });

  it("filters graph visible objects through active project corpus entries", async () => {
    const db = new CapturingDb();
    const repository = new GraphProjectionRepository(db);

    await repository.countVisibleObjects(identity, { projectId: "project-1" });

    expect(db.queries[0]?.sql).toContain("FROM project_corpus_items pci");
    expect(db.queries[0]?.sql).toContain("pci.object_id = so.id");
    expect(db.queries[0]?.sql).toContain("pci.status = 'active'");
    expect(db.queries[0]?.params).toContain("project-1");
  });

});
