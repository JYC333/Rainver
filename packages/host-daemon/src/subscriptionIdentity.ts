import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SubscriptionAccountDisplaySchema, type SubscriptionAccountIdentity } from "@rainver/protocol";

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): string | null =>
  typeof value === "string" && /^[a-zA-Z0-9_|:.-]{1,256}$/.test(value) ? value : null;
const opaque = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Called with the profile response authenticated by the very token used for quota. */
export function claudeSubscriptionIdentity(value: unknown): SubscriptionAccountIdentity | null {
  const root = record(value);
  const account = id(record(root?.account)?.uuid);
  const organization = id(record(root?.organization)?.uuid);
  if (!account || !organization) return null;
  return { provider: "anthropic", product: "claude", account_id: opaque(account), organization_id: opaque(organization) };
}

/** Same-session account/read supplies email and experimental workspace routing, not userId. */
export function codexRpcSubscriptionIdentity(value: unknown): SubscriptionAccountIdentity | null {
  const root = record(value);
  const account = record(root?.account);
  const email = typeof account?.email === "string" ? account.email.trim().toLowerCase() : null;
  const workspace = id(record(root?.workspaceRouting)?.chatgptAccountId);
  // The workspace alone would merge different Team seats. Never fall back to
  // a display name, plan, or another login file when either scope is absent.
  if (account?.type !== "chatgpt" || !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !workspace) return null;
  return { provider: "openai", product: "codex", identity_kind: "email", account_id: opaque(email), organization_id: opaque(workspace) };
}

export async function loginFileFingerprint(path: string): Promise<string | null> {
  try { return opaque(await readFile(path, "utf8")); } catch { return null; }
}

/** Explicit display whitelist from the same authenticated response as quota identity. */
export function subscriptionAccountDisplay(email: unknown, workspaceName?: unknown) {
  const parsed = SubscriptionAccountDisplaySchema.safeParse({
    email,
    ...(typeof workspaceName === "string" && workspaceName.trim() && workspaceName.trim().length <= 256
      ? { workspace_name: workspaceName.trim() } : {}),
  });
  return parsed.success ? parsed.data : null;
}

export function claudeSubscriptionDisplay(value: unknown) {
  const root = record(value);
  const account = record(root?.account);
  return subscriptionAccountDisplay(account?.email_address ?? account?.email, record(root?.organization)?.name);
}

export function codexSubscriptionDisplay(value: unknown) {
  const account = record(record(value)?.account);
  return account?.type === "chatgpt" ? subscriptionAccountDisplay(account.email, account.workspaceName) : null;
}
