import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../../config.js";
import { HttpError, optionalString, requiredString, type Queryable, type SpaceUserIdentity } from "../../routeUtils/common.js";
import { isSpaceOwnerOrAdmin } from "../../access/roles.js";
import { loadOrCreateModelProviderApiKeyMasterKey } from "../../providers/secretRefCrypto.js";
import {
  decryptCustomSourceFetchCredential,
  encryptCustomSourceFetchCredential,
} from "./customSourceCredentialCrypto.js";

/**
 * Custom Source's credential channel (Phase 10): a third credential class
 * alongside ModelProvider API keys and CLI login state (see
 * `.agent/architecture/CREDENTIAL_STORAGE.md`). Stores an encrypted secret
 * plus non-secret request-shaping metadata (which header to inject it as) in
 * the generic `credentials` table; never returns the plaintext through any
 * DTO. Only `resolveCredentialHeader` — called exclusively by the trusted
 * fetch layer (`customSourceEndpointFetch.ts`,
 * `customSourcePipelineInterpreter.ts`), never by handler code — ever
 * decrypts it.
 */
export const CUSTOM_SOURCE_FETCH_CREDENTIAL_TYPE = "custom_source_fetch_credential";

interface CredentialRow {
  id: string;
  space_id: string;
  owner_user_id: string | null;
  name: string;
  scopes_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface CustomSourceCredentialDTO {
  id: string;
  space_id: string;
  owner_user_id: string | null;
  name: string;
  header_name: string;
  header_value_prefix: string;
  created_at: string;
  updated_at: string;
}

function credentialOut(row: CredentialRow): CustomSourceCredentialDTO {
  const scopes = (row.scopes_json ?? {}) as { header_name?: string; header_value_prefix?: string };
  return {
    id: row.id,
    space_id: row.space_id,
    owner_user_id: row.owner_user_id,
    name: row.name,
    header_name: scopes.header_name ?? "Authorization",
    header_value_prefix: scopes.header_value_prefix ?? "Bearer ",
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}

export class CustomSourceCredentialService {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {}

  async create(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<CustomSourceCredentialDTO> {
    await this.requireSpaceAdmin(identity);
    const name = requiredString(body.name, "name");
    const secret = requiredString(body.secret, "secret");
    const headerName = optionalString(body.header_name) ?? "Authorization";
    // Not optionalString: a prefix commonly needs a meaningful trailing
    // space ("Bearer "), and an explicit "" (no prefix at all) is a valid
    // choice — both would be silently destroyed by optionalString's
    // trim-to-null behavior.
    const headerValuePrefix = typeof body.header_value_prefix === "string" ? body.header_value_prefix : "Bearer ";

    const masterKey = await loadOrCreateModelProviderApiKeyMasterKey(this.config.rainverHome);
    const secretRef = encryptCustomSourceFetchCredential(secret, masterKey);
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO credentials (
         id, space_id, owner_user_id, name, credential_type, secret_ref, scopes_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
      [
        id,
        identity.spaceId,
        identity.userId,
        name,
        CUSTOM_SOURCE_FETCH_CREDENTIAL_TYPE,
        secretRef,
        JSON.stringify({ header_name: headerName, header_value_prefix: headerValuePrefix }),
        now,
      ],
    );
    const created = await this.requireCredentialRow(identity.spaceId, id);
    return credentialOut(created);
  }

  async list(identity: SpaceUserIdentity): Promise<CustomSourceCredentialDTO[]> {
    const result = await this.db.query<CredentialRow>(
      `SELECT id, space_id, owner_user_id, name, scopes_json, created_at, updated_at
         FROM credentials
        WHERE space_id = $1 AND credential_type = $2
        ORDER BY created_at DESC`,
      [identity.spaceId, CUSTOM_SOURCE_FETCH_CREDENTIAL_TYPE],
    );
    return result.rows.map(credentialOut);
  }

  /** Validates a `credential_id` supplied when creating/updating a Custom Source draft belongs to this space and is the right credential class. Throws 404, never leaks whether the id exists in another space. */
  async requireOwnCredential(identity: SpaceUserIdentity, credentialId: string): Promise<void> {
    await this.requireCredentialRow(identity.spaceId, credentialId);
  }

  /**
   * Resolves the request header a fetch to an `allowed_network_origins`
   * origin should carry, or `null` if the connection has no credential.
   * Called only by trusted fetch code — the plaintext never crosses into
   * handler-visible data (`input.json`, logs, or any DTO).
   */
  async resolveCredentialHeader(
    spaceId: string,
    credentialId: string | null | undefined,
  ): Promise<{ header_name: string; header_value: string } | null> {
    if (!credentialId) return null;
    const row = await this.requireCredentialRow(spaceId, credentialId);
    const secretRefResult = await this.db.query<{ secret_ref: string }>(
      `SELECT secret_ref FROM credentials WHERE id = $1 AND space_id = $2`,
      [credentialId, spaceId],
    );
    const secretRef = secretRefResult.rows[0]?.secret_ref;
    if (!secretRef) return null;
    const masterKey = await loadOrCreateModelProviderApiKeyMasterKey(this.config.rainverHome);
    const secret = decryptCustomSourceFetchCredential(secretRef, masterKey);
    const scopes = (row.scopes_json ?? {}) as { header_name?: string; header_value_prefix?: string };
    const headerName = scopes.header_name ?? "Authorization";
    const headerValuePrefix = scopes.header_value_prefix ?? "Bearer ";
    return { header_name: headerName, header_value: `${headerValuePrefix}${secret}` };
  }

  private async requireCredentialRow(spaceId: string, credentialId: string): Promise<CredentialRow> {
    const result = await this.db.query<CredentialRow>(
      `SELECT id, space_id, owner_user_id, name, scopes_json, created_at, updated_at
         FROM credentials
        WHERE id = $1 AND space_id = $2 AND credential_type = $3`,
      [credentialId, spaceId, CUSTOM_SOURCE_FETCH_CREDENTIAL_TYPE],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Custom Source credential not found");
    return row;
  }

  private async requireSpaceAdmin(identity: SpaceUserIdentity): Promise<void> {
    const result = await this.db.query<{ role: string }>(
      `SELECT role FROM space_memberships WHERE user_id = $1 AND space_id = $2 AND status = 'active' LIMIT 1`,
      [identity.userId, identity.spaceId],
    );
    if (!isSpaceOwnerOrAdmin(result.rows[0]?.role ?? null)) {
      throw new HttpError(403, "Requires space admin role to manage Custom Source credentials");
    }
  }
}
