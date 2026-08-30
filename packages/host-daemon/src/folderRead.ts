import {
  buildTree,
  folderGitDiff,
  folderGitStatus,
  FolderReadError,
  isWireRelativePath,
  PathPolicyError,
  readFolderFile,
  type FileContent,
  type FileNode,
  type GitDiff,
  type GitStatus,
} from "@rainver/folder-read";
import { sanitizeFailure } from "./ambientRedaction.js";

export type FolderReadKind = "tree" | "file" | "git_status" | "git_diff";

export interface FolderReadRequest {
  request_id: string;
  workspace_location_id: string;
  kind: FolderReadKind;
  path?: string;
  protected: boolean;
  root: string;
}

export type FolderReadResult =
  | { type: "folder_read_result"; request_id: string; ok: true; kind: FolderReadKind; result: FileNode | FileContent | GitStatus | GitDiff }
  | { type: "folder_read_result"; request_id: string; ok: false; error: FolderReadErrorCode; message?: string };

export type FolderReadErrorCode =
  | "location_unknown"
  | "path_forbidden"
  | "not_found"
  | "is_directory"
  | "too_large"
  | "read_failed";

export class FolderReadFrameError extends Error {
  constructor(readonly code: FolderReadErrorCode, message: string) {
    super(message);
    this.name = "FolderReadFrameError";
  }
}

/**
 * Validates the server's request and resolves the location only from the
 * daemon's own registration map. The absolute path never appears on the
 * wire: the control plane can name a location, but only this process knows
 * the path behind it (ADR 0016 D3).
 */
export function parseFolderReadFrame(
  frame: Record<string, unknown>,
  workspaces: Record<string, string>,
): FolderReadRequest {
  const requestId = typeof frame.request_id === "string" ? frame.request_id.trim() : "";
  if (!requestId) throw new FolderReadFrameError("read_failed", "folder_read frame needs a request_id");
  const locationId = typeof frame.workspace_location_id === "string" ? frame.workspace_location_id.trim() : "";
  if (!locationId) throw new FolderReadFrameError("location_unknown", "folder_read frame needs a workspace_location_id");
  const root = workspaces[locationId];
  if (!root) throw new FolderReadFrameError("location_unknown", `This host has no registered directory for location ${locationId}`);
  const kind = frame.kind;
  if (kind !== "tree" && kind !== "file" && kind !== "git_status" && kind !== "git_diff") {
    throw new FolderReadFrameError("read_failed", "folder_read frame has an unknown kind");
  }
  if (typeof frame.protected !== "boolean") {
    throw new FolderReadFrameError("read_failed", "folder_read frame needs a protected boolean");
  }
  const rawPath = frame.path;
  if (rawPath !== undefined && typeof rawPath !== "string") {
    throw new FolderReadFrameError("path_forbidden", "folder_read path must be a relative string");
  }
  if (typeof rawPath === "string" && rawPath.includes("\0")) {
    throw new FolderReadFrameError("path_forbidden", "folder_read path contains an invalid character");
  }
  let path: string | undefined;
  if (kind === "file") {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      throw new FolderReadFrameError("path_forbidden", "file reads require a relative path");
    }
    if (!isWireRelativePath(rawPath)) {
      throw new FolderReadFrameError("path_forbidden", "folder_read paths must be relative");
    }
    path = rawPath;
  } else if (kind === "git_diff" && rawPath !== undefined) {
    if (typeof rawPath !== "string" || !rawPath.trim() || !isWireRelativePath(rawPath)) {
      throw new FolderReadFrameError("path_forbidden", "folder_read paths must be relative");
    }
    path = rawPath;
  } else if (rawPath !== undefined) {
    throw new FolderReadFrameError("read_failed", `${kind} reads do not accept a path`);
  }
  return {
    request_id: requestId,
    workspace_location_id: locationId,
    kind,
    ...(path === undefined ? {} : { path }),
    protected: frame.protected,
    root,
  };
}

/** Performs one bounded, read-only operation on a registered workspace. */
export async function performFolderRead(request: FolderReadRequest): Promise<FolderReadResult> {
  try {
    let result: FileNode | FileContent | GitStatus | GitDiff;
    switch (request.kind) {
      case "tree":
        result = await buildTree(request.root);
        break;
      case "file":
        result = await readFolderFile(request.root, request.path!, { protectedFolder: request.protected });
        break;
      case "git_status":
        result = await folderGitStatus(request.root);
        break;
      case "git_diff":
        result = await folderGitDiff(request.root, request.path ?? null, { protectedFolder: request.protected });
        break;
    }
    return { type: "folder_read_result", request_id: request.request_id, ok: true, kind: request.kind, result };
  } catch (error) {
    const mapped = mapFolderReadFailure(error);
    return {
      type: "folder_read_result",
      request_id: request.request_id,
      ok: false,
      error: mapped.code,
      ...(mapped.message ? { message: mapped.message } : {}),
    };
  }
}

function mapFolderReadFailure(error: unknown): { code: FolderReadErrorCode; message?: string } {
  if (error instanceof PathPolicyError) return { code: "path_forbidden", message: sanitizeFailure(error) };
  if (error instanceof FolderReadError) return { code: error.code, message: sanitizeFailure(error) };
  return { code: "read_failed", message: sanitizeFailure(error) };
}
