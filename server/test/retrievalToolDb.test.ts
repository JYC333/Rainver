import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { RetrievalProjectionService, RetrievalSearchService } from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";
import { RetrievalToolService } from "../src/modules/retrieval/tool/service";
import { enforceRetrievalToolCallPolicy } from "../src/modules/retrieval/tool/policy";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

// W10 agent-space-controlled retrieval tool surface. A managed run calls retrieval
// through RetrievalToolService, which forces the viewer to the run's INSTRUCTING
// USER (the agent cannot widen its own access). Policy enforcement and the audit
// write happen one layer up, at the SystemActionGateway dispatch step (action
// authority consolidation plan, D6/D7) — RetrievalToolService itself performs no
// enforcement of its own, matching every other domain service the gateway calls.
// The audit-behavior tests below call enforceRetrievalToolCallPolicy directly,
// mirroring that real two-step production order (gateway enforces, then the
// executor runs), since RetrievalToolService no longer does both internally.

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let dbUrl = "";
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    dbUrl = container.getConnectionUri();
    pool = new Pool({ connectionString: dbUrl, max: 3 });
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[retrieval-tool-db] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "policy_decision_records", "users", "spaces"],
    { cascade: true },
  );
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Tool', 'team', now(), now())`, [SPACE]);
  for (const id of [USER_A, USER_B]) {
    await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'U', 'active', now(), now())`, [id]);
  }
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('tool-user-a', $1, $2, 'owner', 'active', now(), now()),
            ('tool-user-b', $1, $3, 'member', 'active', now(), now())`,
    [SPACE, USER_A, USER_B],
  );
});

async function seed(doc: { id: string; title: string; content: string; visibility?: string; owner?: string | null }): Promise<void> {
  await insertKnowledgeItem(pool!, {
    id: doc.id,
    spaceId: SPACE,
    title: doc.title,
    content: doc.content,
    slug: doc.id,
    visibility: doc.visibility ?? "space_shared",
    ownerUserId: doc.owner ?? null,
    createdByUserId: doc.owner ?? null,
  });
}

function toolService(): RetrievalToolService {
  return new RetrievalToolService(new RetrievalSearchService(pool!, knowledgeRetrievalRegistry));
}

describe("Retrieval tool surface (real Postgres)", () => {
  it("searches under the instructing user's visibility — an agent cannot exceed it", async () => {
    if (!available || !pool) return;
    await seed({ id: "shared", title: "Quarterly widget plan", content: "The widget rollout plan is shared." });
    // Private, owned by USER_B: USER_A (and an agent acting for USER_A) must not see it.
    await seed({ id: "b-private", title: "Secret widget memo", content: "The secret widget memo about pricing.", visibility: "private", owner: USER_B });
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const res = await toolService().toolSearch(
      { spaceId: SPACE, instructedByUserId: USER_A, agentId: AGENT, runId: RUN },
      { query: "widget", mode: "lexical", maxResults: 10 },
    );
    const ids = res.items.map((i) => i.object_id);
    expect(ids).toContain("shared");
    expect(ids).not.toContain("b-private"); // agent for USER_A cannot read USER_B's private item
  });

  it("audits the tool call as the agent/run actor with pointer metadata only", async () => {
    if (!available || !pool) return;
    await seed({ id: "shared", title: "Widget plan", content: "Shared widget plan." });
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const actor = { spaceId: SPACE, instructedByUserId: USER_A, agentId: AGENT, runId: RUN };
    const params = { query: "widget", mode: "lexical" as const, maxResults: 10 };
    await enforceRetrievalToolCallPolicy({
      databaseUrl: dbUrl,
      actor,
      action: "retrieval.search",
      domain: "knowledge",
      domainEnabled: true,
      mode: params.mode,
      maxResults: params.maxResults,
      surface: "managed_run",
    });
    await toolService().toolSearch(actor, params);

    const audit = await pool.query<{
      actor_type: string; actor_id: string; action: string; run_id: string | null; metadata_json: Record<string, unknown>;
    }>(
      `SELECT actor_type, actor_id, action, run_id, metadata_json
         FROM policy_decision_records WHERE action = 'retrieval.search'`,
    );
    expect(audit.rows).toHaveLength(1);
    const row = audit.rows[0]!;
    expect(row.actor_type).toBe("agent");
    expect(row.actor_id).toBe(AGENT);
    expect(row.action).toBe("retrieval.search");
    expect(row.run_id).toBe(RUN);
    expect(row.metadata_json.domain).toBe("knowledge");
    expect(row.metadata_json.mode).toBe("lexical");
    // Pointer/aggregate metadata only — never the query text or content.
    expect(JSON.stringify(row.metadata_json)).not.toContain("widget");
  });

  it("builds a deterministic-only brief through the tool (no synthesizer) and audits it", async () => {
    if (!available || !pool) return;
    await seed({ id: "shared", title: "Widget plan", content: "Shared widget plan with sufficient content to not be thin enough here." });
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const actor = { spaceId: SPACE, instructedByUserId: USER_A, agentId: AGENT, runId: RUN };
    const params = { query: "widget", mode: "lexical" as const, maxResults: 10 };
    await enforceRetrievalToolCallPolicy({
      databaseUrl: dbUrl,
      actor,
      action: "retrieval.brief",
      domain: "knowledge",
      domainEnabled: true,
      mode: params.mode,
      maxResults: params.maxResults,
      surface: "managed_run",
    });
    const res = await toolService().toolBrief(actor, params);
    expect(res.brief.synthesized).toBe(false); // no synthesizer wired
    expect(res.items.map((i) => i.object_id)).toContain("shared");

    const audit = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM policy_decision_records WHERE action = 'retrieval.brief'`,
    );
    expect(audit.rows[0]!.n).toBe("1");
  });
});
