import { readFileSync } from "node:fs";

interface PackageMetadata {
  version?: unknown;
}

function readText(url: URL): string | null {
  try {
    return readFileSync(url, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * A checkout reports its package version. A published latest archive also
 * carries BUILD_ID (the publishing commit), so two latest builds remain
 * distinguishable without a second hard-coded version constant.
 */
export function daemonVersion(): string {
  const rawPackage = readText(new URL("../package.json", import.meta.url));
  let version = "unknown";
  if (rawPackage) {
    try {
      const parsed = JSON.parse(rawPackage) as PackageMetadata;
      if (typeof parsed.version === "string" && parsed.version.trim()) version = parsed.version.trim();
    } catch {
      // Keep diagnostics available even if package metadata is damaged.
    }
  }

  const buildId = readText(new URL("../BUILD_ID", import.meta.url));
  const normalizedBuildId = buildId?.match(/^[A-Za-z0-9._-]+$/)?.[0];
  return normalizedBuildId ? `${version}+${normalizedBuildId.slice(0, 12)}` : version;
}

