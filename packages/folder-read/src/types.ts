export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: FileNode[];
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  line_count: number;
  /** SHA-256 of the exact UTF-8 bytes returned, for conversation snapshots. */
  sha256?: string;
}

export interface GitChangedFile {
  path: string;
  status: string;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string | null;
  files: GitChangedFile[];
}

export interface GitDiff {
  diff: string;
  path: string | null;
  truncated: boolean;
  redacted: boolean;
}
