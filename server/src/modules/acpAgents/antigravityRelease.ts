import type { AcpRegistryEntry } from "./registry.js";
import type { RuntimeBinaryTarget } from "../runtimeAdapters/specs.js";

const MANIFEST_ROOT = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const PLATFORMS = {
  "linux-x86_64": "linux_amd64",
  "linux-aarch64": "linux_arm64",
  "darwin-x86_64": "darwin_amd64",
  "darwin-aarch64": "darwin_arm64",
  "windows-x86_64": "windows_amd64",
  "windows-aarch64": "windows_arm64",
};

/** Google's CLI release feed supplies the executable and its SHA-512 integrity. */
export async function fetchAntigravityRelease(signal: AbortSignal): Promise<AcpRegistryEntry> {
  const targets = await Promise.all(Object.entries(PLATFORMS).map(async ([platform, manifest]) => {
    const response = await fetch(`${MANIFEST_ROOT}/${manifest}.json`, { signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Antigravity release manifest returned ${response.status} (${platform})`);
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)
      || typeof value.url !== "string" || typeof value.sha512 !== "string" || !/^[a-f0-9]{128}$/i.test(value.sha512)) {
      throw new Error(`Invalid Antigravity release manifest (${platform})`);
    }
    const url = new URL(value.url);
    if (url.origin !== "https://storage.googleapis.com" || !url.pathname.startsWith(`/antigravity-public/antigravity-cli/${value.version}-`)
      || url.username || url.password || url.search || url.hash) throw new Error(`Invalid Antigravity artifact URL (${platform})`);
    const target: RuntimeBinaryTarget = {
      archive: url.href, cmd: platform.startsWith("windows-") ? "./agy.exe" : "./antigravity",
      args: ["acp"], sha256: null, sha512: value.sha512.toLowerCase(), env: {},
    };
    return { platform, version: value.version, target };
  }));
  const version = targets[0]!.version;
  if (targets.some(target => target.version !== version)) throw new Error("Antigravity release manifests disagree on the CLI version");
  return {
    id: "antigravity-acp", name: "Google Antigravity", version,
    description: "Google Antigravity CLI over ACP (agy acp)",
    repository: "https://github.com/google-antigravity/antigravity-cli", license: null, icon: null,
    distribution: { kind: "binary", platforms: Object.fromEntries(targets.map(({ platform, target }) => [platform, target])) },
  };
}
