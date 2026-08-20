import {
  providerCanRunWithoutCredential,
  providerSupportsChat,
} from "./vendors";

/**
 * Provider facts shared by Room admission, conversation backend resolution,
 * and run routing. The SQL callers deliberately return facts rather than
 * embedding user-specific policy in separate predicates; this keeps all three
 * paths on one authorization rule.
 */
export interface ProviderEligibilityRow {
  provider_type: string | null;
  provider_enabled: boolean | null;
  provider_grant_enabled: boolean | null;
  provider_owner_user_id: string | null;
  provider_credential_type: string | null;
  provider_has_eligible_credential: boolean | null;
}

export function isProviderEligibleForUser(
  row: ProviderEligibilityRow,
  userId: string | null,
): boolean {
  if (row.provider_enabled !== true || row.provider_grant_enabled !== true) return false;
  if (
    row.provider_credential_type === "subscription_oauth" &&
    (!userId || row.provider_owner_user_id !== userId)
  ) {
    return false;
  }
  const providerType = row.provider_type ?? "";
  return providerSupportsChat(providerType) && Boolean(
    row.provider_has_eligible_credential ||
    providerCanRunWithoutCredential(providerType),
  );
}

/**
 * SQL expression for credentials that the invocation store can actually use.
 * A primary API key is lazily eligible only while it has not been enrolled in
 * the pool; once enrolled, its enabled/healthy/cooldown state is authoritative.
 * Pool members are restricted to API-key credentials, matching poolMembers().
 * The arguments are internal SQL identifiers, never user input.
 */
export function providerCredentialEligibilitySql(
  providerIdSql: string,
  providerCredentialIdSql: string,
  credentialSql: string,
): string {
  return `(
    ${credentialSql}.credential_type = 'subscription_oauth'
    OR EXISTS (
      SELECT 1
        FROM model_provider_credentials credential
        JOIN credentials pool_credential
          ON pool_credential.id = credential.credential_id
         AND pool_credential.credential_type = 'api_key'
       WHERE credential.provider_id = ${providerIdSql}
         AND credential.enabled = true
         AND credential.healthy = true
         AND (credential.cooldown_until IS NULL OR credential.cooldown_until <= now())
    )
    OR (
      ${credentialSql}.credential_type = 'api_key'
      AND NOT EXISTS (
        SELECT 1
         FROM model_provider_credentials enrolled
         WHERE enrolled.provider_id = ${providerIdSql}
           AND enrolled.credential_id = ${providerCredentialIdSql}
      )
    )
  )`;
}

export function effectiveProviderDefault(
  grantDefault: boolean | null,
  profileDefault: boolean,
): boolean {
  return grantDefault === true || profileDefault;
}
