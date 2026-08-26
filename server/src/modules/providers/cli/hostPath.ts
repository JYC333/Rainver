/**
 * Container-to-host path translation for Docker credential mounts.
 *
 * Docker-mode credential grants hand the sandbox launcher a volume source
 * path. The launcher talks to the host Docker daemon, so that path must be
 * a HOST path even though the broker computes it inside a container.
 *
 * mountinfo semantics (proc(5)): for a bind mount, field 4 is the mount
 * point inside this mount namespace and field 3 (`root`) is the path of the
 * bound directory on its filesystem — i.e. the host-side path for host-dir
 * binds. The LONGEST matching mount point wins so the root overlay mount
 * (`/`) never shadows a specific bind like `/rainver`. Outside Docker (no
 * matching bind), the container path is returned unchanged: it already IS
 * the host path.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let mountinfoReaderOverride: (() => string) | null = null;

/** Test helper: inject mountinfo content (pass null to restore /proc). */
export function __setMountinfoReaderForTests(reader: (() => string) | null): void {
  mountinfoReaderOverride = reader;
}

function readMountinfo(): string {
  if (mountinfoReaderOverride) return mountinfoReaderOverride();
  return readFileSync("/proc/self/mountinfo", "utf8");
}

export function resolveHostPath(containerPath: string): string {
  const target = resolve(containerPath);
  let bestMountPoint: string | null = null;
  let bestRoot = "";
  try {
    for (const line of readMountinfo().split("\n")) {
      const parts = line.split(/\s+/).filter((p) => p.length > 0);
      if (parts.length < 10) continue;
      if (parts.indexOf("-", 6) === -1) continue;
      const mountPoint = parts[4].replace(/\/+$/, "");
      const root = parts[3].replace(/\/+$/, "");
      if (target === mountPoint || target.startsWith(`${mountPoint}/`)) {
        if (bestMountPoint === null || mountPoint.length > bestMountPoint.length) {
          bestMountPoint = mountPoint;
          bestRoot = root;
        }
      }
    }
  } catch {
    // Outside Docker (or unreadable mountinfo): fall through to identity.
  }
  // An empty root means the best match is a whole-filesystem mount (e.g. the
  // container's overlay root) — no translation is possible or needed.
  if (bestMountPoint === null || !bestRoot) return containerPath;
  return bestRoot + target.slice(bestMountPoint.length);
}
