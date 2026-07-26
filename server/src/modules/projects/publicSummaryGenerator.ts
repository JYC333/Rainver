import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import {
  HttpError,
  numberValue,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { resolveProviderCommandStore, type ProviderCommandStore } from "../providers/commands/store";
import {
  ProviderInvocationError,
  completeProviderText,
} from "../providers/invocation/invocation";
import type { MemoryAuthFields } from "../memory/memoryReadAuth";
import { contentResourceDefinition } from "../access/contentAccessRegistry";
import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql";
import { writePolicyAudit } from "../policy/auditWriter";
import { assertProjectWriter } from "./access";
import {
  PROJECT_PUBLIC_SUMMARY_PROMPT_VERSION,
  buildProjectPublicSummaryPrompt,
  parseGeneratedPublicSummary,
  sourceKey,
  type PublicSummaryPromptContext,
  type PublicSummarySourceRef,
} from "./publicSummaryPrompt";
import { PgProjectRepository } from "./repository";

export const PROJECT_PUBLIC_SUMMARY_TASK = "project_public_summary";
export {
  PROJECT_PUBLIC_SUMMARY_PROMPT_VERSION,
  PROJECT_PUBLIC_SUMMARY_REDACTION_VERSION,
} from "./publicSummaryPrompt";

const DEFAULT_MAX_TOKENS = 1200;
const MAX_MAX_TOKENS = 3000;

interface ProjectContextRow {
  id: string;
  name: string;
  description: string | null;
  current_focus: string | null;
}

interface GeneratorMemoryRow extends MemoryAuthFields {
  id: string;
  namespace: string | null;
  memory_type: string;
  title: string | null;
  content: string | null;
  tags: unknown;
  importance: number | string;
  updated_at: unknown;
  source_trust: string | null;
}
const MEMORY_DEFINITION = contentResourceDefinition("memory")!;

interface ActivityContextRow {
  id: string;
  activity_type: string;
  title: string | null;
  content: string | null;
  visibility: string;
  owner_user_id: string | null;
  user_id: string | null;
  subject_user_id: string | null;
  occurred_at: unknown;
}

interface ArtifactContextRow {
  id: string;
  artifact_type: string;
  title: string;
  mime_type: string | null;
  visibility: string;
  owner_user_id: string | null;
  created_at: unknown;
}

interface ProposalContextRow {
  id: string;
  proposal_type: string;
  status: string;
  title: string;
  rationale: string | null;
  visibility: string;
  created_by_user_id: string | null;
  instructed_by_user_id: string | null;
  created_at: unknown;
}

interface GeneratorContext extends PublicSummaryPromptContext {
  project: ProjectContextRow;
  viewerUserId: string;
  memories: GeneratorMemoryRow[];
  activities: ActivityContextRow[];
  artifacts: ArtifactContextRow[];
  proposals: ProposalContextRow[];
  allowedSourceRefs: Map<string, PublicSummarySourceRef>;
}

export interface GeneratePublicSummaryInput {
  providerId?: string | null;
  model?: string | null;
  maxTokens?: number | null;
  generatedByRunId?: string | null;
}

type CompleteText = (
  spaceId: string,
  input: {
    providerId: string;
    model: string | null;
    system: string;
    user: string;
    maxTokens: number;
    subjectUserId: string;
  },
) => Promise<{ text: string; model: string; usage: Record<string, unknown> }>;

export class ProjectPublicSummaryGenerator {
  constructor(
    private readonly db: Queryable,
    private readonly store: ProviderCommandStore,
    private readonly completeText: CompleteText = providerCompleteText(store),
    // Set in `fromConfig`; left null in unit tests so the best-effort audit
    // write is skipped without a real connection.
    private readonly databaseUrl: string | null = null,
  ) {}

  static fromConfig(config: ServerConfig): ProjectPublicSummaryGenerator {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    const store = resolveProviderCommandStore(config);
    return new ProjectPublicSummaryGenerator(
      getDbPool(config.databaseUrl),
      store,
      providerCompleteText(store),
      config.databaseUrl,
    );
  }

  async generateDraft(
    identity: SpaceUserIdentity,
    projectId: string,
    input: GeneratePublicSummaryInput,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const providerId = input.providerId ?? "";
    const taskChain = await this.store.getTaskChain(identity.spaceId, PROJECT_PUBLIC_SUMMARY_TASK);
    if (!providerId && !taskChain) {
      throw new HttpError(
        422,
        `model_provider_id is required unless provider task policy '${PROJECT_PUBLIC_SUMMARY_TASK}' is configured`,
      );
    }

    const context = await this.loadContext(identity, projectId);
    const prompt = buildProjectPublicSummaryPrompt(context);
    let completion: { text: string; model: string; usage: Record<string, unknown> };
    try {
      completion = await this.completeText(identity.spaceId, {
        providerId,
        model: input.model ?? null,
        system: prompt.system,
        user: prompt.user,
        maxTokens: clampMaxTokens(input.maxTokens),
        subjectUserId: identity.userId,
      });
    } catch (error) {
      if (error instanceof ProviderInvocationError) {
        throw new HttpError(error.statusCode, error.message);
      }
      throw new HttpError(502, "Project public summary generation failed");
    }

    const generated = parseGeneratedPublicSummary(completion.text, context.allowedSourceRefs);
    const summary = await new PgProjectRepository(this.db).upsertPublicSummary(identity, projectId, {
      ...generated,
      generated_by_run_id: input.generatedByRunId ?? undefined,
      review_status: "draft",
    });
    await this.recordGenerationAudit(identity, projectId, {
      providerId,
      model: completion.model,
      sourceCounts: {
        memories: context.memories.length,
        activities: context.activities.length,
        artifacts: context.artifacts.length,
        proposals: context.proposals.length,
      },
    });
    return {
      ...summary,
      generator: {
        prompt_version: PROJECT_PUBLIC_SUMMARY_PROMPT_VERSION,
        model: completion.model,
        usage: completion.usage,
        source_counts: {
          memories: context.memories.length,
          activities: context.activities.length,
          artifacts: context.artifacts.length,
          proposals: context.proposals.length,
        },
      },
    };
  }

  /**
   * Durable, best-effort audit that authorized project context was sent to a
   * model provider to generate a public summary draft. Records pointer metadata
   * only (counts, provider id, model, prompt version) — never project content.
   * A failure here must not fail the user-facing draft generation.
   */
  private async recordGenerationAudit(
    identity: SpaceUserIdentity,
    projectId: string,
    info: { providerId: string; model: string; sourceCounts: Record<string, number> },
  ): Promise<void> {
    if (!this.databaseUrl) return;
    try {
      await writePolicyAudit(this.databaseUrl, {
        space_id: identity.spaceId,
        actor_type: "user",
        actor_id: identity.userId,
        action: "project.public_summary.generate",
        resource_type: "project_public_summary",
        resource_id: projectId,
        decision: "allow",
        risk_level: "low",
        audit_code: "project_public_summary.generate",
        metadata_json: {
          task: PROJECT_PUBLIC_SUMMARY_TASK,
          prompt_version: PROJECT_PUBLIC_SUMMARY_PROMPT_VERSION,
          provider_id: info.providerId || null,
          model: info.model,
          source_counts: info.sourceCounts,
        },
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      process.stderr.write(
        `[projects.publicSummary] generation audit write failed: ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }

  private async loadContext(identity: SpaceUserIdentity, projectId: string): Promise<GeneratorContext> {
    const project = await this.loadProject(identity.spaceId, projectId);
    if (!project) throw new HttpError(404, "Project not found");
    const [memories, activities, artifacts, proposals] = await Promise.all([
      this.loadMemories(identity, projectId),
      this.loadActivities(identity, projectId),
      this.loadArtifacts(identity, projectId),
      this.loadProposals(identity, projectId),
    ]);
    const allowedSourceRefs = new Map<string, PublicSummarySourceRef>();
    addAllowedSource(allowedSourceRefs, {
      source_type: "project",
      source_id: project.id,
      label: project.name,
      trust_level: "owner_reviewed",
    });
    for (const memory of memories) {
      addAllowedSource(allowedSourceRefs, {
        source_type: "memory",
        source_id: memory.id,
        label: memory.title ?? memory.memory_type,
        trust_level: memory.source_trust ?? "derived",
      });
    }
    for (const activity of activities) {
      addAllowedSource(allowedSourceRefs, {
        source_type: "activity",
        source_id: activity.id,
        label: activity.title ?? activity.activity_type,
        trust_level: "derived",
      });
    }
    for (const artifact of artifacts) {
      addAllowedSource(allowedSourceRefs, {
        source_type: "artifact",
        source_id: artifact.id,
        label: artifact.title,
        trust_level: "derived",
      });
    }
    for (const proposal of proposals) {
      addAllowedSource(allowedSourceRefs, {
        source_type: "proposal",
        source_id: proposal.id,
        label: proposal.title,
        trust_level: "derived",
      });
    }
    return {
      project,
      viewerUserId: identity.userId,
      memories,
      activities,
      artifacts,
      proposals,
      allowedSourceRefs,
    };
  }

  private async loadProject(spaceId: string, projectId: string): Promise<ProjectContextRow | null> {
    const result = await this.db.query<ProjectContextRow>(
      `SELECT id, name, description, current_focus
         FROM projects
        WHERE id = $1
          AND space_id = $2
          AND deleted_at IS NULL
        LIMIT 1`,
      [projectId, spaceId],
    );
    return result.rows[0] ?? null;
  }

  // loadMemories/loadActivities/loadArtifacts/loadProposals all pass
  // includeOversight: false — their output can become a `review_status =
  // 'approved'` project public summary, readable by the whole Space. Space
  // oversight is a read-only capability for the admin's own browsing; it must
  // not let another member's otherwise-private content flow into a
  // space-wide published artifact just because the triggering owner/admin
  // happens to have oversight visibility (Decision Matrix #4/#7).
  private async loadMemories(identity: SpaceUserIdentity, projectId: string): Promise<GeneratorMemoryRow[]> {
    const result = await this.db.query<GeneratorMemoryRow>(
      `SELECT me.id, me.space_id, me.subject_user_id, me.owner_user_id, me.project_folder_id,
              scope_type, namespace, memory_type, title, content, visibility,
              access_level, ${contentAccessLevelSql({ definition: MEMORY_DEFINITION, alias: "me", userExpr: "$3", includeOversight: false })} AS effective_access_level,
              sensitivity_level, tags, importance, updated_at,
              source_trust, project_id, deleted_at
         FROM memory_entries me
        WHERE space_id = $1
          AND project_id = $2
          AND status = 'active'
          AND deleted_at IS NULL
          AND sensitivity_level <> 'highly_restricted'
          AND scope_type <> 'system'
          AND ${contentReadSql("memory", "me", "$3", { includeOversight: false })}
        ORDER BY importance DESC, updated_at DESC, id DESC
        LIMIT 24`,
      [identity.spaceId, projectId, identity.userId],
    );
    return result.rows;
  }

  private async loadActivities(identity: SpaceUserIdentity, projectId: string): Promise<ActivityContextRow[]> {
    const result = await this.db.query<ActivityContextRow>(
      `SELECT id, activity_type, title, content, visibility, owner_user_id,
              user_id, subject_user_id, occurred_at
         FROM activity_records ar
        WHERE space_id = $1
          AND project_id = $2
          AND status <> 'archived'
          AND ${contentReadSql("activity", "ar", "$3", { includeOversight: false })}
        ORDER BY occurred_at DESC, created_at DESC, id DESC
        LIMIT 16`,
      [identity.spaceId, projectId, identity.userId],
    );
    return result.rows;
  }

  private async loadArtifacts(identity: SpaceUserIdentity, projectId: string): Promise<ArtifactContextRow[]> {
    const result = await this.db.query<ArtifactContextRow>(
      `SELECT id, artifact_type, title, mime_type, visibility, owner_user_id, created_at
         FROM artifacts a
        WHERE space_id = $1
          AND project_id = $2
          AND ${contentReadSql("artifact", "a", "$3", { includeOversight: false })}
        ORDER BY created_at DESC, id DESC
        LIMIT 16`,
      [identity.spaceId, projectId, identity.userId],
    );
    return result.rows;
  }

  private async loadProposals(identity: SpaceUserIdentity, projectId: string): Promise<ProposalContextRow[]> {
    const result = await this.db.query<ProposalContextRow>(
      `SELECT p.id, p.proposal_type, p.status, p.title, p.rationale, p.visibility,
              p.created_by_user_id, run_for_instructed.instructed_by_user_id,
              p.created_at
         FROM proposals p
         LEFT JOIN runs run_for_instructed
           ON run_for_instructed.id = p.created_by_run_id
          AND run_for_instructed.space_id = p.space_id
        WHERE p.space_id = $1
          AND p.project_id = $2
          AND ${contentReadSql("proposal", "p", "$3", { includeOversight: false })}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 16`,
      [identity.spaceId, projectId, identity.userId],
    );
    return result.rows;
  }
}

function addAllowedSource(refs: Map<string, PublicSummarySourceRef>, ref: PublicSummarySourceRef): void {
  refs.set(sourceKey(ref.source_type, ref.source_id), ref);
}

function clampMaxTokens(value: number | null | undefined): number {
  const parsed = numberValue(value);
  if (parsed === null) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(256, Math.trunc(parsed)));
}

function providerCompleteText(store: ProviderCommandStore): CompleteText {
  return async (spaceId, input) => completeProviderText(store, spaceId, {
    provider_id: input.providerId,
    model: input.model,
    system: input.system,
    user: input.user,
    max_tokens: input.maxTokens,
    task: PROJECT_PUBLIC_SUMMARY_TASK,
    metering: { subject_user_id: input.subjectUserId },
  });
}
