import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import {
  HttpError,
  dateIso,
  dbPool,
  jsonBody,
  objectValue,
  optionalString,
  params,
  resolveIdentity,
  sendRouteError,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { assertProjectReadable, assertProjectWriter } from "../projects/access";

interface ProjectFolderExecutionConfigRow {
  id: string;
  space_id: string;
  project_folder_id: string;
  repo_type: string | null;
  tech_stack_json: unknown;
  important_paths_json: unknown;
  forbidden_paths_json: unknown;
  test_commands_json: unknown;
  build_commands_json: unknown;
  architecture_boundaries_json: unknown;
  validation_recipe_id: string | null;
  cloud_allowed: boolean;
  max_data_exposure_level: string | null;
  min_observability_level: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const COLUMNS = `
  id, space_id, project_folder_id, repo_type, tech_stack_json, important_paths_json,
  forbidden_paths_json, test_commands_json, build_commands_json,
  architecture_boundaries_json, validation_recipe_id, cloud_allowed, max_data_exposure_level,
  min_observability_level, created_at, updated_at
`;

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new ProjectFolderExecutionConfigRepository(dbPool(context.config));

  app.get("/api/v1/projects/:projectId/folders/:folderId/execution-config", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const row = await repository().get(identity, projectId(request), folderId(request));
      if (!row) return reply.code(404).send({ detail: "Project Folder Execution Config not found" });
      return reply.send(row);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/folders/:folderId/execution-config", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(
        await repository().create(identity, projectId(request), folderId(request), jsonBody(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/projects/:projectId/folders/:folderId/execution-config", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().update(identity, projectId(request), folderId(request), jsonBody(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function folderId(request: FastifyRequest): string {
  const id = params(request).folderId;
  if (!id) throw new HttpError(422, "folderId is required");
  return id;
}

function projectId(request: FastifyRequest): string {
  const id = params(request).projectId;
  if (!id) throw new HttpError(422, "projectId is required");
  return id;
}

class ProjectFolderExecutionConfigRepository {
  constructor(private readonly db: Queryable) {}

  async get(
    identity: SpaceUserIdentity,
    projectId: string,
    projectFolderId: string,
  ): Promise<Record<string, unknown> | null> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query<ProjectFolderExecutionConfigRow>(
      `SELECT c.${COLUMNS.trim().replaceAll(", ", ", c.").replaceAll("\n  ", "\n  c.")}
         FROM project_folder_execution_configs c
         JOIN project_folders f
           ON f.id = c.project_folder_id AND f.space_id = c.space_id
        WHERE c.project_folder_id = $1 AND c.space_id = $2 AND f.project_id = $3
        LIMIT 1`,
      [projectFolderId, identity.spaceId, projectId],
    );
    return rows.rows[0] ? out(rows.rows[0]) : null;
  }

  async create(
    identity: SpaceUserIdentity,
    projectId: string,
    projectFolderId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    await this.requireFolder(identity, projectId, projectFolderId);
    const now = new Date().toISOString();
    const rows = await this.db.query<ProjectFolderExecutionConfigRow>(
      `INSERT INTO project_folder_execution_configs (
         id, space_id, project_folder_id, repo_type, tech_stack_json,
         important_paths_json, forbidden_paths_json, test_commands_json,
         build_commands_json, architecture_boundaries_json,
         validation_recipe_id, cloud_allowed,
         max_data_exposure_level, min_observability_level, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb,
         $6::jsonb, $7::jsonb, $8::jsonb,
         $9::jsonb, $10::jsonb, $11, $12,
         $13, $14, $15, $15
       )
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        identity.spaceId,
        projectFolderId,
        optionalString(body.repo_type),
        json(body.tech_stack_json, []),
        json(body.important_paths_json, []),
        json(body.forbidden_paths_json, []),
        json(body.test_commands_json, []),
        json(body.build_commands_json, []),
        json(body.architecture_boundaries_json, {}),
        optionalString(body.validation_recipe_id),
        body.cloud_allowed === true,
        optionalString(body.max_data_exposure_level),
        optionalString(body.min_observability_level),
        now,
      ],
    );
    return out(rows.rows[0]!);
  }

  async update(
    identity: SpaceUserIdentity,
    projectId: string,
    projectFolderId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const current = await this.get(identity, projectId, projectFolderId);
    if (!current) throw new HttpError(404, "Project Folder Execution Config not found");
    const now = new Date().toISOString();
    const rows = await this.db.query<ProjectFolderExecutionConfigRow>(
      `UPDATE project_folder_execution_configs
          SET repo_type = CASE WHEN $3::boolean THEN $4 ELSE repo_type END,
              tech_stack_json = CASE WHEN $5::boolean THEN $6::jsonb ELSE tech_stack_json END,
              important_paths_json = CASE WHEN $7::boolean THEN $8::jsonb ELSE important_paths_json END,
              forbidden_paths_json = CASE WHEN $9::boolean THEN $10::jsonb ELSE forbidden_paths_json END,
              test_commands_json = CASE WHEN $11::boolean THEN $12::jsonb ELSE test_commands_json END,
              build_commands_json = CASE WHEN $13::boolean THEN $14::jsonb ELSE build_commands_json END,
              architecture_boundaries_json = CASE WHEN $15::boolean THEN $16::jsonb ELSE architecture_boundaries_json END,
              validation_recipe_id = CASE WHEN $17::boolean THEN $18 ELSE validation_recipe_id END,
              cloud_allowed = COALESCE($19::boolean, cloud_allowed),
              max_data_exposure_level = CASE WHEN $20::boolean THEN $21 ELSE max_data_exposure_level END,
              min_observability_level = CASE WHEN $22::boolean THEN $23 ELSE min_observability_level END,
              updated_at = $24
        WHERE project_folder_id = $1 AND space_id = $2
        RETURNING ${COLUMNS}`,
      [
        projectFolderId,
        identity.spaceId,
        Object.hasOwn(body, "repo_type"),
        optionalString(body.repo_type),
        Object.hasOwn(body, "tech_stack_json"),
        json(body.tech_stack_json, []),
        Object.hasOwn(body, "important_paths_json"),
        json(body.important_paths_json, []),
        Object.hasOwn(body, "forbidden_paths_json"),
        json(body.forbidden_paths_json, []),
        Object.hasOwn(body, "test_commands_json"),
        json(body.test_commands_json, []),
        Object.hasOwn(body, "build_commands_json"),
        json(body.build_commands_json, []),
        Object.hasOwn(body, "architecture_boundaries_json"),
        json(body.architecture_boundaries_json, {}),
        Object.hasOwn(body, "validation_recipe_id"),
        optionalString(body.validation_recipe_id),
        typeof body.cloud_allowed === "boolean" ? body.cloud_allowed : null,
        Object.hasOwn(body, "max_data_exposure_level"),
        optionalString(body.max_data_exposure_level),
        Object.hasOwn(body, "min_observability_level"),
        optionalString(body.min_observability_level),
        now,
      ],
    );
    return out(rows.rows[0]!);
  }

  private async requireFolder(
    identity: SpaceUserIdentity,
    projectId: string,
    projectFolderId: string,
  ): Promise<void> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM project_folders
        WHERE id = $1 AND space_id = $2 AND project_id = $3
        LIMIT 1`,
      [projectFolderId, identity.spaceId, projectId],
    );
    if (!rows.rows[0]) throw new HttpError(404, "Project Folder not found");
  }
}

function json(value: unknown, fallback: unknown): string {
  return JSON.stringify(value === undefined ? fallback : value);
}

function out(row: ProjectFolderExecutionConfigRow): Record<string, unknown> {
  return {
    ...row,
    tech_stack_json: objectValue(row.tech_stack_json),
    important_paths_json: row.important_paths_json ?? [],
    forbidden_paths_json: row.forbidden_paths_json ?? [],
    test_commands_json: row.test_commands_json ?? [],
    build_commands_json: row.build_commands_json ?? [],
    architecture_boundaries_json: objectValue(row.architecture_boundaries_json),
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}
