import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config";
import { getDbPool } from "../src/db/pool";
import {
  __setAuthRepositoryForTests,
  type AuthRepository,
} from "../src/modules/auth";
import { buildServer } from "../src/server";
import { registerKnowledgeProposalAppliers } from "../src/modules/knowledge/proposalApplier";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry";
import { PgProposalApplyService } from "../src/modules/proposals/applyService";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository";

vi.mock("../src/db/pool", () => ({ getDbPool: vi.fn() }));

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthRepositoryForTests(null);
  vi.mocked(getDbPool).mockReset();
  await app?.close();
  app = undefined;
});

class ObjectKindApplyFakeDb {
  readonly objectKinds = new Map<string, Record<string, unknown>>();
  readonly relationHints = new Map<string, Record<string, unknown>>();
  readonly writes: string[] = [];

  async query(sql: string, params: readonly unknown[] = []) {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("SELECT id FROM space_object_kinds")) {
      const exists = [...this.objectKinds.values()].find((row) =>
        row.space_id === params[0] &&
        row.base_object_type === params[1] &&
        row.key === params[2]
      );
      return { rows: exists ? [{ id: exists.id }] : [], rowCount: exists ? 1 : 0 };
    }
    if (norm.startsWith("INSERT INTO space_object_kinds")) {
      this.writes.push("object_kind_create");
      const row = {
        id: params[0],
        space_id: params[1],
        key: params[2],
        label: params[3],
        description: params[4],
        base_object_type: params[5],
        status: params[6],
        version: 1,
        field_schema_json: JSON.parse(String(params[7])),
        extraction_policy_json: JSON.parse(String(params[8])),
        retrieval_policy_json: JSON.parse(String(params[9])),
        ui_config_json: JSON.parse(String(params[10])),
        created_by_user_id: params[11],
        created_from_proposal_id: params[12],
        updated_from_proposal_id: params[12],
        created_at: params[13],
        updated_at: params[13],
      };
      this.objectKinds.set(String(row.id), row);
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("INSERT INTO space_object_kind_relation_hints")) {
      this.writes.push("relation_hint_create");
      const row = {
        id: params[0],
        space_id: params[1],
        object_kind_id: params[2],
        endpoint_object_type: params[3],
        endpoint_object_kind_id: params[4],
        relation_type: params[5],
        direction: params[6],
        confidence_default: params[7],
        required: params[8],
        created_at: params[9],
      };
      this.relationHints.set(String(row.id), row);
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("DELETE FROM space_object_kind_relation_hints")) {
      this.writes.push("relation_hint_delete");
      for (const [id, row] of this.relationHints.entries()) {
        if (row.space_id === params[0] && row.object_kind_id === params[1]) this.relationHints.delete(id);
      }
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("SELECT id, space_id, key, label")) {
      const row = this.objectKinds.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (norm.startsWith("UPDATE space_object_kinds SET label")) {
      this.writes.push("object_kind_update");
      const row = this.objectKinds.get(String(params[0]));
      if (row) {
        row.label = params[2];
        row.description = params[3];
        row.status = params[4];
        row.field_schema_json = JSON.parse(String(params[5]));
        row.extraction_policy_json = JSON.parse(String(params[6]));
        row.retrieval_policy_json = JSON.parse(String(params[7]));
        row.ui_config_json = JSON.parse(String(params[8]));
        row.version = Number(row.version) + 1;
        row.updated_from_proposal_id = params[9];
        row.updated_at = params[10];
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (norm.startsWith("UPDATE space_object_kinds SET status")) {
      this.writes.push(`object_kind_${String(params[2])}`);
      const row = this.objectKinds.get(String(params[0]));
      if (row) {
        row.status = params[2];
        row.version = Number(row.version) + 1;
        row.updated_from_proposal_id = params[3];
        row.updated_at = params[4];
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }
}

class ObjectKindApplyServiceFakeClient extends ObjectKindApplyFakeDb {
  proposalRow: Record<string, unknown> = proposalRow({
    proposal_type: "object_kind_create",
    status: "pending",
    risk_level: "high",
    payload_json: {
      operation: "object_kind_create",
      key: "decision",
      label: "Decision",
      base_object_type: "knowledge_item",
    },
  });
  acceptedUpdates = 0;
  auditWrites = 0;
  released = false;

  override async query(sql: string, params: readonly unknown[] = []) {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (norm.startsWith("SELECT proposal.id, proposal.space_id, proposal.proposal_type")) {
      return { rows: [this.proposalRow], rowCount: 1 };
    }
    if (norm.includes("AS effective_access_level")) {
      return { rows: [{ effective_access_level: "full" }], rowCount: 1 };
    }
    if (norm.startsWith("SELECT role FROM space_memberships")) {
      return { rows: [{ role: "admin" }], rowCount: 1 };
    }
    if (norm.startsWith("INSERT INTO policy_decision_records")) {
      this.auditWrites += 1;
      return { rows: [{ id: "policy-decision-1" }], rowCount: 1 };
    }
    if (norm.startsWith("UPDATE proposals SET status = $5")) {
      if (this.proposalRow.status !== "pending") return { rows: [], rowCount: 0 };
      this.proposalRow.status = params[4];
      this.proposalRow.reviewed_at = params[2];
      this.proposalRow.reviewed_by = params[3];
      this.acceptedUpdates += 1;
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("SELECT p.id, p.space_id")) {
      return { rows: [this.proposalRow], rowCount: 1 };
    }
    return super.query(sql, params);
  }

  release() {
    this.released = true;
  }
}

describe("object kind proposal applier", () => {
  it("creates object kind registry rows without writing canonical space objects", async () => {
    const db = new ObjectKindApplyFakeDb();
    const result = await apply(db, proposal("object_kind_create", {
      operation: "object_kind_create",
      key: "decision",
      label: "Decision",
      base_object_type: "knowledge_item",
      field_schema: { fields: [{ key: "risk", type: "string" }] },
    }));

    expect(result.result_type).toBe("object_kind");
    expect(result.result.registry_write_performed).toBe(true);
    expect(result.result.canonical_domain_write_performed).toBe(false);
    expect(db.writes).toEqual(["object_kind_create"]);
    const objectKind = result.result.object_kind as Record<string, unknown>;
    expect(objectKind).toMatchObject({
      key: "decision",
      base_object_type: "knowledge_item",
      version: 1,
    });
  });

  it("rejects object kind registry keys outside the canonical subtype set", async () => {
    const db = new ObjectKindApplyFakeDb();

    await expect(apply(db, proposal("object_kind_create", {
      operation: "object_kind_create",
      key: "vendor_profile",
      label: "Vendor profile",
      base_object_type: "knowledge_item",
    }))).rejects.toThrow(/canonical knowledge_item subtype/);

    expect(db.writes).toEqual([]);
  });

  it("rejects schema config with executable fields", async () => {
    const db = new ObjectKindApplyFakeDb();

    await expect(apply(db, proposal("object_kind_create", {
      operation: "object_kind_create",
      key: "concept",
      label: "Bad kind",
      base_object_type: "knowledge_item",
      field_schema: { sql_query: "SELECT * FROM hidden" },
    }))).rejects.toThrow(/not allowed in object schema config/);

    expect(db.writes).toEqual([]);
  });

  it("updates and deprecates object kinds through explicit proposals", async () => {
    const db = new ObjectKindApplyFakeDb();
    const created = await apply(db, proposal("object_kind_create", {
      operation: "object_kind_create",
      key: "metric",
      label: "Metric",
      base_object_type: "claim",
    }));
    const kindId = String((created.result.object_kind as Record<string, unknown>).id);

    const updated = await apply(db, proposal("object_kind_update", {
      operation: "object_kind_update",
      target_kind_id: kindId,
      label: "Reviewed metric claim",
    }));
    expect(updated.result.object_kind).toMatchObject({ label: "Reviewed metric claim", version: 2 });

    const deprecated = await apply(db, proposal("object_kind_deprecate", {
      operation: "object_kind_deprecate",
      target_kind_id: kindId,
    }));
    expect(deprecated.result.object_kind).toMatchObject({ status: "deprecated", version: 3 });
  });

  it("applies relation hints as object kind registry config", async () => {
    const db = new ObjectKindApplyFakeDb();
    const endpoint = await apply(db, proposal("object_kind_create", {
      operation: "object_kind_create",
      key: "summary",
      label: "Summary",
      base_object_type: "knowledge_item",
    }));
    const endpointKindId = String((endpoint.result.object_kind as Record<string, unknown>).id);

    const created = await apply(db, proposal("object_kind_create", {
      operation: "object_kind_create",
      key: "decision",
      label: "Decision",
      base_object_type: "knowledge_item",
      relation_hints: [{
        endpoint_object_type: "knowledge_item",
        endpoint_object_kind_id: endpointKindId,
        relation_type: "supports",
        direction: "from",
        confidence_default: 0.7,
        required: true,
      }],
    }));
    const sourceKindId = String((created.result.object_kind as Record<string, unknown>).id);

    expect([...db.relationHints.values()]).toEqual([
      expect.objectContaining({
        object_kind_id: sourceKindId,
        endpoint_object_kind_id: endpointKindId,
        relation_type: "supports",
        required: true,
      }),
    ]);

    await apply(db, proposal("object_kind_update", {
      operation: "object_kind_update",
      target_kind_id: sourceKindId,
      relation_hints: [{
        endpoint_object_type: "source",
        relation_type: "references",
        direction: "either",
      }],
    }));

    expect([...db.relationHints.values()]).toEqual([
      expect.objectContaining({
        object_kind_id: sourceKindId,
        endpoint_object_type: "source",
        endpoint_object_kind_id: null,
        relation_type: "references",
        direction: "either",
        required: false,
      }),
    ]);
    expect(db.writes).toEqual([
      "object_kind_create",
      "object_kind_create",
      "relation_hint_create",
      "object_kind_update",
      "relation_hint_delete",
      "relation_hint_create",
    ]);
  });

  it("activates draft object kinds through update proposals only", async () => {
    const db = new ObjectKindApplyFakeDb();
    const created = await apply(db, proposal("object_kind_create", {
      operation: "object_kind_create",
      key: "fact",
      label: "Draft fact",
      base_object_type: "claim",
      status: "draft",
    }));
    const kindId = String((created.result.object_kind as Record<string, unknown>).id);

    const activated = await apply(db, proposal("object_kind_update", {
      operation: "object_kind_update",
      target_kind_id: kindId,
      status: "active",
    }));

    expect(activated.result.object_kind).toMatchObject({ status: "active", version: 2 });
    await expect(apply(db, proposal("object_kind_update", {
      operation: "object_kind_update",
      target_kind_id: kindId,
      status: "active",
    }))).rejects.toThrow(/only draft object kinds can be activated/);
  });
});

describe("object kind proposal routes", () => {
  it("lets a space admin create an object kind proposal", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    mockPool((sql, params) => {
      if (/INSERT INTO proposals/.test(sql)) {
        return {
          rows: [proposalRow({
            id: "proposal-1",
            proposal_type: String(params[3]),
            title: String(params[8]),
            payload_json: JSON.parse(String(params[10])),
            risk_level: String(params[5]),
          })],
          rowCount: 1,
        };
      }
      return undefined;
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/object-schema/kinds/proposals",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        key: "decision",
        label: "Decision",
        base_object_type: "knowledge_item",
        relation_hints: [{
          endpoint_object_type: "source",
          relation_type: "references",
          direction: "from",
        }],
      }),
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.proposal_type).toBe("object_kind_create");
    expect(body.risk_level).toBe("high");
    expect(body.proposed_content).toContain("decision");
  });

  it("rejects unsafe object kind config before creating a proposal", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    let inserts = 0;
    mockPool((sql) => {
      if (/INSERT INTO proposals/.test(sql)) inserts += 1;
      return undefined;
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/object-schema/kinds/proposals",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        key: "concept",
        label: "Bad kind",
        base_object_type: "knowledge_item",
        field_schema: { command_template: "rm -rf ." },
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("not allowed in object schema config");
    expect(inserts).toBe(0);
  });

  it("rejects object kind keys that cannot project from the selected canonical domain", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    let inserts = 0;
    mockPool((sql) => {
      if (/INSERT INTO proposals/.test(sql)) inserts += 1;
      return undefined;
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/object-schema/kinds/proposals",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        key: "vendor_profile",
        label: "Vendor profile",
        base_object_type: "knowledge_item",
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("canonical knowledge_item subtype");
    expect(inserts).toBe(0);
  });

  it("enforces strict active object kind field schema before creating knowledge proposals", async () => {
    __setAuthRepositoryForTests(auth("member"));
    let inserts = 0;
    mockPool((sql, params) => {
      if (/FROM space_object_kinds/.test(sql)) {
        expect(params).toEqual(["space-1", "knowledge_item", "decision"]);
        return {
          rows: [objectKindRow({
            key: "decision",
            label: "Decision",
            base_object_type: "knowledge_item",
            field_schema_json: {
              enforcement: "strict",
              fields: [{ key: "risk", type: "string", required: true }],
            },
          })],
          rowCount: 1,
        };
      }
      if (/INSERT INTO proposals/.test(sql)) inserts += 1;
      return undefined;
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/items/proposals",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        title: "Decision without risk",
        content: "We chose the narrower path.",
        knowledge_kind: "decision",
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("risk is required");
    expect(inserts).toBe(0);
  });

  it("lets admins propose activating a draft object kind", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    mockPool((sql, params) => {
      if (/FROM space_object_kinds/.test(sql)) {
        return {
          rows: [objectKindRow({
            id: String(params[0]),
            status: "draft",
          })],
          rowCount: 1,
        };
      }
      if (/INSERT INTO proposals/.test(sql)) {
        return {
          rows: [proposalRow({
            id: "proposal-activate",
            proposal_type: String(params[3]),
            title: String(params[8]),
            payload_json: JSON.parse(String(params[10])),
            risk_level: String(params[5]),
          })],
          rowCount: 1,
        };
      }
      return undefined;
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/knowledge/object-schema/kinds/kind-1/proposals",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ status: "active" }),
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.proposal_type).toBe("object_kind_update");
    expect(body.proposed_content).toContain("kind-1");
  });

  it("rejects archived object kind targets before creating review work", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    let inserts = 0;
    mockPool((sql, params) => {
      if (/FROM space_object_kinds/.test(sql)) {
        return {
          rows: [objectKindRow({
            id: String(params[0]),
            status: "archived",
          })],
          rowCount: 1,
        };
      }
      if (/INSERT INTO proposals/.test(sql)) inserts += 1;
      return undefined;
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/object-schema/kinds/kind-1/deprecate-proposals",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("archived object kinds cannot be changed");
    expect(inserts).toBe(0);
  });

  it("exports object schema definitions without private object content or proposal history", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    mockPool((sql) => {
      if (/FROM space_object_kinds/.test(sql) && /status <> 'archived'/.test(sql)) {
        return {
          rows: [objectKindRow({
            id: "kind-decision",
            key: "decision",
            label: "Decision",
            base_object_type: "knowledge_item",
            field_schema_json: { fields: [{ key: "risk", type: "string" }] },
          })],
          rowCount: 1,
        };
      }
      if (/FROM space_object_kind_relation_hints h/.test(sql)) {
        return {
          rows: [{
            id: "hint-1",
            object_kind_id: "kind-decision",
            endpoint_object_type: "source",
            endpoint_object_kind_id: null,
            endpoint_object_kind_key: null,
            relation_type: "references",
            direction: "from",
            confidence_default: 0.55,
            required: false,
          }],
          rowCount: 1,
        };
      }
      return undefined;
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({ method: "GET", url: "/api/v1/knowledge/object-schema/export" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe("agent_space.object_schema.v1");
    expect(body.object_kinds).toEqual([
      expect.objectContaining({
        key: "decision",
        field_schema: { fields: [{ key: "risk", type: "string" }] },
        relation_hints: [expect.objectContaining({ endpoint_object_type: "source", relation_type: "references" })],
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("created_by_user_id");
    expect(JSON.stringify(body)).not.toContain("created_from_proposal_id");
  });

  it("returns relation hints on object kind list responses", async () => {
    __setAuthRepositoryForTests(auth("member"));
    mockPool((sql) => {
      if (/FROM space_object_kind_relation_hints h/.test(sql)) {
        return {
          rows: [{
            id: "hint-1",
            object_kind_id: "kind-1",
            endpoint_object_type: "source",
            endpoint_object_kind_id: null,
            endpoint_object_kind_key: null,
            relation_type: "references",
            direction: "from",
            confidence_default: 0.55,
            required: false,
          }],
          rowCount: 1,
        };
      }
      if (/count\(\*\)::text AS total FROM space_object_kinds/.test(sql)) {
        return { rows: [{ total: "1" }], rowCount: 1 };
      }
      if (/FROM space_object_kinds/.test(sql)) {
        return { rows: [objectKindRow({ id: "kind-1" })], rowCount: 1 };
      }
      return undefined;
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({ method: "GET", url: "/api/v1/knowledge/object-schema/kinds" });

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].relation_hints).toEqual([
      expect.objectContaining({ id: "hint-1", endpoint_object_type: "source", relation_type: "references" }),
    ]);
  });

  it("imports object schema manifests as draft object kind proposals", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    const insertedPayloads: Record<string, unknown>[] = [];
    mockPool((sql, params) => {
      if (/FROM space_object_kinds/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO proposals/.test(sql)) {
        const payload = JSON.parse(String(params[10])) as Record<string, unknown>;
        insertedPayloads.push(payload);
        return {
          rows: [proposalRow({
            id: `proposal-${insertedPayloads.length}`,
            proposal_type: String(params[3]),
            title: String(params[8]),
            payload_json: payload,
            risk_level: String(params[5]),
          })],
          rowCount: 1,
        };
      }
      return undefined;
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/object-schema/imports/proposals",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        manifest: {
          format: "agent_space.object_schema.v1",
          exported_at: "2026-06-27T00:00:00.000Z",
          object_schema_version: 1,
          object_kinds: [{
            key: "decision",
            label: "Decision",
            base_object_type: "knowledge_item",
            status: "active",
            field_schema: { fields: [{ key: "risk", type: "string" }] },
            relation_hints: [{ endpoint_object_type: "source", relation_type: "references" }],
          }],
        },
      }),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ created_proposal_count: 1, skipped_count: 0 });
    expect(insertedPayloads).toHaveLength(1);
    expect(insertedPayloads[0]).toMatchObject({
      operation: "object_kind_create",
      key: "decision",
      status: "draft",
      relation_hints: [expect.objectContaining({ endpoint_object_type: "source", relation_type: "references" })],
    });
  });

  it("rejects object kind proposal creation for non-admin members", async () => {
    __setAuthRepositoryForTests(auth("member"));
    mockPool(() => undefined);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/object-schema/kinds/proposals",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        key: "decision",
        label: "Decision",
        base_object_type: "knowledge_item",
      }),
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("object kind proposal apply service", () => {
  it("marks generic object kind proposals accepted and prevents replay", async () => {
    const client = new ObjectKindApplyServiceFakeClient();
    vi.mocked(getDbPool).mockReturnValue({
      connect: async () => client,
      query: async (sql: string, params?: readonly unknown[]) => client.query(sql, params),
    } as never);
    const registry = new ProposalApplierRegistry();
    registerKnowledgeProposalAppliers(registry);
    const service = new PgProposalApplyService(config(), registry);

    const first = await service.accept("proposal-1", { spaceId: "space-1", userId: "user-1" });

    expect(first?.proposal).toMatchObject({ id: "proposal-1", status: "accepted" });
    expect(first?.result_type).toBe("object_kind");
    expect(client.proposalRow.reviewed_by).toBe("user-1");
    expect(client.acceptedUpdates).toBe(1);
    expect(client.writes).toEqual(["object_kind_create"]);

    const replay = await service.accept("proposal-1", { spaceId: "space-1", userId: "user-1" });

    expect(replay).toBeNull();
    expect(client.acceptedUpdates).toBe(1);
    expect(client.writes).toEqual(["object_kind_create"]);
  });
});

async function apply(db: ObjectKindApplyFakeDb, p: ApplyProposal) {
  const registry = new ProposalApplierRegistry();
  registerKnowledgeProposalAppliers(registry);
  return registry.apply({
    config: loadConfig({
      SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
      SERVER_INTERNAL_TOKEN: "internal-token",
    }),
    db: db as never,
    proposal: p,
    userId: "user-1",
  });
}

function proposal(proposalType: string, payload: Record<string, unknown>): ApplyProposal {
  return {
    id: "proposal-1",
    space_id: "space-1",
    proposal_type: proposalType,
    title: proposalType,
    project_folder_id: null,
    project_id: null,
    created_by_user_id: "user-1",
    created_by_run_id: null,
    payload_json: payload,
  };
}

function config() {
  return loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" });
}

function auth(role: "owner" | "admin" | "reviewer" | "member" | "guest" = "admin"): AuthRepository {
  return {
    async resolveIdentity() {
      return { ok: true, spaceId: "space-1", userId: "user-1" };
    },
    async getSpaceForUser() {
      return {
        id: "space-1",
        name: "Team",
        type: "team",
        role,
        oversight_mode: "none",
        created_by_user_id: "owner-1",
        created_at: "2026-06-18T00:00:00.000Z",
        updated_at: "2026-06-18T00:00:00.000Z",
      };
    },
    async getCurrentUser() { throw new Error("not used"); },
    async getUserSpaces() { throw new Error("not used"); },
    async logout() { throw new Error("not used"); },
    async findOrCreateFromGoogle() { throw new Error("not used"); },
    async createSession() { throw new Error("not used"); },
  };
}

interface Handler {
  (sql: string, params: readonly unknown[]): { rows: unknown[]; rowCount: number } | undefined;
}

function mockPool(handler: Handler): void {
  const query = async (sql: string, params: readonly unknown[] = []) =>
    handler(sql, params) ?? { rows: [], rowCount: 0 };
  vi.mocked(getDbPool).mockReturnValue({
    query,
    connect: async () => ({
      query,
      release: () => undefined,
    }),
  } as never);
}

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "proposal-1",
    space_id: "space-1",
    created_by_user_id: "user-1",
    project_folder_id: null,
    created_by_run_id: null,
    proposal_type: "object_kind_create",
    status: "pending",
    risk_level: "high",
    urgency: "normal",
    preview: false,
    title: "Create object kind",
    payload_json: {},
    rationale: "Object kind creation requested.",
    visibility: "space_shared",
    review_deadline: null,
    expires_at: null,
    created_at: "2026-06-27T00:00:00.000Z",
    reviewed_at: null,
    reviewed_by: null,
    project_id: null,
    egress_approval_id: null,
    egress_approval_status: null,
    ...overrides,
  };
}

function objectKindRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "kind-1",
    space_id: "space-1",
    key: "decision",
    label: "Decision",
    description: null,
    base_object_type: "knowledge_item",
    status: "active",
    version: 1,
    field_schema_json: {},
    extraction_policy_json: {},
    retrieval_policy_json: {},
    ui_config_json: {},
    created_by_user_id: "user-1",
    created_from_proposal_id: "proposal-create",
    updated_from_proposal_id: "proposal-create",
    created_at: "2026-06-27T00:00:00.000Z",
    updated_at: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}
