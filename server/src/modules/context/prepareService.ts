import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import type { ServerConfig } from "../../config";
import {
  PgRuntimeSkillProvider,
  renderRuntimeSkillCandidate,
  type RenderedRuntimeSkill,
  type RuntimeSkillCandidate,
  type RuntimeSkillProvider,
} from "../capabilities/runtimeSkillProvider";
import { loadActionRegistry } from "../policy/actionRegistry";
import { enforce } from "../policy/service";
import { assertSandboxOnly, ContextCompiler, type CompiledContext } from "./compiler";
import { buildContextPackage } from "./contextPackage";
import { resolveReadableScopes } from "./contextRepositoryHelpers";
import { PgContextProfileRepository } from "./profiles";
import { DEFAULT_CONTEXT_ROUTING_MANIFEST } from "./routingManifest";
import {
  PgRunContextRepository,
  type ContextDigestRow,
  type DigestBundle,
  type RunContextRecord,
} from "./repository";
import type { ContextPackage, PolicyCheckRequest } from "@agent-space/protocol" with {
  "resolution-mode": "import",
};

const COMPILER_VERSION = "context_digest.v1";
const STABLE_PREFIX_BUDGET_CHARS = 64_000; // fallback for unknown models
const STABLE_PREFIX_FRACTION = 0.35; // fraction of model context window allocated to stable prefix

// [regex, context_window_tokens] — first match wins
const MODEL_CONTEXT_WINDOW_TOKENS: Array<[RegExp, number]> = [
  [/^claude-(?:opus|sonnet|haiku)-[4-9]/, 200_000],
  [/^claude-3(?:-5)?-(?:opus|sonnet|haiku)/, 200_000],
  [/^gpt-4o/, 128_000],
  [/^gpt-4/, 128_000],
  [/^gpt-3\.5/, 16_000],
  [/^o[1-9]/, 128_000],
  [/^gemini/, 200_000], // cap at 200K for budget purposes
];

// Priority for stable prefix item selection — lower value = kept first.
// system_prompt/digest (0-9) > policy (10-19) > user memory (20-29) >
// workspace/capability (30-39) > agent (40-49) > episodic (50+)
const STABLE_PREFIX_SCOPE_PRIORITY: Record<string, number> = {
  system: 20,
  user: 25,
  project_folder: 30,
  capability: 32,
  agent: 40,
};
const STABLE_PREFIX_LAYER_PRIORITY: Record<string, number> = {
  semantic: 0,
  procedural: 1,
  episodic: 5,
};

interface StablePrefixResult {
  text: string;
  budgetChars: number;
  droppedCount: number;
  droppedIds: string[];
  truncatedCount: number;
  truncatedIds: string[];
}

const PERSONAL_CONTEXT_HEADER =
  "[Personal context granted for this run - reasoning only]";
const PERSONAL_CONTEXT_WARNING =
  "This personal context is granted for reasoning only. Do not quote or persist it directly.";
const PERSONAL_CONTEXT_FOOTER = "[End personal context]";

export interface ContextPrepareInput {
  runId: string;
  spaceId: string;
  adapterType: string | null;
  sandboxCwd: string | null;
  targetFormat: string | null;
  workspacePath: string | null;
  promptOverride?: string | null;
}

export interface ContextPrepareResult {
  runtime_prompt: string;
  runtime_context_text?: string | null;
  context_snapshot_id: string | null;
  context_rendered: boolean;
  target_format?: string | null;
  instruction_file_path?: string | null;
  runtime_skill_file_paths?: string[];
  runtime_skill_binding_ids?: string[];
  total_chars?: number;
  budget_chars?: number;
  dropped_sections?: string[];
}

export class ContextPrepareError extends Error {
  constructor(
    readonly code:
      | "run_not_found"
      | "policy_denied"
      | "policy_requires_approval"
      | "policy_audit_persist_failed"
      | "context_prepare_failed",
    message: string,
  ) {
    super(message);
    this.name = "ContextPrepareError";
  }
}

export class ContextPrepareService {
  constructor(
    private readonly config: ServerConfig,
    private readonly repository = PgRunContextRepository.fromConfig(config),
    private readonly compiler = new ContextCompiler(),
    private readonly runtimeSkillProvider: RuntimeSkillProvider | null = PgRuntimeSkillProvider.fromConfig(config),
  ) {}

  async prepare(input: ContextPrepareInput): Promise<ContextPrepareResult> {
    try {
      return await this.repository.withTransaction(async (repo) => {
        const run = await repo.loadRun(input.spaceId, input.runId);
        if (!run) {
          throw new ContextPrepareError(
            "run_not_found",
            "Run not found in this space.",
          );
        }
        if (!run.context_snapshot_id) {
          throw new ContextPrepareError(
            "context_prepare_failed",
            `Run ${run.id} has no ContextSnapshot; execution blocked to preserve auditability.`,
          );
        }
        const runtimePrompt = input.promptOverride ?? run.prompt ?? "";

        await this.enforceContextInjectMemory(run);

        const userId = run.instructed_by_user_id || "system";
        const memoryPolicy = recordValue(run.memory_policy_json);
        const includeSystemScope =
          Object.keys(memoryPolicy).length === 0 ||
          arrayOfStrings(memoryPolicy.readable_scopes).includes("system");
        // Same scope gate the direct retriever uses (see repository.retrieve), so
        // digest injection cannot read past the agent's readable_scopes boundary.
        const readableScopes = resolveReadableScopes(memoryPolicy, includeSystemScope);
        const retrieval = await repo.retrieve({
          spaceId: run.space_id,
          userId,
          projectFolderId: run.project_folder_id,
          agentId: run.agent_id,
          query: runtimePrompt,
          agentMemoryPolicy: memoryPolicy,
          includeSystemScope,
          // Project cut: a run bound to project P sees P's memory (only if the
          // instructing user can access P) + project-free memory; a run with no
          // project sees project-free memory only.
          projectId: run.project_id,
        });
        await repo.recordContextMemoryAccess({
          memories: retrieval.memories,
          spaceId: run.space_id,
          userId,
          agentId: run.agent_id,
          runId: run.id,
          reason: `run_execution:${run.id}`,
        });

        const sessionSummary = await repo.loadLatestSessionSummary(
          run.space_id,
          run.session_id,
        );
        await this.enforceContextSelectEvidence(run);
        const evidenceSelections = await repo.selectEvidenceForContext({
          spaceId: run.space_id,
          userId,
          projectFolderId: run.project_folder_id,
          projectId: run.project_id,
          runId: run.id,
        });
        const artifactAttachments = await repo.selectArtifactAttachments({
          spaceId: run.space_id,
          userId,
          projectFolderId: run.project_folder_id,
          projectId: run.project_id,
          artifactIds: contextArtifactIdsForRun(run),
        });
        const pkg = buildContextPackage({
          memories: retrieval.memories,
          activePolicies: retrieval.activePolicies,
          sourceRefs: retrieval.sourceRefs,
          retrievalTrace: retrieval.retrievalTrace,
          tokenBudget: retrieval.tokenBudget,
          userId,
          spaceId: run.space_id,
          projectFolderId: run.project_folder_id,
          sessionSummary,
          evidenceSelections,
          artifactAttachments,
        });

        const digestLoad = await loadDigestBundleSafely(repo, run);
        // Decide which loaded digests are trustworthy enough to inject. Dirty
        // digests and digests whose claimed source memory no longer fully
        // revalidates against the live scope are dropped here, so stale content
        // never reaches the prompt or the snapshot trace. Dropped scopes fall back
        // to the direct retriever (memory) / direct active policies (policy_bundle).
        const { bundle: digestBundle, digestMemoryIds: validatedDigestMemoryIds, dropped } =
          await resolveUsableDigests(repo, run, digestLoad.bundle, readableScopes);
        const digestTrace = buildDigestTrace(
          run,
          digestBundle,
          dropped,
          digestLoad.loadError,
          readableScopes,
        );
        const retrievedMemoryIds = new Set(retrieval.memories.map((memory) => memory.id));
        const digestOnlyMemoryIds = [...validatedDigestMemoryIds]
          .filter((memoryId) => !retrievedMemoryIds.has(memoryId));
        await repo.recordContextDigestMemoryAccess({
          memoryIds: digestOnlyMemoryIds,
          spaceId: run.space_id,
          userId,
          agentId: run.agent_id,
          runId: run.id,
          reason: `run_execution:${run.id}:context_digest`,
        });
        const runtimeSkills = await this.renderRuntimeSkillsForRun(run, input.adapterType);
        const stablePrefixResult = renderStablePrefix(pkg, run, digestBundle, validatedDigestMemoryIds);
        const stableText = stablePrefixResult.text;
        const runtimeSkillText = renderRuntimeSkillContextSection(runtimeSkills);
        const tailText = appendRuntimeSkillText(
          renderDynamicTail(pkg, { ...run, prompt: runtimePrompt }),
          runtimeSkillText,
        );
        const compilerDynamicTailText = renderDynamicTail(pkg, run, { includePrompt: false });
        const runtimeTailText = appendRuntimeSkillText(
          compilerDynamicTailText,
          runtimeSkillText,
        );
        const runtimeContextText = composeRuntimeContextText(stableText, runtimeTailText);
        const tokenBudget = buildTokenBudget(stableText, tailText, stablePrefixResult);
        const sourceRefs: Record<string, unknown>[] = [...pkg.source_refs];
        sourceRefs.push(...digestSourceRefs(digestBundle));
        sourceRefs.push(...runtimeSkillSourceRefs(runtimeSkills));

        const retrievalTrace: Record<string, unknown> = {
          ...recordValue(pkg.retrieval_trace),
          token_budget: tokenBudget,
          ...digestTrace,
          runtime_skill_rendering: runtimeSkillTrace(runtimeSkills),
        };

        const grant = await repo.resolvePersonalGrantForRun(run);
        if (grant.metadata) {
          pkg.personal_context_block = grant.personal_context_block;
          sourceRefs.push({
            source_type: "personal_memory_grant",
            grant_id: grant.metadata.grant_id,
            granting_user_id: grant.metadata.granting_user_id,
            personal_space_id: grant.metadata.personal_space_id,
            target_space_id: grant.metadata.target_space_id,
            access_mode: grant.metadata.access_mode,
            memory_count: grant.metadata.memory_count,
            raw_private_memory_included: false,
            personal_summary_persisted: false,
            section: "ephemeral",
          });
          retrievalTrace.personal_memory_grant = {
            grant_id: grant.metadata.grant_id,
            access_mode: grant.metadata.access_mode,
            memory_count: grant.metadata.memory_count,
            raw_private_memory_included: false,
            personal_summary_persisted: false,
          };
          await repo.markRunPersonalGrantContext({
            runId: run.id,
            spaceId: run.space_id,
            metadata: grant.metadata,
          });
        } else {
          retrievalTrace.personal_memory_grant = null;
        }

        await repo.updateSnapshot({
          snapshotId: run.context_snapshot_id,
          spaceId: run.space_id,
          sourceRefs,
          includedEvidenceRefs: includedEvidenceLikeRefs(sourceRefs),
          retrievalTrace: [retrievalTrace],
          tokenBudget,
          compiledPrefixText: stableText,
          compiledTailText: tailText,
          prefixHash: sha256(stableText),
          tailHash: sha256(tailText),
          compilerVersion: COMPILER_VERSION,
          tokenEstimate: Math.floor((stableText.length + tailText.length) / 4),
          policyBundleVersion: digestBundle.policy_bundle
            ? String(digestBundle.policy_bundle.version)
            : null,
          memoryDigestVersion: digestBundle.agent
            ? String(digestBundle.agent.version)
            : null,
          projectFolderDigestVersion: digestBundle.project_folder
            ? String(digestBundle.project_folder.version)
            : null,
        });

        await this.enforceContextRender(run, input.adapterType);

        const composedRuntimePrompt = composeRuntimePrompt(
          runtimePrompt,
          pkg.personal_context_block,
          upstreamInputsBlock(run.contract_snapshot_json),
        );
        const routingManifest = await this.loadRoutingManifestForRun(run, userId);
        const touchedFiles = contextTouchedFilesForRun(run);
        let compiled: CompiledContext | null = null;
        if (input.sandboxCwd && input.targetFormat) {
          compiled = await this.compiler.compile({
            context: pkg,
            target: input.targetFormat,
            taskGoal: composedRuntimePrompt,
            sandboxDir: input.sandboxCwd,
            workspacePath: input.workspacePath,
            touchedFiles,
            routingManifest,
            stablePrefixText: stableText,
            dynamicTailText: compilerDynamicTailText,
            runtimeSkillText,
          });
        }
        const runtimeSkillFilePaths = input.sandboxCwd
          ? await writeRuntimeSkillFiles(input.sandboxCwd, input.workspacePath, runtimeSkills)
          : [];

        return {
          runtime_prompt: composedRuntimePrompt,
          runtime_context_text: runtimeContextText,
          context_snapshot_id: run.context_snapshot_id,
          context_rendered: compiled !== null,
          target_format: compiled?.target ?? null,
          instruction_file_path: compiled?.instruction_file_path ?? null,
          runtime_skill_file_paths: runtimeSkillFilePaths,
          runtime_skill_binding_ids: runtimeSkills.map((skill) => skill.binding_id),
          total_chars: compiled?.total_chars,
          budget_chars: compiled?.budget_chars,
          dropped_sections: compiled?.dropped_sections,
        };
      });
    } catch (error) {
      if (error instanceof ContextPrepareError) throw error;
      throw new ContextPrepareError(
        "context_prepare_failed",
        `Context preparation failed: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          1000,
        ),
      );
    }
  }

  private async loadRoutingManifestForRun(
    run: RunContextRecord,
    userId: string | null,
  ) {
    if (!this.config.databaseUrl) return DEFAULT_CONTEXT_ROUTING_MANIFEST;
    return PgContextProfileRepository.fromConfig(this.config).loadEffectiveManifestForRun(run, userId);
  }

  private async enforceContextInjectMemory(run: RunContextRecord): Promise<void> {
    await enforcePolicyOrThrow(this.config, {
      action: "context.inject_memory",
      force_record: false,
      actor_type: "run",
      actor_id: run.id,
      space_id: run.space_id,
      resource_type: "memory",
      run_id: run.id,
      context: {
        trigger_origin: run.trigger_origin ?? "manual",
      },
      metadata_json: {
        agent_id: run.agent_id,
        project_folder_id: run.project_folder_id,
        data_exposure_level: run.data_exposure_level,
        trust_level: run.trust_level,
        has_personal_grant_context: Boolean(run.has_personal_grant_context),
      },
    });
  }

  private async enforceContextRender(
    run: RunContextRecord,
    adapterType: string | null,
  ): Promise<void> {
    await enforcePolicyOrThrow(this.config, {
      action: "context.render_for_runtime",
      force_record: false,
      actor_type: "run",
      actor_id: run.id,
      space_id: run.space_id,
      resource_type: "context",
      resource_id: run.context_snapshot_id,
      run_id: run.id,
      context: {
        has_personal_grant_context: Boolean(run.has_personal_grant_context),
      },
      metadata_json: {
        context_snapshot_id: run.context_snapshot_id,
        adapter_type: adapterType,
        data_exposure_level: run.data_exposure_level,
        trust_level: run.trust_level,
      },
    });
  }

  private async enforceContextSelectEvidence(run: RunContextRecord): Promise<void> {
    await enforcePolicyOrThrow(this.config, {
      action: "context.select_evidence",
      force_record: false,
      actor_type: "run",
      actor_id: run.id,
      space_id: run.space_id,
      resource_type: "evidence",
      run_id: run.id,
      context: {
        project_folder_id: run.project_folder_id,
        project_id: run.project_id,
      },
      metadata_json: {
        project_folder_id: run.project_folder_id,
        project_id: run.project_id,
      },
    });
  }

  private async renderRuntimeSkillsForRun(
    run: RunContextRecord,
    adapterType: string | null,
  ): Promise<RenderedRuntimeSkill[]> {
    if (!this.runtimeSkillProvider || !adapterType) return [];
    const candidates = await this.runtimeSkillProvider.loadCandidatesForRun({
      space_id: run.space_id,
      run_id: run.id,
      adapter_type: adapterType,
      capability_id: run.capability_id,
      agent_id: run.agent_id,
      project_id: run.project_id,
      instructed_by_user_id: run.instructed_by_user_id,
      capabilities_json: run.capabilities_json,
    });
    const rendered: RenderedRuntimeSkill[] = [];
    for (const candidate of candidates) {
      await this.enforceRuntimeSkillRender(run, candidate);
      const item = renderRuntimeSkillCandidate(candidate);
      if (item) rendered.push(item);
    }
    return rendered;
  }

  private async enforceRuntimeSkillRender(
    run: RunContextRecord,
    candidate: RuntimeSkillCandidate,
  ): Promise<void> {
    await enforcePolicyOrThrow(this.config, {
      action: "runtime_skill.render",
      force_record: false,
      actor_type: "run",
      actor_id: run.id,
      space_id: run.space_id,
      resource_type: "runtime_skill_binding",
      resource_id: candidate.binding_id,
      run_id: run.id,
      context: {
        adapter_type: candidate.runtime_adapter_type,
        render_mode: candidate.render_mode,
        capability_id: candidate.capability_id,
        capability_version_id: candidate.capability_version_id,
        capability_enablement_id: candidate.capability_enablement_id,
        enabled_binding: true,
        risk_level: candidate.risk_level,
      },
      metadata_json: {
        binding_id: candidate.binding_id,
        capability_id: candidate.capability_id,
        capability_version_id: candidate.capability_version_id,
        capability_enablement_id: candidate.capability_enablement_id,
        adapter_type: candidate.runtime_adapter_type,
        render_mode: candidate.render_mode,
        risk_level: candidate.risk_level,
      },
    });
  }
}

function includedEvidenceLikeRefs(sourceRefs: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return sourceRefs.filter((ref) => {
    if (ref.source_type === "evidence") return true;
    return ref.source_type === "artifact" && ref.attachment_type === "artifact_evidence_pack";
  });
}

async function enforcePolicyOrThrow(
  config: ServerConfig,
  request: PolicyCheckRequest,
): Promise<void> {
  const registry = await loadActionRegistry();
  const result = await enforce(config, registry, request);
  if (result.status === "allow") return;
  throw new ContextPrepareError(
    result.error_code ?? "policy_denied",
    result.message ?? "Policy denied context preparation.",
  );
}

async function loadDigestBundleSafely(
  repo: PgRunContextRepository,
  run: RunContextRecord,
): Promise<{ bundle: DigestBundle; loadError: string | null }> {
  try {
    const bundle = await repo.loadDigestBundle({
      spaceId: run.space_id,
      projectFolderId: run.project_folder_id,
      agentId: run.agent_id,
    });
    return { bundle, loadError: null };
  } catch (error) {
    return {
      bundle: { policy_bundle: null, project_folder: null, agent: null },
      loadError: `${error instanceof Error ? error.name : "Error"}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

interface DroppedDigest {
  digest_type: "policy_bundle" | "project_folder" | "agent";
  reason: "dirty" | "stale_source_memory" | "scope_not_readable";
}

/**
 * Decide which loaded digests are trustworthy enough to inject into the prompt.
 *
 * A digest is dropped (its scope then falls back to the direct retriever / direct
 * active policies) when:
 *  - (memory digests only) the agent's `readable_scopes` does not include that
 *    scope — the digest is a derived view of that scope's memory, so injecting it
 *    would bypass the same read boundary the direct retriever enforces; or
 *  - it is `dirty` — a pending change means the cached content may be stale; or
 *  - (memory digests only) any memory id it claims as a source no longer passes
 *    live revalidation for its scope (archived / superseded / downgraded to
 *    private or highly_restricted). The content is a blended summary that cannot
 *    be partially redacted, so the whole digest is dropped.
 *
 * Only surviving digests are rendered, traced and source-ref'd, so a stale or
 * tampered row can never leak old content (or out-of-scope content) into the
 * prompt or the snapshot trace.
 */
async function resolveUsableDigests(
  repo: PgRunContextRepository,
  run: RunContextRecord,
  loaded: DigestBundle,
  readableScopes: ReadonlySet<string>,
): Promise<{ bundle: DigestBundle; digestMemoryIds: Set<string>; dropped: DroppedDigest[] }> {
  const dropped: DroppedDigest[] = [];
  const digestMemoryIds = new Set<string>();

  let policyBundle: ContextDigestRow | null = null;
  if (loaded.policy_bundle) {
    if (loaded.policy_bundle.status === "active") {
      policyBundle = loaded.policy_bundle;
    } else {
      // Dirty policy bundle: fall back to the direct active policies so a pending
      // policy change cannot suppress the current security/boundary policies.
      dropped.push({ digest_type: "policy_bundle", reason: "dirty" });
    }
  }

  const workspace = await resolveMemoryDigest(
    repo, run, "project_folder", run.project_folder_id, loaded.project_folder, readableScopes, dropped,
  );
  for (const id of workspace.validatedIds) digestMemoryIds.add(id);
  const agent = await resolveMemoryDigest(
    repo, run, "agent", run.agent_id, loaded.agent, readableScopes, dropped,
  );
  for (const id of agent.validatedIds) digestMemoryIds.add(id);

  return {
    bundle: { policy_bundle: policyBundle, project_folder: workspace.digest, agent: agent.digest },
    digestMemoryIds,
    dropped,
  };
}

async function resolveMemoryDigest(
  repo: PgRunContextRepository,
  run: RunContextRecord,
  scopeType: "project_folder" | "agent",
  scopeId: string | null,
  digest: ContextDigestRow | null,
  readableScopes: ReadonlySet<string>,
  dropped: DroppedDigest[],
): Promise<{ digest: ContextDigestRow | null; validatedIds: string[] }> {
  if (!digest || !scopeId) return { digest: null, validatedIds: [] };
  if (!readableScopes.has(scopeType)) {
    // The agent is not allowed to read this scope's memory; the direct retriever
    // already excludes it, so the derived digest must be excluded too.
    dropped.push({ digest_type: scopeType, reason: "scope_not_readable" });
    return { digest: null, validatedIds: [] };
  }
  if (digest.status !== "active") {
    dropped.push({ digest_type: scopeType, reason: "dirty" });
    return { digest: null, validatedIds: [] };
  }
  const parsed = parseDigestSourceMemoryIds(digest.source_memory_ids_json);
  if (parsed.malformed || (parsed.ids.length === 0 && digest.content?.trim())) {
    // Malformed source metadata is treated as stale/tampered. A memory digest's
    // content is a blended artifact, so without a valid complete source list we
    // cannot prove what it covers.
    dropped.push({ digest_type: scopeType, reason: "stale_source_memory" });
    return { digest: null, validatedIds: [] };
  }
  const claimed = parsed.ids;
  const validated = await repo.filterEligibleDigestMemoryIds({
    spaceId: run.space_id,
    scopeType,
    scopeId,
    memoryIds: claimed,
  });
  const validatedSet = new Set(validated);
  if (!claimed.every((id) => validatedSet.has(id))) {
    // At least one claimed source memory is no longer eligible — the cached
    // summary may embed removed/downgraded content. Drop the whole digest.
    dropped.push({ digest_type: scopeType, reason: "stale_source_memory" });
    return { digest: null, validatedIds: [] };
  }
  return { digest, validatedIds: validated };
}

function buildDigestTrace(
  run: RunContextRecord,
  usable: DigestBundle,
  dropped: DroppedDigest[],
  loadError: string | null,
  readableScopes: ReadonlySet<string>,
): Record<string, unknown> {
  if (loadError) {
    return {
      digest_used: false,
      fallback_to_memory_retriever: true,
      digest_fallback_reason: "load_error",
      digest_load_error: loadError,
    };
  }
  const missingTypes = expectedDigestTypes(run, readableScopes)
    .filter((type) => !usable[type]);
  const used = digestUsed(usable);
  return {
    digest_used: used,
    digest_ids: allDigests(usable).map((d) => d.id),
    digest_types: allDigests(usable).map((d) => d.digest_type),
    digest_versions: allDigests(usable).map((d) => Number(d.version)),
    digest_dropped: dropped,
    fallback_to_memory_retriever: missingTypes.length > 0,
    digest_missing_types: missingTypes,
    digest_fallback_reason: missingTypes.length > 0
      ? used
        ? "missing_digest_for_scope"
        : "no_digest_available"
      : null,
  };
}

function expectedDigestTypes(
  run: RunContextRecord,
  readableScopes: ReadonlySet<string>,
): Array<keyof DigestBundle> {
  const types: Array<keyof DigestBundle> = ["policy_bundle"];
  if (run.project_folder_id && readableScopes.has("project_folder")) types.push("project_folder");
  if (run.agent_id && readableScopes.has("agent")) types.push("agent");
  return types;
}

function renderStablePrefix(
  pkg: ContextPackage,
  run: RunContextRecord,
  digestBundle: DigestBundle,
  digestMemoryIds: Set<string>,
): StablePrefixResult {
  interface PrefixItem { priority: number; id: string; text: string; }
  const items: PrefixItem[] = [];

  if (run.system_prompt?.trim()) {
    items.push({ priority: 0, id: "system_prompt", text: `[system_prompt]\n${run.system_prompt.trim()}` });
  }

  for (const digest of allDigests(digestBundle)) {
    if (digest.content?.trim()) {
      items.push({
        priority: 5,
        id: `digest:${digest.id}`,
        text: `[digest:${digest.digest_type}:v${digest.version}]\n${digest.content.trim()}`,
      });
    }
  }

  if (!digestBundle.policy_bundle) {
    let policyRank = 0;
    for (const policy of pkg.active_policies) {
      const p = recordValue(policy);
      const name = stringValue(p.name) ?? stringValue(p.id) ?? "policy";
      const domain = stringValue(p.domain) ?? "";
      items.push({
        priority: 10 + policyRank,
        id: `policy:${String(p.id ?? "unknown")}`,
        text: `[policy:${domain}:${name}]\n${JSON.stringify(recordValue(p.policy_json))}`,
      });
      policyRank++;
    }
  }

  const stableIds = new Set(
    pkg.stable_prefix_refs
      .filter((r) => r.source_type === "memory" && typeof r.source_id === "string")
      .map((r) => r.source_id as string),
  );
  const memorySections = [
    pkg.system_policy,
    pkg.user_memory,
    pkg.project_folder_memory,
    pkg.capability_memory,
    pkg.agent_memory,
  ];
  for (const section of memorySections) {
    for (const memory of section) {
      if (!stableIds.has(memory.id)) continue;
      if (digestMemoryIds.has(memory.id)) continue;
      const scopePri = STABLE_PREFIX_SCOPE_PRIORITY[memory.scope_type as string] ?? 50;
      const layerPri = STABLE_PREFIX_LAYER_PRIORITY[memory.memory_layer as string] ?? 3;
      items.push({
        priority: scopePri + layerPri,
        id: memory.id,
        text: `[memory:${memory.id}:${memory.title ?? ""}]\n${memory.content ?? ""}`,
      });
    }
  }

  // Sort by priority (lower = higher importance = keep first), stable on id for determinism.
  items.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const budgetChars = computeStablePrefixBudgetChars(run.model_config_json);
  const kept: string[] = [];
  const droppedIds: string[] = [];
  const truncatedIds: string[] = [];
  let usedChars = 0;

  for (const item of items) {
    const sep = kept.length > 0 ? 2 : 0;
    const fullCost = item.text.length + sep;
    if (usedChars + fullCost <= budgetChars) {
      kept.push(item.text);
      usedChars += fullCost;
    } else {
      // Try 50% reduction before dropping entirely.
      const truncated = fitStablePrefixItem(item.text);
      const truncCost = truncated.length + sep;
      if (usedChars + truncCost <= budgetChars) {
        kept.push(truncated);
        usedChars += truncCost;
        truncatedIds.push(item.id);
      } else {
        droppedIds.push(item.id);
      }
    }
  }

  return {
    text: kept.join("\n\n"),
    budgetChars,
    droppedCount: droppedIds.length,
    droppedIds,
    truncatedCount: truncatedIds.length,
    truncatedIds,
  };
}

function computeStablePrefixBudgetChars(modelConfigJson: unknown): number {
  const config = recordValue(modelConfigJson);
  const modelName = stringValue(config.model) ?? stringValue(config.model_name);
  if (modelName) {
    for (const [pattern, tokens] of MODEL_CONTEXT_WINDOW_TOKENS) {
      if (pattern.test(modelName)) {
        return Math.floor(tokens * 4 * STABLE_PREFIX_FRACTION);
      }
    }
  }
  if (typeof config.context_window === "number" && config.context_window > 0) {
    return Math.floor(config.context_window * 4 * STABLE_PREFIX_FRACTION);
  }
  return STABLE_PREFIX_BUDGET_CHARS;
}

function fitStablePrefixItem(text: string): string {
  const targetChars = Math.floor(text.length * 0.5);
  const slice = text.slice(0, targetChars);
  const lastNewline = slice.lastIndexOf("\n");
  const cutAt = lastNewline > 0 && lastNewline > targetChars * 0.75 ? lastNewline : targetChars;
  return `${text.slice(0, cutAt)}\n\n> [compacted to 50% — stable prefix budget]`;
}

function renderDynamicTail(
  pkg: ContextPackage,
  run: RunContextRecord,
  options: { includePrompt?: boolean } = {},
): string {
  const includePrompt = options.includePrompt !== false;
  const parts: string[] = [];
  const dynamicIds = new Set(
    pkg.dynamic_tail_refs
      .filter((r) => r.source_type === "memory" && typeof r.source_id === "string")
      .map((r) => r.source_id as string),
  );
  for (const memory of pkg.relevant_episodes) {
    if (dynamicIds.size > 0 && !dynamicIds.has(memory.id)) continue;
    parts.push(`[episode:${memory.id}:${memory.title ?? ""}]\n${memory.content ?? ""}`);
  }
  if (includePrompt && run.prompt?.trim()) {
    parts.push(`[prompt]\n${run.prompt.trim()}`);
  }
  for (const evidence of pkg.evidence_items) {
    const ev = recordValue(evidence);
    const excerpt = stringValue(ev.content_excerpt);
    if (!excerpt) continue;
    parts.push(
      `[evidence:${stringValue(ev.id) ?? ""}:${stringValue(ev.title) ?? "evidence"}]\n${excerpt}`,
    );
  }
  for (const attachment of pkg.attachments) {
    const item = recordValue(attachment);
    const label = stringValue(item.label) ?? stringValue(item.attachment_type) ?? "attachment";
    if (item.approved === false) {
      parts.push(
        `[attachment_blocked:${label}]\n${stringValue(item.rejection_reason) ?? "security policy"}`,
      );
      continue;
    }
    const content = stringValue(item.resolved_content);
    if (!content) continue;
    parts.push(`[attachment:${label}]\n${content}`);
  }
  return parts.join("\n\n");
}

function composeRuntimeContextText(stableText: string, tailText: string): string | null {
  const parts = [stableText.trim(), tailText.trim()].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function renderRuntimeSkillContextSection(skills: RenderedRuntimeSkill[]): string {
  if (skills.length === 0) return "";
  const parts = ["# Runtime Skills"];
  for (const skill of skills) {
    const rendered = skill.rendered;
    const lines = [
      `## ${skill.capability.name}`,
      "",
      `Capability ID: ${skill.capability_id}`,
      `Binding ID: ${skill.binding_id}`,
      `Version ID: ${skill.capability_version_id}`,
      `Adapter: ${skill.runtime_adapter_type}`,
      `Render mode: ${skill.render_mode}`,
    ];
    if (rendered.files.length > 0) {
      lines.push(
        "",
        "Generated files:",
        ...rendered.files.map((file) => `- ${file.path}`),
        "",
        "Use these generated adapter files as run-scoped skill instructions. They are not source of truth.",
      );
    }
    if (rendered.prompt_block?.trim()) {
      lines.push("", rendered.prompt_block.trim());
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

function appendRuntimeSkillText(base: string, runtimeSkillText: string): string {
  const parts = [base.trim(), runtimeSkillText.trim()].filter((part) => part.length > 0);
  return parts.join("\n\n");
}

function runtimeSkillSourceRefs(skills: RenderedRuntimeSkill[]): Record<string, unknown>[] {
  return skills.map((skill) => ({
    source_type: "runtime_skill_binding",
    source_id: skill.binding_id,
    binding_id: skill.binding_id,
    capability_id: skill.capability_id,
    capability_version_id: skill.capability_version_id,
    capability_enablement_id: skill.capability_enablement_id,
    runtime_adapter_type: skill.runtime_adapter_type,
    render_mode: skill.render_mode,
    risk_level: skill.risk_level,
    section: "runtime_skills",
    root_path: skill.rendered.root_path,
    file_paths: skill.rendered.files.map((file) => file.path),
    file_hashes: skill.rendered.files.map((file) => ({
      path: file.path,
      content_hash: sha256(file.content),
    })),
    prompt_block_hash: skill.rendered.prompt_block ? sha256(skill.rendered.prompt_block) : null,
    raw_content_in_trace: false,
  }));
}

function runtimeSkillTrace(skills: RenderedRuntimeSkill[]): Record<string, unknown> {
  return {
    rendered_count: skills.length,
    bindings: skills.map((skill) => ({
      binding_id: skill.binding_id,
      capability_id: skill.capability_id,
      capability_version_id: skill.capability_version_id,
      runtime_adapter_type: skill.runtime_adapter_type,
      render_mode: skill.render_mode,
      risk_level: skill.risk_level,
      files_count: skill.rendered.files.length,
      prompt_block_rendered: Boolean(skill.rendered.prompt_block),
    })),
  };
}

async function writeRuntimeSkillFiles(
  sandboxCwd: string,
  workspacePath: string | null | undefined,
  skills: RenderedRuntimeSkill[],
): Promise<string[]> {
  // Self-contained boundary: never write generated vendor files into the real
  // workspace, even if the caller reaches here without the compiler having run.
  await assertSandboxOnly(sandboxCwd, workspacePath ?? null);
  const written: string[] = [];
  const sandboxRoot = resolve(sandboxCwd);
  for (const skill of skills) {
    for (const file of skill.rendered.files) {
      const target = resolveSandboxRelativePath(sandboxRoot, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
      written.push(target);
    }
  }
  return written;
}

function resolveSandboxRelativePath(sandboxRoot: string, filePath: string): string {
  if (!filePath.trim() || filePath.startsWith("/") || filePath.includes("\0")) {
    throw new Error(`Runtime skill file path must be a relative sandbox path: ${filePath}`);
  }
  const target = resolve(join(sandboxRoot, filePath));
  const rel = relative(sandboxRoot, target);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/") || rel.includes(`..${"/"}`)) {
    throw new Error(`Runtime skill file path escapes sandbox: ${filePath}`);
  }
  return target;
}

function buildTokenBudget(
  stableText: string,
  tailText: string,
  stableCompaction: StablePrefixResult,
): Record<string, unknown> {
  const stableChars = stableText.length;
  const tailChars = tailText.length;
  const totalChars = stableChars + tailChars;
  const stablePct = Math.round((stableChars / Math.max(totalChars, 1)) * 1000) / 10;
  const budget: Record<string, unknown> = {
    stable_prefix_chars: stableChars,
    dynamic_tail_chars: tailChars,
    total_chars: totalChars,
    stable_prefix_budget_chars: stableCompaction.budgetChars,
    stable_prefix_pct: stablePct,
    stable_prefix_target_pct: 50,
    compiler_version: COMPILER_VERSION,
  };
  if (stableCompaction.droppedCount > 0 || stableCompaction.truncatedCount > 0) {
    budget.stable_prefix_compaction = {
      applied: true,
      items_dropped: stableCompaction.droppedCount,
      dropped_ids: stableCompaction.droppedIds,
      items_truncated: stableCompaction.truncatedCount,
      truncated_ids: stableCompaction.truncatedIds,
    };
  }
  if (stablePct > 50) {
    budget.stable_prefix_warning = `stable_prefix occupies ${stablePct}% of total context (target <= 50%)`;
  }
  return budget;
}

// Only ever called with the *usable* bundle (post-resolution), so the claimed
// source ids it records are already fully revalidated — a stale/tampered digest
// is dropped before this point and never contributes a (possibly wrong) trace.
function digestSourceRefs(bundle: DigestBundle): Record<string, unknown>[] {
  return allDigests(bundle).map((digest) => ({
    source_type: "context_digest",
    source_id: digest.id,
    digest_type: digest.digest_type,
    digest_version: Number(digest.version),
    section: "stable_prefix",
    source_memory_ids: arrayValue(digest.source_memory_ids_json),
    source_policy_ids: arrayValue(digest.source_policy_ids_json),
    source_relation_ids: arrayValue(digest.source_relation_ids_json),
    source_hash: digest.source_hash,
    content_hash: digest.content_hash,
    status: digest.status,
  }));
}

function digestUsed(bundle: DigestBundle): boolean {
  return allDigests(bundle).length > 0;
}

function allDigests(bundle: DigestBundle): ContextDigestRow[] {
  return [bundle.policy_bundle, bundle.project_folder, bundle.agent].filter(
    (row): row is ContextDigestRow => row !== null,
  );
}

function contextArtifactIdsForRun(run: RunContextRecord): string[] {
  const request = recordValue(run.request_json);
  return arrayOfStrings(request.context_artifact_ids).slice(0, 8);
}

function contextTouchedFilesForRun(run: RunContextRecord): string[] {
  const request = recordValue(run.request_json);
  return [
    ...arrayOfStrings(request.touched_files),
    ...arrayOfStrings(request.context_touched_files),
  ].slice(0, 100);
}

function composeRuntimePrompt(userPrompt: string, personalContextBlock: string, upstreamBlock = ""): string {
  const parts = [userPrompt];
  const personal = personalContextBlock.trim();
  if (personal) parts.push(PERSONAL_CONTEXT_HEADER, PERSONAL_CONTEXT_WARNING, personal, PERSONAL_CONTEXT_FOOTER);
  if (upstreamBlock.trim()) parts.push("## Upstream inputs", upstreamBlock.trim());
  return parts.filter(Boolean).join("\n\n");
}

function upstreamInputsBlock(contract: unknown): string {
  const upstream = recordValue(recordValue(contract).upstream_inputs_json);
  const bindings = Array.isArray(upstream.bindings) ? upstream.bindings : [];
  if (bindings.length === 0) return "";
  return bindings.map((item) => {
    const binding = recordValue(item);
    const value = typeof binding.value === "string" ? binding.value : JSON.stringify(binding.value ?? null);
    return [
      `### ${String(binding.name ?? "input")}`,
      `Source node: ${String(binding.from_node ?? "unknown")}`,
      `Source run: ${String(binding.source_run_id ?? "none")}`,
      value,
      binding.truncated === true ? "[input was truncated by the context budget]" : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseDigestSourceMemoryIds(
  value: unknown,
): { ids: string[]; malformed: boolean } {
  if (!Array.isArray(value)) return { ids: [], malformed: true };
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      return { ids: [], malformed: true };
    }
    ids.push(item);
  }
  return { ids, malformed: false };
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
