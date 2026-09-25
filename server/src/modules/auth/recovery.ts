const links = new Map<string, { url: string; expiresAt: number }>();

/**
 * Manual delivery adapter for the current deployment. The raw link is kept
 * only until an administrator retrieves it once; no mail transport is
 * coupled to Better Auth's verification lifecycle.
 */
export function storeManualResetLink(email: string, url: string): void {
  const now = Date.now();
  for (const [key, value] of links) if (value.expiresAt <= now) links.delete(key);
  links.set(email, { url, expiresAt: now + 30 * 60_000 });
  while (links.size > 256) links.delete(links.keys().next().value!);
}

export function consumeManualResetLink(email: string): string | null {
  const value = links.get(email);
  if (!value || value.expiresAt <= Date.now()) { links.delete(email); return null; }
  links.delete(email);
  return value.url;
}
