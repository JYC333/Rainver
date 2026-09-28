import { randomBytes } from "node:crypto";

interface PendingGoogleReauth {
  userId: string;
  previousSessionId: string;
  issuedAt: number;
  verifiedSessionTokenHash: string | null;
}

const pending = new Map<string, PendingGoogleReauth>();
const TTL_MS = 10 * 60_000;

export function issueGoogleReauth(userId: string, previousSessionId: string): string {
  const now = Date.now();
  for (const [nonce, value] of pending) if (value.issuedAt + TTL_MS <= now) pending.delete(nonce);
  const nonce = randomBytes(24).toString("base64url");
  pending.set(nonce, { userId, previousSessionId, issuedAt: now, verifiedSessionTokenHash: null });
  return nonce;
}

export function markGoogleReauthVerified(nonce: string, sessionTokenHash: string): void {
  const value = pending.get(nonce);
  if (value && value.issuedAt + TTL_MS > Date.now()) value.verifiedSessionTokenHash = sessionTokenHash;
}

export function consumeGoogleReauth(nonce: string): PendingGoogleReauth | null {
  const value = pending.get(nonce);
  pending.delete(nonce);
  if (!value || value.issuedAt + TTL_MS <= Date.now()) return null;
  return value;
}
