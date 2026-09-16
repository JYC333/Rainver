import {
  MAX_WRITE_FILE_BYTES,
  isWireRelativePath,
  redactLocalPaths,
} from "@rainver/folder-read";
import type { FolderWriteFailureCode, FolderWriteResult } from "./connectionRegistry.js";

/** Validate a daemon's write acknowledgement before it reaches a Project Folder caller. */
export function parseFolderWriteResultFrame(
  frame: Record<string, unknown>,
  expectedPath?: string,
): FolderWriteResult | null {
  if (frame.ok === false) {
    const code = frame.error;
    const allowed: readonly FolderWriteFailureCode[] = [
      "location_unknown", "path_forbidden", "not_found", "is_directory",
      "too_large", "not_text", "stale", "write_failed",
    ];
    if (typeof code !== "string" || !allowed.includes(code as FolderWriteFailureCode)) return null;
    return {
      ok: false,
      error: code as FolderWriteFailureCode,
      ...(typeof frame.message === "string" ? { message: sanitizeFailure(frame.message) } : {}),
    };
  }
  if (frame.ok !== true
    || typeof frame.path !== "string"
    || (expectedPath !== undefined && frame.path !== expectedPath)
    || !isPlainRelativePath(frame.path)
    || typeof frame.exists !== "boolean"
    || typeof frame.size !== "number"
    || !Number.isSafeInteger(frame.size)
    || frame.size < 0
    || frame.size > MAX_WRITE_FILE_BYTES
    || typeof frame.line_count !== "number"
    || !Number.isSafeInteger(frame.line_count)
    || frame.line_count < 0
    || frame.line_count > MAX_WRITE_FILE_BYTES + 1
    || (frame.exists
      ? (typeof frame.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(frame.sha256))
      : frame.sha256 !== null)) {
    return null;
  }
  if (!frame.exists && (frame.size !== 0 || frame.line_count !== 0)) return null;
  return {
    ok: true,
    path: frame.path,
    exists: frame.exists,
    sha256: frame.sha256 as string | null,
    size: frame.size,
    line_count: frame.line_count,
  };
}

function isPlainRelativePath(value: string): boolean {
  return isWireRelativePath(value)
    && value !== "."
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function sanitizeFailure(value: string): string {
  return redactLocalPaths(value).slice(0, 512);
}
