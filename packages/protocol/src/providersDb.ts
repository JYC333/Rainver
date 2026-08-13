/**
 * DB column allowlist for the provider reader.
 *
 * This is the schema-drift ratchet: server readers SELECT exactly these columns.
 * Adding, renaming, or dropping a column should update this list and the
 * corresponding repository/tests in the same change.
 */

export const MODEL_PROVIDERS_TABLE = "model_providers" as const;

export const MODEL_PROVIDERS_READ_COLUMNS = [
  "id",
  "space_id",
  "owner_user_id",
  "name",
  "provider_type",
  "base_url",
  "network_profile_id",
  "default_model",
  "enabled",
  "credential_id",
  "capabilities_json",
  "config_json",
  "created_at",
  "updated_at",
] as const;
