import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { getDbPool } from "../src/db/pool";
import { buildServer } from "../src/server";
import { __setAuthIdentityForTests } from "../src/modules/auth";

vi.mock("../src/db/pool", () => ({
  getDbPool: vi.fn(),
}));

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
});

afterEach(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

describe("context routes", () => {
  it("returns a schema-validated context package with requested artifact attachments", async () => {
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      const norm = sql.replace(/\s+/g, " ").trim();
      if (/FROM artifacts/.test(norm)) {
        return {
          rows: [
            {
              id: "brief-1",
              artifact_type: "retrieval_brief",
              title: "Context Brief",
              content: JSON.stringify({ raw: "not copied" }),
              metadata_json: {
                kind: "retrieval_brief",
                surface: "knowledge_brief",
                answer: "Use the visible cited answer.",
              },
              visibility: "private",
              owner_user_id: params[2],
              project_id: null,
              project_folder_id: null,
              created_at: "2026-06-25T00:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/context/build",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        query: "alpha",
        context_artifact_ids: ["brief-1"],
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({
      attachment_type: "artifact_evidence_pack",
      artifact_id: "brief-1",
      approved: true,
      policy_snapshot: {
        content_mode: "bounded_summary",
        raw_artifact_content_included: false,
      },
    });
    expect(body.attachments[0].resolved_content).toContain("Answer: Use the visible cited answer.");
    expect(body.attachments[0].resolved_content).not.toContain("not copied");
    expect(body.retrieval_trace.artifact_attachment).toMatchObject({
      requested_count: 1,
      attached_count: 1,
      blocked_count: 0,
    });
  });

  it("rejects overlarge context artifact attachment lists before retrieval", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/context/build",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        context_artifact_ids: Array.from({ length: 9 }, (_, index) => `artifact-${index}`),
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ detail: "context_artifact_ids must contain at most 8 items" });
    expect(query).not.toHaveBeenCalled();
  });

  it("lists, creates, and deletes workspace-scoped context artifact revocations", async () => {
    const query = vi.fn(async (sql: string) => {
      const norm = sql.replace(/\s+/g, " ").trim();
      if (/INSERT INTO context_artifact_revocations/.test(norm)) {
        return {
          rows: [
            {
              id: "revocation-1",
              space_id: "space-1",
              artifact_id: "brief-1",
              scope_type: "project_folder",
              scope_id: "workspace-1",
              reason: "superseded",
              created_by_user_id: "user-1",
              created_at: "2026-06-26T00:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      }
      if (/UPDATE context_artifact_revocations/.test(norm)) {
        return { rows: [], rowCount: 1 };
      }
      if (/FROM context_artifact_revocations/.test(norm)) {
        return {
          rows: [
            {
              id: "revocation-1",
              space_id: "space-1",
              artifact_id: "brief-1",
              scope_type: "project_folder",
              scope_id: "workspace-1",
              reason: "superseded",
              created_by_user_id: "user-1",
              created_at: "2026-06-26T00:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM project_folders w\b/.test(norm)) {
        return { rows: [{ one: 1 }], rowCount: 1 };
      }
      if (/FROM artifacts/.test(norm)) {
        return {
          rows: [
            {
              id: "brief-1",
              artifact_type: "retrieval_brief",
              title: "Context Brief",
              content: null,
              metadata_json: {
                kind: "retrieval_brief",
                answer: "Use the visible cited answer.",
              },
              visibility: "private",
              owner_user_id: "user-1",
              project_id: null,
              project_folder_id: "workspace-1",
              created_at: "2026-06-25T00:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildServer(config(), { logger: false });

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/context/artifact-revocations",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        artifact_id: "brief-1",
        scope_type: "project_folder",
        scope_id: "workspace-1",
        reason: "superseded",
      }),
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({
      artifact_id: "brief-1",
      scope_type: "project_folder",
      scope_id: "workspace-1",
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/context/artifact-revocations?project_folder_id=workspace-1&artifact_ids=brief-1",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);

    const remove = await app.inject({
      method: "DELETE",
      url: "/api/v1/context/artifact-revocations/brief-1?scope_type=project_folder&scope_id=workspace-1",
    });
    expect(remove.statusCode).toBe(204);
  });
});
