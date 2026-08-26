import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CliCredentialBroker } from "../src/modules/providers/cli/credentialBroker.js";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common.js";
import { resolveUsageAttribution } from "../src/modules/usage/attribution.js";
import { CliHistoryImportService } from "../src/modules/usage/cliHistoryImport.js";
import type { PgUsageRepository, UsageImportBatchRecord } from "../src/modules/usage/repository.js";
import type { NormalizedUsageObservation, UsageObservation } from "../src/modules/usage/types.js";

describe("usageAttribution", () => {
  class AttributionDb implements Queryable {
    readonly calls: Array<{ sql: string; params?: readonly unknown[] }> = [];

    constructor(
      private readonly handler: (sql: string, params?: readonly unknown[]) => QueryResult<unknown>,
    ) {}

    async query<Row = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      this.calls.push({ sql, params });
      return this.handler(sql, params) as QueryResult<Row>;
    }
  }

  function observation(overrides: Partial<UsageObservation> = {}): UsageObservation {
    return {
      space_id: "space-1",
      event_type: "llm.generation",
      source_type: "local_run",
      execution_channel: "managed_api",
      ...overrides,
    };
  }

  describe("usage attribution", () => {
    it("attributes a direct user call as private after active membership validation", async () => {
      const db = new AttributionDb((sql) => {
        if (sql.includes("FROM space_memberships")) return { rows: [{ one: 1 }], rowCount: 1 };
        throw new Error(`unexpected query: ${sql}`);
      });

      const result = await resolveUsageAttribution(db, observation({ subject_user_id: "user-1" }));

      expect(result).toEqual({
        owner_user_id: "user-1",
        visibility: "private",
        access_level: "full",
        source_resource_type: null,
        source_resource_id: null,
        project_folder_id: null,
        project_id: null,
        grant_snapshots: [],
      });
      expect(db.calls[0]?.params).toEqual(["space-1", "user-1"]);
    });

    it("snapshots owner, scope, policy, and active selected-user grants from a Run", async () => {
      const db = new AttributionDb((sql, params) => {
        if (sql.includes("FROM runs usage_source")) {
          expect(params).toEqual(["space-1", "run-1"]);
          return {
            rows: [{
              owner_user_id: "owner-1",
              visibility: "selected_users",
              access_level: "summary",
              project_folder_id: "workspace-1",
              project_id: "project-1",
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM content_access_grants")) {
          return {
            rows: [{
              grantee_user_id: "member-2",
              granted_by_user_id: "owner-1",
              access_level: "full",
            }],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      });

      const result = await resolveUsageAttribution(db, observation({ run_id: "run-1" }));

      expect(result).toMatchObject({
        owner_user_id: "owner-1",
        visibility: "selected_users",
        access_level: "summary",
        source_resource_type: "run",
        source_resource_id: "run-1",
        project_folder_id: "workspace-1",
        project_id: "project-1",
        grant_snapshots: [{
          user_id: "member-2",
          granted_by_user_id: "owner-1",
          access_level: "full",
        }],
      });
      expect(result.grant_snapshots[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("rejects ownerless sources unless the caller marks an explicit shared Space system task", async () => {
      const db = new AttributionDb((sql) => {
        if (sql.includes("FROM runs usage_source")) {
          return {
            rows: [{
              owner_user_id: null,
              visibility: "space_shared",
              access_level: "full",
              project_folder_id: null,
              project_id: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM content_access_grants")) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected query: ${sql}`);
      });

      await expect(resolveUsageAttribution(db, observation({ run_id: "run-1" })))
        .rejects.toMatchObject({ statusCode: 422 });
      await expect(resolveUsageAttribution(db, observation({
        run_id: "run-1",
        space_system_task: true,
      }))).resolves.toMatchObject({
        owner_user_id: null,
        visibility: "space_shared",
        source_resource_type: "run",
        source_resource_id: "run-1",
      });
    });

    it("snapshots disclosure-upgrade grants for a space_shared source too", async () => {
      const db = new AttributionDb((sql, params) => {
        if (sql.includes("FROM runs usage_source")) {
          return {
            rows: [{
              owner_user_id: "owner-1",
              visibility: "space_shared",
              access_level: "summary",
              project_folder_id: null,
              project_id: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM content_access_grants")) {
          expect(params).toEqual(["space-1", "run", "run-1"]);
          return {
            rows: [{
              grantee_user_id: "member-2",
              granted_by_user_id: "owner-1",
              access_level: "full",
            }],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      });

      const result = await resolveUsageAttribution(db, observation({ run_id: "run-1" }));

      expect(result).toMatchObject({
        owner_user_id: "owner-1",
        visibility: "space_shared",
        access_level: "summary",
        grant_snapshots: [{
          user_id: "member-2",
          granted_by_user_id: "owner-1",
          access_level: "full",
        }],
      });
    });

    it("fails before writing when no owner or explicit system attribution exists", async () => {
      const db = new AttributionDb(() => {
        throw new Error("database should not be queried");
      });

      await expect(resolveUsageAttribution(db, observation()))
        .rejects.toMatchObject({ statusCode: 422 });
      expect(db.calls).toHaveLength(0);
    });
  });
});

describe("usageCliHistoryImport", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function config() {
    return loadConfig({
      SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    });
  }

  function assistantLine(): string {
    return JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-14T10:00:00.000Z",
      requestId: "req-1",
      message: {
        id: "msg-1",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: "SECRET_COMPLETION_TEXT",
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 10,
        },
      },
    });
  }

  function fakeRepository(appended: NormalizedUsageObservation[]): PgUsageRepository {
    let batch: UsageImportBatchRecord | null = null;
    return {
      async getOrCreateInstanceId() {
        return "instance-1";
      },
      async countExistingIdempotencyKeys() {
        return 0;
      },
      async createImportBatch(input: {
        instanceId: string;
        targetSpaceId: string;
        ownerUserId: string;
        sourceType: string;
        sourceKind: string;
        sourceFingerprint: string;
        previewSummary: Record<string, unknown>;
      }) {
        batch = {
          id: "batch-1",
          instance_id: input.instanceId,
          target_space_id: input.targetSpaceId,
          owner_user_id: input.ownerUserId,
          source_type: input.sourceType,
          source_kind: input.sourceKind,
          status: "previewed",
          started_at: null,
          completed_at: null,
          source_fingerprint: input.sourceFingerprint,
          preview_summary_json: input.previewSummary,
          import_summary_json: {},
          error_json: null,
          created_at: "2026-06-14T10:00:00.000Z",
          updated_at: "2026-06-14T10:00:00.000Z",
        };
        return batch;
      },
      async getImportBatch(id: string, targetSpaceId: string) {
        if (!batch) return null;
        return batch.id === id && batch.target_space_id === targetSpaceId ? batch : null;
      },
      async markImportBatchImporting() {
        if (batch) batch.status = "importing";
      },
      async appendEvent(event: NormalizedUsageObservation) {
        appended.push(event);
        return {} as never;
      },
      async completeImportBatch(id: string, summary: Record<string, unknown>) {
        if (!batch || batch.id !== id) throw new Error("missing batch");
        batch.status = "completed";
        batch.completed_at = "2026-06-14T10:00:01.000Z";
        batch.import_summary_json = summary;
        return batch;
      },
      async failImportBatch() {
        throw new Error("unexpected failure");
      },
    } as unknown as PgUsageRepository;
  }

  function fakeBroker(profileDir: string): CliCredentialBroker {
    return {
      async resolveProfile(runtime: string, profileId?: string | null) {
        expect(runtime).toBe("claude_code");
        expect(profileId).toBe("profile-1");
        return {
          id: "profile-1",
          runtime: "claude_code",
          name: "Claude Main",
          source_path: profileDir,
          target_path: "/home/agent/.claude",
          readonly: true,
          notes: "",
          network_profile_id: null,
        };
      },
    } as unknown as CliCredentialBroker;
  }

  describe("CliHistoryImportService", () => {
    it("rejects imports into a Space outside the active identity", async () => {
      const service = new CliHistoryImportService(
        config(),
        fakeRepository([]),
        {} as CliCredentialBroker,
      );

      await expect(service.preview(
        { spaceId: "space-1", userId: "user-1" },
        {
          runtime: "claude_code",
          sourceKind: "managed_profile",
          targetSpaceId: "space-2",
        },
      )).rejects.toMatchObject({ statusCode: 403 });
    });

    it("previews and commits managed Claude transcript usage as lower-bound ledger events", async () => {
      tempDir = await mkdtemp(join(tmpdir(), "aspace-cli-import-"));
      const project = join(tempDir, "projects", "demo");
      await mkdir(project, { recursive: true });
      await writeFile(join(project, "session.jsonl"), assistantLine());

      const appended: NormalizedUsageObservation[] = [];
      const service = new CliHistoryImportService(
        config(),
        fakeRepository(appended),
        fakeBroker(tempDir),
      );

      const preview = await service.preview(
        { spaceId: "space-1", userId: "user-1" },
        {
          runtime: "claude_code",
          sourceKind: "managed_profile",
          credentialProfileId: "profile-1",
        },
      );

      expect(preview).toMatchObject({
        import_batch_id: "batch-1",
        status: "previewed",
        detected_runtime: "claude_code",
        source_kind: "managed_profile",
        credential_profile_id: "profile-1",
        candidate_event_count: 1,
        duplicate_count: 0,
        totals: {
          event_count: 1,
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 10,
          total_tokens: 135,
        },
      });
      expect(JSON.stringify(preview)).not.toContain("SECRET_COMPLETION_TEXT");

      const committed = await service.commit(
        { spaceId: "space-1", userId: "user-1" },
        { importBatchId: "batch-1", confirmation: true },
      );

      expect(committed).toMatchObject({
        import_batch_id: "batch-1",
        status: "completed",
        imported_event_count: 1,
        candidate_event_count: 1,
      });
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({
        instance_id: "instance-1",
        space_id: "space-1",
        event_type: "cli.history_usage",
        source_type: "cli_history_import",
        execution_channel: "local_cli_transcript",
        meter_subject_type: "session",
        subject_user_id: "user-1",
        adapter_type: "claude_code",
        vendor: "anthropic",
        model: "claude-sonnet-4-6",
        external_session_id: expect.stringMatching(/^claude_code:/),
        session_path: "projects/demo/session.jsonl",
        input_tokens: 100,
        output_tokens: 25,
        cache_read_input_tokens: 10,
        total_tokens: 135,
        usage_accuracy: "transcript_lower_bound",
        import_batch_id: "batch-1",
        dimensions_json: expect.objectContaining({
          runtime: "claude_code",
          source_kind: "managed_profile",
          credential_profile_id: "profile-1",
        }),
      });
      expect(JSON.stringify(appended[0])).not.toContain("SECRET_COMPLETION_TEXT");
    });
  });
});
