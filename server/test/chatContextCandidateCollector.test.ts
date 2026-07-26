import { describe, expect, it } from "vitest";
import { ChatContextCandidateCollector } from "../src/modules/context/chatCandidateCollector";
import { PgChatCandidateRepository } from "../src/modules/context/candidateRepository";
import type { Queryable } from "../src/modules/memory/repository";

/**
 * Fake `Queryable` that dispatches by the table named in the SQL. Lets the
 * collector + repository run end-to-end without a database, the way the budget
 * loop is unit-tested.
 */
class FakeDb implements Queryable {
  constructor(
    private readonly rowsByTable: Record<string, Record<string, unknown>[]>,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    const table = tableOf(sql);
    let rows = filterRows(table, this.rowsByTable[table] ?? [], params);
    if (table === "memory_entries") {
      const userId = String(params[1] ?? "");
      const projects = this.rowsByTable.projects ?? [];
      const projectMembers = this.rowsByTable.project_members ?? [];
      rows = rows.filter((row) => {
        const basicVisible = row.owner_user_id === userId || row.visibility === "space_shared";
        if (!basicVisible) return false;
        if (!row.project_id) return true;
        const project = projects.find((candidate) => candidate.id === row.project_id);
        return project?.owner_user_id === userId || projectMembers.some((member) =>
          member.project_id === row.project_id
          && member.user_id === userId
          && member.status === "active"
        );
      });
    }
    return { rows: rows as Row[], rowCount: rows.length };
  }
}

function tableOf(sql: string): string {
  if (sql.includes("FROM agents")) return "policy";
  if (sql.includes("FROM memory_entries")) return "memory_entries";
  if (sql.includes("FROM provenance_links")) return "provenance_links";
  if (sql.includes("FROM source_connections")) return "source_connections";
  if (sql.includes("FROM knowledge_items ki")) return "knowledge_items";
  if (sql.includes("FROM activity_records ar")) return "activity_records";
  if (sql.includes("FROM space_memberships")) return "space_memberships";
  if (sql.includes("FROM settings")) return "settings";
  if (sql.includes("FROM spaces")) return "spaces";
  if (sql.includes("FROM project_public_summaries")) return "project_public_summaries";
  if (sql.includes("FROM projects")) return "projects";
  if (sql.includes("FROM project_members")) return "project_members";
  if (sql.includes("FROM sources")) return "sources";
  return "unknown";
}

function filterRows(
  table: string,
  rows: Record<string, unknown>[],
  params: readonly unknown[],
): Record<string, unknown>[] {
  if (table === "provenance_links") {
    const targetType = typeof params[1] === "string" ? params[1] : null;
    const targetIds = Array.isArray(params[2]) ? params[2] : [];
    return rows.filter((row) =>
      (!targetType || row.target_type === targetType) &&
      targetIds.includes(row.target_id),
    );
  }
  if (table === "source_connections") {
    const ids = Array.isArray(params[1]) ? params[1] : [];
    return rows.filter((row) => ids.includes(row.id));
  }
  if (table === "space_memberships") {
    return rows.filter((row) => row.user_id === params[1] && row.status === "active");
  }
  if(table==="project_public_summaries"&&typeof params[1]==="string"&&!String(params[1]).startsWith("%"))return rows.filter(row=>row.project_id===params[1]);
  return rows;
}

function memoryRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "m1",
    space_id: "space-1",
    subject_user_id: "user-1",
    owner_user_id: "user-1",
    project_folder_id: null,
    scope_type: "user",
    namespace: null,
    memory_type: "fact",
    title: "Mem",
    content: "memory content",
    status: "active",
    visibility: "private",
    sensitivity_level: "normal",
    access_level: "full",
    deleted_at: null,
    importance: 0.9,
    confidence: 0.9,
    project_id: null,
    ...over,
  };
}

function sourceConnection(over: Record<string, unknown> = {}): Record<string, unknown> {
  const id = typeof over.id === "string" ? over.id : "source-1";
  const ownerUserId = typeof over.owner_user_id === "string" ? over.owner_user_id : "source-owner";
  return {
    id,
    owner_user_id: ownerUserId,
    consent_json: {
      schema_version: 1,
      owner_user_id: ownerUserId,
      allowed_reader_user_ids: ["user-1"],
      allowed_agent_ids: [],
      allow_space_admins: false,
      allow_local_provider_egress: true,
      allow_external_model_egress: true,
      ...(typeof over.consent_json === "object" && over.consent_json ? over.consent_json : {}),
    },
    policy_json: {
      schema_version: 1,
      source_egress_class: "external_provider_allowed",
      ...(typeof over.policy_json === "object" && over.policy_json ? over.policy_json : {}),
    },
    ...over,
  };
}

const request = {
  agent_id: "agent-1",
  space_id: "space-1",
  user_id: "user-1",
  session_id: "session-1",
  message: "hello world",
};

function collector(db: FakeDb): ChatContextCandidateCollector {
  return new ChatContextCandidateCollector(new PgChatCandidateRepository(db));
}

describe("ChatContextCandidateCollector", () => {
  it("rejects an empty message with a public validation error", async () => {
    const db = new FakeDb({});
    await expect(
      collector(db).fetchCandidates({ ...request, message: "   " }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("defaults to all sources when the version policy is empty", async () => {
    const db = new FakeDb({
      policy: [{ context_policy_json: {} }],
      memory_entries: [memoryRow({})],
      knowledge_items: [{ id: "k1", title: "K", content: "knowledge" }],
      sources: [{ id: "s1", title: "S", summary: "src summary", raw_text: null }],
      activity_records: [{ id: "a1", title: "A", content: "activity" }],
    });
    const result = await collector(db).fetchCandidates(request);

    expect(result.context_policy_applied).toBe(true);
    expect(result.max_tokens).toBe(4000);
    expect(result.max_items).toBe(20);
    // Priority order: memory, knowledge_item, source, activity_record.
    expect(result.items.map((i) => i.item_type)).toEqual([
      "memory",
      "knowledge_item",
      "source",
      "activity_record",
    ]);
    const memory = result.items[0];
    expect(memory).toMatchObject({
      item_id: "m1",
      excerpt: "memory content",
      score: 0.8,
      reason: "approved_memory",
      token_count: Math.floor("memory content".length / 4),
    });
    // allowed_sources echoes the full recognised set, sorted.
    expect(result.allowed_sources).toContain("project_folder");
    expect(result.allowed_sources).toEqual([...result.allowed_sources].sort());
  });

  it("surfaces approved project public summaries for cross-project inspiration", async () => {
    const db = new FakeDb({
      policy: [{ context_policy_json: {} }],
      project_public_summaries: [
        { project_id: "project-1", title: "Aster", summary_text: "Cross-project discovery brief." },
      ],
    });
    const result = await collector(db).fetchCandidates(request);

    const summary = result.items.find((i) => i.item_type === "project_public_summary");
    expect(summary).toMatchObject({
      item_id: "project-1",
      title: "Aster",
      excerpt: "Cross-project discovery brief.",
      score: 0.4,
      reason: "project_public_summary",
    });
    expect(result.allowed_sources).toContain("project_public_summary");
  });

  it("keeps Project Chat candidates within the requested Project",async()=>{
    const db=new FakeDb({policy:[{context_policy_json:{}}],memory_entries:[memoryRow({})],knowledge_items:[{id:"k1",title:"K",content:"knowledge"}],project_public_summaries:[{project_id:"project-1",title:"One",summary_text:"One summary"},{project_id:"project-2",title:"Two",summary_text:"Two summary"}]});
    const result=await collector(db).fetchCandidates({...request,project_id:"project-1"});
    expect(result.items.map(item=>item.item_id)).toEqual(["project-1"]);
    expect(result.items.map(item=>item.item_type)).toEqual(["project_public_summary"]);
  });

  it("honors the context_policy_json sources allow-list and caps", async () => {
    const db = new FakeDb({
      policy: [
        {
          context_policy_json: {
            sources: ["memory"],
            max_tokens: 1000,
            max_items: 5,
          },
        },
      ],
      memory_entries: [memoryRow({})],
      knowledge_items: [{ id: "k1", title: "K", content: "knowledge" }],
    });
    const result = await collector(db).fetchCandidates(request);

    expect(result.allowed_sources).toEqual(["memory"]);
    expect(result.max_tokens).toBe(1000);
    expect(result.max_items).toBe(5);
    expect(result.items.map((i) => i.item_type)).toEqual(["memory"]);
  });

  it("applies memory read authorization", async () => {
    const db = new FakeDb({
      policy: [{ context_policy_json: { sources: ["memory"] } }],
      memory_entries: [
        memoryRow({ id: "mine", owner_user_id: "user-1" }),
        // Private memory owned by another user — must be filtered out.
        memoryRow({ id: "theirs", owner_user_id: "user-2", subject_user_id: "user-2" }),
        // Another private memory remains filtered out.
        memoryRow({
          id: "theirs-private-2",
          owner_user_id: "user-2",
          subject_user_id: "user-2",
          visibility: "private",
          access_level: "full",
        }),
      ],
    });
    const result = await collector(db).fetchCandidates(request);

    expect(result.items.map((i) => i.item_id)).toEqual(["mine"]);
  });

  it("applies project ACL to memory candidates", async () => {
    const db = new FakeDb({
      policy: [{ context_policy_json: { sources: ["memory"] } }],
      spaces: [{ type: "household" }],
      projects: [
        { id: "project-accessible", owner_user_id: "user-1" },
        { id: "project-hidden", owner_user_id: "user-2" },
      ],
      project_members: [],
      memory_entries: [
        memoryRow({ id: "free", project_id: null, title: "Free" }),
        memoryRow({ id: "allowed", project_id: "project-accessible", title: "Allowed" }),
        memoryRow({ id: "hidden", project_id: "project-hidden", title: "Hidden" }),
      ],
    });
    const result = await collector(db).fetchCandidates(request);

    expect(result.items.map((i) => i.item_id)).toEqual(["free", "allowed"]);
  });

  it("filters source-backed knowledge items denied by source read policy", async () => {
    const db = new FakeDb({
      policy: [{ context_policy_json: { sources: ["knowledge_item"] } }],
      knowledge_items: [
        { id: "k-allowed", title: "Allowed", content: "allowed knowledge" },
        { id: "k-denied", title: "Denied", content: "denied knowledge" },
      ],
      provenance_links: [
        { target_type: "knowledge", target_id: "k-allowed", source_connection_id: "source-allowed" },
        { target_type: "knowledge", target_id: "k-denied", source_connection_id: "source-denied" },
      ],
      source_connections: [
        sourceConnection({ id: "source-allowed" }),
        sourceConnection({
          id: "source-denied",
          consent_json: {
            schema_version: 1,
            owner_user_id: "source-owner",
            allowed_reader_user_ids: ["someone-else"],
            allowed_agent_ids: [],
            allow_space_admins: false,
            allow_local_provider_egress: true,
            allow_external_model_egress: true,
          },
        }),
      ],
    });

    const result = await collector(db).fetchCandidates(request);

    expect(result.items.map((i) => i.item_id)).toEqual(["k-allowed"]);
  });

  it("filters source-backed knowledge items denied by external egress policy", async () => {
    const db = new FakeDb({
      policy: [{ context_policy_json: { sources: ["knowledge_item"] } }],
      knowledge_items: [
        { id: "k-local-only", title: "Local only", content: "local only knowledge" },
        { id: "k-external", title: "External", content: "external knowledge" },
      ],
      provenance_links: [
        { target_type: "knowledge", target_id: "k-local-only", source_connection_id: "source-local" },
        { target_type: "knowledge", target_id: "k-external", source_connection_id: "source-external" },
      ],
      source_connections: [
        sourceConnection({
          id: "source-local",
          consent_json: {
            schema_version: 1,
            owner_user_id: "source-owner",
            allowed_reader_user_ids: ["user-1"],
            allowed_agent_ids: [],
            allow_space_admins: false,
            allow_local_provider_egress: true,
            allow_external_model_egress: false,
          },
          policy_json: {
            schema_version: 1,
            source_egress_class: "local_provider_allowed",
          },
        }),
        sourceConnection({ id: "source-external" }),
      ],
    });

    const result = await collector(db).fetchCandidates(request);

    expect(result.items.map((i) => i.item_id)).toEqual(["k-external"]);
  });

  it("applies the space external egress switch to non-source chat candidates", async () => {
    const db = new FakeDb({
      policy: [{ context_policy_json: { sources: ["memory"] } }],
      memory_entries: [memoryRow({ id: "m1", owner_user_id: "user-1" })],
      settings: [{ settings_json: { external_egress_enabled: false } }],
    });

    const result = await collector(db).fetchCandidates(request);

    expect(result.items).toEqual([]);
  });

  it("applies the space external egress switch to source-backed chat candidates", async () => {
    const db = new FakeDb({
      policy: [{ context_policy_json: { sources: ["source"] } }],
      sources: [
        {
          id: "source-object",
          title: "Source",
          summary: "source summary",
          raw_text: null,
          metadata_json: { source_connection_id: "source-external" },
        },
      ],
      source_connections: [sourceConnection({ id: "source-external" })],
      settings: [{ settings_json: { external_egress_enabled: false } }],
    });

    const result = await collector(db).fetchCandidates(request);

    expect(result.items).toEqual([]);
  });

  it("marks context_policy_applied false when no current version resolves", async () => {
    const db = new FakeDb({ policy: [] });
    const result = await collector(db).fetchCandidates(request);
    expect(result.context_policy_applied).toBe(false);
  });
});
