import { randomUUID } from "node:crypto";
import type { Queryable, RunRecord } from "../runRepositoryTypes.js";
import { redactEvidenceText, sanitizeEvidenceJson } from "../evidenceRedaction.js";
import { contractRecord } from "../contractSnapshot.js";
import type {
  ValidationRecipePlan,
  VerificationResultRecord,
} from "./types.js";

export interface VerificationPlanReader {
  getPlan(run: Pick<RunRecord, "space_id" | "project_folder_id" | "contract_snapshot_json">): Promise<ValidationRecipePlan>;
}

interface VerificationPlanRow {
  recipe_id: string | null;
  commands_json: unknown;
  required_checks_json: unknown;
  artifact_expectations_json: unknown;
  timeout_seconds: number | null;
  profile_test_commands_json: unknown;
  profile_build_commands_json: unknown;
  forbidden_paths_json: unknown;
}

export class PgVerificationRepository implements VerificationPlanReader {
  constructor(private readonly db: Queryable) {}

  async getPlan(run: Pick<RunRecord, "space_id" | "project_folder_id" | "contract_snapshot_json">): Promise<ValidationRecipePlan> {
    let plan = emptyPlan();
    if (run.project_folder_id) {
      const result = await this.db.query<VerificationPlanRow>(
        `SELECT vr.id AS recipe_id,
                vr.commands_json,
                vr.required_checks_json,
                vr.artifact_expectations_json,
                vr.timeout_seconds,
                fec.test_commands_json AS profile_test_commands_json,
                fec.build_commands_json AS profile_build_commands_json,
                fec.forbidden_paths_json
           FROM project_folders f
           LEFT JOIN project_folder_execution_configs fec
             ON fec.project_folder_id = f.id
            AND fec.space_id = f.space_id
           LEFT JOIN validation_recipes vr
             ON vr.id = fec.validation_recipe_id
            AND vr.space_id = f.space_id
            AND vr.enabled = true
          WHERE f.id = $1 AND f.space_id = $2
          LIMIT 1`,
        [run.project_folder_id, run.space_id],
      );
      const row = result.rows[0];
      if (row) {
        plan = {
          recipe_id: row.recipe_id,
          commands: row.commands_json,
          required_checks: row.required_checks_json,
          artifact_expectations: row.artifact_expectations_json,
          timeout_seconds: row.timeout_seconds,
          profile_test_commands: row.profile_test_commands_json,
          profile_build_commands: row.profile_build_commands_json,
          forbidden_paths: row.forbidden_paths_json,
        };
      }
    }

    // A workflow/plan node may name one or more validation recipes. These are
    // execution inputs, not metadata: resolve them in the run's space and
    // merge them into the same deterministic declaration plan used by A2.
    const routeHints = recordValue(contractRecord(run.contract_snapshot_json).route_hints_json);
    const recipeRefs = stringArray(routeHints.verification_recipe_refs);
    if (recipeRefs.length === 0) return plan;
    const recipes = await this.db.query<VerificationPlanRow>(
      `SELECT id AS recipe_id, commands_json, required_checks_json,
              artifact_expectations_json, timeout_seconds,
              NULL::jsonb AS profile_test_commands_json,
              NULL::jsonb AS profile_build_commands_json,
              NULL::jsonb AS forbidden_paths_json
         FROM validation_recipes
        WHERE space_id = $1 AND enabled = true AND id = ANY($2::varchar[])
        ORDER BY id ASC`,
      [run.space_id, recipeRefs],
    );
    const missing = recipeRefs.filter((ref) => !recipes.rows.some((row) => row.recipe_id === ref));
    return {
      recipe_id: recipes.rows.map((row) => row.recipe_id).filter(Boolean).join(",") || plan.recipe_id,
      commands: mergeRecipeValues(plan.commands, recipes.rows.map((row) => row.commands_json)),
      required_checks: mergeRecipeValues(plan.required_checks, recipes.rows.map((row) => row.required_checks_json)),
      artifact_expectations: mergeRecipeValues(plan.artifact_expectations, recipes.rows.map((row) => row.artifact_expectations_json)),
      timeout_seconds: minTimeout(plan.timeout_seconds, recipes.rows.map((row) => row.timeout_seconds)),
      profile_test_commands: plan.profile_test_commands,
      profile_build_commands: plan.profile_build_commands,
      forbidden_paths: plan.forbidden_paths,
      ...(missing.length > 0 ? { missing_recipe_refs: missing } : {}),
    } as ValidationRecipePlan;
  }

  async upsertResults(
    spaceId: string,
    runId: string,
    results: Array<{
      verifier_type: string;
      verifier_version: string;
      status: VerificationResultRecord["status"];
      summary: string | null;
      evidence_refs_json: unknown;
      details_json: unknown;
      started_at: string;
      completed_at: string;
    }>,
  ): Promise<VerificationResultRecord[]> {
    const persisted: VerificationResultRecord[] = [];
    for (const result of results) {
      // Results belong to the attempt that produced them. The engine runs
      // inside the currently executing attempt (before the Supervisor can
      // create the next one), so the latest attempt number is that attempt.
      // The upsert therefore only replaces re-verification of the same
      // attempt; a retry's verification never overwrites a prior attempt's rows.
      const inserted = await this.db.query<VerificationResultRecord>(
        `INSERT INTO verification_results (
           id, space_id, run_id, attempt_number, verifier_type, verifier_version, status,
           summary, evidence_refs_json, details_json, started_at, completed_at, created_at
         ) VALUES ($1, $2, $3,
           COALESCE((SELECT max(attempt_number)
                       FROM run_attempts
                      WHERE space_id = $2::varchar AND run_id = $3::varchar), 1),
           $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)
         ON CONFLICT (run_id, attempt_number, verifier_type, verifier_version)
         DO UPDATE SET
           status = EXCLUDED.status,
           summary = EXCLUDED.summary,
           evidence_refs_json = EXCLUDED.evidence_refs_json,
           details_json = EXCLUDED.details_json,
           started_at = EXCLUDED.started_at,
           completed_at = EXCLUDED.completed_at
         RETURNING id, space_id, run_id, attempt_number, verifier_type, verifier_version, status,
                   summary, evidence_refs_json, details_json, started_at, completed_at, created_at`,
        [
          randomUUID(),
          spaceId,
          runId,
          result.verifier_type,
          result.verifier_version,
          result.status,
          redactEvidenceText(result.summary),
          JSON.stringify(sanitizeEvidenceJson(result.evidence_refs_json ?? {})),
          JSON.stringify(sanitizeEvidenceJson(result.details_json ?? {})),
          result.started_at,
          result.completed_at,
          result.completed_at,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("Verification result insert returned no row");
      persisted.push(row);
    }
    return persisted;
  }

  async listResults(spaceId: string, runId: string): Promise<VerificationResultRecord[]> {
    const result = await this.db.query<VerificationResultRecord>(
      `SELECT id, space_id, run_id, verifier_type, verifier_version, status,
              summary, evidence_refs_json, details_json, started_at, completed_at, created_at
         FROM verification_results
        WHERE space_id = $1 AND run_id = $2
        ORDER BY created_at ASC, id ASC`,
      [spaceId, runId],
    );
    return result.rows;
  }
}

function emptyPlan(): ValidationRecipePlan {
  return {
    recipe_id: null,
    commands: null,
    required_checks: null,
    artifact_expectations: null,
    timeout_seconds: null,
    profile_test_commands: null,
    profile_build_commands: null,
    forbidden_paths: null,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function mergeRecipeValues(base: unknown, additions: unknown[]): unknown {
  const values = [base, ...additions].filter((value) => value !== null && value !== undefined);
  if (values.length === 0) return null;
  const flattened = values.flatMap((value) => Array.isArray(value) ? value : [value]);
  return flattened.length === 1 ? flattened[0] : flattened;
}

function minTimeout(base: number | null, additions: Array<number | null>): number | null {
  const values = [base, ...additions].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return values.length > 0 ? Math.min(...values) : null;
}
