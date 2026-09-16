export const MAX_DEPTH = 5;
export const MAX_FILES = 500;
export const MAX_FILE_BYTES = 1_048_576;
/** Direct File-page writes use the same cap as File-page reads. */
export const MAX_WRITE_FILE_BYTES = MAX_FILE_BYTES;
export const MAX_DIFF_BYTES = 512 * 1024;

export const IGNORE_DIRS = new Set([
  ".git",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
]);

export const SHOW_HIDDEN = new Set([
  ".gitignore",
  ".env.example",
  ".env.dev.example",
  ".env.test.example",
  ".env.prod.example",
  ".claude",
  ".editorconfig",
]);
