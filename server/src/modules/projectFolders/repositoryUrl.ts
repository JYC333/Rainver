import { HttpError } from "../routeUtils/common.js";

/**
 * The one transport a member-supplied clone source may use.
 *
 * git also accepts a local path or `file://`, which would copy a repository
 * from the server's own disk into the Space, and `ssh://`, `git://` and the
 * scp-like `user@host:path`, whose connections git opens itself with nothing
 * in between to judge the destination. HTTPS is the transport the clone can
 * be made to go through the control plane's guarded CONNECT proxy, which
 * resolves every host — the first and every redirect — and refuses the
 * instance's own network. A repository reachable only another way is cloned
 * on a trusted machine and registered as an existing directory or through a
 * paired host.
 */
const CLONE_PROTOCOL = "https";

/** git's own allow-list for the clone, so a redirect or a submodule cannot switch transport. */
export const CLONE_GIT_ALLOW_PROTOCOL = CLONE_PROTOCOL;

/** Why a clone source was refused, phrased for the person who typed it. */
export const CLONE_URL_MESSAGE =
  "repo_url must be an https:// URL of a public Git service. "
  + "For a repository on a private network or reached over SSH, clone it on a trusted machine "
  + "and connect the existing directory or register it through a paired host.";

export function assertRemoteRepositoryUrl(repoUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new HttpError(422, CLONE_URL_MESSAGE);
  }
  if (parsed.protocol !== `${CLONE_PROTOCOL}:` || !parsed.hostname) {
    throw new HttpError(422, CLONE_URL_MESSAGE);
  }
  return parsed;
}

/**
 * Credentials a person pasted into the URL are theirs to keep: git prints the
 * URL in its failure text, and that text is shown back and could be logged.
 */
export function redactRepositoryUrlCredentials(text: string): string {
  return text.replace(/(\bhttps?:\/\/)[^\s/@]+@/gi, "$1***@");
}
