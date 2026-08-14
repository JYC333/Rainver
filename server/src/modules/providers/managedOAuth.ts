/**
 * The agent-space contract for a managed subscription OAuth flow.
 *
 * Agent-space owns the credential: it decides which subscriptions may be
 * connected, who may connect them, how the refresh token is encrypted at rest,
 * when it is refreshed, and which Runs may spend it. What it does not own is
 * the vendor's device-code and PKCE choreography, which is what an
 * implementation of this interface supplies.
 *
 * These types are declared here rather than beside the implementation so that
 * `subscriptionOAuth` — the credential authority — depends on the contract and
 * not on whichever library currently performs the exchange. The implementation
 * keeps compile-time structural guards proving it still satisfies the vendor
 * library's own shapes, which is what makes this a contract rather than a copy.
 */

export interface ManagedOAuthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

export type ManagedAuthPrompt = {
  signal?: AbortSignal;
  message: string;
  placeholder?: string;
} & (
  | { type: "text" | "secret" | "manual_code" }
  | { type: "select"; options: readonly { id: string; label: string; description?: string }[] }
);

export type ManagedAuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export interface ManagedAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: ManagedAuthPrompt): Promise<string>;
  notify(event: ManagedAuthEvent): void;
}

export interface ManagedOAuthFlow {
  login(interaction: ManagedAuthInteraction): Promise<ManagedOAuthCredential>;
  refresh(credential: ManagedOAuthCredential, signal: AbortSignal): Promise<ManagedOAuthCredential>;
}
