export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: FileNode[];
  /** Another page of this directory, absent when the listing is complete. */
  next_offset?: number;
}

export interface FileContent {
  /** Explicit bounded original-byte acquisition (Skill imports), never a text preview. */
  content_base64?: string;
  path: string;
  content: string;
  size: number;
  line_count: number;
  /** SHA-256 of the exact UTF-8 bytes returned, for conversation snapshots. */
  sha256?: string;
  /** Admission metadata. A read may omit it. */
  encoding?: "utf8" | "utf16le" | "utf16be" | "binary" | "unknown";
  has_bom?: boolean;
  line_ending_mode?: "lf" | "crlf" | "mixed" | "none";
  writable?: boolean;
  conversion_available?: boolean;
}

export interface GitChangedFile {
  path: string;
  status: string;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string | null;
  files: GitChangedFile[];
  /**
   * `files` is a prefix of the real change list: git was stopped at the
   * output limit or the timeout, or more entries changed than are shown. A
   * truncated status is not a clean tree and not a complete list; nothing
   * destructive may be decided from it.
   */
  truncated: boolean;
}

export interface GitDiff {
  diff: string;
  path: string | null;
  truncated: boolean;
  redacted: boolean;
}
