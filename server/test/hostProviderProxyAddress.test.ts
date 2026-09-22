import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { setProviderProxyBaseUrlForProcess } from "../src/modules/providers/proxy/lease.js";
import { hostProviderProxyBaseUrl } from "../src/modules/runs/hostProviderProxyAddress.js";

// Where a host is told to reach the provider proxy. The Command Center shows
// this answer and a dispatched Run is handed it, so a wrong address is either
// a run that fails on someone's laptop or a lease token sent somewhere the
// instance never published (ADR 0008).

const paired = { provider_proxy_base_url: null, kind: "remote" };
const builtin = { provider_proxy_base_url: null, kind: "server" };

const config = (env: Record<string, string> = {}) =>
  loadConfig({ FRONTEND_URL: "http://space.example.com/app/", PROVIDER_PROXY_PORT: "8021", ...env });

// Files share a worker: the proxy addresses live in module state, so anything
// left here would follow whichever file runs next.
afterAll(() => {
  setProviderProxyBaseUrlForProcess(null, null);
});

describe("where a host reaches the provider proxy", () => {
  it("derives a paired host's address from FRONTEND_URL, never from what a daemon reports", () => {
    setProviderProxyBaseUrlForProcess("http://server:8021", null);
    // `http://server:8021` is the in-network listener a daemon reports; a
    // paired machine cannot resolve a Compose service name. A path on the
    // control-plane address is not part of the proxy's address either.
    expect(hostProviderProxyBaseUrl(paired, config())).toBe("http://space.example.com:8021");
  });

  it("does not derive a plaintext proxy address from an https control plane", () => {
    setProviderProxyBaseUrlForProcess("http://server:8021", null);
    // The listener is plaintext: TLS terminates somewhere this port is not
    // behind, so a derived `https:` URL would fail the handshake or quietly
    // drop TLS around the lease token.
    expect(hostProviderProxyBaseUrl(paired, config({ FRONTEND_URL: "https://space.example.com" }))).toBeNull();
  });

  it("keeps the built-in host on the in-network listener even when an external address is published", () => {
    setProviderProxyBaseUrlForProcess("http://server:8021", "http://192.168.1.5:8021");
    // An address published for machines outside would take the lease token
    // off the internal network.
    expect(hostProviderProxyBaseUrl(builtin, config())).toBe("http://server:8021");
  });

  it("prefers an explicit per-host override, then the instance-wide setting", () => {
    setProviderProxyBaseUrlForProcess("http://server:8021", "https://proxy.instance.example/");
    // Configuration outranks derivation: an operator who published the proxy
    // elsewhere said so, and the trailing slash is normalized off so the
    // lease path concatenates cleanly.
    expect(hostProviderProxyBaseUrl({ ...paired, provider_proxy_base_url: "https://proxy.example.com/" }, config()))
      .toBe("https://proxy.example.com");
    expect(hostProviderProxyBaseUrl(paired, config())).toBe("https://proxy.instance.example");
  });

  it("declines to guess with an OS-assigned proxy port and nothing configured", () => {
    setProviderProxyBaseUrlForProcess("http://server:8021", null);
    // PROVIDER_PROXY_PORT unset is the OS-assigned case (port 0): there is no
    // port to put in a derived URL, so no address applies.
    expect(hostProviderProxyBaseUrl(paired, loadConfig({ FRONTEND_URL: "http://space.example.com" }))).toBeNull();
  });
});
