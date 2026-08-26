import { randomUUID } from "node:crypto";
import { redactEvidenceText } from "../runs/evidenceRedaction.js";
import { runFinalizationReconcilerRegistry } from "../runs/finalizationReconcilerRegistry.js";
import type { Queryable, RunRecord } from "../runs/runRepositoryTypes.js";
import { autonomyDiscovererRegistry, type AutonomyCandidateKind } from "./registry.js";

export function registerAutonomyRunFinalizationReconciler(): void {
  runFinalizationReconcilerRegistry.register("autonomy", {
    reconcile: (db, run) => reconcileAutonomyRun(db, run),
  }, "autonomy");
}

export async function reconcileAutonomyRun(db: Queryable, run: RunRecord): Promise<void> {
  if (run.trigger_origin !== "autonomous") return;
  const candidateResult = await db.query<{
    id: string;
    owner_user_id: string;
    project_id: string | null;
    candidate_kind: AutonomyCandidateKind;
    discovery_snapshot_json: Record<string, unknown>;
    launch_tick_id: string | null;
    artifact_id: string | null;
  }>(
    `SELECT id, owner_user_id, project_id, candidate_kind, discovery_snapshot_json,
            launch_tick_id, artifact_id
       FROM autonomy_candidates
      WHERE space_id = $1 AND run_id = $2
      FOR UPDATE`,
    [run.space_id, run.id],
  );
  const candidate = candidateResult.rows[0];
  if (!candidate || !candidate.launch_tick_id) return;
  const handler = autonomyDiscovererRegistry.get(candidate.candidate_kind);
  if (!handler) return;
  const nowDate = new Date();
  const now = nowDate.toISOString();
  let artifactId = candidate.artifact_id;
  if ((run.status === "succeeded" || run.status === "degraded") && !artifactId) {
    const report = handler.buildReport({
      candidateId: candidate.id,
      projectId: candidate.project_id,
      discoverySnapshot: candidate.discovery_snapshot_json,
      run,
      now: nowDate,
    });
    artifactId = randomUUID();
    const output = recordValue(run.output_json);
    const content = redactEvidenceText(
      stringValue(output.summary)
      ?? stringValue(recordValue(output.result).report)
      ?? report.fallbackContent,
    );
    await db.query(
      `INSERT INTO artifacts (
         id, space_id, run_id, project_id, artifact_type, title, content,
         mime_type, exportable, export_formats_json, preview, owner_user_id,
         metadata_json, created_at, updated_at, visibility, trust_level
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         'text/markdown', true, '[]'::jsonb, false, $8, $9::jsonb,
         $10, $10, 'private', 'medium'
       )`,
      [
        artifactId,
        run.space_id,
        run.id,
        candidate.project_id,
        report.artifactType,
        report.title,
        content,
        candidate.owner_user_id,
        JSON.stringify({
          autonomy_candidate_id: candidate.id,
          autonomy_tick_id: candidate.launch_tick_id,
          source_run_id: run.id,
          immutable_report: true,
        }),
        now,
      ],
    );
  }
  const completed = run.status === "succeeded" || run.status === "degraded";
  if (completed && artifactId) {
    await handler.onCompleted?.(db, {
      candidateId: candidate.id,
      spaceId: run.space_id,
      ownerUserId: candidate.owner_user_id,
      artifactId,
      run,
      now: nowDate,
    });
  }
  await db.query(
    `UPDATE autonomy_candidates
        SET status = $3, artifact_id = COALESCE($4, artifact_id),
            completed_at = $5, updated_at = $5
      WHERE space_id = $1 AND id = $2`,
    [run.space_id, candidate.id, completed ? "completed" : "failed", artifactId, now],
  );
  await settleAutonomyCoordinator(db, run.space_id, candidate.launch_tick_id, now);
}

export async function settleAutonomyCoordinator(db: Queryable, spaceId: string, tickId: string, now: string): Promise<void> {
  const tick = await db.query<{ coordinator_run_id: string | null }>(
    `SELECT coordinator_run_id FROM autonomy_ticks
      WHERE space_id = $1 AND id = $2 FOR UPDATE`,
    [spaceId, tickId],
  );
  const coordinatorRunId = tick.rows[0]?.coordinator_run_id;
  if (!coordinatorRunId) return;
  const pending = await db.query<{ total: number; failed: number }>(
    `SELECT
       count(*) FILTER (WHERE status IN ('admitted', 'launched'))::int AS total,
       count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM autonomy_candidates
      WHERE space_id = $1 AND launch_tick_id = $2
        AND run_id IS NOT NULL`,
    [spaceId, tickId],
  );
  if ((pending.rows[0]?.total ?? 0) > 0) return;
  const failed = (pending.rows[0]?.failed ?? 0) > 0;
  await db.query(
    `UPDATE runs
        SET status = $3, output_json = $4::jsonb, ended_at = $5, updated_at = $5
      WHERE space_id = $1 AND id = $2
        AND status = 'waiting_for_dependency'`,
    [
      spaceId,
      coordinatorRunId,
      failed ? "degraded" : "succeeded",
      JSON.stringify({
        schema_version: "run_output.v1",
        status: failed ? "failed" : "succeeded",
        summary: failed
          ? "Autonomous tick completed with one or more failed candidates."
          : "Autonomous tick completed.",
        result: { autonomy_tick_id: tickId },
        output_manifest: [],
      }),
      now,
    ],
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
