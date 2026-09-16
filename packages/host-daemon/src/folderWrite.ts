import type { FolderWriteDaemonError, HostServerFrameOf } from "@rainver/protocol";
import {
  FolderWriteError,
  isWireRelativePath,
  MAX_WRITE_FILE_BYTES,
  restoreFolderFile,
  writeFolderFile,
} from "@rainver/folder-read";
import { sanitizeFailure } from "./ambientRedaction.js";

export interface FolderWriteRequest {
  request_id: string;
  workspace_location_id: string;
  path: string;
  content: string | null;
  expected_exists: boolean;
  expected_sha256: string | null;
  protected: boolean;
  root: string;
}

export type FolderWriteResult =
  | { type: "folder_write_result"; request_id: string; ok: true; path: string; exists: boolean; sha256: string | null; size: number; line_count: number }
  | { type: "folder_write_result"; request_id: string; ok: false; error: FolderWriteDaemonError; message?: string };

export class FolderWriteFrameError extends Error {
  constructor(readonly code: FolderWriteDaemonError, message: string) {
    super(message);
    this.name = "FolderWriteFrameError";
  }
}

/** Resolve only through the daemon's local Location map; no absolute path is trusted from the server. */
export function resolveFolderWriteRequest(
  frame: Omit<HostServerFrameOf<"folder_write">, "type">,
  workspaces: Record<string, string>,
): FolderWriteRequest {
  const requestId = frame.request_id.trim();
  if (!requestId) throw new FolderWriteFrameError("write_failed", "folder_write frame needs a request_id");
  const locationId = frame.workspace_location_id.trim();
  if (!locationId) throw new FolderWriteFrameError("location_unknown", "folder_write frame needs a workspace_location_id");
  const root = workspaces[locationId];
  if (!root) throw new FolderWriteFrameError("location_unknown", `This host has no registered directory for location ${locationId}`);
  if (!isWireRelativePath(frame.path) || frame.path === "." || frame.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new FolderWriteFrameError("path_forbidden", "folder_write paths must be plain relative paths");
  }
  if (frame.content !== null && Buffer.byteLength(frame.content, "utf8") > MAX_WRITE_FILE_BYTES) {
    throw new FolderWriteFrameError("too_large", `File is too large to write (max ${MAX_WRITE_FILE_BYTES} bytes)`);
  }
  return {
    request_id: requestId,
    workspace_location_id: locationId,
    path: frame.path,
    content: frame.content,
    expected_exists: frame.expected_exists,
    expected_sha256: frame.expected_sha256,
    protected: frame.protected,
    root,
  };
}

export async function performFolderWrite(request: FolderWriteRequest): Promise<FolderWriteResult> {
  try {
    const result = request.content === null
      ? await restoreFolderFile(request.root, request.path, null, {
          protectedFolder: request.protected,
          expectedExists: request.expected_exists,
          expectedSha256: request.expected_sha256,
        })
      : await writeFolderFile(request.root, request.path, request.content, {
          protectedFolder: request.protected,
          expectedExists: request.expected_exists,
          expectedSha256: request.expected_sha256,
        });
    return {
      type: "folder_write_result",
      request_id: request.request_id,
      ok: true,
      path: result.path,
      exists: result.exists,
      sha256: result.sha256,
      size: result.size,
      line_count: result.line_count,
    };
  } catch (error) {
    const mapped = mapFolderWriteFailure(error);
    return {
      type: "folder_write_result",
      request_id: request.request_id,
      ok: false,
      error: mapped.code,
      ...(mapped.message ? { message: mapped.message } : {}),
    };
  }
}

function mapFolderWriteFailure(error: unknown): { code: FolderWriteDaemonError; message?: string } {
  if (error instanceof FolderWriteError) return { code: error.code, message: sanitizeFailure(error) };
  return { code: "write_failed", message: sanitizeFailure(error) };
}
