import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

/** Settings key the Custom Source policy lives under; the tests pin the literal on purpose. */
const CUSTOM_SOURCE_SPACE_POLICY_SETTINGS_KEY = "source.custom_source.space_policy";

/**
 * The world every Custom Source / Source Recipe real-Postgres file starts
 * from: one user, one team Space they created, the fixed custom_source
 * connector → provider → mapping rows the services look up by id, and the
 * user's owner membership. Literals match what the files used to inline.
 */
export async function seedCustomSourceWorld(
  pool: Pool,
  identity: { spaceId: string; userId: string },
  options: { membership?: boolean } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'User', 'active', now(), now())`,
    [identity.userId],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Space A', 'team', $2, now(), now())`,
    [identity.spaceId, identity.userId],
  );
  await pool.query(
    `INSERT INTO source_connectors (
       id, connector_key, display_name, connector_type, ingestion_mode, status,
       capabilities_json, created_at, updated_at
     ) VALUES ('connector-custom-source', 'custom_source', 'Custom Source', 'external_url', 'pull', 'active', '{}'::jsonb, now(), now())`,
  );
  await pool.query(
    `INSERT INTO source_providers (
       id, provider_key, display_name, provider_kind, category, status,
       capabilities_json, created_at, updated_at
     ) VALUES ('provider-custom-source', 'custom_source', 'Custom Source', 'named', 'general', 'active', '{}'::jsonb, now(), now())`,
  );
  await pool.query(
    `INSERT INTO source_provider_connectors (
       id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at
     ) VALUES ('mapping-custom-source', 'provider-custom-source', 'connector-custom-source', 'active', 0, '{}'::jsonb, now(), now())`,
  );
  if (options.membership !== false) {
    await pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'owner', 'active', now(), now())`,
      [randomUUID(), identity.spaceId, identity.userId],
    );
  }
}

/** The Space's Custom Source policy settings row, with the defaults the tests assume. */
export async function upsertCustomSourceSpacePolicy(
  pool: Pool,
  spaceId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO settings (
       id, scope_type, scope_id, settings_key, settings_json, created_at, updated_at
     ) VALUES ($1, 'space', $2, $3, $4::jsonb, now(), now())
     ON CONFLICT (scope_type, scope_id, settings_key)
     DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = EXCLUDED.updated_at`,
    [
      randomUUID(),
      spaceId,
      CUSTOM_SOURCE_SPACE_POLICY_SETTINGS_KEY,
      JSON.stringify({
        creator_roles: ["owner", "admin"],
        default_capture_policy: "extract_text",
        default_retention_policy: "full_text",
        allowed_domains: [],
        credentialed_sources_allowed: false,
        same_envelope_repair_auto_apply: false,
        ...overrides,
      }),
    ],
  );
}
