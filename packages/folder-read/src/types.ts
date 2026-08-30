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
