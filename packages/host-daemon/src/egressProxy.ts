import { connect, createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { isBlockedAddress } from "@rainver/outbound-guard";

/**
 * The host's own egress proxy: one HTTP CONNECT server, on the container's
 * loopback, that every strict Run is pointed at.
 *
 * **What this is.** A place to say what a Run may reach, and a record of what
 * it did reach. `HTTP_PROXY` points a Run here, and pointing is advisory —
 * every vendor CLI, git and package manager honours it; a process that opens
 * its own socket does not. `none` is still the only profile that *confines* a
 * Run's network, and it does that with a network namespace, not with this.
 *
 * **What is a real boundary here.** The private-range refusal — one list,
 * `@rainver/outbound-guard`, shared with the control plane's own outbound
 * fetches — because the proxy declines rather than the client neglecting to ask. Nothing dialled
 * through this reaches the instance's own network, a sibling container, a
 * cloud metadata endpoint, or loopback — under every profile, `install`
 * included. That is the difference between "we asked it not to" and "it
 * cannot".
 */
export type EgressProfile = "none" | "default" | "install";

export interface EgressDecision {
  allowed: boolean;
  host: string;
  port: number;
  /** Why it was refused, phrased for a runtime to print to whoever is watching. */
  reason: string | null;
  at: string;
}

export interface EgressGrant {
  /** The value a Run sends back in `Proxy-Authorization`, so one Run cannot borrow another's policy. */
  token: string;
  profile: EgressProfile;
}

/**
 * Package registries and their download hosts.
 *
 * Named rather than pattern-matched: "does this host look like a registry" has
 * no answer, and a Run that installs from somewhere unexpected should be a
 * visible refusal rather than a lucky match. A registry a team actually needs
 * is a line here, added deliberately.
 */
const REGISTRY_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "repo.maven.apache.org",
  "packagist.org",
  "repo.packagist.org",
  "ghcr.io",
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
];

function hostMatches(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((entry) => name === entry || name.endsWith(`.${entry}`));
}

/**
 * Whether this profile may reach this host, before the address is resolved.
 *
 * Registries are the only name-level distinction: `default` is a Run doing its
 * work, `install` is a Run that was granted the ability to pull packages
 * (ADR 0017's exposure row).
 */
export function policyAllows(profile: EgressProfile, host: string): { allowed: boolean; reason: string | null } {
  if (profile === "none") {
    return { allowed: false, reason: "This Run has no network access." };
  }
  if (profile === "default" && hostMatches(host, REGISTRY_HOSTS)) {
    return {
      allowed: false,
      reason: `Package installs are not allowed for this Run, so ${host} was refused. `
        + "Ask for install access if this Run needs to fetch dependencies.",
    };
  }
  return { allowed: true, reason: null };
}

export interface EgressProxyHandle {
  /** `host:port` a Run's `HTTP_PROXY` points at. */
  readonly address: string;
  /** Registers a Run's policy and returns the credential its environment carries. */
  grant(runId: string, profile: EgressProfile): EgressGrant;
  /**
   * Forgets a Run's policy and its log; later connections on its token are
   * refused. Called once the completion frame has read the log, so nothing is
   * lost — and without it both maps would grow for the daemon's lifetime.
   */
  revoke(runId: string): void;
  /** What this Run reached, and what it was refused, oldest first. */
  log(runId: string): EgressDecision[];
  /**
   * Drops a Run's log while keeping its grant. Used when a retry has taken
   * over the id: the finished attempt reports its own entries and must not
   * leave them for the live attempt to report again.
   */
  clearLog(runId: string): void;
  close(): Promise<void>;
}

/** How long to wait for an upstream to accept, before the client is told it could not be reached. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

/** How many decisions are kept per Run; a log is for explaining a Run, not for auditing a crawl. */
const MAX_LOG_ENTRIES = 200;

/**
 * Starts the proxy on the container's loopback.
 *
 * Loopback on purpose: only this container's processes can reach it, so the
 * grant token is about telling *Runs* apart, not about keeping strangers out.
 */
export async function startEgressProxy(log: (line: string) => void = () => {}): Promise<EgressProxyHandle> {
  const grants = new Map<string, { runId: string; profile: EgressProfile }>();
  const runTokens = new Map<string, string>();
  const decisions = new Map<string, EgressDecision[]>();

  const record = (runId: string, decision: EgressDecision) => {
    const entries = decisions.get(runId) ?? [];
    entries.push(decision);
    // Oldest first, bounded: a Run that fetches thousands of URLs must not
    // grow this without limit, and the first refusals are the ones that
    // explain what happened. The last entry says so rather than the record
    // silently ending, so nobody reads 200 as "that was all of it".
    if (entries.length > MAX_LOG_ENTRIES) {
      entries.splice(MAX_LOG_ENTRIES - 1);
      entries.push({
        allowed: false,
        host: "(truncated)",
        port: 0,
        reason: `More than ${MAX_LOG_ENTRIES} requests; the rest are not recorded.`,
        at: decision.at,
      });
    }
    decisions.set(runId, entries);
  };

  const server: Server = createServer();
  server.on("connection", (client: Socket) => {
    // Accumulated, not read from the first chunk: a CONNECT request arrives
    // split whenever the client writes its headers separately, and reading one
    // chunk turned that into a 405 or a 407 depending on where the split fell.
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        // A header this large is not a CONNECT request.
        if (head.length > 16_384) { client.removeListener("data", onData); refuse(client, 431, "Request header is too large."); }
        return;
      }
      client.removeListener("data", onData);
      // Whatever followed the header is the tunnel's first bytes — a client
      // that pipelines its ClientHello sends it here — and must be replayed
      // once the tunnel opens rather than dropped.
      const rest = head.subarray(end + 4);
      // Nothing may arrive while the policy is decided and DNS is resolved:
      // a flowing socket with no listener drops what it receives.
      client.pause();
      void handleRequest(client, head.subarray(0, end + 4), rest);
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  });

  async function handleRequest(client: Socket, head: Buffer, pipelined: Buffer): Promise<void> {
    const text = head.toString("utf8");
    const requestLine = text.split("\r\n", 1)[0] ?? "";
    const [method, target] = requestLine.split(" ");
    // CONNECT only. Everything a Run does is https, and a plain proxied GET
    // would put the request — headers, tokens — through this process, which is
    // not a thing this should ever hold.
    if (method !== "CONNECT" || !target) {
      return refuse(client, 405, "This proxy accepts CONNECT only.");
    }
    const token = /\r\nproxy-authorization:\s*basic\s+(\S+)/i.exec(text)?.[1] ?? "";
    const grant = grants.get(Buffer.from(token, "base64").toString("utf8").replace(/^.*:/, ""));
    if (!grant) {
      return refuse(client, 407, "This Run is not authorized to use the host's egress proxy.");
    }
    const separator = target.lastIndexOf(":");
    // `[::1]:443` is how a client writes an IPv6 literal; without stripping the
    // brackets the host is never recognised as an address at all — which both
    // broke every IPv6 target and skipped the block list for it.
    const rawHost = separator > 0 ? target.slice(0, separator) : target;
    const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
    const port = separator > 0 ? Number(target.slice(separator + 1)) : 443;
    const at = new Date().toISOString();
    // Validated before anything is recorded: a non-integer port used to be
    // written into the log as `NaN`, which serializes as null, which the
    // `complete` frame's schema rejects — discarding the whole frame, leaving
    // the Run running forever and never releasing its concurrency slot.
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      record(grant.runId, { allowed: false, host: host || "(malformed)", port: 0, reason: "Malformed CONNECT target.", at });
      return refuse(client, 400, `${target} is not a host and port this proxy can dial.`);
    }
    const deny = (reason: string, status = 403) => {
      record(grant.runId, { allowed: false, host, port, reason, at });
      log(`egress refused for run ${grant.runId}: ${host}:${port} — ${reason}`);
      return refuse(client, status, reason);
    };
    const policy = policyAllows(grant.profile, host);
    if (!policy.allowed) return deny(policy.reason ?? "Refused by this Run's egress policy.");

    // Resolved before the policy's last word: a public name that resolves into
    // the instance's own network is exactly how a Run reaches a sibling
    // service, and the name alone cannot say so.
    let address: string;
    try {
      address = isIP(host) ? host : (await lookup(host)).address;
    } catch {
      return deny(`${host} could not be resolved.`, 502);
    }
    if (isBlockedAddress(address)) {
      return deny(
        `${host} resolves to ${address}, which is inside this instance's own network. `
        + "Runs reach the public Internet only.",
      );
    }

    // Registered before the socket exists, so a client that left during DNS
    // resolution still tears down whatever this is about to open — `close`
    // has already fired by the time a listener attached afterwards would see
    // it, and a piped destination error does not destroy its source.
    let established = false;
    // `client.destroyed` is checked rather than only listened for: a client
    // that left *during* DNS resolution has already fired its `close`, and a
    // listener attached now would never hear it. The listeners below cover
    // everything after this point; a piped destination error does not destroy
    // its source, so this is the only teardown there is.
    let clientGone = client.destroyed;
    let upstream: Socket | null = null;
    client.on("close", () => { clientGone = true; upstream?.destroy(); });
    client.on("error", () => upstream?.destroy());
    upstream = connect({ host: address, port }, () => {
      const socket = upstream!;
      socket.setTimeout(0);
      if (clientGone) { socket.destroy(); return; }
      established = true;
      record(grant.runId, { allowed: true, host, port, reason: null, at });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (pipelined.length > 0) socket.write(pipelined);
      socket.pipe(client);
      client.pipe(socket);
      client.resume();
    });
    // A host that accepts nothing leaves the client waiting on a response that
    // never comes; the Run's own timeout is minutes away.
    upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => {
      if (!established) upstream?.destroy(new Error(`Timed out connecting to ${host}`));
    });
    upstream.on("error", (error) => {
      // After the tunnel is open there is no protocol left to speak: writing an
      // HTTP response here injects plaintext into the Run's own TLS session,
      // which it reports as a corrupt record rather than a reset. And a
      // transport failure is not a policy refusal — recording it as one made
      // every ordinary connection reset raise an `egress_refused` warning.
      if (established) { client.destroy(); return; }
      record(grant.runId, { allowed: false, host, port, reason: error.message, at });
      refuse(client, 502, `Could not reach ${host}: ${error.message}`);
    });

  }

  const STATUS_TEXT: Record<number, string> = {
    400: "Bad Request",
    403: "Forbidden",
    405: "Method Not Allowed",
    407: "Proxy Authentication Required",
    431: "Request Header Fields Too Large",
    502: "Bad Gateway",
  };

  function refuse(client: Socket, status: number, reason: string): void {
    if (client.destroyed) return;
    const body = `${reason}\n`;
    client.write(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Forbidden"}\r\n`
      + "Content-Type: text/plain\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + (status === 407 ? 'Proxy-Authenticate: Basic realm="rainver"\r\n' : "")
      + "Connection: close\r\n\r\n"
      + body,
    );
    // `end()` alone leaves the socket half-open until the client closes its own
    // side, which a client waiting for a tunnel never does.
    client.end(() => client.destroy());
  }

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error) => reject(error);
    server.once("error", onListenError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onListenError);
      // A later error is not a startup failure and must not be swallowed: the
      // proxy stays up, and the line is how anyone finds out it misbehaved.
      server.on("error", (error) => log(`egress proxy error: ${error.message}`));
      resolve();
    });
  });
  const listening = server.address();
  const port = typeof listening === "object" && listening ? listening.port : 0;
  log(`egress proxy listening on 127.0.0.1:${port}`);

  return {
    address: `127.0.0.1:${port}`,
    grant(runId, profile) {
      const previous = runTokens.get(runId);
      if (previous) grants.delete(previous);
      const token = randomBytes(24).toString("hex");
      grants.set(token, { runId, profile });
      runTokens.set(runId, token);
      return { token, profile };
    },
    revoke(runId) {
      const token = runTokens.get(runId);
      if (token) grants.delete(token);
      runTokens.delete(runId);
      decisions.delete(runId);
    },
    log(runId) {
      return decisions.get(runId) ?? [];
    },
    clearLog(runId) {
      decisions.delete(runId);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Every hostname the control plane tells this Run to talk to.
 *
 * A Run is handed the instance's own addresses — the work surface's
 * `RAINVER_API_URL`, a provider lease's base URL — and those resolve into this
 * instance's network, which the proxy refuses by design. Proxying them would
 * break the Run on the *default* path and log a refusal for every attempt, so
 * they bypass the proxy rather than being blocked by it.
 *
 * Read out of what is actually handed over, not from a list somebody has to
 * remember to update — and that means **both** channels. Only `claude_code`
 * takes its lease URL through the environment; `codex_cli` and `opencode`
 * receive theirs inside a config file the daemon writes, so scanning the
 * environment alone covered one adapter in three. It happened to work because
 * both URLs are built from the same host, which is exactly the kind of
 * accident that survives until someone sets `provider_proxy_base_url`.
 */
export function proxyBypassHosts(sources: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/https?:\/\/[^\s"'`,)\]}]+/g)) {
      try {
        hosts.add(new URL(match[0]).hostname);
      } catch {
        // Not a URL after all; nothing to bypass.
      }
    }
  }
  return [...hosts];
}

/**
 * The environment that points a Run at the proxy.
 *
 * `NO_PROXY` names the loopback — so a runtime talking to something it started
 * itself does not loop back through here — plus every control-plane address
 * this Run was handed. The credential is Basic, because that is what every
 * client's proxy support understands.
 */
export function egressProxyEnv(address: string, token: string, bypass: readonly string[] = []): Record<string, string> {
  const url = `http://run:${token}@${address}`;
  const noProxy = ["localhost", "127.0.0.1", "[::1]", ...bypass].join(",");
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
