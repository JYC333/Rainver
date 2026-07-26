import { randomUUID } from "node:crypto";
import {
  HttpError,
  dateIso,
  objectValue,
  optionalString,
  requiredString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { assertProjectReadable, assertProjectWriter, lockActiveProjectForMutation } from "../projects/access";
import { InquirySignalService } from "../inquiry/signalService";
import { ExperimentDefinitionService } from "./definitionService";
import { stringArray } from "./common";

const VERDICTS = new Set(["supports", "contradicts", "inconclusive"]);

// An Experiment's verdict is not one of Signal's literature-classification
// values (supports/contradicts/adds_context/adds_method/fills_gap/
// raises_gap/unrelated); "inconclusive" maps to adds_context (a genuinely
// inconclusive result is still relevant context for the Hypothesis, not
// nothing) rather than inventing a parallel classification vocabulary.
const VERDICT_TO_CLASSIFICATION: Record<string, string> = {
  supports: "supports",
  contradicts: "contradicts",
  inconclusive: "adds_context",
};

// The Candidate's proposed_change carried through to accept -> recordIteration
// produces a cited Inquiry Iteration. This only takes effect if a human accepts the resulting
// Candidate — the Interpretation itself never touches the Hypothesis.
const VERDICT_TO_EVALUATION_STATE: Record<string, string> = {
  supports: "supported",
  contradicts: "contradicted",
  inconclusive: "inconclusive",
};

interface InterpretationRow {
  id: string; space_id: string; project_id: string; definition_id: string;
  run_ids_json: unknown; verdict: string; conclusion: string | null;
  negative_results: string | null; limitations: string | null; repro_lock_json: unknown;
  status: string; resulting_signal_id: string | null;
  reviewed_by_user_id: string | null; reviewed_at: unknown;
  created_by_user_id: string | null; created_at: unknown; updated_at: unknown;
}

function interpretationToOut(row: InterpretationRow): Record<string, unknown> {
  return {
    id: row.id, project_id: row.project_id, definition_id: row.definition_id,
    run_ids: Array.isArray(row.run_ids_json) ? row.run_ids_json : [],
    verdict: row.verdict, conclusion: row.conclusion,
    negative_results: row.negative_results, limitations: row.limitations,
    repro_lock: objectValue(row.repro_lock_json),
    status: row.status, resulting_signal_id: row.resulting_signal_id,
    reviewed_by_user_id: row.reviewed_by_user_id, reviewed_at: dateIso(row.reviewed_at),
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Experiment Interpretation: a reviewed conclusion over one or more Runs,
 * convertible to an Inquiry Evidence Signal once reviewed.
 * Conversion never edits the Hypothesis Thread directly — it only creates a
 * Signal, which follows the existing material-Signal -> Candidate ->
 * reviewed-accept -> Iteration path unchanged. An Interpretation
 * cannot silently change a Hypothesis; only an accepted Candidate can.
 */
export class ExperimentInterpretationService {
  constructor(private readonly db: Queryable) {}

  async createInterpretation(
    identity: SpaceUserIdentity,
    projectId: string,
    definitionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const verdict = requiredString(body.verdict, "verdict");
    if (!VERDICTS.has(verdict)) throw new HttpError(422, `verdict must be one of ${[...VERDICTS].join(", ")}`);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await new ExperimentDefinitionService(db).requireDefinition(identity.spaceId, projectId, definitionId, db);
      const runIds = [...new Set(stringArray(body.run_ids))];
      if (runIds.length === 0) throw new HttpError(422, "run_ids must contain at least one Experiment Run");
      const referencedRuns = await db.query<{ id: string }>(
        `SELECT r.id FROM experiment_runs r
           JOIN experiment_versions v ON v.id=r.version_id AND v.space_id=r.space_id
          WHERE r.space_id=$1 AND v.definition_id=$2
            AND r.id=ANY($3::varchar[]) AND r.status IN ('completed','failed')`,
        [identity.spaceId, definitionId, runIds],
      );
      if (referencedRuns.rows.length !== runIds.length) {
        throw new HttpError(422, "run_ids must reference completed or failed Runs from this Experiment");
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      await db.query(
        `INSERT INTO experiment_interpretations (
           id, space_id, project_id, definition_id, run_ids_json, verdict, conclusion,
           negative_results, limitations, repro_lock_json, status, created_by_user_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, 'draft', $11, $12, $12)`,
        [id, identity.spaceId, projectId, definitionId, JSON.stringify(runIds), verdict,
          optionalString(body.conclusion), optionalString(body.negative_results), optionalString(body.limitations),
          JSON.stringify(objectValue(body.repro_lock)), identity.userId, now],
      );
      const row = await this.row(db, identity.spaceId, projectId, id);
      if (!row) throw new HttpError(500, "Failed to create Experiment Interpretation");
      return interpretationToOut(row);
    });
  }

  async listInterpretations(identity: SpaceUserIdentity, projectId: string, definitionId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    await new ExperimentDefinitionService(this.db).requireDefinition(identity.spaceId, projectId, definitionId);
    const rows = await this.db.query<InterpretationRow>(
      `SELECT * FROM experiment_interpretations WHERE space_id=$1 AND project_id=$2 AND definition_id=$3 ORDER BY created_at DESC`,
      [identity.spaceId, projectId, definitionId],
    );
    return rows.rows.map(interpretationToOut);
  }

  async markReviewed(identity: SpaceUserIdentity, projectId: string, interpretationId: string): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const row = await this.row(db, identity.spaceId, projectId, interpretationId, true);
      if (!row) throw new HttpError(404, "Experiment Interpretation not found");
      if (row.status !== "draft") throw new HttpError(409, `Interpretation already ${row.status}`);
      const now = new Date().toISOString();
      await db.query(
        `UPDATE experiment_interpretations SET status='reviewed', reviewed_by_user_id=$3, reviewed_at=$4, updated_at=$4 WHERE id=$1 AND space_id=$2`,
        [interpretationId, identity.spaceId, identity.userId, now],
      );
      const updated = await this.row(db, identity.spaceId, projectId, interpretationId);
      return interpretationToOut(updated!);
    });
  }

  async convertToSignal(
    identity: SpaceUserIdentity,
    projectId: string,
    interpretationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const row = await this.row(db, identity.spaceId, projectId, interpretationId, true);
      if (!row) throw new HttpError(404, "Experiment Interpretation not found");
      if (row.status !== "reviewed") throw new HttpError(409, "Only a reviewed Interpretation can be converted to an Evidence Signal");
      const definition = await new ExperimentDefinitionService(db).requireDefinition(identity.spaceId, projectId, row.definition_id, db);
      const threadId = definition.primary_hypothesis_thread_id;
      if (!threadId) throw new HttpError(409, "This Experiment has no primary Hypothesis Thread to attach a Signal to");
      const signal = await new InquirySignalService(db).createSignalFromReviewedExperiment(identity, projectId, threadId, interpretationId, {
        classification: VERDICT_TO_CLASSIFICATION[row.verdict],
        is_material: true,
        confidence: typeof body.confidence === "number" ? body.confidence : null,
        proposed_change: { evaluation_state: VERDICT_TO_EVALUATION_STATE[row.verdict] },
        source_provenance: {
          source: "experiment_interpretation",
          definition_id: row.definition_id,
          run_ids: Array.isArray(row.run_ids_json) ? row.run_ids_json : [],
          verdict: row.verdict,
          conclusion: row.conclusion,
        },
      });
      const now = new Date().toISOString();
      await db.query(
        `UPDATE experiment_interpretations SET status='converted', resulting_signal_id=$3, updated_at=$4 WHERE id=$1 AND space_id=$2`,
        [interpretationId, identity.spaceId, signal.id, now],
      );
      const updated = await this.row(db, identity.spaceId, projectId, interpretationId);
      return { ...interpretationToOut(updated!), signal };
    });
  }

  private async row(db: Queryable, spaceId: string, projectId: string, id: string, forUpdate = false): Promise<InterpretationRow | null> {
    const result = await db.query<InterpretationRow>(
      `SELECT * FROM experiment_interpretations WHERE id=$1 AND space_id=$2 AND project_id=$3${forUpdate ? " FOR UPDATE" : ""}`,
      [id, spaceId, projectId],
    );
    return result.rows[0] ?? null;
  }
}
