import { resolve } from "node:path";
import { isInside } from "@rainver/folder-read";

/**
 * Resolve an artifact `storage_path` under the instance artifact root.
 * Returns null for absolute paths, NUL bytes, or `..` escapes — the same
 * refusal artifact export uses, so a polluted DB row cannot load or unlink
 * a file outside the store.
 */
export function resolveStoredArtifactPath(
  artifactStorageRoot: string,
  storagePath: string | null | undefined,
): string | null {
  if (!storagePath || storagePath.startsWith("/") || storagePath.includes("\0")) return null;
  const root = resolve(artifactStorageRoot);
  const candidate = resolve(root, storagePath);
  if (!isInside(candidate, root)) return null;
  return candidate;
}
