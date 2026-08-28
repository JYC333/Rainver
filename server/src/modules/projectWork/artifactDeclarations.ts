import { randomUUID } from "node:crypto";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { resolveAgentActorId } from "../../db/actorResolver.js";
import { appendProjectWorkEvent } from "./eventWriter.js";
import type { AgentActionContext } from "./taskActions.js";

/**
 * What a Run said one of the files it leaves behind actually is.
 *
 * Settlement (`architecture/PROJECT_WORK.md` §4) closes a Task only when the
 * `artifact_type` of one of its `role = 'output'` artifacts matches each entry
 * of `required_outputs_json`. Files collected from a CLI Run arrive as
 * anonymous paths typed `adapter_file`, so without this an agent can finish
 * the work and still leave every such Task parked for review.
 *
 * The declaration carries no content and uploads nothing: the file's final
 * state is collected after the run — by the executing host for a remote run,
 * by materialization for a server-host one — and the declared type and role
 * are applied to what actually arrived. A file declared but never written
 * therefore closes nothing: the Task still needs the artifact to exist.
 */
export type RunArtifactRole = "output" | "evidence" | "draft";

export interface RunArtifactDeclaration {
  id: string;
  task_id: string;
  path: string;
  artifact_type: string;
  role: RunArtifactRole;
  note: string | null;
}

/**
 * A path relative to the run's artifact output directory, as the collector
 * will name it.
 *
 * Declaring `./out/report.md` and collecting `out/report.md` must be the same
 * file, so both sides normalize the same way. An absolute path, or one that
 * climbs out of the directory, is refused rather than silently reinterpreted:
 * a declaration is only meaningful about a file inside the place the run was
 * told to leave deliverables.
 */
export function normalizeDeclaredPath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed) throw new HttpError(422, "A declared artifact needs a path");
  if (/^[a-zA-Z]:\//.test(trimmed) || trimmed.startsWith("/")) {
    throw new HttpError(422, "Declare the path relative to $RAINVER_OUTPUT_DIR, not as an absolute path");
  }
  const segments: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      throw new HttpError(422, "A declared artifact must be inside $RAINVER_OUTPUT_DIR");
    }
    segments.push(segment);
  }
  if (segments.length === 0) throw new HttpError(422, "A declared artifact needs a path");
  return segments.join("/");
}

/**
 * Records the declaration and the fact that it was made.
 *
 * The row and its `task.reported` event are written in one transaction, for
 * the reason `PROJECT_WORK.md` §3 gives: a fold that can exist without its
 * event is a fold that can disagree with the record it claims to summarize.
 * Re-declaring the same path in the same Run replaces the earlier row — an
 * agent correcting the type it named is not two artifacts.
 */
export async function declareRunArtifact(
  db: Queryable,
  context: AgentActionContext,
  task: { id: string; project_id: string },
  input: { path: string; artifact_type: string; role?: RunArtifactRole; note?: string | null },
): Promise<RunArtifactDeclaration> {
  const path = normalizeDeclaredPath(input.path);
  const role: RunArtifactRole = input.role ?? "output";
  const now = new Date().toISOString();
  const result = await db.query<RunArtifactDeclaration>(
    `INSERT INTO run_artifact_declarations
       (id, space_id, run_id, task_id, path, artifact_type, role, note, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $9::timestamptz)
     ON CONFLICT (run_id, path) DO UPDATE
       SET task_id = EXCLUDED.task_id,
           artifact_type = EXCLUDED.artifact_type,
           role = EXCLUDED.role,
           note = EXCLUDED.note,
           updated_at = EXCLUDED.updated_at
     RETURNING id, task_id, path, artifact_type, role, note`,
    [randomUUID(), context.spaceId, context.runId, task.id, path, input.artifact_type.trim(), role, input.note ?? null, now],
  );
  const declaration = result.rows[0];
  if (!declaration) throw new Error("Artifact declaration returned no row");
  await appendProjectWorkEvent(db, {
    spaceId: context.spaceId,
    projectId: task.project_id,
    eventKind: "task.reported",
    subjectType: "task",
    subjectId: task.id,
    actorId: context.actorId,
    correlationId: context.runId,
    idempotencyKey: `artifact.declared:${context.idempotencyKey}`,
    data: {
      summary: `Declared ${path} as ${role} (${declaration.artifact_type})${input.note ? `: ${input.note}` : ""}`,
      outcome: "progress",
      refs: [],
      run_id: context.runId,
      artifact_path: path,
      artifact_type: declaration.artifact_type,
      artifact_role: role,
    },
  });
  return declaration;
}

/** Every declaration this Run made, for materialization to apply. */
export async function listRunArtifactDeclarations(
  db: Queryable,
  spaceId: string,
  runId: string,
): Promise<RunArtifactDeclaration[]> {
  const result = await db.query<RunArtifactDeclaration>(
    `SELECT id, task_id, path, artifact_type, role, note
       FROM run_artifact_declarations
      WHERE space_id = $1 AND run_id = $2
      ORDER BY path ASC`,
    [spaceId, runId],
  );
  return result.rows;
}

/**
 * Gives collected files the identity their Run declared for them.
 *
 * A dispatched agent writes a deliverable into the run's artifact output
 * directory and declares it; the executing host uploads whatever landed there.
 * This is where the two meet: the uploaded artifact gets the declared type,
 * and a `role = 'output'` declaration links it to its Task, which is what lets
 * settlement match it against `required_outputs_json` and close the Task.
 *
 * An undeclared upload keeps whatever type the uploader gave it and links to
 * no Task — the pre-existing behavior, unchanged. A declaration whose file
 * never arrived is reported into the Task's stream rather than dropped: the
 * agent believed it had delivered something, and the difference between that
 * and having delivered it is exactly what a person needs to see.
 */
export async function applyRunArtifactDeclarations(
  db: Queryable,
  run: { id: string; space_id: string },
  uploaded: ReadonlyArray<{ artifact_id: string; name: string }>,
): Promise<{ applied: number; missing: string[] }> {
  const declarations = await listRunArtifactDeclarations(db, run.space_id, run.id);
  if (declarations.length === 0) return { applied: 0, missing: [] };

  const byPath = new Map<string, { artifact_id: string }>();
  for (const file of uploaded) {
    try {
      byPath.set(normalizeDeclaredPath(file.name), { artifact_id: file.artifact_id });
    } catch {
      // An upload whose name cannot be a declared path simply matches nothing.
    }
  }

  const now = new Date().toISOString();
  let applied = 0;
  const missing: string[] = [];
  for (const declaration of declarations) {
    const match = byPath.get(declaration.path);
    if (!match) {
      missing.push(declaration.path);
      continue;
    }
    await db.query(
      `UPDATE artifacts SET artifact_type = $3, updated_at = $4::timestamptz
        WHERE id = $1 AND space_id = $2`,
      [match.artifact_id, run.space_id, declaration.artifact_type, now],
    );
    // `uq_task_artifacts_task_artifact` makes a repeated upload of the same
    // artifact idempotent rather than a duplicate link.
    await db.query(
      `INSERT INTO task_artifacts (id, space_id, task_id, artifact_id, run_id, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
       ON CONFLICT (artifact_id, task_id) DO UPDATE SET role = EXCLUDED.role, run_id = EXCLUDED.run_id`,
      [randomUUID(), run.space_id, declaration.task_id, match.artifact_id, run.id, declaration.role, now],
    );
    applied += 1;
  }
  if (missing.length > 0) await reportMissingDeclarations(db, run, declarations, missing);
  return { applied, missing };
}

/**
 * One entry per Task, so an agent that declared three missing files in one
 * Task's stream produces one readable line rather than three.
 */
async function reportMissingDeclarations(
  db: Queryable,
  run: { id: string; space_id: string },
  declarations: readonly RunArtifactDeclaration[],
  missing: readonly string[],
): Promise<void> {
  const missingSet = new Set(missing);
  const byTask = new Map<string, string[]>();
  for (const declaration of declarations) {
    if (!missingSet.has(declaration.path)) continue;
    byTask.set(declaration.task_id, [...(byTask.get(declaration.task_id) ?? []), declaration.path]);
  }
  const runRow = await db.query<{ agent_id: string | null }>(
    `SELECT agent_id FROM runs WHERE space_id = $1 AND id = $2`,
    [run.space_id, run.id],
  );
  const agentId = runRow.rows[0]?.agent_id ?? null;
  if (!agentId) return;
  const actorId = await resolveAgentActorId(db, run.space_id, agentId);
  // The Task's Project, not the Run's: `declareRunArtifact` files its event
  // under the Task's, and a report that lands in a different stream than the
  // declaration it is about is the silent drop this function exists to end.
  const projects = await db.query<{ id: string; project_id: string | null }>(
    `SELECT id, project_id FROM tasks WHERE space_id = $1 AND id = ANY($2::varchar[])`,
    [run.space_id, [...byTask.keys()]],
  );
  const projectByTask = new Map(projects.rows.map((row) => [row.id, row.project_id]));
  for (const [taskId, paths] of byTask) {
    const projectId = projectByTask.get(taskId);
    if (!projectId) continue;
    await appendProjectWorkEvent(db, {
      spaceId: run.space_id,
      projectId,
      eventKind: "task.reported",
      subjectType: "task",
      subjectId: taskId,
      actorId,
      correlationId: run.id,
      idempotencyKey: `artifact.declared_missing:${run.id}:${taskId}`,
      data: {
        summary: `Declared but not delivered: ${paths.join(", ")}. Nothing was collected at ${
          paths.length === 1 ? "that path" : "those paths"
        }.`,
        outcome: "stuck",
        refs: [],
        run_id: run.id,
      },
    });
  }
}
