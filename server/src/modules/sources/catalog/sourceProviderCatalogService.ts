import { HttpError, type Queryable, type SpaceUserIdentity } from "../../routeUtils/common.js";
import { sourceProviderSetupSchema } from "./sourceProviderSetup.js";

export interface SourceProviderCatalogRow {
  id: string;
  provider_key: string;
  display_name: string;
  provider_kind: string;
  category: string;
  status: string;
  capabilities_json: unknown;
  config_schema_json: unknown;
  connector_mapping_id: string | null;
  connector_id: string | null;
  connector_key: string | null;
  connector_display_name: string | null;
  connector_type: string | null;
  ingestion_mode: string | null;
  mapping_status: string | null;
  mapping_priority: number | null;
  mapping_capabilities_json: unknown;
  mapping_config_schema_json: unknown;
}

export interface ResolvedSourceProviderConnector {
  provider_id: string;
  provider_key: string;
  provider_display_name: string;
  provider_kind: string;
  provider_category: string;
  provider_status: string;
  provider_capabilities_json: unknown;
  provider_config_schema_json: unknown;
  mapping_id: string;
  mapping_status: string;
  mapping_priority: number;
  mapping_capabilities_json: unknown;
  mapping_config_schema_json: unknown;
  connector_id: string;
  connector_key: string;
  connector_display_name: string;
  connector_type: string;
  ingestion_mode: string;
  connector_status: string;
  connector_capabilities_json: unknown;
  connector_config_schema_json: unknown;
}

const CATALOG_SELECT = `
  p.id, p.provider_key, p.display_name, p.provider_kind, p.category, p.status,
  p.capabilities_json, p.config_schema_json,
  spc.id AS connector_mapping_id, c.id AS connector_id, c.connector_key,
  c.display_name AS connector_display_name, c.connector_type, c.ingestion_mode,
  spc.status AS mapping_status, spc.priority AS mapping_priority,
  spc.capabilities_json AS mapping_capabilities_json,
  spc.config_schema_json AS mapping_config_schema_json`;

export class SourceProviderCatalogService {
  constructor(private readonly db: Queryable) {}

  async listProviders(options: { activeOnly?: boolean } = {}) {
    const where = options.activeOnly
      ? "WHERE p.status = 'active' AND spc.id IS NOT NULL AND spc.status = 'active' AND c.status = 'active'"
      : "";
    const result = await this.db.query<SourceProviderCatalogRow>(
      `SELECT ${CATALOG_SELECT}
         FROM source_providers p
         LEFT JOIN LATERAL (
           SELECT m.* FROM source_provider_connectors m
            WHERE m.provider_id = p.id
            ORDER BY CASE WHEN m.status = 'active' THEN 0 ELSE 1 END, m.priority, m.id
            LIMIT 1
         ) spc ON true
         LEFT JOIN source_connectors c ON c.id = spc.connector_id
        ${where}
        ORDER BY p.category, p.display_name, p.provider_key`,
    );
    return result.rows.map((row) => this.providerOut(row));
  }

  async listPublicProviders() {
    const providers = await this.listProviders({ activeOnly: true });
    return providers.map(({ connector_mapping: _connectorMapping, ...provider }) => provider);
  }

  async listCatalog() {
    const [providers, connectors, mappings] = await Promise.all([
      this.listProviders({ activeOnly: false }),
      this.db.query(
        `SELECT id, connector_key, display_name, connector_type, ingestion_mode, status,
                capabilities_json, config_schema_json, created_at, updated_at
           FROM source_connectors ORDER BY display_name, connector_key`,
      ),
      this.db.query(
        `SELECT m.id, m.provider_id, p.provider_key, m.connector_id, c.connector_key,
                m.status, m.priority, m.capabilities_json, m.config_schema_json,
                m.created_at, m.updated_at
           FROM source_provider_connectors m
           JOIN source_providers p ON p.id = m.provider_id
           JOIN source_connectors c ON c.id = m.connector_id
          ORDER BY p.provider_key, m.priority, c.connector_key`,
      ),
    ]);
    return { providers, connectors: connectors.rows, mappings: mappings.rows };
  }

  async resolve(providerKey: string): Promise<ResolvedSourceProviderConnector> {
    const result = await this.db.query<ResolvedSourceProviderConnector>(
      `SELECT
         p.id AS provider_id, p.provider_key, p.display_name AS provider_display_name,
         p.provider_kind, p.category AS provider_category, p.status AS provider_status,
         p.capabilities_json AS provider_capabilities_json,
         p.config_schema_json AS provider_config_schema_json,
         spc.id AS mapping_id, spc.status AS mapping_status, spc.priority AS mapping_priority,
         spc.capabilities_json AS mapping_capabilities_json,
         spc.config_schema_json AS mapping_config_schema_json,
         c.id AS connector_id, c.connector_key, c.display_name AS connector_display_name,
         c.connector_type, c.ingestion_mode, c.status AS connector_status,
         c.capabilities_json AS connector_capabilities_json,
         c.config_schema_json AS connector_config_schema_json
        FROM source_providers p
        JOIN source_provider_connectors spc ON spc.provider_id = p.id
        JOIN source_connectors c ON c.id = spc.connector_id
       WHERE p.provider_key = $1
         AND p.status = 'active'
         AND spc.status = 'active'
         AND c.status = 'active'
       ORDER BY spc.priority ASC, spc.id ASC
       LIMIT 1`,
      [providerKey],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, `Source provider is not available: ${providerKey}`);
    return row;
  }

  async updateProvider(id: string, input: { status?: string }): Promise<unknown> {
    if (input.status && !["active", "disabled"].includes(input.status)) {
      throw new HttpError(422, "status must be active or disabled");
    }
    const result = await this.db.query(
      `UPDATE source_providers SET status = COALESCE($2, status), updated_at = now()
        WHERE id = $1 RETURNING id, provider_key, display_name, provider_kind, category, status, capabilities_json, config_schema_json, created_at, updated_at`,
      [id, input.status ?? null],
    );
    if (!result.rows[0]) throw new HttpError(404, "Source provider not found");
    return result.rows[0];
  }

  async updateConnector(id: string, input: { status?: string }): Promise<unknown> {
    if (input.status && !["active", "disabled"].includes(input.status)) {
      throw new HttpError(422, "status must be active or disabled");
    }
    const result = await this.db.query(
      `UPDATE source_connectors SET status = COALESCE($2, status), updated_at = now()
        WHERE id = $1 RETURNING id, connector_key, display_name, connector_type, ingestion_mode, status, capabilities_json, config_schema_json, created_at, updated_at`,
      [id, input.status ?? null],
    );
    if (!result.rows[0]) throw new HttpError(404, "Source connector not found");
    return result.rows[0];
  }

  async updateMapping(id: string, input: { status?: string; priority?: number }): Promise<unknown> {
    if (input.status && !["active", "disabled"].includes(input.status)) {
      throw new HttpError(422, "status must be active or disabled");
    }
    if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0)) {
      throw new HttpError(422, "priority must be a non-negative integer");
    }
    const result = await this.db.query(
      `UPDATE source_provider_connectors SET
         status = COALESCE($2, status), priority = COALESCE($3, priority), updated_at = now()
        WHERE id = $1
        RETURNING id, provider_id, connector_id, status, priority, capabilities_json, config_schema_json, created_at, updated_at`,
      [id, input.status ?? null, input.priority ?? null],
    );
    if (!result.rows[0]) throw new HttpError(404, "Source provider connector mapping not found");
    return result.rows[0];
  }

  private providerOut(row: SourceProviderCatalogRow) {
    return {
      id: row.id,
      provider_key: row.provider_key,
      display_name: row.display_name,
      provider_kind: row.provider_kind,
      category: row.category,
      status: row.status,
      capabilities: row.capabilities_json ?? {},
      config_schema: row.config_schema_json ?? null,
      setup_schema: sourceProviderSetupSchema(row.provider_key),
      connector_mapping: row.connector_mapping_id
        ? {
            id: row.connector_mapping_id,
            connector_key: row.connector_key,
            status: row.mapping_status,
            priority: row.mapping_priority,
            capabilities: row.mapping_capabilities_json ?? {},
          }
        : null,
    };
  }

  static async requireSpaceProvider(db: Queryable, identity: SpaceUserIdentity, providerKey: string) {
    return new SourceProviderCatalogService(db).resolve(providerKey);
  }
}
