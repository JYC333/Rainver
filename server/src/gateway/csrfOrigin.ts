/**
 * Cookie-authenticated mutating requests rely on SameSite=Lax. This check
 * additionally refuses any explicit `Origin` other than the configured
 * frontend, and any request a browser says came from another site.
 *
 * Missing *both* headers is left to SameSite — browsers send `Origin` on a
 * cross-site POST and `Sec-Fetch-Site` on everything; inject tests and host
 * daemons send neither.
 *
 * There is no same-host fallback: behind the frontend proxy the Host header
 * carries no port and the scheme is the proxy's, so a derived origin never
 * matched a real browser origin, and a request-derived allowlist is exactly
 * what `FRONTEND_URL` exists to replace.
 *
 * Requiring `application/json` on writes was considered and not adopted. The
 * property it would buy — that a cross-origin HTML form cannot send the body,
 * since forms are limited to `x-www-form-urlencoded`, `multipart/form-data`
 * and `text/plain` — is what `Sec-Fetch-Site` already decides, and decides
 * more precisely. And one of those three is ours: the activity import route
 * (`activity/routes.ts`) takes a real `multipart/form-data` upload, so the
 * rule would have to carry an exception for the one route most worth guarding.
 */
import { INTERNAL_TOKEN_HEADER } from "./internalAuth.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfOriginAllowed(
  request: {
    method: string;
    headers: { origin?: string | string[]; "sec-fetch-site"?: string | string[] };
  },
  frontendUrl: string,
): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const site = firstHeader(request.headers["sec-fetch-site"]);
  // A browser saying plainly that another site caused this. `none` is the
  // person's own address bar, which cannot produce a write.
  if (site && site !== "same-origin" && site !== "same-site" && site !== "none") return false;
  const originHeader = firstHeader(request.headers.origin);
  if (!originHeader) return true;
  try {
    return new URL(originHeader).origin === new URL(frontendUrl).origin;
  } catch {
    return false;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * The same check for a GET that changes something.
 *
 * For a GET whose effects reach past the response — a host runtime's
 * interactive login or logout, a managed subscription's login, a Project Folder
 * read that spawns `git` on the owner's machine and writes a durable policy
 * record naming the requested path. Those are long-lived streams or reads in
 * shape, so they cannot simply become POSTs, and `SameSite=Lax` sends the
 * cookie on a top-level cross-site GET — which makes them reachable from
 * someone else's page in a way a POST is not.
 *
 * Three terms, in order, and it fails closed.
 *
 * An explicit `Origin` decides it: that is the browser naming who caused the
 * request, and judging it against `FRONTEND_URL` is the rule mutating requests
 * already use. It comes first because it is the more specific answer — a
 * frontend served from a sibling host of the API is `Sec-Fetch-Site:
 * same-site`, which would otherwise be indistinguishable from a navigation
 * somebody else's page on that domain caused.
 *
 * With no `Origin`, `Sec-Fetch-Site` is what is left, and only `same-origin` or
 * `none` — the person's own address bar — is accepted. `same-site` is not: a
 * top-level navigation from any host under the same registrable domain sends
 * exactly that, with no `Origin` and with the `SameSite=Lax` cookie attached.
 *
 * And a request carrying neither header, plus none of this client's own, is
 * refused rather than allowed: a top-level cross-site navigation in a browser
 * that sends no `Sec-Fetch-Site` carries no `Origin` either, and allowing that
 * case is exactly the hole this closes.
 *
 * A route whose only effect is its response must not use this — it would refuse
 * an ordinary cross-origin read for no reason.
 */
export function stateChangingReadAllowed(
  request: { headers: Record<string, string | string[] | undefined> },
  frontendUrl: string,
): boolean {
  const originHeader = firstHeader(request.headers.origin);
  if (originHeader) {
    try {
      return new URL(originHeader).origin === new URL(frontendUrl).origin;
    } catch {
      return false;
    }
  }
  const site = firstHeader(request.headers["sec-fetch-site"]);
  if (site) return site === "same-origin" || site === "none";
  // Neither header. A browser navigation this old sends no fetch metadata, so
  // the only thing left that a cross-site page cannot forge is a header this
  // client sets itself — one of ours, or the bearer a non-browser caller uses.
  return Boolean(
    firstHeader(request.headers["x-rainver-space-id"])
    || firstHeader(request.headers.authorization)
    || firstHeader(request.headers[INTERNAL_TOKEN_HEADER]),
  );
}
