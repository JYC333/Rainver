import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Codex's own default sandbox is `read-only`. Inside a strict (bubblewrap)
 * namespace that already binds the Run's workspace and HOME read-write, that
 * second sandbox stacks and the Run silently cannot write.
 *
 * `RAINVER_STRICT_SANDBOX=1` is exported into the namespace for anything
 * downstream that reads it; Codex does not. This file is the runtime half:
 * the copy's `config.toml` is the switch that was measured to restore writes.
 */
export const CODEX_STRICT_SANDBOX_MODE = "workspace-write";
export const CODEX_STRICT_SANDBOX_TOML = `sandbox_mode = "${CODEX_STRICT_SANDBOX_MODE}"`;

/**
 * Sets the top-level `sandbox_mode`, and only the top-level one.
 *
 * TOML scopes a key to the table above it, so a pattern that matched
 * `sandbox_mode` anywhere in the file rewrote the first one it found — which in
 * a config with named profiles is `[profiles.something]`'s. That left the
 * top-level default exactly as it was, so the Run still could not write, and
 * silently changed a profile the person configured for a different purpose.
 * The search stops at the first table header; the insert goes above it.
 */
export function applyCodexStrictSandboxToml(contents: string): string {
  const lines = contents.split("\n");
  // A *table header* is a bracketed name alone on its line, on a line that is
  // not inside an open array. `/^\s*\[/` also matched a continuation line of a
  // multi-line array (`notify = [` … `  ["a"],`), so the scan stopped early,
  // the insert went above a key that was still top-level, and the file ended
  // with two top-level `sandbox_mode` keys — a TOML duplicate-key error, which
  // stops Codex from starting at all. Requiring the line to be alone is not
  // enough on its own: a final array element carries no trailing comma, so
  // `  ["a"]` before a closing `]` reads exactly like a header.
  const topLevelEnd = findFirstTableHeader(lines);
  // The same string-awareness the header scan has. Without it a
  // `sandbox_mode = …` line *inside* a multi-line string was taken as the
  // top-level key and rewritten, leaving the real one untouched: Codex starts
  // — no duplicate key — the vendor sandbox stays `read-only` inside the
  // namespace, and the strict-host Run silently cannot write, which is the
  // failure this module exists to prevent.
  const existing = findTopLevelSandboxMode(lines, topLevelEnd);
  if (existing !== -1) {
    lines[existing] = lines[existing]!.replace(
      /^(\s*)sandbox_mode\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/,
      `$1${CODEX_STRICT_SANDBOX_TOML}`,
    );
    return lines.join("\n");
  }
  const trimmed = contents.trimStart();
  return trimmed ? `${CODEX_STRICT_SANDBOX_TOML}\n${contents}` : `${CODEX_STRICT_SANDBOX_TOML}\n`;
}

/** Where the top-level `sandbox_mode` is, skipping any inside a string. */
function findTopLevelSandboxMode(lines: string[], topLevelEnd: number): number {
  let open: MultilineDelimiter | null = null;
  for (const [index, line] of lines.entries()) {
    if (index >= topLevelEnd) break;
    const insideString = open !== null;
    open = scanLine(line, open).open;
    if (!insideString && /^\s*sandbox_mode\s*=/.test(line)) return index;
  }
  return -1;
}

/** A multi-line string's delimiter, while one is open. */
type MultilineDelimiter = '"""' | "'''";

/** Where the top-level table ends: the first table header, or end of file. */
function findFirstTableHeader(lines: string[]): number {
  let depth = 0;
  let open: MultilineDelimiter | null = null;
  for (const [index, line] of lines.entries()) {
    const insideString = open !== null;
    const scanned = scanLine(line, open);
    open = scanned.open;
    // Nothing inside a multi-line string is syntax. A line reading
    // `[not a header]` in one was taken as the first table header, which hid
    // the real top-level `sandbox_mode` and inserted a second — the TOML
    // duplicate-key error that stops Codex from starting.
    if (!insideString && depth === 0 && /^\s*\[\[?[^\]\[]+\]\]?\s*(?:#.*)?$/.test(line)) return index;
    // Net brackets carried across lines, so an array's own elements are never
    // read as headers however they are spelled.
    depth += (scanned.code.match(/\[/g)?.length ?? 0) - (scanned.code.match(/\]/g)?.length ?? 0);
    if (depth < 0) depth = 0;
  }
  return lines.length;
}

/**
 * The syntax on one line — quoted values and the `#` comment removed — and
 * whatever multi-line string is still open at the end of it.
 *
 * Counting brackets over the raw line let one unbalanced `[` inside a string or
 * a comment — `notify = ["bash","-c","echo [done"]`, or `# see the [profiles
 * docs` — pin the depth above zero for the rest of the file. The scan then
 * never found a header, fell back to matching `sandbox_mode` anywhere, and
 * rewrote the first named profile's key: the original bug, reinstated by the
 * fix for the array one. A character walk rather than a regex, because a
 * multi-line string's state has to survive the end of the line.
 */
function scanLine(line: string, open: MultilineDelimiter | null): { code: string; open: MultilineDelimiter | null } {
  let code = "";
  let index = 0;
  if (open) {
    const close = line.indexOf(open);
    if (close === -1) return { code: "", open };
    index = close + open.length;
    open = null;
  }
  while (index < line.length) {
    const three = line.slice(index, index + 3);
    if (three === '"""' || three === "'''") {
      const close = line.indexOf(three, index + 3);
      if (close === -1) return { code, open: three };
      index = close + 3;
      continue;
    }
    const char = line[index]!;
    if (char === "#") break;
    if (char === '"') {
      index += 1;
      // A basic string takes backslash escapes; a literal string does not.
      while (index < line.length && line[index] !== '"') index += line[index] === "\\" ? 2 : 1;
      index += 1;
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < line.length && line[index] !== "'") index += 1;
      index += 1;
      continue;
    }
    code += char;
    index += 1;
  }
  return { code, open };
}

/** Ensures `CODEX_HOME/config.toml` relaxes the vendor sandbox for a strict-host Run. */
export async function ensureCodexStrictSandboxConfig(codexHome: string): Promise<void> {
  const path = join(codexHome, "config.toml");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const next = applyCodexStrictSandboxToml(current);
  if (next === current) return;
  await writeFile(path, next, { encoding: "utf8", mode: 0o600 });
}
