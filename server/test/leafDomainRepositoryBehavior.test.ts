import { describe, expect, it } from "vitest";
import { PgActivityConsolidationRepository } from "../src/modules/activity/consolidationRepository.js";
import { PgActivityRepository } from "../src/modules/activity/repository.js";
import { PgSourcesRepository } from "../src/modules/sources/repository.js";
import { ProjectSourceBindingService } from "../src/modules/projects/projectSourceBindingService.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import type { ServerConfig } from "../src/config.js";
import type { SpaceUserIdentity, Queryable } from "../src/modules/routeUtils/common.js";
import { handleSourceRetrievalTestSql } from "./support/sourceRetrievalTestSql.js";

function sourcesConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 8010,
    logLevel: "silent",
    requestTimeoutMs: 1000,
    catalogRoot: "/tmp/catalog",
    runEventStreamPollIntervalMs: 1000,
    runEventStreamPageLimit: 100,
    enableNotificationWebhookEgress: false,
    notificationWebhookAllowlist: [],
    notificationMaxPayloadBytes: 64 * 1024,
    databaseUrl: null,
    rainverHome: "/tmp/rainver",
    workspaceRoot: "/tmp/rainver/workspaces",
    cliToolsRoot: "/tmp/rainver/runtime-tools",
    cliSandboxImage: "rainver-sandbox",
    sandboxRunnerHost: "sandbox-runner",
    sandboxRunnerPort: 8020,
    sandboxRunnerServerHost: "server",
    sandboxRoot: "/tmp/rainver/sandboxes",
    deployerSocketPath: "/tmp/rainver/run/deployer.sock",
    artifactStorageRoot: "/tmp/rainver/storage/artifacts",
    internalToken: null,
    instanceAdminEmail: null,
    googleClientId: "",
    googleClientSecret: "",
    googleRedirectUri: "",
    frontendUrl: "http://localhost:5173",
    sessionExpireDays: 30,
    debug: true,
    dailyReportSchedulerEnabled: true,
    dailyReportSchedulerIntervalSeconds: 60,
    automationSchedulerEnabled: true,
    automationSchedulerIntervalSeconds: 60,
    contentAccessLogRetentionEnabled: true,
    contentAccessLogRetentionDays: 90,
    contentAccessLogPruneIntervalSeconds: 3600,
    memoryMaintenanceSchedulerEnabled: true,
    memoryMaintenanceSchedulerIntervalSeconds: 900,
    memoryMaintenanceSchedulerBatchLimit: 5,
    sourceExtractionSchedulerEnabled: true,
    sourceExtractionSchedulerIntervalSeconds: 30,
    retrievalRerankEnabled: false,
    retrievalQueryRewriteEnabled: false,
    rainverEnv: "",
    appVersion: null,
    customSourceAllowedLanguages: ["typescript_node"],
    customSourceNetworkHardDenyRules: [],
    customSourceTimeoutMsMax: 30_000,
    customSourceOutputBytesMax: 1_048_576,
    customSourceLogBytesMax: 65_536,
    customSourceMaxFiles: 50,
    customSourceBrowserAutomationAvailable: false,
    customSourceShellAvailable: false,
    customSourceDependencyInstallationAvailable: false,
    customSourceGenerateRateLimitPerHour: 30,
    customSourceArtifactRetentionEnabled: true,
    customSourceArtifactRetentionDays: 30,
    customSourceArtifactRetentionIntervalSeconds: 3600,
    backupEnabled: false,
    backupIntervalHours: 24,
    backupRetentionCount: 7,
    backupIncludeLogs: false,
    backupOnStartup: true,
    backupRoot: "/tmp/backups",
    backupAcceptNoBackup: false,
    backupDatabaseUrl: null,
    providerProxyPort: 0,
    providerProxyExternalBaseUrl: null,
  };
}


class FakeDb implements Queryable {
  constructor(private readonly handler: (sql: string, params: readonly unknown[]) => unknown[]) {}

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const retrievalResult = handleSourceRetrievalTestSql<Row>(sql, params);
    if (retrievalResult) return retrievalResult;
    if (sql.includes("FROM scheduler_tasks")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    return { rows: this.handler(sql, params) as Row[], rowCount: null };
  }
}

const identity: SpaceUserIdentity = { spaceId: "space-1", userId: "user-1" };

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "activity-1",
    space_id: "space-1",
    source_run_id: null,
    session_id: null,
    user_id: "user-1",
    project_folder_id: null,
    agent_id: null,
    source_task_id: null,
    project_id: null,
    source_url: null,
    activity_type: "user_capture",
    title: "Captured note",
    content: "Remember the sourced activity.",
    payload_json: {},
    occurred_at: "2026-06-16T00:00:00.000Z",
    created_at: "2026-06-16T00:00:00.000Z",
    status: "raw",
    updated_at: "2026-06-16T00:00:00.000Z",
    source_kind: "user_capture",
    source_trust: "user_confirmed",
    source_integrity_json: null,
    entity_refs_json: null,
    subject_user_id: "user-1",
    owner_user_id: "user-1",
    visibility: "space_shared",
    processed_at: null,
    discarded_at: null,
    aggregate_key: null,
    ...overrides,
  };
}

// Positions match insertProposalRow's INSERT column order
// (server/src/modules/proposals/reviewPackets.ts): id, space_id,
// created_by_run_id, proposal_type, status, risk_level, urgency, preview,
// title, summary, payload_json, created_at, project_folder_id, rationale,
// created_by_user_id, visibility, project_id, created_by_agent_id,
// required_approver_role.
function proposalRow(params: readonly unknown[]) {
  return {
    id: String(params[0] ?? "proposal-1"),
    space_id: String(params[1] ?? "space-1"),
    created_by_run_id: typeof params[2] === "string" ? params[2] : null,
    proposal_type: String(params[3] ?? "memory_create"),
    status: typeof params[4] === "string" ? params[4] : "pending",
    risk_level: typeof params[5] === "string" ? params[5] : "low",
    urgency: typeof params[6] === "string" ? params[6] : "normal",
    preview: Boolean(params[7] ?? false),
    title: String(params[8] ?? "Proposal"),
    payload_json: JSON.parse(String(params[10] ?? "{}")) as Record<string, unknown>,
    rationale: String(params[13] ?? ""),
    visibility: typeof params[15] === "string" ? params[15] : "space_shared",
    review_deadline: null,
    expires_at: null,
    created_at: String(params[11] ?? "2026-06-16T00:00:00.000Z"),
    reviewed_at: null,
    project_folder_id: typeof params[12] === "string" ? params[12] : null,
    created_by_user_id: typeof params[14] === "string" ? params[14] : "user-1",
    project_id: typeof params[16] === "string" ? params[16] : null,
    egress_approval_id: null,
    egress_approval_status: null,
  };
}

function noteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "note-1",
    space_id: "space-1",
    title: "Project note",
    content_json: {},
    content_format: "plain",
    content_schema_version: 1,
    plain_text: "Project note body",
    excerpt: "Project note body",
    status: "active",
    primary_project_id: null,
    collection_id: "collection-1",
    created_from_activity_id: null,
    created_by_user_id: "user-1",
    created_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
    archived_at: null,
    deleted_at: null,
    ...overrides,
  };
}

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "claim-1",
    space_id: "space-1",
    subject_object_id: null,
    subject_text: "Retrieval",
    claim_kind: "fact",
    claim_text: "The retrieval default embedding dimension is 2560.",
    normalized_claim_hash: "hash-1",
    holder_object_id: null,
    holder_type: null,
    holder_id: null,
    confidence: 0.9,
    confidence_method: "human_confirmed",
    resolution_state: "confirmed",
    valid_from: null,
    valid_until: null,
    observed_at: null,
    metadata_json: {},
    status: "active",
    visibility: "space_shared",
    title: "Retrieval embedding dimension",
    excerpt: null,
    owner_user_id: "user-1",
    primary_project_id: null,
    project_folder_id: null,
    created_by_user_id: "user-1",
    created_by_agent_id: null,
    created_by_run_id: null,
    created_from_proposal_id: null,
    approved_by_user_id: null,
    created_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

function objectRelationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "object-relation-1",
    space_id: "space-1",
    from_object_id: "claim-1",
    from_object_type: "claim",
    to_object_id: "claim-2",
    to_object_type: "claim",
    link_type: "supports",
    status: "active",
    confidence: 0.8,
    evidence_summary: null,
    source_claim_id: "claim-source-1",
    source_object_id: "source-1",
    source_proposal_id: null,
    metadata_json: {},
    created_by_user_id: "user-1",
    created_by_agent_id: null,
    created_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function sourceItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    title: "Item",
    excerpt: "Item excerpt",
    source_uri: "https://example.test/i",
    content_state: "metadata_only",
    connection_id: null,
    ...overrides,
  };
}

function sourceConnectionRow(policyOverrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    space_id: "space-1",
    connector_id: "connector-1",
    owner_user_id: "user-1",
    credential_id: null,
    visibility: "space_shared",
    name: "Source",
    endpoint_url: "https://example.test/feed",
    status: "active",
    fetch_frequency: "manual",
    capture_policy: "reference_only",
    trust_level: "normal",
    topic_hints_json: null,
    consent_json: {},
    policy_json: {
      schema_version: 1,
      source_egress_class: "internal_only",
      retention_policy: "summary_only",
      import_trust_level: "normal",
      derived_write_policy: "proposal_required",
      allowed_import_targets: ["activity", "source_artifact"],
      revalidation: { required: true, viewer_scoped: true },
      ...policyOverrides,
    },
    config_json: {},
    last_checked_at: null,
    next_check_at: null,
    handler_kind: "built_in",
    connector_type: "external_feed",
    connector_key: "rss",
    active_handler_version_id: null,
    active_recipe_version_id: null,
    repair_status: "ok",
    last_handler_run_id: null,
    created_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
  };
}

function extractionJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    space_id: "space-1",
    connection_id: null,
    source_item_id: "item-1",
    source_snapshot_id: null,
    source_object_type: null,
    source_object_id: null,
    job_type: "extract_text",
    status: "pending",
    started_at: null,
    completed_at: null,
    items_seen: null,
    items_created: null,
    items_updated: null,
    error_code: null,
    error_message: null,
    metadata_json: {},
    created_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function projectSourceBindingRow(params: readonly unknown[]) {
  return {
    id: String(params[0] ?? "binding-1"),
    space_id: String(params[1] ?? "space-1"),
    project_id: String(params[2] ?? "project-1"),
    source_channel_id: String(params[3] ?? "channel-1"),
    binding_key: String(params[4] ?? "default"),
    status: "active",
    priority: Number(params[5] ?? 0),
    delivery_scope: String(params[6] ?? "project_members"),
    collection_notifications_enabled: typeof params[7] === "boolean" ? params[7] : true,
    standing_comparison_enabled: typeof params[8] === "boolean" ? params[8] : false,
    filters_json: JSON.parse(String(params[9] ?? "{}")) as Record<string, unknown>,
    routing_policy_json: JSON.parse(String(params[10] ?? "{}")) as Record<string, unknown>,
    extraction_policy_json: JSON.parse(String(params[11] ?? "{}")) as Record<string, unknown>,
    created_by_user_id: typeof params[12] === "string" ? params[12] : null,
    created_at: String(params[13] ?? "2026-06-16T00:00:00.000Z"),
    updated_at: String(params[13] ?? "2026-06-16T00:00:00.000Z"),
  };
}

describe("Leaf domain repository behavior", () => {
  it("project source item list reads materialized project item links", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = new FakeDb((sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM projects")) return [{ id: "project-1", owner_user_id: "user-1", status: "active" }];
      if (sql.includes("FROM spaces")) return [{ type: "personal" }];
      if (sql.includes("count(*)::text AS total")) return [{ total: "0" }];
      if (sql.includes("FROM project_source_item_links")) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await new PgSourcesRepository(db, sourcesConfig()).listProjectItems(identity, {
      projectId: "project-1",
      sourceChannelId: null,
      itemType: null,
      sourceDomain: null,
      matchedDate: null,
      createdAfter: null,
      occurredAfter: null,
      q: null,
      limit: 20,
      offset: 0,
    });

    const listSql = calls.find((call) => call.sql.includes("FROM project_source_item_links") && call.sql.includes("ORDER BY"));
    expect(listSql?.sql).toContain("JOIN project_source_bindings psb");
    expect(listSql?.sql).toContain("psb.delivery_scope = 'project_members'");
    expect(listSql?.sql).not.toContain(`workspace_${"source"}_bindings`);
  });

  it("source item library type filters use soft content classification", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = new FakeDb((sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("count(*)::text AS total")) return [{ total: "0" }];
      if (sql.includes("FROM source_items")) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await new PgSourcesRepository(db, sourcesConfig()).listItems(identity, {
      libraryStatus: null,
      readStatus: null,
      contentState: null,
      connectionId: null,
      itemType: null,
      libraryType: "pdf",
      sourceDomain: null,
      createdAfter: null,
      occurredAfter: null,
      q: null,
      limit: 20,
      offset: 0,
    });

    const listSql = calls.find((call) => call.sql.includes("FROM source_items") && call.sql.includes("ORDER BY"));
    expect(listSql?.sql).toContain("metadata_json->>'library_type'");
    expect(listSql?.sql).toContain("metadata_json->>'content_type'");
    expect(listSql?.sql).toContain("\\.pdf($|[?#])");
  });

  it("source item podcast type filters use soft content classification", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = new FakeDb((sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("count(*)::text AS total")) return [{ total: "0" }];
      if (sql.includes("FROM source_items")) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await new PgSourcesRepository(db, sourcesConfig()).listItems(identity, {
      libraryStatus: null,
      readStatus: null,
      contentState: null,
      connectionId: null,
      itemType: null,
      libraryType: "podcast",
      sourceDomain: null,
      createdAfter: null,
      occurredAfter: null,
      q: null,
      limit: 20,
      offset: 0,
    });

    const listSql = calls.find((call) => call.sql.includes("FROM source_items") && call.sql.includes("ORDER BY"));
    expect(listSql?.sql).toContain("metadata_json->>'library_type'");
    expect(listSql?.sql).toContain("LIKE 'audio/%'");
    expect(listSql?.sql).toContain("podcasts.apple.com");
  });

  it("captures raw input as an activity record", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("INSERT INTO activity_records")) return [activityRow()];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new PgActivityRepository(db).create(identity, {
      source_type: "user_capture",
      title: "Captured note",
      content: "Remember the sourced activity.",
    });

    expect(out).toMatchObject({ id: "activity-1", status: "raw" });
  });

  it("consolidates activity into a pending memory proposal with inherited visibility and provenance", async () => {
    const db = new FakeDb((sql, params) => {
      if (sql.includes("FROM activity_records")) return [activityRow({ visibility: "private" })];
      if (sql.includes("FROM retrieval_aliases")) return [];
      if (sql.includes("FROM retrieval_chunks")) return [];
      if (sql.includes("INSERT INTO proposals")) return [proposalRow(params)];
      if (sql.includes("UPDATE activity_records")) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const proposals = await new PgActivityRepository(db).consolidate(identity, "activity-1");

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      proposal_type: "memory_create",
      status: "pending",
      visibility: "private",
    });
    expect(proposals[0].provenance_entries).toEqual([
      expect.objectContaining({
        source_type: "activity",
        source_id: "activity-1",
        source_trust: "user_confirmed",
      }),
    ]);
  });

  it("rejects direct consolidation for Activity pointer records", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM activity_records")) {
        return [activityRow({ aggregate_key: "source:briefing:source-1:2026-07-08" })];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(
      new PgActivityRepository(db).consolidate(identity, "activity-1"),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("excludes Activity pointer records from batch consolidation selection", async () => {
    let selectSql = "";
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM activity_records")) {
        selectSql = sql;
        return [];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await new PgActivityConsolidationRepository(db).runPending({
      spaceId: "space-1",
      actingUserId: "user-1",
      batchLimit: 20,
      activityIds: null,
    });

    expect(selectSql).toContain("aggregate_key IS NULL");
  });

  it("pre-dedupes activity consolidation against visible memory", async () => {
    let proposalInsertCount = 0;
    let activityUpdateSql = "";
    let activityUpdateParams: readonly unknown[] | null = null;
    const db = new FakeDb((sql, params) => {
      if (sql.includes("FROM activity_records")) return [activityRow()];
      if (sql.includes("FROM retrieval_aliases")) return [];
      if (sql.includes("FROM retrieval_chunks")) {
        return [{
          object_type: "memory_entry",
          object_id: "memory-1",
          object_profile: "experience",
          object_profile_label: null,
          title: "Existing memory",
          source_connection_ids_json: [],
          snippet: "Remember the sourced activity.",
          matched_text: "Remember the sourced activity.",
          matched_field: "plain_text",
          updated_at: "2026-06-16T00:00:00.000Z",
          rank: 1,
        }];
      }
      if (sql.includes("FROM memory_entries")) {
        return [{
          id: "memory-1",
          space_id: "space-1",
          deleted_at: null,
          sensitivity_level: "normal",
          visibility: "space_shared",
          owner_user_id: "user-1",
          scope_type: "user",
          project_folder_id: null,
          access_level: "full",
          project_id: null,
          title: "Existing memory",
          content: "Remember the sourced activity.",
        }];
      }
      if (sql.includes("FROM retrieval_edges")) return [];
      if (sql.includes("INSERT INTO content_access_logs")) return [];
      if (sql.startsWith("UPDATE memory_entries")) return [];
      if (sql.includes("INSERT INTO proposals")) {
        proposalInsertCount += 1;
        return [proposalRow(params)];
      }
      if (sql.includes("UPDATE activity_records")) {
        activityUpdateSql = sql;
        activityUpdateParams = params;
        return [];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const proposals = await new PgActivityRepository(db).consolidate(identity, "activity-1");

    expect(proposals).toEqual([]);
    expect(proposalInsertCount).toBe(0);
    expect(activityUpdateSql).toContain("status = 'processed'");
    expect(activityUpdateParams?.[0]).toBe("activity-1");
  });

  it("creates source summary proposals with evidence and source provenance", async () => {
    const proposalPayloads: Record<string, unknown>[] = [];
    const db = new FakeDb((sql, params) => {
      if (sql.includes("FROM extracted_evidence")) {
        return [{ id: "evidence-1", title: "Evidence", content_excerpt: "Excerpt", source_uri: "https://example.test/e", trust_level: "normal" }];
      }
      if (sql.includes("FROM source_items")) {
        return [{ id: "item-1", title: "Item", excerpt: "Item excerpt", source_uri: "https://example.test/i", content_state: "excerpt_saved" }];
      }
      if (sql.includes("INSERT INTO artifacts")) return [];
      if (sql.includes("INSERT INTO proposals")) {
        proposalPayloads.push(JSON.parse(String(params[10])) as Record<string, unknown>);
        return [{ id: `${params[3]}-proposal` }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new PgSourcesRepository(db, sourcesConfig()).createSummaryRun(identity, {
      evidence_ids: ["evidence-1"],
      source_item_ids: ["item-1"],
      create_memory_proposal: true,
      create_knowledge_proposal: true,
    });

    expect(out).toMatchObject({ status: "succeeded", proposal_ids: ["memory_create-proposal", "knowledge_create-proposal"] });
    expect(proposalPayloads[0]).toMatchObject({
      provenance_entries: [
        { source_type: "artifact", source_trust: "internal_system" },
        { source_type: "extracted_evidence", source_id: "evidence-1", source_trust: "agent_inferred" },
        { source_type: "source_item", source_id: "item-1", source_trust: "untrusted_external" },
      ],
    });
    expect(proposalPayloads[1]).toMatchObject({
      source_refs: [
        { source_type: "artifact", source_trust: "internal_system" },
        { source_type: "extracted_evidence", source_id: "evidence-1", source_trust: "agent_inferred" },
        { source_type: "source_item", source_id: "item-1", source_trust: "untrusted_external" },
      ],
    });
  });

  it("requires project scope when creating project source bindings", async () => {
    const db = new FakeDb(() => {
      throw new Error("no DB call expected");
    });

    expect(() => new ProjectSourceBindingService(db).createBinding(identity, {
      source_channel_id: "channel-1",
    })).toThrow(expect.objectContaining({ statusCode: 422, message: "project_id is required" }));
  });

  it("creates project source bindings after project writer validation", async () => {
    let insertParams: readonly unknown[] | null = null;
    const db = new FakeDb((sql, params) => {
      if (sql.includes("FROM project_source_bindings") && sql.includes("binding_key")) return [];
      if (sql.includes("AS effective_access_level")) return [{ effective_access_level: "full" }];
      if (sql.includes("JOIN source_connections")) return [sourceConnectionRow()];
      if (sql.includes("FROM projects")) return [{ id: "project-1", owner_user_id: "user-1", status: "active" }];
      if (sql.includes("INSERT INTO project_source_bindings")) {
        insertParams = params;
        return [projectSourceBindingRow(params)];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new ProjectSourceBindingService(db).createBinding(identity, {
      project_id: "project-1",
      source_channel_id: "channel-1",
    });

    expect(out).toMatchObject({
      project_id: "project-1",
      source_channel_id: "channel-1",
      delivery_scope: "project_members",
      extraction_policy_json: { profile_key: "generic_document_v1" },
      extraction_profile: { key: "generic_document_v1", entity_type: "document" },
    });
    expect(insertParams?.[2]).toBe("project-1");
    expect(insertParams?.[3]).toBe("channel-1");
  });

  it("rejects an unregistered extraction profile before writing a binding", () => {
    const db = new FakeDb(() => {
      throw new Error("no DB call expected");
    });

    expect(() => new ProjectSourceBindingService(db).createBinding(identity, {
      project_id: "project-1",
      source_channel_id: "channel-1",
      extraction_policy: { profile_key: "missing_profile_v1" },
    })).toThrow(expect.objectContaining({ statusCode: 422, message: "unknown extraction profile: missing_profile_v1" }));
    expect(() => new ProjectSourceBindingService(db).createBinding(identity, {
      project_id: "project-1",
      source_channel_id: "channel-1",
      extraction_policy: { profile_key: 42 },
    })).toThrow(expect.objectContaining({ statusCode: 422, message: "extraction_policy.profile_key must be a non-empty string" }));
  });

  it("restores an archived project source binding instead of creating a duplicate", async () => {
    const calls: string[] = [];
    const archived = { ...projectSourceBindingRow(["binding-1", "space-1", "project-1", "channel-1", "default"]), status: "archived" };
    const db = new FakeDb((sql, params) => {
      calls.push(sql);
      if (sql.includes("AS effective_access_level")) return [{ effective_access_level: "full" }];
      if (sql.includes("JOIN source_connections")) return [sourceConnectionRow()];
      if (sql.includes("FROM projects")) return [{ id: "project-1", owner_user_id: "user-1", status: "active" }];
      if (sql.includes("FROM project_source_bindings") && sql.includes("binding_key")) return [archived];
      if (sql.includes("UPDATE project_source_bindings") && sql.includes("SET status = 'active'")) {
        return [{ ...archived, status: "active", updated_at: String(params[9]) }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new ProjectSourceBindingService(db).createBinding(identity, {
      project_id: "project-1",
      source_channel_id: "channel-1",
    });

    expect(out).toMatchObject({ id: "binding-1", status: "active" });
    expect(calls.some(sql => sql.includes("INSERT INTO project_source_bindings"))).toBe(false);
  });

  it("backfills historical evidence when requested during project source binding creation", async () => {
    let bindingId: string | null = null;
    let backfillParams: readonly unknown[] | null = null;
    const db = new FakeDb((sql, params) => {
      if (sql.includes("FROM project_source_bindings") && sql.includes("binding_key")) return [];
      if (sql.includes("AS effective_access_level")) return [{ effective_access_level: "full" }];
      if (sql.includes("SELECT DISTINCT si.id")) {
        backfillParams = params;
        return [];
      }
      if (sql.includes("INSERT INTO evidence_links")) {
        backfillParams = params;
        return [];
      }
      if (sql.includes("JOIN source_connections")) return [sourceConnectionRow()];
      if (sql.includes("FROM projects")) return [{ id: "project-1", owner_user_id: "user-1", status: "active" }];
      if (sql.includes("INSERT INTO project_source_bindings")) {
        bindingId = String(params[0]);
        return [projectSourceBindingRow(params)];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new ProjectSourceBindingService(db).createBinding(identity, {
      project_id: "project-1",
      source_channel_id: "channel-1",
      backfill_history: true,
    });

    expect(out).toMatchObject({
      backfill_result: {
        project_id: "project-1",
      created_links: 0,
        evidence_links: 0,
      },
    });
    expect(backfillParams?.[0]).toBe("space-1");
    expect(backfillParams?.[1]).toBe(bindingId);
  });

  it("backfills historical evidence for an existing project source binding after validation", async () => {
    let backfillParams: readonly unknown[] | null = null;
    const db = new FakeDb((sql, params) => {
      if (sql.includes("SELECT DISTINCT si.id")) {
        backfillParams = params;
        return [];
      }
      if (sql.includes("FROM project_source_bindings")) {
        return [projectSourceBindingRow(["binding-1", "space-1", "project-1", "channel-1"])];
      }
      if (sql.includes("FROM projects")) return [{ id: "project-1", owner_user_id: "user-1", status: "active" }];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new ProjectSourceBindingService(db).backfillBinding(identity, "binding-1");

    expect(out).toMatchObject({
      binding_id: "binding-1",
      project_id: "project-1",
      created_links: 0,
      evidence_links: 0,
    });
    expect(backfillParams?.[0]).toBe("space-1");
    expect(backfillParams?.[1]).toBe("binding-1");
  });

  it("blocks connected manual URL content queueing beyond source retention policy", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM source_channel_user_subscriptions")) {
        return [{ id: "sub-1" }];
      }
      if (sql.includes("FROM source_connections")) {
        return [sourceConnectionRow({ retention_policy: "metadata_only" })];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(new PgSourcesRepository(db, sourcesConfig()).createManualUrl(identity, {
      connection_id: "conn-1",
      url: "https://example.test/private",
      queue_content: true,
    })).rejects.toThrow("Source retention policy does not allow full_text");
  });

  it("blocks connected source item actions beyond source retention policy", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM source_items")) {
        return [sourceItemRow({ connection_id: "conn-1" })];
      }
      if (sql.includes("FROM source_connections")) {
        return [sourceConnectionRow({ retention_policy: "metadata_only" })];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(new PgSourcesRepository(db, sourcesConfig()).itemAction(identity, "item-1", {
      action: "queue_content",
    })).rejects.toThrow("Source retention policy does not allow full_text");
  });

  it("queues extract_text for an individual metadata source item", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = new FakeDb((sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM source_items")) return [sourceItemRow({ content_state: "metadata_only" })];
      if (sql.includes("UPDATE source_items")) return [];
      if (sql.includes("FROM extraction_jobs")) return [];
      if (sql.includes("INSERT INTO extraction_jobs")) return [extractionJobRow()];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await new PgSourcesRepository(db, sourcesConfig()).itemAction(identity, "item-1", {
      action: "queue_content",
    });

    const insert = calls.find((call) => call.sql.includes("INSERT INTO extraction_jobs"));
    expect(insert?.params[4]).toBe("extract_text");
    expect(insert?.params[3]).toBe("item-1");
  });

  it("does not queue duplicate extract_text jobs when one is already active", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = new FakeDb((sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM source_items")) return [sourceItemRow({ content_state: "metadata_only" })];
      if (sql.includes("UPDATE source_items")) return [];
      if (sql.includes("FROM extraction_jobs")) return [{ id: "job-active" }];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await new PgSourcesRepository(db, sourcesConfig()).itemAction(identity, "item-1", {
      action: "queue_content",
    });

    expect(calls.some((call) => call.sql.includes("INSERT INTO extraction_jobs"))).toBe(false);
  });

  it("updates the source for manually saved URL items", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = new FakeDb((sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM source_items")) {
        return [sourceItemRow({
          connection_id: "conn-old",
          item_type: "external_url",
          metadata_json: { created_by: "manual_url" },
          retention_policy: "metadata_only",
        })];
      }
      if (sql.includes("FROM source_channel_user_subscriptions")) return [{ id: "sub-1" }];
      if (sql.includes("FROM source_connections")) return [sourceConnectionRow()];
      if (sql.includes("UPDATE source_items")) return [];
      if (sql.includes("UPDATE source_snapshots")) return [];
      if (sql.includes("UPDATE extraction_jobs")) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await new PgSourcesRepository(db, sourcesConfig()).updateItem(identity, "item-1", {
      connection_id: "conn-1",
    });

    const itemUpdate = calls.find((call) => call.sql.includes("UPDATE source_items"));
    const snapshotUpdate = calls.find((call) => call.sql.includes("UPDATE source_snapshots"));
    const jobUpdate = calls.find((call) => call.sql.includes("UPDATE extraction_jobs"));
    expect(itemUpdate?.params[2]).toBe("conn-1");
    expect(snapshotUpdate?.params[2]).toBe("conn-1");
    expect(jobUpdate?.params[2]).toBe("conn-1");
  });

  it("does not allow source reassignment for scanned source items", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM source_items")) {
        return [sourceItemRow({
          connection_id: "conn-1",
          item_type: "feed_entry",
          metadata_json: { capture_method: "connection_scan" },
        })];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(new PgSourcesRepository(db, sourcesConfig()).updateItem(identity, "item-1", {
      connection_id: "conn-2",
    })).rejects.toThrow("Only manually saved URL items can change source");
  });

  it("blocks source-derived summary proposals unless the source policy allows the target", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM source_items")) {
        return [sourceItemRow({ connection_id: "conn-1" })];
      }
      if (sql.includes("INSERT INTO artifacts")) return [];
      if (sql.includes("FROM source_connections")) {
        return [sourceConnectionRow({ allowed_import_targets: ["activity", "source_artifact"] })];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(new PgSourcesRepository(db, sourcesConfig()).createSummaryRun(identity, {
      source_item_ids: ["item-1"],
      create_memory_proposal: true,
    })).rejects.toThrow("Source policy does not allow memory_proposal imports");
  });

  it("blocks source-derived summary artifacts unless the source policy allows source_artifact", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM source_items")) {
        return [sourceItemRow({ connection_id: "conn-1" })];
      }
      if (sql.includes("FROM source_connections")) {
        return [sourceConnectionRow({ allowed_import_targets: ["activity"] })];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(new PgSourcesRepository(db, sourcesConfig()).createSummaryRun(identity, {
      source_item_ids: ["item-1"],
    })).rejects.toThrow("Source policy does not allow source_artifact imports");
  });

  it("applies Source import-target policy through Evidence origin and snapshot provenance", async () => {
    for (const provenance of ["origin_item", "snapshot"] as const) {
      const db = new FakeDb((sql) => {
        if (sql.includes("FROM extracted_evidence")) {
          return [{
            id: "evidence-1",
            title: "Reader evidence",
            content_excerpt: "Excerpt",
            trust_level: "normal",
            source_item_id: null,
            origin_source_item_id: provenance === "origin_item" ? "item-1" : null,
            source_snapshot_id: provenance === "snapshot" ? "snapshot-1" : null,
          }];
        }
        if (sql.includes("FROM source_items si")) return [sourceItemRow({ id: "item-1", connection_id: "conn-1" })];
        if (sql.includes("SELECT id, connection_id FROM source_snapshots")) {
          return [{ id: "snapshot-1", connection_id: "conn-1" }];
        }
        if (sql.includes("FROM source_connections")) {
          return [sourceConnectionRow({ allowed_import_targets: ["activity", "source_artifact"] })];
        }
        if (sql.includes("INSERT INTO artifacts")) return [];
        throw new Error(`unexpected SQL: ${sql}`);
      });
      await expect(new PgSourcesRepository(db, sourcesConfig()).createSummaryRun(identity, {
        evidence_ids: ["evidence-1"],
        create_knowledge_proposal: true,
      })).rejects.toThrow("Source policy does not allow knowledge imports");
    }
  });

  it("gates source summary item inputs through the current user's readable source set", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = new FakeDb((sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM source_items")) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(new PgSourcesRepository(db, sourcesConfig()).createSummaryRun(identity, {
      source_item_ids: ["item-1"],
    })).rejects.toThrow("Summary input not found");

    const itemSelect = calls.find((call) => call.sql.includes("FROM source_items si"));
    expect(itemSelect?.sql).toContain("si.owner_user_id = $3");
    expect(itemSelect?.sql).toContain("FROM content_access_grants content_grant");
    expect(itemSelect?.sql).toContain("FROM space_memberships content_member");
    expect(itemSelect?.sql).toContain("FROM source_channel_user_subscriptions scus_read");
    expect(itemSelect?.sql).toContain("scus_read.status = 'subscribed'");
  });

  it("allows source-derived summary proposals when the source policy opts in", async () => {
    const db = new FakeDb((sql, params) => {
      if (sql.includes("FROM source_items")) {
        return [sourceItemRow({ connection_id: "conn-1" })];
      }
      if (sql.includes("INSERT INTO artifacts")) return [];
      if (sql.includes("FROM source_connections")) {
        return [sourceConnectionRow({ allowed_import_targets: ["activity", "source_artifact", "memory_proposal", "knowledge"] })];
      }
      if (sql.includes("INSERT INTO proposals")) return [{ id: `${params[3]}-proposal` }];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new PgSourcesRepository(db, sourcesConfig()).createSummaryRun(identity, {
      source_item_ids: ["item-1"],
      create_memory_proposal: true,
      create_knowledge_proposal: true,
    });

    expect(out).toMatchObject({ proposal_ids: ["memory_create-proposal", "knowledge_create-proposal"] });
  });

  it("creates Knowledge proposals with knowledge-specific provenance", async () => {
    const db = new FakeDb((sql, params) => {
      if (sql.includes("FROM space_object_profiles")) return [];
      if (sql.includes("INSERT INTO proposals")) return [proposalRow(params)];
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const proposal = await new PgKnowledgeRepository(db).proposeCreate(identity, {
      knowledge_kind: "concept",
      title: "Knowledge item",
      content: "Curated knowledge content.",
      source_refs: [{ source_type: "activity", source_id: "activity-1", source_trust: "user_confirmed" }],
    });

    expect(proposal).toMatchObject({ proposal_type: "knowledge_create", status: "pending" });
    expect(proposal.provenance_entries).toBeNull();
  });

  it("creates Claim proposals with normalized sources", async () => {
    const payloads: Record<string, unknown>[] = [];
    const db = new FakeDb((sql, params) => {
      if (sql.includes("FROM space_object_profiles")) return [];
      if (sql.includes("FROM source_connections")) {
        return [sourceConnectionRow()];
      }
      if (sql.includes("INSERT INTO proposals")) {
        payloads.push(JSON.parse(String(params[10])) as Record<string, unknown>);
        return [proposalRow(params)];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const proposal = await new PgKnowledgeRepository(db).proposeClaimCreate(identity, {
      claim_kind: "fact",
      subject_text: "Retrieval",
      claim_text: "The retrieval default embedding dimension is 2560.",
      sources: [{
        source_ref_type: "external_pointer",
        source_ref_id: "pointer-1",
        source_connection_id: "conn-1",
        evidence_role: "supports",
        confidence: 0.8,
      }],
    });

    expect(proposal).toMatchObject({ proposal_type: "claim_create", status: "pending" });
    expect(payloads[0]).toMatchObject({
      operation: "claim_create",
      claim_kind: "fact",
      subject_text: "Retrieval",
      sources: [expect.objectContaining({
        source_ref_type: "external_pointer",
        source_ref_id: "pointer-1",
        source_connection_id: "conn-1",
        evidence_role: "supports",
        confidence: 0.8,
      })],
    });
  });

  it("rejects claim source refs without a source connection", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM space_object_profiles")) return [];
      throw new Error("unexpected DB call");
    });

    await expect(new PgKnowledgeRepository(db).proposeClaimCreate(identity, {
      claim_kind: "fact",
      subject_text: "Retrieval",
      claim_text: "The retrieval default embedding dimension is 2560.",
      sources: [{
        source_ref_type: "external_pointer",
        source_ref_id: "pointer-1",
        evidence_role: "supports",
      }],
    })).rejects.toThrow("source_ref entries require source_connection_id");
  });

  it("creates object relation proposals after checking both endpoint objects", async () => {
    const seenObjectLookups: unknown[][] = [];
    const payloads: Record<string, unknown>[] = [];
    const db = new FakeDb((sql, params) => {
      if (sql.includes("FROM space_objects")) {
        seenObjectLookups.push([...params]);
        return [{
          id: params[0],
          space_id: "space-1",
          object_type: "claim",
          title: String(params[0]),
          status: "active",
          visibility: "space_shared",
          owner_user_id: "user-1",
          primary_project_id: null,
          project_folder_id: null,
          created_by_user_id: "user-1",
        }];
      }
      if (sql.includes("INSERT INTO proposals")) {
        payloads.push(JSON.parse(String(params[10])) as Record<string, unknown>);
        return [proposalRow(params)];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const proposal = await new PgKnowledgeRepository(db).proposeObjectRelation(identity, {
      from_object_id: "claim-a",
      to_object_id: "claim-b",
      link_type: "supports",
    });

    expect(seenObjectLookups).toEqual([
      ["claim-a", "space-1", "user-1"],
      ["claim-b", "space-1", "user-1"],
    ]);
    expect(proposal).toMatchObject({ proposal_type: "object_relation_create", status: "pending" });
    expect(payloads[0]).toMatchObject({
      operation: "object_relation_create",
      from_object_id: "claim-a",
      to_object_id: "claim-b",
      link_type: "supports",
    });
  });

  it("counts only what the viewer can read, in every part of the knowledge summary", async () => {
    // Three of these four used to be gated by Space membership alone while the
    // fourth applied the content gate. A count is a weaker leak than a list, but
    // it is still an answer about content the viewer cannot open — and one
    // gated count beside three ungated ones is how the gap stayed invisible.
    const gated = (sql: string, params: readonly unknown[]) => {
      expect(sql).toContain("so.visibility = 'space_shared'");
      expect(sql).toContain("content_access_grants");
      expect(sql).toContain("space_memberships");
      expect(sql).toContain("so.owner_user_id = $2");
      expect(params).toEqual(["space-1", "user-1"]);
    };
    const db = new FakeDb((sql, params) => {
      const norm = sql.replace(/\s+/g, " ");
      if (norm.includes("FROM notes n")) {
        gated(sql, params);
        return [{ status: "active", total: "2" }];
      }
      if (norm.includes("FROM knowledge_items ki")) {
        gated(sql, params);
        return [{ total: "3" }];
      }
      if (norm.includes("FROM sources s")) {
        gated(sql, params);
        return [{ total: "4" }];
      }
      if (norm.includes("FROM claims c")) {
        gated(sql, params);
        return [{ total: "1" }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new PgKnowledgeRepository(db).summary(identity);

    expect(out).toMatchObject({
      claims: { active: 1 },
      notes: { active: 2 },
      wiki: { active: 3 },
      sources: { total: 4 },
    });
  });

  it("hides claim relations unless both endpoint claims are visible", async () => {
    const db = new FakeDb((sql, params) => {
      const norm = sql.replace(/\s+/g, " ");
      if (norm.includes("FROM claims c")) return [claimRow()];
      if (norm.includes("FROM object_relations r")) {
        expect(sql).toContain("JOIN space_objects from_so");
        expect(sql).toContain("JOIN space_objects to_so");
        expect(sql).toContain("from_so.visibility = 'space_shared'");
        expect(sql).toContain("to_so.visibility = 'space_shared'");
        expect(sql).toContain("content_access_grants");
        expect(sql).toContain("from_so.owner_user_id = $2");
        expect(sql).toContain("to_so.owner_user_id = $2");
        expect(sql).toContain("from_so.deleted_at IS NULL");
        expect(sql).toContain("to_so.deleted_at IS NULL");
        expect(params).toEqual(["space-1", "user-1", "claim-1"]);
        return [objectRelationRow({ id: "claim-relation-1" })];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new PgKnowledgeRepository(db).claimRelations(identity, "claim-1");

    expect(out).toEqual([expect.objectContaining({ id: "claim-relation-1" })]);
  });

  it("hides object relations unless endpoints and evidence objects are visible", async () => {
    const db = new FakeDb((sql, params) => {
      const norm = sql.replace(/\s+/g, " ");
      if (norm.includes("FROM object_relations r")) {
        expect(sql).toContain("JOIN space_objects from_so");
        expect(sql).toContain("JOIN space_objects to_so");
        expect(sql).toContain("from_so.object_type AS from_object_type");
        expect(sql).toContain("to_so.object_type AS to_object_type");
        expect(sql).toContain("LEFT JOIN space_objects source_claim_so");
        expect(sql).toContain("LEFT JOIN space_objects source_so");
        expect(sql).toContain("from_so.visibility = 'space_shared'");
        expect(sql).toContain("to_so.visibility = 'space_shared'");
        expect(sql).toContain("source_claim_so.visibility = 'space_shared'");
        expect(sql).toContain("source_so.visibility = 'space_shared'");
        expect(sql).toContain("content_access_grants");
        expect(sql).toContain("r.source_claim_id IS NULL OR");
        expect(sql).toContain("r.source_object_id IS NULL OR");
        expect(params).toEqual(["space-1", "user-1", "claim-1"]);
        return [objectRelationRow()];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new PgKnowledgeRepository(db).objectRelations(identity, {
      from_object_id: "claim-1",
    });

    expect(out).toEqual([expect.objectContaining({ id: "object-relation-1", retrieval_projected: true })]);
  });

  it("marks object relations as not retrieval projected when an endpoint is not indexed by Knowledge retrieval", async () => {
    const db = new FakeDb((sql, params) => {
      const norm = sql.replace(/\s+/g, " ");
      if (norm.includes("FROM object_relations r")) {
        expect(params).toEqual(["space-1", "user-1"]);
        return [objectRelationRow({ from_object_id: "project-1", from_object_type: "project", to_object_type: "claim" })];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new PgKnowledgeRepository(db).objectRelations(identity, {});

    expect(out).toEqual([
      expect.objectContaining({
        id: "object-relation-1",
        from_object_id: "project-1",
        retrieval_projected: false,
      }),
    ]);
  });

  it("filters notes by collection in both count and row queries", async () => {
    const seenSql: string[] = [];
    const db = new FakeDb((sql, params) => {
      seenSql.push(sql);
      const norm = sql.replace(/\s+/g, " ");
      if (norm.includes("count(DISTINCT n.object_id)")) {
        expect(sql).toContain("LEFT JOIN note_collection_items nci_filter");
        expect(sql).toContain("nci_filter.space_id = n.space_id");
        expect(sql).toMatch(/nci_filter\.collection_id = \$\d+/);
        // The viewer id is a parameter of the list too: the content read gate
        // runs on the list, not only on the per-note read.
        expect(sql).toContain("space_object_project_shares");
        expect(params).toEqual(["space-1", "user-1", "collection-1"]);
        return [{ total: "1" }];
      }
      if (norm.includes("FROM notes n")) {
        expect(sql).toContain("LEFT JOIN note_collection_items nci_filter");
        expect(sql).toContain("nci_filter.space_id = n.space_id");
        expect(sql).toMatch(/nci_filter\.collection_id = \$\d+/);
        return [noteRow()];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const out = await new PgKnowledgeRepository(db).listNotes(identity, {
      status: null,
      projectId: null,
      collectionId: "collection-1",
      collectionIds: null,
      q: null,
      limit: 50,
      offset: 0,
    });

    expect(out).toMatchObject({ total: 1 });
    expect(seenSql).toHaveLength(2);
  });

  it("rejects note statuses outside the note lifecycle", async () => {
    let updateCount = 0;
    const db = new FakeDb((sql) => {
      const norm = sql.replace(/\s+/g, " ");
      if (norm.includes("FROM notes n")) return [noteRow()];
      if (sql.includes("UPDATE space_objects")) {
        updateCount += 1;
        return [];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(new PgKnowledgeRepository(db).updateNote(identity, "note-1", {
      status: "processed",
    })).rejects.toThrow("invalid note status");

    expect(updateCount).toBe(0);
  });

  it("writes note collection memberships with the current space", async () => {
    const seenSql: string[] = [];
    const db = new FakeDb((sql, params) => {
      seenSql.push(sql);
      const norm = sql.replace(/\s+/g, " ");
      if (norm.includes("FROM notes n")) return [noteRow()];
      if (sql.includes("UPDATE space_objects")) return [];
      if (sql.includes("SELECT id FROM note_collections")) {
        expect(params).toEqual(["collection-1", "space-1"]);
        return [{ id: "collection-1" }];
      }
      if (norm.includes("SELECT collection_id FROM note_collection_items")) {
        expect(params).toEqual(["note-1", "space-1"]);
        return [];
      }
      if (norm.includes("WITH RECURSIVE ancestry AS")) {
        expect(params).toEqual(["space-1", "collection-1"]);
        return [];
      }
      if (sql.includes("DELETE FROM note_collection_items")) {
        expect(sql).toContain("space_id = $2");
        expect(params).toEqual(["note-1", "space-1"]);
        return [];
      }
      if (sql.includes("SELECT COALESCE(MAX(sort_order), -1) + 1")) {
        expect(params).toEqual(["space-1", "collection-1"]);
        return [{ next_sort_order: 0 }];
      }
      if (sql.includes("INSERT INTO note_collection_items")) {
        expect(sql).toContain("id, space_id, collection_id, note_id");
        expect(params.slice(1, 4)).toEqual(["space-1", "collection-1", "note-1"]);
        return [];
      }
      // Reading the note back audits cross-person reads (ADR 0013 decision 18).
      if (sql.includes("INSERT INTO content_access_logs")) return [];
      // Every note update also drops marginalia bindings that no longer hold.
      // This test is about collection membership carrying the current space, so
      // the clean-up is unrelated here — but it must be declared rather than
      // fall through, because the throw below is what keeps this fake honest.
      if (sql.includes("SET marginalia_project_id = NULL")) {
        expect(params).toEqual(["note-1", "space-1"]);
        return [];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await new PgKnowledgeRepository(db).updateNote(identity, "note-1", {
      collection_id: "collection-1",
    });

    expect(seenSql.some((sql) => sql.includes("INSERT INTO note_collection_items"))).toBe(true);
  });
});
