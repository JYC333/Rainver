import {
  HttpError,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import { readProviderTaskChain } from "../providers/commands/store.js";
import type { MemoryAuthFields } from "../memory/memoryReadAuth.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { contentAccessLevelSql, contentReadSql, roomRunReadAccessSql } from "../access/contentAccessSql.js";
import { writePolicyAudit } from "../policy/auditWriter.js";
import { assertProjectWriter } from "./access.js";
import { ProjectManagementMutationError } from "./managementErrors.js";
import {
  PROJECT_PUBLIC_SUMMARY_PROMPT_VERSION,
  buildProjectPublicSummaryPrompt,
  parseGeneratedPublicSummary,
  sourceKey,
  type PublicSummaryPromptContext,
  type PublicSummarySourceRef,
} from "./publicSummaryPrompt.js";
import { PgProjectRepository } from "./repository.js";
import { memoryExcerptIncluded } from "./publicSummaryPrompt.js";
import {
  lockPublicSummarySourceClosure,
  requiredSourceLevel,
  type FrozenSourceAccess,
} from "./publicSummarySourceClosure.js";

const PROJECT_PUBLIC_SUMMARY_TASK = "project_public_summary";
import type { ContentAccessLevel } from "../access/contentAccessTypes.js";

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
  effective_access_level: ContentAccessLevel;
}
const MEMORY_DEFINITION = contentResourceDefinition("memory")!;
const ACTIVITY_DEFINITION = contentResourceDefinition("activity")!;
const ARTIFACT_DEFINITION = contentResourceDefinition("artifact")!;
const PROPOSAL_DEFINITION = contentResourceDefinition("proposal")!;
const levelSql = (definition: NonNullable<ReturnType<typeof contentResourceDefinition>>, alias: string) =>
  contentAccessLevelSql({ definition, alias, userExpr: "$3", includeOversight: false });

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
  effective_access_level: ContentAccessLevel;
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
  effective_access_level: ContentAccessLevel;
}

export interface PreparedPublicSummaryDraft {
  providerId: string;
  model: string | null;
  prompt: { system: string; user: string };
  allowedSourceRefs: PublicSummarySourceRef[];
  /** The level each source needs for what the prompt carries from it. */
  sourceAccess: FrozenSourceAccess;
  sourceCounts: Record<string, number>;
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

export class ProjectPublicSummaryGenerator {
  constructor(
    private readonly db: Queryable,
    // Null in unit tests, so the best-effort provider-call audit is skipped.
    private readonly databaseUrl: string | null = null,
  ) {}


  /**
   * Admission half of draft generation: authorized context and the frozen
   * prompt. The provider call runs later in the bounded ProviderTask worker,
   * never inside the admitting transaction.
   */
  async prepareDraft(
    identity: SpaceUserIdentity,
    projectId: string,
    input: { providerId?: string | null; model?: string | null },
  ): Promise<PreparedPublicSummaryDraft> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const providerId = input.providerId ?? "";
    if (!providerId && !(await readProviderTaskChain(this.db, identity.spaceId, PROJECT_PUBLIC_SUMMARY_TASK))) {
      throw new ProjectManagementMutationError(
        422,
        `model_provider_id is required unless provider task policy '${PROJECT_PUBLIC_SUMMARY_TASK}' is configured`,
      );
    }
    const context = await this.loadContext(identity, projectId);
    return {
      providerId,
      model: input.model ?? null,
      prompt: buildProjectPublicSummaryPrompt(context),
      allowedSourceRefs: [...context.allowedSourceRefs.values()],
      sourceAccess: frozenSourceAccess(context),
      sourceCounts: {
        memories: context.memories.length,
        activities: context.activities.length,
        artifacts: context.artifacts.length,
        proposals: context.proposals.length,
      },
    };
  }

  /**
   * The frozen prompt embeds the bodies of every admitted source, so the person
   * must still reach the *whole* closure, by the same non-oversight predicates
   * admission used, whenever that prompt is about to leave the server or its
   * reply is about to be published. Filtering the reply's references is not
   * enough: a revoked Memory, a Room the person left or a hidden Artifact
   * would still have been sent to the provider.
   *
   * Readable is not enough either: a source whose body is in the prompt must
   * still be readable at `full`. A source narrowed to `summary` after
   * admission is still listed, but its frozen excerpt or rationale is no
   * longer the person's to send.
   *
   * The caller has admitted the closure's Projects (`lockPublicSummaryProjects`).
   * The closure is share-locked first (`lockPublicSummarySourceClosure`), so
   * a concurrent revocation either commits before these reads and is refused
   * here, or waits until the attempt or draft that rests on them commits.
   * The caller must run this inside that transaction.
   */
  async assertFrozenSourcesReadable(
    identity: SpaceUserIdentity,
    projectId: string,
    refs: readonly PublicSummarySourceRef[],
    access: FrozenSourceAccess | undefined,
    admittedProjects: ReadonlySet<string>,
  ): Promise<void> {
    if (!(await this.loadProject(identity.spaceId, projectId))) throw new HttpError(404, "Project not found");
    await lockPublicSummarySourceClosure(this.db, identity.spaceId, projectId, identity.userId, refs, admittedProjects);
    const wantedRefs = (type: string) => {
      const byId = new Map<string, PublicSummarySourceRef>();
      for (const ref of refs) if (ref.source_type === type) byId.set(ref.source_id, ref);
      return [...byId.values()];
    };
    const checks: Array<[string, string]> = [
      ["memory", `SELECT me.id, ${levelSql(MEMORY_DEFINITION, "me")} AS level FROM memory_entries me
          WHERE me.space_id = $1 AND me.project_id = $2 AND me.id = ANY($4::varchar[])
            AND me.status = 'active' AND me.deleted_at IS NULL AND me.sensitivity_level <> 'highly_restricted'
            AND ${contentReadSql("memory", "me", "$3", { includeOversight: false })}`],
      ["activity", `SELECT ar.id, ${levelSql(ACTIVITY_DEFINITION, "ar")} AS level FROM activity_records ar
          WHERE ar.space_id = $1 AND ar.project_id = $2 AND ar.id = ANY($4::varchar[]) AND ar.status <> 'archived'
            AND ${contentReadSql("activity", "ar", "$3", { includeOversight: false })}`],
      ["artifact", `SELECT a.id, ${levelSql(ARTIFACT_DEFINITION, "a")} AS level FROM artifacts a
          WHERE a.space_id = $1 AND a.project_id = $2 AND a.id = ANY($4::varchar[])
            AND ${contentReadSql("artifact", "a", "$3", { includeOversight: false })}
            AND ${roomRunReadAccessSql("a.run_id", "a.space_id", "$3")}`],
      ["proposal", `SELECT p.id, ${levelSql(PROPOSAL_DEFINITION, "p")} AS level FROM proposals p
          WHERE p.space_id = $1 AND p.project_id = $2 AND p.id = ANY($4::varchar[])
            AND ${contentReadSql("proposal", "p", "$3", { includeOversight: false })}
            AND ${roomRunReadAccessSql("p.created_by_run_id", "p.space_id", "$3")}`],
    ];
    for (const [type, sql] of checks) {
      const wanted = wantedRefs(type);
      if (!wanted.length) continue;
      const found = new Map((await this.db.query<{ id: string; level: ContentAccessLevel }>(
        sql,
        [identity.spaceId, projectId, identity.userId, wanted.map(ref => ref.source_id)],
      )).rows.map(row => [row.id, row.level]));
      for (const ref of wanted) {
        const level = found.get(ref.source_id);
        if (!level) throw new HttpError(403, `A ${type} frozen into this draft request is no longer readable`);
        if (requiredSourceLevel(access, ref) === "full" && level !== "full") {
          throw new HttpError(403, `A ${type} whose content is frozen into this draft request is no longer readable in full`);
        }
      }
    }
  }

  /** Worker half: only references frozen at admission may survive into the draft. */
  async applyDraft(
    identity: SpaceUserIdentity,
    projectId: string,
    completion: { text: string; providerId: string; model: string },
    prepared: Pick<PreparedPublicSummaryDraft, "allowedSourceRefs" | "sourceCounts">,
    generatedByRunId: string,
  ): Promise<Record<string, unknown>> {
    const allowed = new Map<string, PublicSummarySourceRef>();
    for (const ref of prepared.allowedSourceRefs) addAllowedSource(allowed, ref);
    const generated = parseGeneratedPublicSummary(completion.text, allowed);
    const summary = await new PgProjectRepository(this.db).upsertPublicSummary(identity, projectId, {
      ...generated,
      generated_by_run_id: generatedByRunId,
    });
    return summary;
  }

  /** Best-effort pointer audit, written after the draft's transaction commits. */
  async auditGeneration(
    identity: SpaceUserIdentity,
    projectId: string,
    info: { providerId: string; model: string; sourceCounts: Record<string, number> },
  ): Promise<void> {
    await this.recordGenerationAudit(identity, projectId, info);
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
    // Sequential: admission runs on one transaction client.
    const memories = await this.loadMemories(identity, projectId);
    const activities = await this.loadActivities(identity, projectId);
    const artifacts = await this.loadArtifacts(identity, projectId);
    const proposals = await this.loadProposals(identity, projectId);
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
  // includeOversight: false — their output can become a published project
  // public summary, readable by the whole Space. Space
  // oversight is a read-only capability for the admin's own browsing; it must
  // not let another member's otherwise-private content flow into a
  // space-wide published artifact just because the triggering owner/admin
  // happens to have oversight visibility (Decision Matrix #4/#7).
  private async loadMemories(identity: SpaceUserIdentity, projectId: string): Promise<GeneratorMemoryRow[]> {
    const result = await this.db.query<GeneratorMemoryRow>(
      `SELECT me.id, me.space_id, me.subject_user_id, me.owner_user_id,
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
          AND ${contentReadSql("memory", "me", "$3", { includeOversight: false })}
        ORDER BY importance DESC, updated_at DESC, id DESC
        LIMIT 24`,
      [identity.spaceId, projectId, identity.userId],
    );
    return result.rows;
  }

  private async loadActivities(identity: SpaceUserIdentity, projectId: string): Promise<ActivityContextRow[]> {
    const result = await this.db.query<ActivityContextRow>(
      `SELECT id, activity_type, title, visibility, owner_user_id,
              user_id, subject_user_id, occurred_at,
              ${levelSql(ACTIVITY_DEFINITION, "ar")} AS effective_access_level,
              -- A summary-level reader is not served the body (B-access: summary withholds content).
              CASE WHEN ${levelSql(ACTIVITY_DEFINITION, "ar")} = 'full' THEN content END AS content
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
          -- A Room's outputs stay with its members (ADR 0018 decision 3).
          AND ${roomRunReadAccessSql("a.run_id", "a.space_id", "$3")}
          -- A research-call output Artifact passes this gate only while every
          -- Source it read stays fully readable (researchArtifactReadableSql).
        ORDER BY created_at DESC, id DESC
        LIMIT 16`,
      [identity.spaceId, projectId, identity.userId],
    );
    return result.rows;
  }

  private async loadProposals(identity: SpaceUserIdentity, projectId: string): Promise<ProposalContextRow[]> {
    const result = await this.db.query<ProposalContextRow>(
      `SELECT p.id, p.proposal_type, p.status, p.title, p.visibility,
              p.created_by_user_id, run_for_instructed.instructed_by_user_id,
              p.created_at, ${levelSql(PROPOSAL_DEFINITION, "p")} AS effective_access_level,
              CASE WHEN ${levelSql(PROPOSAL_DEFINITION, "p")} = 'full' THEN p.rationale END AS rationale
         FROM proposals p
         LEFT JOIN runs run_for_instructed
           ON run_for_instructed.id = p.created_by_run_id
          AND run_for_instructed.space_id = p.space_id
        WHERE p.space_id = $1
          AND p.project_id = $2
          AND ${contentReadSql("proposal", "p", "$3", { includeOversight: false })}
          AND ${roomRunReadAccessSql("p.created_by_run_id", "p.space_id", "$3")}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 16`,
      [identity.spaceId, projectId, identity.userId],
    );
    return result.rows;
  }
}

/** What the prompt actually carries from each source decides the level it needs. */
function frozenSourceAccess(context: GeneratorContext): FrozenSourceAccess {
  const access: FrozenSourceAccess = {};
  for (const memory of context.memories) {
    access[sourceKey("memory", memory.id)] = memoryExcerptIncluded(memory, context.viewerUserId) ? "full" : "summary";
  }
  for (const activity of context.activities) access[sourceKey("activity", activity.id)] = activity.content ? "full" : "summary";
  for (const artifact of context.artifacts) access[sourceKey("artifact", artifact.id)] = "summary";
  for (const proposal of context.proposals) access[sourceKey("proposal", proposal.id)] = proposal.rationale ? "full" : "summary";
  return access;
}

function addAllowedSource(refs: Map<string, PublicSummarySourceRef>, ref: PublicSummarySourceRef): void {
  refs.set(sourceKey(ref.source_type, ref.source_id), ref);
}
