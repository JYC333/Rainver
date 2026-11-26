import { createHash } from "node:crypto";

/**
 * What this process recently issued to, and ended for, each browser — the
 * part of a browser's account state its cookies cannot carry yet.
 *
 * A sign-in, addition or rotation (`settleSessionCookies`) answers with
 * cookies the browser applies whenever that response arrives. Two requests in
 * flight together each see only the cookies the browser had when they left:
 * two additions from a browser at four accounts each pass the limit, and a
 * sign-in whose response lands after a logout's signs the browser back in.
 * Here a browser is the group of verified session ids (and their tokens) its
 * requests carried, joined with every session issued to it. A logout revokes
 * the whole group and marks its sessions ended, so an issuance from a request
 * that still carried one of them is refused when it settles. The check and
 * the record happen in one synchronous step, so no other request interleaves
 * between them.
 *
 * Process-local and short-lived, like the Google reauthentication nonces: it
 * only needs to outlast requests in flight and an OAuth round trip. A
 * restart cuts the requests it guards; the browser's cookies, not this
 * ledger, still decide which accounts it holds.
 */
const TTL_MS = 15 * 60_000;
/** Bounds the table as the login limiter bounds its own; past it the least recently touched browser goes. */
const MAX_GROUPS = 4096;

export interface IssuedSession { sessionId: string; userId: string }
/**
 * `members` are ledger keys: verified session ids (`s:`), the digests of
 * tokens proven with them (`t:`) and the ids issued to the group. `verified`
 * holds the ids a request of the browser proved it held.
 */
interface Group { members: Set<string>; verified: Set<string>; issued: Map<string, IssuedSession>; touchedAt: number; bornAt: number; selected?: Selection }
/**
 * The browser's last selection (a sign-in issuing it or a switch to it).
 * `bornAt` is the event order at which the group's oldest part was first
 * recorded: a group born after a logout holds nothing from before it.
 */
interface Selection { id: string; order: number }

/**
 * One process-wide order of selections and logouts. Which came first is read
 * from it alone; `Date.now()` only ages marks and groups (TTL), since two
 * events can share a millisecond and the wall clock can step back.
 */
let order = 0;
function nextOrder(): number { return ++order; }

const groupOf = new Map<string, Group>();
const groups = new Set<Group>();
/** Session id or token digest → when a browser logout ended it. */
const ended = new Map<string, number>();
/**
 * A mark's place in the event order (`order`) and when a request last relied
 * on it (`seenAt`); it lasts until `seenAt` is TTL old, so it outlives
 * requests as long as the browser keeps sending what it repairs.
 */
interface Mark { order: number; seenAt: number; latest?: number }
/**
 * Session id → when a browser logout revoked it before the browser had shown
 * holding it: issued by a request still in flight (a password rotation
 * whose response had not landed). Not an ended mark — no request that left
 * before the logout can carry it — but its late response may still write it
 * back as the selected account (`lateSelectorRepair`). The browser keeps
 * that selector until a sign-in, switch or logout of its own replaces it:
 * this mark, keyed by the session id the selector names, is what recognizes
 * it, also once its jar cookie is gone.
 */
const lateRevoked = new Map<string, Mark>();
/*
 * `latest` on a late-revoked mark is the newest selection made, since that
 * logout, in any group born after it. The logout ended every group of the
 * browser and its cookies, so each session it is given afterwards starts in
 * such a group, as does every unrelated browser's fresh sign-in: the server
 * cannot tell them apart. Recorded when the selection is made, so a group
 * dropped later (expired, evicted for capacity, never seen beside the jar)
 * still counts.
 */

function live(mark: Mark | undefined, now: number): mark is Mark { return mark !== undefined && mark.seenAt + TTL_MS > now; }

function tokenKey(token: string): string { return `t:${createHash("sha256").update(token).digest("base64url")}`; }
function sessionKey(sessionId: string): string { return `s:${sessionId}`; }
function keysOf(sessionIds: readonly string[], tokens: readonly string[]): string[] {
  return [...sessionIds.map(sessionKey), ...tokens.map(tokenKey)];
}

function sweep(now: number): void {
  for (const group of groups) if (group.touchedAt + TTL_MS <= now) dropGroup(group);
  for (const [key, at] of ended) if (at + TTL_MS <= now) ended.delete(key);
  for (const [id, mark] of lateRevoked) if (!live(mark, now)) lateRevoked.delete(id);
  while (groups.size > MAX_GROUPS) dropGroup(groups.values().next().value!);
}
function select(group: Group, id: string): void {
  group.selected = { id, order: nextOrder() };
  for (const mark of lateRevoked.values()) if (group.bornAt > mark.order) mark.latest = group.selected.order;
}
function dropGroup(group: Group): void {
  groups.delete(group);
  for (const key of group.members) if (groupOf.get(key) === group) groupOf.delete(key);
}
function groupsOf(keys: readonly string[]): Group[] {
  return [...new Set(keys.map((key) => groupOf.get(key)).filter((group): group is Group => Boolean(group)))];
}

/** The one group these keys belong to, merging the groups they were in. */
function joined(keys: readonly string[], now: number): Group {
  const found = groupsOf(keys);
  const group = found.shift() ?? { members: new Set<string>(), verified: new Set<string>(), issued: new Map<string, IssuedSession>(), touchedAt: now, bornAt: nextOrder() };
  for (const other of found) {
    group.bornAt = Math.min(group.bornAt, other.bornAt);
    for (const key of other.members) group.members.add(key);
    for (const id of other.verified) group.verified.add(id);
    for (const [id, issued] of other.issued) group.issued.set(id, issued);
    if (other.selected && (!group.selected || other.selected.order > group.selected.order)) group.selected = other.selected;
    groups.delete(other);
  }
  for (const key of keys) group.members.add(key);
  for (const key of group.members) groupOf.set(key, group);
  // Re-inserted so iteration order is least recently touched first.
  touch(group, now);
  return group;
}

/**
 * Whether a browser logout ended any session this request carried. Such a
 * request left before the browser applied the logout's response, which drops
 * every one of those cookies; whenever it reaches the server, before or after
 * the logout does, it must not sign the browser back in. `sessionIds` may be
 * unverified cookie names and `tokens` raw cookie values: a forged one can
 * only refuse the forger's own request, and only verified ids are ever
 * marked ended.
 */
export function endedFor(sessionIds: readonly string[], tokens: readonly string[]): boolean {
  // Holds only as long as the mark does, whether or not anything swept since.
  const now = Date.now();
  return keysOf(sessionIds, tokens).some((key) => {
    const at = ended.get(key);
    return at !== undefined && at + TTL_MS > now;
  });
}

/**
 * Sessions recently issued to the browser holding these verified sessions or
 * tokens that its cookies do not show yet.
 */
export function issuedElsewhere(sessionIds: readonly string[], tokens: readonly string[] = []): IssuedSession[] {
  const now = Date.now();
  sweep(now);
  const shown = new Set(sessionIds);
  const result = new Map<string, IssuedSession>();
  for (const group of groupsOf(keysOf(sessionIds, tokens))) {
    for (const [issuedId, issued] of group.issued) if (!shown.has(issuedId)) result.set(issuedId, issued);
  }
  return [...result.values()];
}

/**
 * Records `issued` as given to the browser holding the verified `sessionIds`
 * and `tokens`. A token joins the group so that a logout which carries it
 * still finds the group after its session is gone: a password change rotates
 * the only session a browser had, and Better Auth deletes it before the new
 * one is settled.
 */
export function recordIssued(sessionIds: readonly string[], issued: IssuedSession, tokens: readonly string[] = []): void {
  const now = Date.now();
  sweep(now);
  const group = joined([...keysOf(sessionIds, tokens), sessionKey(issued.sessionId)], now);
  for (const id of sessionIds) group.verified.add(id);
  group.issued.set(issued.sessionId, issued);
  select(group, issued.sessionId);
}

/**
 * Marks a group used now. A switch and every late selector repair touch the
 * group they rely on, so which sessions share a browser is kept as long as
 * any selection mark it is read with (`lateSelectorRepair`).
 */
function touch(group: Group, now: number): void {
  group.touchedAt = now;
  groups.delete(group);
  groups.add(group);
}

/**
 * A switch made `sessionId` the selected one of the browser holding the
 * verified `sessionIds` and `tokens` (the switch request's valid jar
 * entries, the target among them). They are grouped together, as a sign-in
 * groups what it proved, so the selection is kept with every session the
 * browser showed, also after the target's cookie is gone.
 */
export function noteSelected(sessionIds: readonly string[], sessionId: string, tokens: readonly string[] = []): void {
  const now = Date.now();
  sweep(now);
  const group = joined([...keysOf(sessionIds, tokens), sessionKey(sessionId)], now);
  for (const id of sessionIds) group.verified.add(id);
  select(group, sessionId);
}

/**
 * A session revoked on purpose is no longer on its way to any browser. A
 * selection of it stays: the browser selected it, so a repair answers none
 * rather than an earlier selection.
 */
export function forgetIssued(sessionId: string): void {
  for (const group of groups) group.issued.delete(sessionId);
}

/**
 * A browser logout: marks the browser's tokens, its verified sessions and
 * everything grouped with them as ended now, forgets the browser, and
 * returns the session ids the caller must revoke besides the ones it holds.
 * `tokens` are the raw cookie values the logout carried; a group is found
 * through one only by presenting that exact token.
 *
 * A session issued to the group that no request of the browser has shown
 * holding — not the logout, not any settle — is revoked but not marked
 * ended: only a response landing after the logout can give the browser its
 * cookie, so a request carrying it left after the logout did, and refusing
 * it would refuse every later sign-in, addition or rotation of this browser
 * (one of a session signed in since included). It is noted as revoked late
 * instead (`lateSelectorRepair`).
 */
export function endBrowser(sessionIds: readonly string[], tokens: readonly string[]): string[] {
  const now = Date.now();
  sweep(now);
  const keys = keysOf(sessionIds, tokens);
  const end = (key: string) => {
    ended.set(key, now);
    if (key.startsWith("s:")) lateRevoked.delete(key.slice(2));
  };
  for (const key of keys) end(key);
  const held = new Set(sessionIds);
  const toRevoke = new Set<string>();
  for (const group of groupsOf(keys)) {
    const unseen = new Set([...group.issued.keys()].filter((id) => !group.verified.has(id) && !held.has(id)));
    for (const key of group.members) {
      const sessionId = key.startsWith("s:") ? key.slice(2) : null;
      if (sessionId && !held.has(sessionId)) toRevoke.add(sessionId);
      if (sessionId && unseen.has(sessionId)) continue;
      end(key);
    }
    for (const id of group.issued.keys()) {
      if (!held.has(id)) toRevoke.add(id);
      if (unseen.has(id)) { if (!ended.has(sessionKey(id))) lateRevoked.set(id, { order: nextOrder(), seenAt: now }); }
      else end(sessionKey(id));
    }
    dropGroup(group);
  }
  return [...toRevoke];
}

/**
 * Which account a request whose selector names a session a logout revoked
 * late acts as: the session the browser selected last since that logout (a
 * sign-in or a switch), or none. "Since" is the ledger's event order, not
 * the clock.
 *
 * An account is named only when continuity is proven: the last selection
 * among the groups of this request's jar entries is the newest selection
 * made since the logout in any group born after it (`Mark.latest`), and its
 * entry is still in the jar, neither ended nor revoked late. A browser's
 * selection outside those groups is never inferred absent from the cookies
 * it shows now: any newer post-logout selection elsewhere — a group whose
 * cookies are gone or were never seen beside these, one expired or evicted
 * for capacity, or another browser's fresh sign-in — answers none, and the
 * person signs in again with the other entries kept. A gone or revoked last
 * selection answers none too, never an earlier entry, and the caller drops
 * Better Auth's cookie. Null when the selector is not such a session, or
 * the ledger no longer knows (a restart, or 15 minutes without a request
 * relying on it); then nothing is repaired and the selector reads as any
 * revoked one does. Each answer renews the mark and the groups it used.
 * Cookie and ledger reads only; the answer is for this request alone and is
 * never written back as the browser's selector.
 */
export function lateSelectorRepair(selector: string | null, jarIds: readonly string[]): { to: string | null } | null {
  if (!selector) return null;
  const now = Date.now();
  const revoked = lateRevoked.get(selector);
  if (!live(revoked, now)) return null;
  const browser = groupsOf(jarIds.map(sessionKey));
  revoked.seenAt = now;
  for (const group of browser) touch(group, now);
  let last: Selection | null = null;
  for (const group of browser) if (group.selected && (!last || group.selected.order > last.order)) last = group.selected;
  const proven = last !== null && last.order === revoked.latest && last.id !== selector;
  const usable = proven && jarIds.includes(last!.id) && !revokedLate(last!.id) && !endedFor([last!.id], []);
  return { to: usable ? last!.id : null };
}

/** Whether a logout revoked this session before the browser held it; see `lateSelectorRepair`. */
export function revokedLate(sessionId: string): boolean {
  return live(lateRevoked.get(sessionId), Date.now());
}

/** Exported for tests. */
export function __resetBrowserAccountLedgerForTests(): void {
  groupOf.clear();
  groups.clear();
  ended.clear();
  lateRevoked.clear();
  order = 0;
}
