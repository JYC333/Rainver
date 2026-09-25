import type { Queryable } from "../routeUtils/common.js";
import { buildRunToolGrants } from "../systemActions/runToolGrants.js";
import { INPUT_RESOURCE_TOOL_ALLOWANCE } from "../systemActions/scenarioToolAllowance.js";
import { RUN_ARTIFACT_URI_PREFIX } from "../sessions/conversationInputResourceService.js";

/** git's extended header lines for a rename (`rename from <path>`, `rename to <path>`). */
const RENAME_SOURCE = /^rename from /;
const RENAME_TARGET = /^rename to /;

/**
 * What an Agent changed travels as a change list plus a reference, never
 * the patch: `git diff --stat`-style lines
 * derived here from the Run's stored `remote_diff` Artifact, and the
 * Artifact's `rainver://artifacts/<id>` link, which the Run-scoped
 * `input_resource.read/search` tools resolve on demand. The patch itself is
 * never put in a prompt.
 */

/** More files than this are summarized in one line. */
export const RUN_CHANGE_MAX_LISTED_FILES = 20;

export interface DiffStatFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface RunChange {
  run_id: string;
  artifact_id: string;
  files: DiffStatFile[];
  /** The stored diff was cut at capture or upload: counts cover only what was kept. */
  truncated: boolean;
}

export function runChangeArtifactUri(artifactId: string): string {
  return `${RUN_ARTIFACT_URI_PREFIX}${artifactId}`;
}

/** Whether a prompt carries a change link, so its Run needs the resource tools. */
export function containsRunChangeLink(text: string | null | undefined): boolean {
  return typeof text === "string" && /rainver:\/\/artifacts\/[A-Za-z0-9-]+/u.test(text);
}

/**
 * Per-file added/removed line counts of a unified `git diff`, in diff order.
 * Hunk bodies are consumed by their header's line counts, so a removed line
 * that itself begins with `--` is not mistaken for a file header. A diff cut
 * mid-hunk yields the counts of the part that is there.
 */
export function diffStat(diff: string): DiffStatFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const line of diff.split(/\r?\n/u)) {
    if (current && (oldRemaining > 0 || newRemaining > 0)) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      if (line.startsWith("+")) {
        current.added += 1;
        newRemaining -= 1;
      } else if (line.startsWith("-")) {
        current.removed += 1;
        oldRemaining -= 1;
      } else {
        oldRemaining -= 1;
        newRemaining -= 1;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      current = {
        header: headerPath(line.slice("diff --git ".length)),
        from: null, to: null, renameFrom: null, renameTo: null,
        added: 0, removed: 0, binary: false,
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(line);
    if (hunk) {
      oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
    } else if (RENAME_SOURCE.test(line)) {
      current.renameFrom = unquote(line.replace(RENAME_SOURCE, ""));
    } else if (RENAME_TARGET.test(line)) {
      current.renameTo = unquote(line.replace(RENAME_TARGET, ""));
    } else if (line.startsWith("--- ")) {
      current.from = diffSidePath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      current.to = diffSidePath(line.slice(4));
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
      const sides = /^Binary files (.+) and (.+) differ$/u.exec(line);
      if (sides) {
        current.from ??= diffSidePath(sides[1]!);
        current.to ??= diffSidePath(sides[2]!);
      }
    }
  }
  return files.flatMap((file) => {
    const path = file.renameFrom && file.renameTo
      ? `${file.renameFrom} => ${file.renameTo}`
      : file.to ?? file.from ?? file.header;
    return path ? [{ path, added: file.added, removed: file.removed, binary: file.binary }] : [];
  });
}

interface ParsedFile {
  header: string | null;
  from: string | null;
  to: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  added: number;
  removed: number;
  binary: boolean;
}

/** `a/P b/P` → `P` when both sides name the same path (the common case). */
function headerPath(rest: string): string | null {
  const value = rest.trim();
  if (value.length % 2 === 0) return null;
  const half = (value.length - 1) / 2;
  const left = stripPrefix(unquote(value.slice(0, half)));
  const right = stripPrefix(unquote(value.slice(half + 1)));
  return left === right && left.length > 0 ? right : null;
}

/** One side of `---`/`+++`/`Binary files`; null for `/dev/null`. */
function diffSidePath(value: string): string | null {
  const path = unquote(value.replace(/\t.*$/u, ""));
  return path === "/dev/null" || path.length === 0 ? null : stripPrefix(path);
}

function stripPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/**
 * git C-quotes a path with special characters: `"t\303\251st.txt"`. Octal
 * escapes are UTF-8 bytes, so they are collected and decoded together.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\""))) return trimmed;
  const body = trimmed.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\u0007", b: "\b", f: "\f", v: "\v" };
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character !== "\\" || index + 1 >= body.length) {
      bytes.push(...Buffer.from(character, "utf8"));
      continue;
    }
    const next = body[index + 1]!;
    const octal = /^[0-7]{3}/u.exec(body.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else {
      bytes.push(...Buffer.from(simple[next] ?? next, "utf8"));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The `[Changes]` block for one Run. Every line is prefixed with `indent`, so
 * it can sit under a numbered result entry or stand on its own.
 */
export function renderRunChangeBlock(change: RunChange, indent = ""): string {
  const added = change.files.reduce((sum, file) => sum + file.added, 0);
  const removed = change.files.reduce((sum, file) => sum + file.removed, 0);
  const count = change.files.length;
  const noun = count === 1 ? "file" : "files";
  const lines = [
    count === 0
      ? "[Changes] a diff was recorded but could not be summarized into files"
      : change.truncated
      ? `[Changes] at least ${count} ${noun} changed, +${added} -${removed} (the stored diff was truncated: counts cover only the stored part, and files after the cut are not listed)`
      : `[Changes] ${count} ${noun} changed, +${added} -${removed}`,
  ];
  const listed = change.files.slice(0, RUN_CHANGE_MAX_LISTED_FILES);
  for (const file of listed) {
    lines.push(`  ${file.path} | ${file.binary && file.added === 0 && file.removed === 0 ? "binary" : `+${file.added} -${file.removed}`}`);
  }
  const rest = change.files.slice(RUN_CHANGE_MAX_LISTED_FILES);
  if (rest.length > 0) {
    const restAdded = rest.reduce((sum, file) => sum + file.added, 0);
    const restRemoved = rest.reduce((sum, file) => sum + file.removed, 0);
    lines.push(`  … and ${rest.length} more ${rest.length === 1 ? "file" : "files"} (+${restAdded} -${restRemoved})`);
  }
  lines.push(
    `Full patch (not included): ${runChangeArtifactUri(change.artifact_id)} — read it only if you need the lines, with input_resource.read or input_resource.search (resource_id: ${change.artifact_id}).`,
  );
  return lines.map((line) => `${indent}${line}`).join("\n");
}

/**
 * Each Run's latest `remote_diff` Artifact (a supervisor retry reuses the Run
 * id, and the last upload is the attempt that finished), summarized. A Run
 * with no Artifact or an empty diff changed nothing and has no entry.
 */
export async function loadRunChanges(
  db: Queryable,
  spaceId: string,
  runIds: readonly string[],
): Promise<Map<string, RunChange>> {
  const changes = new Map<string, RunChange>();
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return changes;
  const result = await db.query<{ id: string; run_id: string; content: string | null; truncated: boolean | null }>(
    `SELECT DISTINCT ON (artifact.run_id)
            artifact.id, artifact.run_id, artifact.content,
            COALESCE(artifact.metadata_json->>'truncated' = 'true', false) AS truncated
       FROM artifacts artifact
      WHERE artifact.space_id = $1
        AND artifact.run_id = ANY($2::varchar[])
        AND artifact.artifact_type = 'remote_diff'
      ORDER BY artifact.run_id, artifact.created_at DESC, artifact.id DESC`,
    [spaceId, ids],
  );
  for (const row of result.rows) {
    if (typeof row.content !== "string" || row.content.trim().length === 0) continue;
    changes.set(row.run_id, {
      run_id: row.run_id,
      artifact_id: row.id,
      files: diffStat(row.content),
      truncated: row.truncated === true,
    });
  }
  return changes;
}

/**
 * A waiting Run resumed with a change link gains the resource tools — the
 * same pair `conversationToolGrantInput({ has_input_resources: true })` adds
 * at creation — recomputed through the same grant intersection. Only a Run
 * whose tools are bound to its conversation (a scenario allowance) is
 * touched; the grant can only add the two read tools, never remove one.
 */
export async function grantRunChangeReadTools(
  db: Queryable,
  run: { space_id: string; id: string },
): Promise<void> {
  const selected = await db.query<{
    capabilities_json: unknown;
    permission_snapshot_json: unknown;
    trigger_origin: string | null;
  }>(
    `SELECT capabilities_json, permission_snapshot_json, trigger_origin
       FROM runs
      WHERE space_id = $1 AND id = $2 AND status = 'queued'
      FOR UPDATE`,
    [run.space_id, run.id],
  );
  const row = selected.rows[0];
  if (!row) return;
  const snapshot = row.permission_snapshot_json && typeof row.permission_snapshot_json === "object"
    && !Array.isArray(row.permission_snapshot_json)
    ? row.permission_snapshot_json as Record<string, unknown>
    : {};
  if (!Array.isArray(snapshot.scenario_tool_allowance)) return;
  const allowance = snapshot.scenario_tool_allowance.filter((item): item is string => typeof item === "string");
  const capabilities = (Array.isArray(row.capabilities_json) ? row.capabilities_json : [])
    .filter((item): item is string => typeof item === "string");
  if (INPUT_RESOURCE_TOOL_ALLOWANCE.every((action) => capabilities.includes(action) && allowance.includes(action))) return;
  const nextCapabilities = [...new Set([...capabilities, ...INPUT_RESOURCE_TOOL_ALLOWANCE])];
  const nextAllowance = [...new Set([...allowance, ...INPUT_RESOURCE_TOOL_ALLOWANCE])];
  const grants = await buildRunToolGrants(nextCapabilities, { allowed_tools: nextAllowance });
  const toolGrants = row.trigger_origin === "autonomous"
    ? grants.filter((grant) => grant.action_id !== "authorization.request" && !grant.side_effecting)
    : grants;
  await db.query(
    `UPDATE runs
        SET capabilities_json = $3::jsonb,
            permission_snapshot_json = COALESCE(permission_snapshot_json, '{}'::jsonb)
              || jsonb_build_object('tool_grants', $4::jsonb, 'scenario_tool_allowance', $5::jsonb)
      WHERE space_id = $1 AND id = $2`,
    [run.space_id, run.id, JSON.stringify(nextCapabilities), JSON.stringify(toolGrants), JSON.stringify(nextAllowance)],
  );
}
