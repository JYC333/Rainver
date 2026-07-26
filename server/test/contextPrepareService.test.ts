import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ContextCompiler } from "../src/modules/context/compiler";
import { ContextPrepareService } from "../src/modules/context/prepareService";
import type {
  RuntimeSkillCandidate,
  RuntimeSkillProvider,
  RuntimeSkillRunContext,
} from "../src/modules/capabilities/runtimeSkillProvider";
import {
  PgRunContextRepository,
  type ContextDigestRow,
  type ContextMemoryRow,
  type DigestBundle,
  type RunContextRecord,
  type SessionSummaryRow,
  type SnapshotUpdateInput,
  type PersonalGrantMetadata,
  type ContextEvidenceSelection,
  type ContextArtifactAttachmentSelection,
} from "../src/modules/context/repository";
import { serializeMemoryRow } from "../src/modules/memory/repository";
import type { ServerConfig } from "../src/config";

function config(): ServerConfig {
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
    agentSpaceHome: "/tmp/aspace",
    workspaceRoot: "/tmp/aspace/workspaces",
    cliToolsRoot: "/tmp/aspace/runtime-tools",
    cliSandboxImage: "agent-space-sandbox",
    sandboxRoot: "/tmp/aspace/sandboxes",
    deployerSocketPath: "/tmp/aspace/run/deployer.sock",
    artifactStorageRoot: "/tmp/aspace/storage/artifacts",
    internalToken: "token",
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
    memoryAccessLogRetentionEnabled: true,
    memoryAccessLogRetentionDays: 90,
    memoryAccessLogPruneIntervalSeconds: 3600,
    memoryMaintenanceSchedulerEnabled: true,
    memoryMaintenanceSchedulerIntervalSeconds: 900,
    memoryMaintenanceSchedulerBatchLimit: 5,
    sourceExtractionSchedulerEnabled: true,
    sourceExtractionSchedulerIntervalSeconds: 30,
    retrievalRerankEnabled: false,
    retrievalQueryRewriteEnabled: false,
    agentSpaceEnv: "",
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
  };
}

function memory(over: Partial<ContextMemoryRow> = {}): ContextMemoryRow {
  return {
    id: "mem-1",
    space_id: "space-1",
    subject_user_id: "user-1",
    owner_user_id: "user-1",
    project_folder_id: null,
    scope_type: "user",
    namespace: null,
    memory_type: "fact",
    title: "Known fact",
    content: "The user prefers concise plans.",
    status: "active",
    visibility: "private",
    sensitivity_level: "normal",
    access_level: "full",
    last_confirmed_at: null,
    confidence: 0.9,
    importance: 0.8,
    source_id: null,
    created_by: "user-1",
    created_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
    deleted_at: null,
    version: 1,
    tags: [],
    memory_layer: "semantic",
    source_trust: "internal_system",
    created_from_proposal_id: null,
    root_memory_id: null,
    supersedes_memory_id: null,
    project_id: null,
    agent_id: "agent-1",
    access_count: 0,
    last_accessed_at: null,
    last_retrieved_at: null,
    ...over,
  };
}

class FakeContextRepo extends PgRunContextRepository {
  readonly accesses: unknown[] = [];
  readonly digestAccesses: unknown[] = [];
  readonly snapshots: SnapshotUpdateInput[] = [];
  readonly runMarkers: Array<{ runId: string; metadata: PersonalGrantMetadata }> = [];
  readonly evidenceSelections: ContextEvidenceSelection[] = [
    {
      item: {
        id: "evidence-1",
        title: "Evidence",
        content_excerpt: "Relevant linked evidence.",
        evidence_type: "excerpt",
        trust_level: "normal",
        source_uri: null,
        artifact_id: null,
        link_id: "evidence-link-1",
        target_type: "space",
        target_id: "space-1",
      },
      ref: {
        source_type: "evidence",
        source_id: "evidence-1",
        evidence_type: "excerpt",
        link_id: "evidence-link-1",
        link_type: "context_candidate",
        target_type: "space",
        target_id: "space-1",
        trust_level: "normal",
        provenance_trust: "normal",
        section: "dynamic_tail",
      },
    },
  ];
  readonly artifactAttachments: ContextArtifactAttachmentSelection[] = [];
  readonly artifactAttachmentInputs: unknown[] = [];
  run: RunContextRecord | null = {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "version-1",
    context_snapshot_id: "snapshot-1",
    prompt: "Do the work",
    project_folder_id: null,
    project_id: null,
    session_id: "session-1",
    instructed_by_user_id: "user-1",
    capability_id: null,
    trigger_origin: "manual",
    data_exposure_level: "model_provider",
    trust_level: "trusted",
    has_personal_grant_context: false,
    personal_grant_context_json: null,
    request_json: {},
    system_prompt: "You are a test agent.",
    capabilities_json: [],
    memory_policy_json: { readable_scopes: ["user", "system", "project_folder", "agent"] },
    model_config_json: null,
  };
  rows: ContextMemoryRow[] = [memory()];
  digest: DigestBundle = {
    policy_bundle: null,
    project_folder: null,
    agent: null,
  };
  grant = {
    personal_context_block:
      "The user has 1 relevant personal memory entry available for this context.",
    metadata: {
      grant_id: "grant-1",
      granting_user_id: "user-1",
      personal_space_id: "personal-space",
      target_space_id: "space-1",
      access_mode: "summary_only",
      memory_count: 1,
      raw_private_memory_included: false,
      personal_summary_persisted: false,
    } satisfies PersonalGrantMetadata,
  };

  constructor() {
    super({ async query() { return { rows: [], rowCount: 0 }; } });
  }

  override async withTransaction<T>(
    fn: (repo: PgRunContextRepository) => Promise<T>,
  ): Promise<T> {
    return fn(this);
  }

  override async loadRun(): Promise<RunContextRecord | null> {
    return this.run;
  }

  override async retrieve(): ReturnType<PgRunContextRepository["retrieve"]> {
    return {
      memories: this.rows,
      activePolicies: [
        {
          id: "policy-1",
          name: "Policy",
          domain: "runtime",
          policy_key: "runtime.policy",
          enforcement_mode: "allow",
          priority: 10,
          policy_json: { decision: "allow" },
        },
      ],
      sourceRefs: [
        {
          source_type: "memory",
          source_id: "mem-1",
          section: "stable_prefix",
          stage: "symbol_match",
        },
      ],
      retrievalTrace: { total_selected: 1 },
      tokenBudget: { default_budget_chars: 128000 },
    };
  }

  override async recordContextMemoryAccess(input: unknown): Promise<void> {
    this.accesses.push(input);
  }

  override async recordContextDigestMemoryAccess(input: unknown): Promise<void> {
    this.digestAccesses.push(input);
  }

  // Ids the live-scope re-validation should reject (stale/tampered digest sources).
  digestIneligibleIds = new Set<string>();
  override async filterEligibleDigestMemoryIds(input: {
    spaceId: string;
    scopeType: "project_folder" | "agent";
    scopeId: string;
    memoryIds: readonly string[];
  }): Promise<string[]> {
    return input.memoryIds.filter((id) => !this.digestIneligibleIds.has(id));
  }

  override async loadLatestSessionSummary(): Promise<SessionSummaryRow | null> {
    return {
      id: "summary-1",
      session_id: "session-1",
      summary_text: "Earlier context.",
      version: 1,
      condenser_version: "v1",
    };
  }

  override async selectEvidenceForContext(): Promise<ContextEvidenceSelection[]> {
    return this.evidenceSelections;
  }

  override async selectArtifactAttachments(input: unknown): Promise<ContextArtifactAttachmentSelection[]> {
    this.artifactAttachmentInputs.push(input);
    return this.artifactAttachments;
  }

  override async loadDigestBundle(): Promise<DigestBundle> {
    return this.digest;
  }

  override async updateSnapshot(input: SnapshotUpdateInput): Promise<void> {
    this.snapshots.push(input);
  }

  override async resolvePersonalGrantForRun() {
    return this.grant;
  }

  override async markRunPersonalGrantContext(input: {
    runId: string;
    spaceId: string;
    metadata: PersonalGrantMetadata;
  }): Promise<void> {
    this.runMarkers.push({ runId: input.runId, metadata: input.metadata });
  }
}

class FakeRuntimeSkillProvider implements RuntimeSkillProvider {
  readonly calls: Array<{
    adapter_type: string | null;
    capability_id?: string | null;
    capabilities_json?: unknown;
  }> = [];

  constructor(private readonly candidates: RuntimeSkillCandidate[]) {}

  async loadCandidatesForRun(input: RuntimeSkillRunContext): Promise<RuntimeSkillCandidate[]> {
    this.calls.push(input);
    return this.candidates.filter(
      (candidate) => candidate.runtime_adapter_type === input.adapter_type,
    );
  }
}

function runtimeSkillCandidate(over: Partial<RuntimeSkillCandidate> = {}): RuntimeSkillCandidate {
  const capability = {
    id: "research-summary",
    namespace: "open_skill",
    name: "Research Summary",
    description: "Summarize imported research material.",
    version: "1.0.0",
    source_kind: "imported_skill" as const,
    input_schema_json: {},
    output_artifact_types: ["report"],
    permissions: { risk_level: "low" },
    supported_execution_modes: ["manual"],
    default_runtime_bindings: [],
    status: "available" as const,
  };
  return {
    binding_id: "binding-1",
    capability_id: capability.id,
    capability_version_id: "cap-version-1",
    capability_enablement_id: "cap-enable-1",
    runtime_adapter_type: "codex_cli",
    render_mode: "render_skill",
    binding_json: {},
    enablement_config_json: { workflow: "research" },
    capability,
    normalized_skill: {
      name: "research-summary",
      description: "Summarize imported research material.",
      version: "1.0.0",
      license: null,
      instructions_markdown: "Read the package resources and produce a concise research summary.",
      resources: [],
      requested_permissions: [],
      execution_profile: {},
      vendor_extensions: {},
      trust_analysis: { risk_level: "low" },
    },
    risk_level: "low",
    ...over,
  };
}

describe("ContextPrepareService", () => {
  it("renders bounded upstream inputs with provenance into the runtime prompt", async () => {
    const repo = new FakeContextRepo();
    repo.run = {
      ...repo.run!,
      contract_snapshot_json: {
        upstream_inputs_json: {
          bindings: [{
            name: "answer",
            from_node: "research",
            source: "output_json",
            source_run_id: "run-upstream",
            value: 42,
            truncated: false,
          }],
        },
      },
    };
    const result = await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });
    expect(result.runtime_prompt).toContain("## Upstream inputs");
    expect(result.runtime_prompt).toContain("Source node: research");
    expect(result.runtime_prompt).toContain("Source run: run-upstream");
    expect(result.runtime_prompt).toContain("42");
  });

  it("populates the run snapshot, logs context memory reads, and keeps grant text ephemeral", async () => {
    const repo = new FakeContextRepo();
    const service = new ContextPrepareService(config(), repo);

    const result = await service.prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    expect(result).toMatchObject({
      runtime_prompt: expect.stringContaining(
        "[Personal context granted for this run - reasoning only]",
      ),
      context_snapshot_id: "snapshot-1",
      context_rendered: false,
    });
    expect(repo.accesses).toHaveLength(1);
    expect(repo.accesses[0]).toMatchObject({
      spaceId: "space-1",
      userId: "user-1",
      agentId: "agent-1",
      runId: "run-1",
      reason: "run_execution:run-1",
    });

    const snapshot = repo.snapshots[0]!;
    expect(snapshot.compiledPrefixText).toContain("[system_prompt]");
    expect(snapshot.compiledPrefixText).toContain("The user prefers concise plans.");
    expect(snapshot.compiledTailText).toContain("[prompt]\nDo the work");
    expect(snapshot.compiledTailText).toContain(
      "[evidence:evidence-1:Evidence]\nRelevant linked evidence.",
    );
    expect(snapshot.includedEvidenceRefs).toContainEqual(
      expect.objectContaining({
        source_type: "evidence",
        source_id: "evidence-1",
        link_id: "evidence-link-1",
      }),
    );
    expect(snapshot.retrievalTrace[0]).toMatchObject({
      evidence_selection: {
        selected_count: 1,
        selection_owner: "ts_context_prepare",
        selection_status: "selected",
      },
    });
    expect(snapshot.tokenEstimate).toBeGreaterThan(0);
    expect(snapshot.sourceRefs).toContainEqual(
      expect.objectContaining({
        source_type: "personal_memory_grant",
        grant_id: "grant-1",
        raw_private_memory_included: false,
        personal_summary_persisted: false,
      }),
    );
    expect(JSON.stringify(snapshot.sourceRefs)).not.toContain(
      "The user has 1 relevant personal memory entry",
    );
    expect(snapshot.retrievalTrace[0]).toMatchObject({
      personal_memory_grant: {
        grant_id: "grant-1",
        raw_private_memory_included: false,
        personal_summary_persisted: false,
      },
    });
    expect(repo.runMarkers).toHaveLength(1);
  });

  it("injects explicit artifact evidence packs into runtime context and included refs", async () => {
    const repo = new FakeContextRepo();
    repo.run = {
      ...repo.run!,
      request_json: { context_artifact_ids: ["brief-1"] },
    };
    repo.artifactAttachments.push({
      item: {
        attachment_type: "artifact_evidence_pack",
        artifact_id: "brief-1",
        artifact_type: "retrieval_brief",
        label: "Context Brief",
        domain_label: "knowledge_brief",
        approved: true,
        resolved_content: "Artifact: Context Brief\nAnswer: Use the attached brief.",
        policy_snapshot: {
          content_mode: "bounded_summary",
          raw_artifact_content_included: false,
        },
      },
      ref: {
        source_type: "artifact",
        source_id: "brief-1",
        artifact_type: "retrieval_brief",
        attachment_type: "artifact_evidence_pack",
        included: true,
        section: "dynamic_tail",
        content_mode: "bounded_summary",
        raw_artifact_content_included: false,
      },
    });

    const result = await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    expect(result.runtime_context_text).toContain("[attachment:Context Brief]");
    expect(result.runtime_context_text).toContain("Answer: Use the attached brief.");
    const snapshot = repo.snapshots[0]!;
    expect(snapshot.sourceRefs).toContainEqual(
      expect.objectContaining({
        source_type: "artifact",
        source_id: "brief-1",
        attachment_type: "artifact_evidence_pack",
      }),
    );
    expect(snapshot.includedEvidenceRefs).toContainEqual(
      expect.objectContaining({
        source_type: "artifact",
        source_id: "brief-1",
        attachment_type: "artifact_evidence_pack",
      }),
    );
    expect(snapshot.retrievalTrace[0]).toMatchObject({
      artifact_attachment: {
        requested_count: 1,
        attached_count: 1,
        blocked_count: 0,
      },
    });
  });

  it("revalidates artifact attachments against the run workspace at prepare time", async () => {
    const repo = new FakeContextRepo();
    repo.run = {
      ...repo.run!,
      project_folder_id: "ws-current",
      request_json: { context_artifact_ids: ["brief-1"] },
    };
    repo.artifactAttachments.push({
      item: {
        attachment_type: "artifact_evidence_pack",
        artifact_id: "brief-1",
        artifact_type: "retrieval_brief",
        label: "Context Brief",
        domain_label: "knowledge_brief",
        approved: false,
        rejection_reason: "artifact not found or not visible",
        policy_snapshot: {
          content_mode: "blocked",
          raw_artifact_content_included: false,
        },
      },
      ref: {
        source_type: "artifact",
        source_id: "brief-1",
        artifact_type: "retrieval_brief",
        attachment_type: "artifact_evidence_pack",
        included: false,
        section: "dynamic_tail",
        content_mode: "blocked",
        raw_artifact_content_included: false,
        rejection_reason: "artifact not found or not visible",
      },
    });

    const result = await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    expect(repo.artifactAttachmentInputs[0]).toMatchObject({
      projectFolderId: "ws-current",
      artifactIds: ["brief-1"],
    });
    expect(result.runtime_context_text).not.toContain("[attachment:Context Brief]");
    const snapshot = repo.snapshots[0]!;
    expect(snapshot.sourceRefs).toContainEqual(
      expect.objectContaining({
        source_type: "artifact",
        source_id: "brief-1",
        included: false,
        rejection_reason: "artifact not found or not visible",
      }),
    );
    expect(snapshot.retrievalTrace[0]).toMatchObject({
      artifact_attachment: {
        requested_count: 1,
        attached_count: 0,
        blocked_count: 1,
      },
    });
  });

  it("records active digest source refs when a digest is available", async () => {
    const repo = new FakeContextRepo();
    const digest: ContextDigestRow = {
      id: "digest-1",
      digest_type: "policy_bundle",
      version: 3,
      status: "active",
      content: "Digest content",
      source_memory_ids_json: ["mem-1"],
      source_policy_ids_json: ["policy-1"],
      source_relation_ids_json: [],
      source_hash: "source-hash",
      content_hash: "content-hash",
    };
    const agentDigest: ContextDigestRow = {
      id: "agent-digest-1",
      digest_type: "agent",
      version: 7,
      status: "active",
      content: "Agent digest content",
      source_memory_ids_json: ["agent-mem-1"],
      source_policy_ids_json: [],
      source_relation_ids_json: [],
      source_hash: "agent-source-hash",
      content_hash: "agent-content-hash",
    };
    repo.digest = { policy_bundle: digest, project_folder: null, agent: agentDigest };

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    expect(repo.snapshots[0]?.compiledPrefixText).toContain(
      "[digest:policy_bundle:v3]",
    );
    expect(repo.snapshots[0]?.sourceRefs).toContainEqual(
      expect.objectContaining({
        source_type: "context_digest",
        source_id: "digest-1",
        digest_version: 3,
      }),
    );
    expect(repo.snapshots[0]?.policyBundleVersion).toBe("3");
    expect(repo.snapshots[0]?.memoryDigestVersion).toBe("7");
  });

  it("falls back per missing digest scope instead of suppressing policies globally", async () => {
    const repo = new FakeContextRepo();
    repo.run = { ...repo.run!, project_folder_id: "ws-1" };
    repo.digest = {
      policy_bundle: null,
      project_folder: {
        id: "workspace-digest",
        digest_type: "project_folder",
        version: 2,
        status: "active",
        content: "Workspace digest content",
        source_memory_ids_json: ["mem-1"],
        source_policy_ids_json: [],
        source_relation_ids_json: [],
        source_hash: "source-hash",
        content_hash: "content-hash",
      },
      agent: null,
    };

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    expect(snapshot.compiledPrefixText).toContain("[digest:project_folder:v2]");
    expect(snapshot.compiledPrefixText).toContain("[policy:runtime:Policy]");
    expect(snapshot.projectFolderDigestVersion).toBe("2");
    expect(snapshot.retrievalTrace[0]).toMatchObject({
      digest_used: true,
      fallback_to_memory_retriever: true,
      digest_missing_types: ["policy_bundle", "agent"],
      digest_fallback_reason: "missing_digest_for_scope",
    });
  });

  it("deduplicates memories covered by digest and logs digest-only source memory reads", async () => {
    const repo = new FakeContextRepo();
    repo.rows = [
      memory({
        id: "shared-mem",
        title: "Shared direct title",
        content: "Shared direct content should be replaced by digest.",
        scope_type: "project_folder",
        project_folder_id: "ws-1",
        visibility: "space_shared",
      }),
      memory({
        id: "private-mem",
        title: "Private memory",
        content: "Private owner-specific content remains direct.",
        scope_type: "project_folder",
        project_folder_id: "ws-1",
        visibility: "private",
      }),
    ];
    repo.run = { ...repo.run!, project_folder_id: "ws-1" };
    repo.retrieve = async () => ({
      memories: repo.rows,
      activePolicies: [],
      sourceRefs: repo.rows.map((m) => ({
        source_type: "memory",
        source_id: m.id,
        section: "stable_prefix",
        stage: "symbol_match",
      })),
      retrievalTrace: {},
      tokenBudget: {},
    });
    repo.digest = {
      policy_bundle: null,
      project_folder: {
        id: "workspace-digest",
        digest_type: "project_folder",
        version: 4,
        status: "active",
        content: "Digest-safe shared memory summary.",
        source_memory_ids_json: ["shared-mem", "digest-only-mem"],
        source_policy_ids_json: [],
        source_relation_ids_json: [],
        source_hash: "source-hash",
        content_hash: "content-hash",
      },
      agent: null,
    };

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    expect(snapshot.compiledPrefixText).toContain("Digest-safe shared memory summary.");
    expect(snapshot.compiledPrefixText).not.toContain("Shared direct content should be replaced");
    expect(snapshot.compiledPrefixText).toContain("Private owner-specific content remains direct.");
    expect(repo.digestAccesses).toHaveLength(1);
    expect(repo.digestAccesses[0]).toMatchObject({
      memoryIds: ["digest-only-mem"],
      reason: "run_execution:run-1:context_digest",
    });
  });

  it("ignores digest source ids that fail live-scope re-validation", async () => {
    const repo = new FakeContextRepo();
    repo.rows = [
      memory({
        id: "private-mem",
        title: "Private memory",
        content: "Private owner-specific content must stay direct.",
        scope_type: "project_folder",
        project_folder_id: "ws-1",
        visibility: "private",
      }),
    ];
    repo.run = { ...repo.run!, project_folder_id: "ws-1" };
    repo.retrieve = async () => ({
      memories: repo.rows,
      activePolicies: [],
      sourceRefs: repo.rows.map((m) => ({
        source_type: "memory",
        source_id: m.id,
        section: "stable_prefix",
        stage: "symbol_match",
      })),
      retrievalTrace: {},
      tokenBudget: {},
    });
    // A stale/tampered digest claims a private memory id it does not legitimately cover.
    repo.digest = {
      policy_bundle: null,
      project_folder: {
        id: "workspace-digest",
        digest_type: "project_folder",
        version: 4,
        status: "active",
        content: "Digest summary.",
        source_memory_ids_json: ["private-mem"],
        source_policy_ids_json: [],
        source_relation_ids_json: [],
        source_hash: "source-hash",
        content_hash: "content-hash",
      },
      agent: null,
    };
    repo.digestIneligibleIds = new Set(["private-mem"]);

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    // The whole digest is dropped (its summary may embed the now-ineligible memory).
    expect(snapshot.compiledPrefixText).not.toContain("Digest summary.");
    expect(snapshot.projectFolderDigestVersion).toBeNull();
    // Not suppressed by the poisoned digest: the private memory still renders directly.
    expect(snapshot.compiledPrefixText).toContain("Private owner-specific content must stay direct.");
    // And it is not falsely audited as a digest-sourced read (empty → real repo no-ops).
    expect(repo.digestAccesses).toEqual([
      expect.objectContaining({ memoryIds: [] }),
    ]);
    expect(snapshot.retrievalTrace[0]).toMatchObject({
      digest_used: false,
      digest_dropped: [{ digest_type: "project_folder", reason: "stale_source_memory" }],
    });
  });

  it("drops a dirty workspace digest and falls back to the direct retriever", async () => {
    const repo = new FakeContextRepo();
    repo.rows = [
      memory({
        id: "shared-mem",
        title: "Shared direct title",
        content: "Current shared content from the live retriever.",
        scope_type: "project_folder",
        project_folder_id: "ws-1",
        visibility: "space_shared",
      }),
    ];
    repo.run = { ...repo.run!, project_folder_id: "ws-1" };
    repo.retrieve = async () => ({
      memories: repo.rows,
      activePolicies: [],
      sourceRefs: repo.rows.map((m) => ({
        source_type: "memory",
        source_id: m.id,
        section: "stable_prefix",
        stage: "symbol_match",
      })),
      retrievalTrace: {},
      tokenBudget: {},
    });
    // A pending memory change has marked the digest dirty; its cached summary is stale.
    repo.digest = {
      policy_bundle: null,
      project_folder: {
        id: "workspace-digest",
        digest_type: "project_folder",
        version: 6,
        status: "dirty",
        content: "Stale digest summary that must not be injected.",
        source_memory_ids_json: ["shared-mem"],
        source_policy_ids_json: [],
        source_relation_ids_json: [],
        source_hash: "source-hash",
        content_hash: "content-hash",
      },
      agent: null,
    };

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    // Dirty digest content is not injected; the live memory renders directly instead.
    expect(snapshot.compiledPrefixText).not.toContain("Stale digest summary");
    expect(snapshot.compiledPrefixText).toContain("Current shared content from the live retriever.");
    expect(snapshot.projectFolderDigestVersion).toBeNull();
    expect(snapshot.retrievalTrace[0]).toMatchObject({
      digest_used: false,
      fallback_to_memory_retriever: true,
      digest_dropped: [{ digest_type: "project_folder", reason: "dirty" }],
    });
  });

  it("drops a workspace digest when the agent may not read the workspace scope", async () => {
    const repo = new FakeContextRepo();
    // readable_scopes excludes "project_folder": the direct retriever already filters
    // workspace memory out, so the derived workspace digest must not be injected.
    repo.run = {
      ...repo.run!,
      project_folder_id: "ws-1",
      memory_policy_json: { readable_scopes: ["user", "agent"] },
    };
    repo.retrieve = async () => ({
      memories: [],
      activePolicies: [],
      sourceRefs: [],
      retrievalTrace: {},
      tokenBudget: {},
    });
    repo.digest = {
      policy_bundle: null,
      project_folder: {
        id: "workspace-digest",
        digest_type: "project_folder",
        version: 3,
        status: "active",
        content: "Workspace summary the agent is not allowed to read.",
        source_memory_ids_json: [],
        source_policy_ids_json: [],
        source_relation_ids_json: [],
        source_hash: "source-hash",
        content_hash: "content-hash",
      },
      agent: null,
    };

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    expect(snapshot.compiledPrefixText).not.toContain("Workspace summary the agent is not allowed to read.");
    expect(snapshot.projectFolderDigestVersion).toBeNull();
    expect(snapshot.retrievalTrace[0]).toMatchObject({
      digest_used: false,
      digest_missing_types: ["policy_bundle", "agent"],
      digest_dropped: [{ digest_type: "project_folder", reason: "scope_not_readable" }],
    });
  });

  it("drops an agent digest when the agent may not read the agent scope", async () => {
    const repo = new FakeContextRepo();
    repo.run = {
      ...repo.run!,
      memory_policy_json: { readable_scopes: ["user", "project_folder"] },
    };
    repo.retrieve = async () => ({
      memories: [],
      activePolicies: [],
      sourceRefs: [],
      retrievalTrace: {},
      tokenBudget: {},
    });
    repo.digest = {
      policy_bundle: {
        id: "policy-digest",
        digest_type: "policy_bundle",
        version: 2,
        status: "active",
        content: "Policy digest content.",
        source_memory_ids_json: [],
        source_policy_ids_json: ["policy-1"],
        source_relation_ids_json: [],
        source_hash: "policy-source-hash",
        content_hash: "policy-content-hash",
      },
      project_folder: null,
      agent: {
        id: "agent-digest",
        digest_type: "agent",
        version: 3,
        status: "active",
        content: "Agent summary the agent is not allowed to read.",
        source_memory_ids_json: [],
        source_policy_ids_json: [],
        source_relation_ids_json: [],
        source_hash: "agent-source-hash",
        content_hash: "agent-content-hash",
      },
    };

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    expect(snapshot.compiledPrefixText).toContain("Policy digest content.");
    expect(snapshot.compiledPrefixText).not.toContain("Agent summary the agent is not allowed to read.");
    expect(snapshot.memoryDigestVersion).toBeNull();
    expect(snapshot.retrievalTrace[0]).toMatchObject({
      digest_used: true,
      fallback_to_memory_retriever: false,
      digest_missing_types: [],
      digest_dropped: [{ digest_type: "agent", reason: "scope_not_readable" }],
    });
  });

  it("drops a dirty policy_bundle and falls back to direct active policies", async () => {
    const repo = new FakeContextRepo();
    repo.run = { ...repo.run!, project_folder_id: null };
    repo.retrieve = async () => ({
      memories: [],
      activePolicies: [
        {
          id: "policy-1",
          name: "Boundary",
          domain: "egress",
          policy_key: null,
          enforcement_mode: null,
          priority: 0,
          policy_json: { rule: "deny" },
        },
      ],
      sourceRefs: [],
      retrievalTrace: {},
      tokenBudget: {},
    });
    repo.digest = {
      policy_bundle: {
        id: "policy-digest",
        digest_type: "policy_bundle",
        version: 9,
        status: "dirty",
        content: "Stale policy digest that must not suppress current policies.",
        source_memory_ids_json: [],
        source_policy_ids_json: ["policy-old"],
        source_relation_ids_json: [],
        source_hash: "source-hash",
        content_hash: "content-hash",
      },
      project_folder: null,
      agent: null,
    };

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    expect(snapshot.compiledPrefixText).not.toContain("Stale policy digest");
    // Current active policies are injected directly instead of the dirty digest.
    expect(snapshot.compiledPrefixText).toContain("[policy:egress:Boundary]");
    expect(snapshot.policyBundleVersion).toBeNull();
    expect(snapshot.retrievalTrace[0]).toMatchObject({
      digest_dropped: [{ digest_type: "policy_bundle", reason: "dirty" }],
    });
  });

  it("drops a memory digest with malformed source metadata", async () => {
    const repo = new FakeContextRepo();
    repo.rows = [
      memory({
        id: "shared-mem",
        title: "Shared memory",
        content: "Current shared content from live retrieval.",
        scope_type: "project_folder",
        project_folder_id: "ws-1",
        visibility: "space_shared",
      }),
    ];
    repo.run = { ...repo.run!, project_folder_id: "ws-1" };
    repo.retrieve = async () => ({
      memories: repo.rows,
      activePolicies: [],
      sourceRefs: repo.rows.map((m) => ({
        source_type: "memory",
        source_id: m.id,
        section: "stable_prefix",
        stage: "symbol_match",
      })),
      retrievalTrace: {},
      tokenBudget: {},
    });
    repo.digest = {
      policy_bundle: null,
      project_folder: {
        id: "workspace-digest",
        digest_type: "project_folder",
        version: 5,
        status: "active",
        content: "Digest summary with unprovable source metadata.",
        source_memory_ids_json: ["shared-mem", 42],
        source_policy_ids_json: [],
        source_relation_ids_json: [],
        source_hash: "source-hash",
        content_hash: "content-hash",
      },
      agent: null,
    };

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: "generic",
      workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    expect(snapshot.compiledPrefixText).not.toContain("Digest summary with unprovable");
    expect(snapshot.compiledPrefixText).toContain("Current shared content from live retrieval.");
    expect(snapshot.projectFolderDigestVersion).toBeNull();
    expect(snapshot.retrievalTrace[0]).toMatchObject({
      digest_used: false,
      digest_dropped: [{ digest_type: "project_folder", reason: "stale_source_memory" }],
    });
  });

  it("renders digest-backed context into CLI instruction files and runtime text", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-context-"));
    const sandbox = join(root, "sandbox");
    const workspace = join(root, "project_folder");
    await mkdir(sandbox, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const repo = new FakeContextRepo();
    repo.run = { ...repo.run!, project_folder_id: "ws-1" };
    repo.rows = [
      memory({
        id: "shared-mem",
        title: "Shared direct title",
        content: "Shared direct content should not reach runtime file.",
        scope_type: "project_folder",
        project_folder_id: "ws-1",
        visibility: "space_shared",
      }),
      memory({
        id: "private-mem",
        title: "Private memory",
        content: "Private owner-specific content remains direct.",
        scope_type: "project_folder",
        project_folder_id: "ws-1",
        visibility: "private",
      }),
    ];
    repo.retrieve = async () => ({
      memories: repo.rows,
      activePolicies: [],
      sourceRefs: repo.rows.map((m) => ({
        source_type: "memory",
        source_id: m.id,
        section: "stable_prefix",
        stage: "symbol_match",
      })),
      retrievalTrace: {},
      tokenBudget: {},
    });
    repo.digest = {
      policy_bundle: null,
      project_folder: {
        id: "workspace-digest",
        digest_type: "project_folder",
        version: 5,
        status: "active",
        content: "Digest-safe shared memory summary.",
        source_memory_ids_json: ["shared-mem"],
        source_policy_ids_json: [],
        source_relation_ids_json: [],
        source_hash: "source-hash",
        content_hash: "content-hash",
      },
      agent: null,
    };

    const result = await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "codex_cli",
      sandboxCwd: sandbox,
      targetFormat: "codex_cli",
      workspacePath: workspace,
    });

    expect(result.context_rendered).toBe(true);
    expect(result.instruction_file_path).toBe(join(sandbox, "AGENTS.md"));
    const rendered = await readFile(result.instruction_file_path!, "utf8");
    expect(rendered).toContain("Digest-safe shared memory summary.");
    expect(rendered).toContain("Private owner-specific content remains direct.");
    expect(rendered).not.toContain("Shared direct content should not reach runtime file.");
    expect(result.runtime_context_text).toContain("Digest-safe shared memory summary.");
    expect(result.runtime_context_text).not.toContain("[prompt]\nDo the work");
  });

  it("renders enabled runtime skills into the sandbox and records binding trace metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-runtime-skill-"));
    const sandbox = join(root, "sandbox");
    const workspace = join(root, "project_folder");
    await mkdir(sandbox, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const repo = new FakeContextRepo();
    repo.run = {
      ...repo.run!,
      capability_id: "research-summary",
      capabilities_json: ["research-summary"],
    };
    const provider = new FakeRuntimeSkillProvider([runtimeSkillCandidate()]);

    const result = await new ContextPrepareService(
      config(),
      repo,
      new ContextCompiler(),
      provider,
    ).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "codex_cli",
      sandboxCwd: sandbox,
      targetFormat: "codex_cli",
      workspacePath: workspace,
    });

    expect(provider.calls[0]).toMatchObject({
      adapter_type: "codex_cli",
      capability_id: "research-summary",
      capabilities_json: ["research-summary"],
    });
    expect(result.runtime_skill_binding_ids).toEqual(["binding-1"]);
    expect(result.runtime_skill_file_paths).toEqual([
      join(sandbox, ".agent-space/generated-skills/codex/research-summary/SKILL.md"),
      join(sandbox, ".agent-space/generated-skills/codex/research-summary/agents/openai.yaml"),
    ]);
    const skillMarkdown = await readFile(result.runtime_skill_file_paths![0]!, "utf8");
    expect(skillMarkdown).toContain("# Research Summary");
    expect(skillMarkdown).toContain("Read the package resources");
    const agentsMd = await readFile(result.instruction_file_path!, "utf8");
    expect(agentsMd).toContain("# Runtime Skills");
    expect(agentsMd).toContain(".agent-space/generated-skills/codex/research-summary/SKILL.md");
    expect(repo.snapshots[0]?.sourceRefs).toContainEqual(
      expect.objectContaining({
        source_type: "runtime_skill_binding",
        binding_id: "binding-1",
        capability_id: "research-summary",
        raw_content_in_trace: false,
      }),
    );
    expect(repo.snapshots[0]?.retrievalTrace[0]).toMatchObject({
      runtime_skill_rendering: {
        rendered_count: 1,
        bindings: [
          expect.objectContaining({
            binding_id: "binding-1",
            files_count: 2,
            prompt_block_rendered: false,
          }),
        ],
      },
    });
  });

  it("renders an enabled high-risk binding because enablement is the review gate", async () => {
    const repo = new FakeContextRepo();
    repo.run = {
      ...repo.run!,
      capability_id: "research-summary",
      capabilities_json: ["research-summary"],
    };
    const provider = new FakeRuntimeSkillProvider([
      runtimeSkillCandidate({
        risk_level: "high",
        capability: {
          ...runtimeSkillCandidate().capability,
          permissions: { risk_level: "high" },
        },
      }),
    ]);

    const result = await new ContextPrepareService(
      config(),
      repo,
      new ContextCompiler(),
      provider,
    ).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "codex_cli",
      sandboxCwd: null,
      targetFormat: "codex_cli",
      workspacePath: null,
    });

    // The owner already decided to enable this high-risk capability through the
    // capability_enable proposal, so render honors that decision instead of
    // re-gating and hard-failing the run.
    expect(result.runtime_skill_binding_ids).toEqual(["binding-1"]);
    expect(repo.snapshots).toHaveLength(1);
    expect(repo.snapshots[0]?.retrievalTrace[0]).toMatchObject({
      runtime_skill_rendering: {
        rendered_count: 1,
        bindings: [expect.objectContaining({ binding_id: "binding-1", risk_level: "high" })],
      },
    });
  });

  it("refuses to write runtime skill files into the real workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-runtime-skill-ws-"));
    const workspace = join(root, "project_folder");
    await mkdir(workspace, { recursive: true });

    const repo = new FakeContextRepo();
    repo.run = {
      ...repo.run!,
      capability_id: "research-summary",
      capabilities_json: ["research-summary"],
    };
    const provider = new FakeRuntimeSkillProvider([runtimeSkillCandidate()]);

    // targetFormat is null so the compiler is skipped: the writer must enforce
    // the sandbox boundary itself rather than relying on the compiler's check.
    await expect(
      new ContextPrepareService(config(), repo, new ContextCompiler(), provider).prepare({
        runId: "run-1",
        spaceId: "space-1",
        adapterType: "codex_cli",
        sandboxCwd: workspace,
        targetFormat: null,
        workspacePath: workspace,
      }),
    ).rejects.toThrow(/refuses to write/);
  });
});

describe("ContextPrepareService stable prefix compaction", () => {
  it("keeps higher-priority (user) memories and drops lower-priority (agent) ones when prefix budget overflows", async () => {
    const repo = new FakeContextRepo();
    const userMems = Array.from({ length: 8 }, (_, i) =>
      memory({ id: `user-mem-${i}`, scope_type: "user", memory_layer: "semantic", content: "u".repeat(5_000), title: `User ${i}` }),
    );
    const agentMems = Array.from({ length: 8 }, (_, i) =>
      memory({ id: `agent-mem-${i}`, scope_type: "agent", memory_layer: "semantic", content: "a".repeat(5_000), title: `Agent ${i}` }),
    );
    repo.rows = [...userMems, ...agentMems];
    const allRefs = [...userMems, ...agentMems].map((m) => ({
      source_type: "memory",
      source_id: m.id,
      section: "stable_prefix",
      stage: "symbol_match",
    }));
    repo.retrieve = async () => ({
      memories: repo.rows,
      activePolicies: [],
      sourceRefs: allRefs,
      retrievalTrace: {},
      tokenBudget: {},
    });

    const service = new ContextPrepareService(config(), repo);
    await service.prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: null,
      workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    expect(snapshot.compiledPrefixText).toContain("[memory:user-mem-0:");
    expect(snapshot.compiledPrefixText.length).toBeLessThanOrEqual(64_200);
    const compaction = (snapshot.tokenBudget as Record<string, unknown>).stable_prefix_compaction as Record<string, unknown> | undefined;
    expect(compaction).toMatchObject({ applied: true });
    expect(compaction!.items_dropped as number).toBeGreaterThan(0);
  });

  it("does not set stable_prefix_compaction when all items fit within budget", async () => {
    const repo = new FakeContextRepo();
    // single small memory — fits easily
    repo.rows = [memory({ id: "small-mem", scope_type: "user", content: "Short fact." })];
    repo.retrieve = async () => ({
      memories: repo.rows,
      activePolicies: [],
      sourceRefs: [{ source_type: "memory", source_id: "small-mem", section: "stable_prefix", stage: "symbol_match" }],
      retrievalTrace: {},
      tokenBudget: {},
    });

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: null,
      workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    expect((snapshot.tokenBudget as Record<string, unknown>).stable_prefix_compaction).toBeUndefined();
  });

  it("system_prompt is always included even when other items overflow", async () => {
    const repo = new FakeContextRepo();
    repo.run = { ...repo.run!, system_prompt: "SYSTEM" };
    const bigMems = Array.from({ length: 20 }, (_, i) =>
      memory({ id: `big-mem-${i}`, scope_type: "agent", content: "x".repeat(5_000) }),
    );
    repo.rows = bigMems;
    repo.retrieve = async () => ({
      memories: bigMems,
      activePolicies: [],
      sourceRefs: bigMems.map((m) => ({ source_type: "memory", source_id: m.id, section: "stable_prefix", stage: "symbol_match" })),
      retrievalTrace: {},
      tokenBudget: {},
    });

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1",
      spaceId: "space-1",
      adapterType: "model_api",
      sandboxCwd: null,
      targetFormat: null,
      workspacePath: null,
    });

    expect(repo.snapshots[0]?.compiledPrefixText).toContain("[system_prompt]\nSYSTEM");
  });

  it("truncates a borderline item at 50% rather than dropping it when the full item would not fit", async () => {
    const repo = new FakeContextRepo();
    // Budget ~ 64K chars. system_prompt (prio 0) gets priority.
    // user-mem (prio 25) is large: 40K chars. At 100% it won't fit; at 50% (20K) it should fit.
    // agent-mem (prio 40) is also large and should be dropped after truncated user-mem fills budget.
    repo.run = { ...repo.run!, system_prompt: "SYS", model_config_json: null };
    const bigUserMem = memory({ id: "big-user", scope_type: "user", memory_layer: "semantic", content: "u".repeat(40_000) });
    const bigAgentMem = memory({ id: "big-agent", scope_type: "agent", memory_layer: "semantic", content: "a".repeat(40_000) });
    repo.rows = [bigUserMem, bigAgentMem];
    repo.retrieve = async () => ({
      memories: repo.rows,
      activePolicies: [],
      sourceRefs: [bigUserMem, bigAgentMem].map((m) => ({
        source_type: "memory",
        source_id: m.id,
        section: "stable_prefix",
        stage: "symbol_match",
      })),
      retrievalTrace: {},
      tokenBudget: {},
    });

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1", spaceId: "space-1", adapterType: "model_api",
      sandboxCwd: null, targetFormat: null, workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    // User mem should appear (truncated) in prefix
    expect(snapshot.compiledPrefixText).toContain("big-user");
    // Truncation marker present
    expect(snapshot.compiledPrefixText).toContain("[compacted to 50% — stable prefix budget]");
    const compaction = (snapshot.tokenBudget as Record<string, unknown>).stable_prefix_compaction as Record<string, unknown> | undefined;
    expect(compaction).toMatchObject({ applied: true, items_truncated: 1 });
    expect((compaction!.truncated_ids as string[])).toContain("big-user");
  });

  it("uses a larger stable prefix budget for a known large-context model", async () => {
    const repo = new FakeContextRepo();
    // claude-opus-4-8 has 200K token context → budget = 200K × 4 × 0.35 = 280K chars
    repo.run = { ...repo.run!, model_config_json: { model: "claude-opus-4-8", max_tokens: 4096 } };
    // Fill with memories that would overflow the default 64K budget but fit inside 280K
    const mems = Array.from({ length: 10 }, (_, i) =>
      memory({ id: `mem-${i}`, scope_type: "user", memory_layer: "semantic", content: "m".repeat(8_000) }),
    );
    repo.rows = mems;
    repo.retrieve = async () => ({
      memories: mems,
      activePolicies: [],
      sourceRefs: mems.map((m) => ({ source_type: "memory", source_id: m.id, section: "stable_prefix", stage: "symbol_match" })),
      retrievalTrace: {},
      tokenBudget: {},
    });

    await new ContextPrepareService(config(), repo).prepare({
      runId: "run-1", spaceId: "space-1", adapterType: "model_api",
      sandboxCwd: null, targetFormat: null, workspacePath: null,
    });

    const snapshot = repo.snapshots[0]!;
    const tb = snapshot.tokenBudget as Record<string, unknown>;
    // Budget should be 280K, not 64K
    expect(tb.stable_prefix_budget_chars).toBe(200_000 * 4 * 0.35);
    // All 10 mems (10 × ~8K = 80K) fit inside 280K — no compaction
    expect(tb.stable_prefix_compaction).toBeUndefined();
    // All memories should appear
    for (const m of mems) {
      expect(snapshot.compiledPrefixText).toContain(m.id);
    }
  });
});

describe("ContextCompiler", () => {
  it("writes vendor files to the sandbox and refuses the real workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-context-"));
    const workspace = join(root, "project_folder");
    const sandbox = join(root, "sandbox");
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await mkdir(sandbox, { recursive: true });

    const compiler = new ContextCompiler();
    const compiled = await compiler.compile({
      target: "codex_cli",
      taskGoal: "Do the task",
      sandboxDir: sandbox,
      workspacePath: workspace,
      context: {
        user_memory: [serializeMemoryRow(memory(), "user-1")],
        project_folder_memory: [],
        capability_memory: [],
        agent_memory: [],
        system_policy: [],
        recent_session_summary: [],
        relevant_episodes: [],
        evidence_items: [],
        attachments: [],
        active_policies: [],
        stable_prefix_refs: [],
        dynamic_tail_refs: [],
        source_refs: [],
        retrieval_trace: {},
        token_budget: {},
        personal_context_block: "",
      },
    });

    expect(compiled.instruction_file_path).toBe(join(sandbox, "AGENTS.md"));
    await expect(stat(join(sandbox, "AGENTS.md"))).resolves.toBeTruthy();
    await expect(stat(join(workspace, "AGENTS.md"))).rejects.toThrow();
    await expect(readFile(join(sandbox, "AGENTS.md"), "utf8")).resolves.toContain(
      "Do the task",
    );

    await expect(
      compiler.compile({
        target: "codex_cli",
        taskGoal: "Nope",
        sandboxDir: workspace,
        workspacePath: workspace,
        context: {
          user_memory: [],
          project_folder_memory: [],
          capability_memory: [],
          agent_memory: [],
          system_policy: [],
          recent_session_summary: [],
          relevant_episodes: [],
          evidence_items: [],
          attachments: [],
          active_policies: [],
          stable_prefix_refs: [],
          dynamic_tail_refs: [],
          source_refs: [],
          retrieval_trace: {},
          token_budget: {},
          personal_context_block: "",
        },
      }),
    ).rejects.toThrow(/refuses to write/);
  });

  it("loads .agent docs through routing manifests instead of legacy Python filenames", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-context-routing-"));
    const workspace = join(root, "project_folder");
    const sandbox = join(root, "sandbox");
    await mkdir(join(workspace, ".agent", "modules"), { recursive: true });
    await mkdir(sandbox, { recursive: true });
    await writeFile(join(workspace, ".agent", "INDEX.md"), "Root index doc", "utf8");
    await writeFile(
      join(workspace, ".agent", "modules", "context-compiler.md"),
      "TS context compiler routing doc",
      "utf8",
    );
    await writeFile(
      join(workspace, ".agent", "modules", "memory.md"),
      "Legacy Python models.py doc",
      "utf8",
    );

    const compiler = new ContextCompiler();
    const compiled = await compiler.compile({
      target: "codex_cli",
      taskGoal: "Touch context routing",
      sandboxDir: sandbox,
      workspacePath: workspace,
      touchedFiles: ["server/src/modules/context/models.py"],
      context: {
        user_memory: [],
        project_folder_memory: [],
        capability_memory: [],
        agent_memory: [],
        system_policy: [],
        recent_session_summary: [],
        relevant_episodes: [],
        evidence_items: [],
        attachments: [],
        active_policies: [],
        stable_prefix_refs: [],
        dynamic_tail_refs: [],
        source_refs: [],
        retrieval_trace: {},
        token_budget: {},
        personal_context_block: "",
      },
    });

    const instructionText = await readFile(compiled.instruction_file_path!, "utf8");
    expect(instructionText).toContain("TS context compiler routing doc");
    expect(instructionText).not.toContain("Legacy Python models.py doc");
  });

  it("renders explicit artifact attachments into compiled vendor context files", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-context-attachments-"));
    const sandbox = join(root, "sandbox");
    await mkdir(sandbox, { recursive: true });

    const compiler = new ContextCompiler();
    const compiled = await compiler.compile({
      target: "codex_cli",
      taskGoal: "Use the attached evidence.",
      sandboxDir: sandbox,
      budgetChars: 20_000,
      context: {
        user_memory: [],
        project_folder_memory: [],
        capability_memory: [],
        agent_memory: [],
        system_policy: [],
        recent_session_summary: [],
        relevant_episodes: [],
        evidence_items: [],
        attachments: [
          {
            attachment_type: "artifact_evidence_pack",
            artifact_id: "brief-1",
            label: "Context Brief",
            approved: true,
            resolved_content: "Answer: Use the explicit attached brief.",
            policy_snapshot: {
              content_mode: "bounded_summary",
              raw_artifact_content_included: false,
            },
          },
        ],
        active_policies: [],
        stable_prefix_refs: [],
        dynamic_tail_refs: [],
        source_refs: [],
        retrieval_trace: {},
        token_budget: {},
        personal_context_block: "",
      },
    });

    const instructionText = await readFile(compiled.instruction_file_path!, "utf8");
    expect(instructionText).toContain("# Attached Context");
    expect(instructionText).toContain("Context Brief");
    expect(instructionText).toContain("Answer: Use the explicit attached brief.");
  });

  it("reduces a section to 75% when 100% does not fit but 75% does", async () => {
    const compiler = new ContextCompiler();
    // task is mandatory; user_context is large enough that 100% does not fit,
    // while the 75% compacted section still does.
    const longContent = "w".repeat(700);
    const result = await compiler.compile({
      target: "generic",
      taskGoal: "T",
      budgetChars: 700,
      context: {
        user_memory: [serializeMemoryRow(memory({ content: longContent }), "user-1")],
        project_folder_memory: [],
        capability_memory: [],
        agent_memory: [],
        system_policy: [],
        recent_session_summary: [],
        relevant_episodes: [],
        evidence_items: [],
        attachments: [],
        active_policies: [],
        stable_prefix_refs: [],
        dynamic_tail_refs: [],
        source_refs: [],
        retrieval_trace: {},
        token_budget: {},
        personal_context_block: "",
      },
    });

    const compacted = (result.budget_trace.compacted as Array<{ section: string; fraction: number }>);
    expect(compacted.length).toBeGreaterThan(0);
    expect(compacted[0]!.section).toBe("user_context");
    expect(compacted[0]!.fraction).toBe(0.75);
    expect(result.dropped_sections).not.toContain("user_context");
    // Compacted marker present in output
    expect(result.task_prompt).toBe("T");
  });

  it("drops a section entirely when even 50% does not fit within budget", async () => {
    const compiler = new ContextCompiler();
    const result = await compiler.compile({
      target: "generic",
      taskGoal: "Task",
      budgetChars: 15, // only task fits (mandatory)
      context: {
        user_memory: [serializeMemoryRow(memory({ content: "x".repeat(500) }), "user-1")],
        project_folder_memory: [],
        capability_memory: [],
        agent_memory: [],
        system_policy: [],
        recent_session_summary: [],
        relevant_episodes: [],
        evidence_items: [],
        attachments: [],
        active_policies: [],
        stable_prefix_refs: [],
        dynamic_tail_refs: [],
        source_refs: [],
        retrieval_trace: {},
        token_budget: {},
        personal_context_block: "",
      },
    });

    expect(result.dropped_sections).toContain("user_context");
    const compacted = result.budget_trace.compacted as unknown[];
    expect(compacted).toHaveLength(0);
  });

  it("keeps runtime skill instructions under prepared-context budget pressure", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-context-"));
    const sandbox = join(root, "sandbox");
    await mkdir(sandbox, { recursive: true });

    const compiler = new ContextCompiler();
    const result = await compiler.compile({
      target: "codex_cli",
      taskGoal: "Use the generated skill",
      sandboxDir: sandbox,
      budgetChars: 220,
      stablePrefixText: "stable ".repeat(120),
      dynamicTailText: "dynamic ".repeat(120),
      runtimeSkillText: [
        "# Runtime Skills",
        "",
        "## Research Summary",
        "",
        "Generated files:",
        "- .agent-space/generated-skills/codex/research-summary/SKILL.md",
      ].join("\n"),
      context: {
        user_memory: [],
        project_folder_memory: [],
        capability_memory: [],
        agent_memory: [],
        system_policy: [],
        recent_session_summary: [],
        relevant_episodes: [],
        evidence_items: [],
        attachments: [],
        active_policies: [],
        stable_prefix_refs: [],
        dynamic_tail_refs: [],
        source_refs: [],
        retrieval_trace: {},
        token_budget: {},
        personal_context_block: "",
      },
    });

    const instructionText = await readFile(join(sandbox, "AGENTS.md"), "utf8");
    expect(instructionText).toContain("# Runtime Skills");
    expect(instructionText).toContain(
      ".agent-space/generated-skills/codex/research-summary/SKILL.md",
    );
    expect(result.dropped_sections).not.toContain("runtime_skills");
    expect(result.budget_trace.mandatory).toEqual(
      expect.arrayContaining(["task", "runtime_skills"]),
    );
  });

  it("caps an oversized runtime skill section instead of letting it bypass the budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-context-"));
    const sandbox = join(root, "sandbox");
    await mkdir(sandbox, { recursive: true });

    const compiler = new ContextCompiler();
    const result = await compiler.compile({
      target: "codex_cli",
      taskGoal: "Use the generated skill",
      sandboxDir: sandbox,
      budgetChars: 128_000,
      stablePrefixText: "stable",
      dynamicTailText: "dynamic",
      // A large imported SKILL.md rendered as an inline prompt block.
      runtimeSkillText: ["# Runtime Skills", "", "## Big Skill", "", "BODY ".repeat(20_000)].join("\n"),
      context: {
        user_memory: [],
        project_folder_memory: [],
        capability_memory: [],
        agent_memory: [],
        system_policy: [],
        recent_session_summary: [],
        relevant_episodes: [],
        evidence_items: [],
        attachments: [],
        active_policies: [],
        stable_prefix_refs: [],
        dynamic_tail_refs: [],
        source_refs: [],
        retrieval_trace: {},
        token_budget: {},
        personal_context_block: "",
      },
    });

    const instructionText = await readFile(join(sandbox, "AGENTS.md"), "utf8");
    expect(instructionText).toContain("[truncated - section exceeded per-section cap]");
    expect(result.dropped_sections).not.toContain("runtime_skills");
    // Section was ~100KB of body; the per-section cap bounds it well under budget.
    expect(instructionText.length).toBeLessThan(30_000);
    expect(result.total_chars).toBeLessThanOrEqual(result.budget_chars);
  });
});
