import { lstat, realpath } from "node:fs/promises";
import * as protocol from "@rainver/protocol";
import { resolve } from "node:path";
import type {
  CustomSourceHandlerOutput,
  CustomSourcePolicyLimits,
} from "@rainver/protocol";

/**
 * Validates untrusted Custom Source handler output (`output.json`) against
 * the server-owned contract before any Source row is written. See
 * `.agent/architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md#handler-contract`.
 *
 * All checks run before any database write so an invalid output never
 * produces partial Source writes — the caller only proceeds to
 * materialization after `ok: true`.
 */

export interface CustomSourceContractValidationInput {
  /** Parsed/raw JSON read from the sandbox `output.json`, not yet schema-checked. */
  raw: unknown;
  limits: CustomSourcePolicyLimits;
  /** Policy-approved network origins for `source_uri`/snapshot provenance; an empty list denies all (fail closed). */
  allowedNetworkOrigins: string[];
  /** Absolute path to the sandbox `files/` directory snapshot `file_path` values are resolved against. */
  sandboxFilesRoot: string;
}

export type CustomSourceContractValidationResult =
  | { ok: true; output: CustomSourceHandlerOutput; totalFileBytes: number }
  | { ok: false; errors: string[] };

function isInsideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function originAllowed(sourceUri: string, allowedNetworkOrigins: string[]): boolean {
  let url: URL;
  try {
    url = new URL(sourceUri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // Exact origin (scheme + host + port) match only — a naive prefix/startsWith
  // check would let "https://example.com.evil.net" pass an allowlist entry
  // of "https://example.com".
  return allowedNetworkOrigins.some((origin) => {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  });
}

export async function validateCustomSourceHandlerOutput(
  input: CustomSourceContractValidationInput,
): Promise<CustomSourceContractValidationResult> {
  const parsed = protocol.CustomSourceHandlerOutputSchema.safeParse(input.raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
      ),
    };
  }
  const output = parsed.data;
  const errors: string[] = [];

  if (output.items.length > input.limits.max_items) {
    errors.push(`items count ${output.items.length} exceeds max_items ${input.limits.max_items}`);
  }

  let totalEvidence = 0;
  let totalFiles = 0;
  let totalFileBytes = 0;
  const seenExternalIds = new Set<string>();
  // realpath resolves every symlinked path component, not just the leaf, so
  // comparing against it (rather than the lexical sandboxFilesRoot) also
  // catches a symlinked intermediate directory under files/.
  const realFilesRoot = await realpath(input.sandboxFilesRoot).catch(() => resolve(input.sandboxFilesRoot));

  for (const [itemIndex, item] of output.items.entries()) {
    if (seenExternalIds.has(item.external_id)) {
      errors.push(`items[${itemIndex}]: duplicate external_id ${JSON.stringify(item.external_id)}`);
    }
    seenExternalIds.add(item.external_id);

    if (!originAllowed(item.source_uri, input.allowedNetworkOrigins)) {
      errors.push(`items[${itemIndex}]: source_uri is outside the approved policy envelope`);
    }

    totalEvidence += item.evidence.length;
    totalFiles += item.snapshots.length;

    for (const [snapshotIndex, snapshot] of item.snapshots.entries()) {
      const label = `items[${itemIndex}].snapshots[${snapshotIndex}]`;
      const relPath = snapshot.file_path;
      if (!relPath || relPath.includes("\0") || relPath.startsWith("/") || relPath.includes("..")) {
        errors.push(`${label}: file_path must be a safe relative path, got ${JSON.stringify(relPath)}`);
        continue;
      }
      const absolutePath = resolve(input.sandboxFilesRoot, relPath);
      if (!isInsideRoot(absolutePath, resolve(input.sandboxFilesRoot))) {
        errors.push(`${label}: file_path escapes the sandbox files directory`);
        continue;
      }
      // lstat, not stat: a symlink must be rejected outright, not followed —
      // a handler could otherwise place a symlink under files/ pointing at
      // an arbitrary host-readable file and have it copied out as an
      // artifact via the materializer.
      let info;
      try {
        info = await lstat(absolutePath);
      } catch {
        errors.push(`${label}: file_path does not exist in the sandbox`);
        continue;
      }
      if (info.isSymbolicLink()) {
        errors.push(`${label}: file_path must not be a symlink`);
        continue;
      }
      if (!info.isFile()) {
        errors.push(`${label}: file_path must reference a regular file`);
        continue;
      }
      const realPath = await realpath(absolutePath).catch(() => null);
      if (!realPath || !isInsideRoot(realPath, realFilesRoot)) {
        errors.push(`${label}: file_path escapes the sandbox files directory`);
        continue;
      }
      totalFileBytes += info.size;
    }
  }

  if (totalEvidence > input.limits.max_evidence_items) {
    errors.push(`evidence count ${totalEvidence} exceeds max_evidence_items ${input.limits.max_evidence_items}`);
  }
  if (totalFiles > input.limits.max_files) {
    errors.push(`snapshot file count ${totalFiles} exceeds max_files ${input.limits.max_files}`);
  }
  if (totalFileBytes > input.limits.max_output_bytes) {
    errors.push(`snapshot file bytes ${totalFileBytes} exceeds max_output_bytes ${input.limits.max_output_bytes}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, output, totalFileBytes };
}
