import { randomUUID } from "node:crypto";
import * as protocol from "@rainver/protocol";
import type {
  ResearchContext,
  ResearchContextVersion,
} from "@rainver/protocol";
import {
  HttpError,
  type Queryable,
  type SpaceUserIdentity,
  withQueryableTransaction,
} from "../../routeUtils/common.js";

interface ContextVersionRow {
  id: string;
  project_id: string;
  version: number;
  context_json: unknown;
  assessment_json: unknown;
  provenance_json: unknown;
  created_at: string;
}

export class ResearchContextRepository {
  constructor(private readonly db: Queryable) {}

  async create(
    identity: SpaceUserIdentity,
    projectId: string,
    contextInput: ResearchContext,
    metadata: { assessment?: Record<string, unknown>; provenance?: Record<string, unknown> } = {},
  ): Promise<ResearchContextVersion> {
    const context = protocol.ResearchContextSchema.parse(contextInput);
    return withQueryableTransaction(this.db, async (db) => {
      const project = await db.query<{ id: string }>(
        `SELECT id FROM projects
          WHERE id=$1 AND space_id=$2 AND status='active'
          FOR UPDATE`,
        [projectId, identity.spaceId],
      );
      if (!project.rows[0]) throw new HttpError(404, "Project not found");

      const versionResult = await db.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
           FROM project_research_context_versions
          WHERE space_id=$1 AND project_id=$2`,
        [identity.spaceId, projectId],
      );
      const version = Number(versionResult.rows[0]?.version ?? 1);
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      await db.query(
        `INSERT INTO project_research_context_versions
          (id,space_id,project_id,created_by_user_id,version,objective,context_json,assessment_json,provenance_json,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)`,
        [
          id,
          identity.spaceId,
          projectId,
          identity.userId,
          version,
          context.objective,
          JSON.stringify(context),
          JSON.stringify(metadata.assessment ?? {}),
          JSON.stringify(metadata.provenance ?? {}),
          createdAt,
        ],
      );
      return {
        id,
        project_id: projectId,
        version,
        context,
        assessment: metadata.assessment ?? {},
        provenance: metadata.provenance ?? {},
        created_at: createdAt,
      };
    });
  }

  async get(spaceId: string, projectId: string, contextVersionId: string): Promise<ResearchContextVersion | null> {
    const result = await this.db.query<ContextVersionRow>(
      `SELECT id,project_id,version,context_json,assessment_json,provenance_json,created_at
         FROM project_research_context_versions
        WHERE id=$1 AND space_id=$2 AND project_id=$3
        LIMIT 1`,
      [contextVersionId, spaceId, projectId],
    );
    if (!result.rows[0]) return null;
    return mapContextVersion(result.rows[0], protocol.ResearchContextSchema.parse);
  }

  async listAssessmentConfirmations(
    spaceId: string,
    projectId: string,
    threadId: string,
  ): Promise<ResearchContextVersion[]> {
    const result = await this.db.query<ContextVersionRow>(
      `SELECT id,project_id,version,context_json,assessment_json,provenance_json,created_at
         FROM project_research_context_versions
        WHERE space_id=$1 AND project_id=$2
          AND provenance_json->>'source'='question_assessment_confirmation'
          AND provenance_json->>'thread_id'=$3
        ORDER BY created_at DESC, version DESC`,
      [spaceId, projectId, threadId],
    );
    return result.rows.map(row => mapContextVersion(row, protocol.ResearchContextSchema.parse));
  }
}

function mapContextVersion(row: ContextVersionRow, parseContext: (value: unknown) => ResearchContext): ResearchContextVersion {
  return {
    id: row.id,
    project_id: row.project_id,
    version: Number(row.version),
    context: parseContext(row.context_json),
    assessment: recordValue(row.assessment_json),
    provenance: recordValue(row.provenance_json),
    created_at: row.created_at,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
