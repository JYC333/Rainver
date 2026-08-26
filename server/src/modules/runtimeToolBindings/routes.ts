import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  boolQuery,
  dateIso,
  dbPool,
  objectValue,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";

interface RuntimeToolBindingRow {
  id: string;
  space_id: string;
  project_folder_id: string | null;
  agent_id: string | null;
  capability_id: string | null;
  runtime_adapter_type: string;
  external_type: string;
  external_ref: string;
  display_name: string;
  required_scopes_json: unknown;
  credential_ref: string | null;
  data_exposure_level: string;
  observability_level: string;
  side_effect_level: string;
  approval_required: boolean;
  enabled: boolean;
  notes: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const COLUMNS = `
  id, space_id, project_folder_id, agent_id, capability_id, runtime_adapter_type,
  external_type, external_ref, display_name,
  required_scopes_json, credential_ref, data_exposure_level,
  observability_level, side_effect_level, approval_required, enabled,
  notes, created_at, updated_at
`;

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new RuntimeToolBindingRepository(dbPool(context.config));

  app.get("/api/v1/runtime-tool-bindings", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().list(identity, query(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/runtime-tool-bindings/:bindingId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const row = await repository().get(identity, params(request).bindingId ?? "");
      if (!row) return reply.code(404).send({ detail: "Runtime tool binding not found" });
      return reply.send(row);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

class RuntimeToolBindingRepository {
  constructor(private readonly db: Queryable) {}

  async list(
    identity: SpaceUserIdentity,
    filters: Record<string, string | undefined>,
  ): Promise<Record<string, unknown>[]> {
    const values: unknown[] = [identity.spaceId];
    const clauses = ["space_id = $1"];
    for (const [queryKey, column] of [
      ["project_folder_id", "project_folder_id"],
      ["agent_id", "agent_id"],
      ["capability_id", "capability_id"],
      ["runtime_adapter_type", "runtime_adapter_type"],
    ] as const) {
      const value = optionalString(filters[queryKey]);
      if (!value) continue;
      values.push(value);
      clauses.push(`${column} = $${values.length}`);
    }
    const enabled = filters.enabled === undefined ? null : boolQuery(filters.enabled);
    if (enabled !== null) {
      values.push(enabled);
      clauses.push(`enabled = $${values.length}`);
    }
    const rows = await this.db.query<RuntimeToolBindingRow>(
      `SELECT ${COLUMNS}
         FROM runtime_tool_bindings
        WHERE ${clauses.join(" AND ")}
        ORDER BY enabled DESC, updated_at DESC, id DESC`,
      values,
    );
    return rows.rows.map(out);
  }

  async get(identity: SpaceUserIdentity, bindingId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db.query<RuntimeToolBindingRow>(
      `SELECT ${COLUMNS}
         FROM runtime_tool_bindings
        WHERE id = $1 AND space_id = $2
        LIMIT 1`,
      [bindingId, identity.spaceId],
    );
    return rows.rows[0] ? out(rows.rows[0]) : null;
  }
}

function out(row: RuntimeToolBindingRow): Record<string, unknown> {
  return {
    ...row,
    required_scopes_json: objectValue(row.required_scopes_json),
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}
