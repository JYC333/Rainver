import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool";
import { contentReadSql } from "../access/contentAccessSql";
import { withTransaction } from "../../db/tx";
import {
  HttpError,
  dateIso,
  objectValue,
  optionalObject,
  optionalString,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { PgRunRepository } from "../runs/repository";
import {
  buildEvolutionPlanPrompt,
} from "./prompt";
import { EvolutionSelector } from "./selector";
import { strategyAssetToOut } from "./strategyAssets";
import type {
  EvolutionSelection,
  EvolutionExperienceCreateInput,
  EvolutionExperienceRow,
  EvolutionRunExperienceContext,
  EvolutionRunSetupRecord,
  EvolutionSelectorDecisionRow,
  EvolutionSignalRow,
  EvolutionStrategyAssetRow,
  EvolutionTargetRow,
  EvolutionValidationResultRow,
} from "./types";
import { TARGET_COLUMNS } from "./types";
import {
  assertTargetRunnable,
  boundedRunMode,
  requiredBodyString,
} from "./validation";

interface PersistSelectedRunRequestInput {
  identity: SpaceUserIdentity;
  targetId: string;
  runMode: string;
  runtimeProfileId: string | null;
  projectFolderId: string | null;
  projectId: string | null;
  target: EvolutionTargetRow;
  agentId: string;
  recentSignals: EvolutionSignalRow[];
  selectedStrategy: EvolutionStrategyAssetRow;
  selection: EvolutionSelection;
}

export class EvolutionRepository {
  private readonly runRepository: PgRunRepository;
  private readonly selector = new EvolutionSelector();

  constructor(private readonly db: Queryable) {
    this.runRepository = new PgRunRepository(db);
  }

  async summary(identity: SpaceUserIdentity): Promise<Record<string, unknown>> {
    const [targets, signals, proposals, runs] = await Promise.all([
      this.db.query<{ total: string | number }>(
        `SELECT count(id)::text AS total FROM evolution_targets WHERE (space_id = $1 OR space_id IS NULL) AND status = 'active'`,
        [identity.spaceId],
      ),
      this.db.query<{ total: string | number }>(
        `SELECT count(es.id)::text AS total
           FROM evolution_signals es
           JOIN evolution_targets et ON et.id = es.target_id
          WHERE (et.space_id = $1 OR et.space_id IS NULL)
            AND (es.space_id = $1 OR es.space_id IS NULL)`,
        [identity.spaceId],
      ),
      this.db.query<{ total: string | number }>(
        `SELECT count(p.id)::text AS total
           FROM proposals p
           LEFT JOIN runs r ON r.id = p.created_by_run_id AND r.space_id = p.space_id
          WHERE p.space_id = $1
            AND p.status = 'pending'
            AND (p.proposal_type LIKE 'evolution_%' OR r.run_type = 'evolution')`,
        [identity.spaceId],
      ),
      this.db.query<{ total: string | number }>(
        `SELECT count(id)::text AS total
           FROM runs
          WHERE space_id = $1 AND run_type = 'evolution' AND created_at > now() - interval '30 days'`,
        [identity.spaceId],
      ),
    ]);
    return {
      active_targets: count(targets.rows[0]),
      signals_collected: count(signals.rows[0]),
      pending_proposals: count(proposals.rows[0]),
      recent_runs: count(runs.rows[0]),
    };
  }

  async listTargets(identity: SpaceUserIdentity, status: string | null): Promise<Record<string, unknown>[]> {
    const paramsList: unknown[] = [identity.spaceId];
    const clauses = ["(et.space_id = $1 OR et.space_id IS NULL)"];
    if (status) {
      paramsList.push(status);
      clauses.push(`et.status = $${paramsList.length}`);
    }
    const rows = await this.db.query<EvolutionTargetRow>(
      `SELECT et.${TARGET_COLUMNS.replaceAll(", ", ", et.")},
              (SELECT count(es.id)::text FROM evolution_signals es
                WHERE es.target_id = et.id
                  AND (es.space_id = $1 OR es.space_id IS NULL)) AS recent_signal_count,
              (SELECT max(r.created_at)
                 FROM evolution_selector_decisions esd
                 JOIN runs r ON r.id = esd.run_id AND r.space_id = esd.space_id
                WHERE esd.target_id = et.id AND esd.space_id = $1) AS last_run_at
         FROM evolution_targets et
        WHERE ${clauses.join(" AND ")}
        ORDER BY et.updated_at DESC, et.created_at DESC`,
      paramsList,
    );
    return rows.rows.map(targetToOut);
  }

  async getTarget(identity: SpaceUserIdentity, targetId: string): Promise<Record<string, unknown> | null> {
    const row = await this.getTargetRow(identity, targetId);
    return row ? targetToOut(row) : null;
  }

  async getTargetRow(identity: SpaceUserIdentity, targetId: string): Promise<EvolutionTargetRow | null> {
    const rows = await this.db.query<EvolutionTargetRow>(
      `SELECT et.${TARGET_COLUMNS.replaceAll(", ", ", et.")},
              (SELECT count(es.id)::text FROM evolution_signals es
                WHERE es.target_id = et.id
                  AND (es.space_id = $2 OR es.space_id IS NULL)) AS recent_signal_count,
              (SELECT max(r.created_at)
                 FROM evolution_selector_decisions esd
                 JOIN runs r ON r.id = esd.run_id AND r.space_id = esd.space_id
                WHERE esd.target_id = et.id AND esd.space_id = $2) AS last_run_at
         FROM evolution_targets et
        WHERE et.id = $1 AND (et.space_id = $2 OR et.space_id IS NULL)
        LIMIT 1`,
      [targetId, identity.spaceId],
    );
    return rows.rows[0] ?? null;
  }

  async createTarget(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const metadata = {
      ...objectValue(body.metadata_json),
      target_name: optionalString(body.target_name),
      purpose: optionalString(body.purpose),
    };
    const result = await this.db.query<EvolutionTargetRow>(
      `INSERT INTO evolution_targets (
         id, space_id, target_type, target_ref_type, target_ref_id, capability_key,
         current_version_id, risk_level, status, enabled, engine_policy_json,
         metadata_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11::jsonb,
         $12::jsonb, $13, $13
       )
       RETURNING ${TARGET_COLUMNS}, 0::text AS recent_signal_count, NULL::timestamptz AS last_run_at`,
      [
        randomUUID(),
        identity.spaceId,
        requiredBodyString(body.target_type, "target_type"),
        optionalString(body.target_ref_type),
        optionalString(body.target_ref_id),
        optionalString(body.capability_key),
        optionalString(body.current_version_id),
        optionalString(body.risk_level) ?? "medium",
        optionalString(body.status) ?? "active",
        body.enabled !== false,
        JSON.stringify(optionalObject(body.engine_policy_json) ?? {}),
        JSON.stringify(metadata),
        now,
      ],
    );
    return targetToOut(result.rows[0]!);
  }

  async updateTarget(identity: SpaceUserIdentity, targetId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const current = await this.getTargetRow(identity, targetId);
    if (!current) throw new HttpError(404, "Evolution target not found");
    if (current.space_id === null) throw new HttpError(403, "System evolution targets are read-only");
    const currentMeta = objectValue(current.metadata_json);
    const metadata = {
      ...currentMeta,
      ...objectValue(body.metadata_json),
      ...(body.target_name !== undefined ? { target_name: optionalString(body.target_name) } : {}),
      ...(body.purpose !== undefined ? { purpose: optionalString(body.purpose) } : {}),
    };
    const now = new Date().toISOString();
    const result = await this.db.query<EvolutionTargetRow>(
      `UPDATE evolution_targets
          SET target_type = COALESCE($3, target_type),
              target_ref_type = CASE WHEN $4::boolean THEN $5 ELSE target_ref_type END,
              target_ref_id = CASE WHEN $6::boolean THEN $7 ELSE target_ref_id END,
              capability_key = CASE WHEN $8::boolean THEN $9 ELSE capability_key END,
              current_version_id = CASE WHEN $10::boolean THEN $11 ELSE current_version_id END,
              risk_level = COALESCE($12, risk_level),
              status = COALESCE($13, status),
              enabled = COALESCE($14, enabled),
              engine_policy_json = CASE WHEN $15::boolean THEN $16::jsonb ELSE engine_policy_json END,
              metadata_json = $17::jsonb,
              updated_at = $18
        WHERE id = $1 AND (space_id = $2 OR space_id IS NULL)
        RETURNING ${TARGET_COLUMNS},
                  (SELECT count(es.id)::text FROM evolution_signals es
                    WHERE es.target_id = evolution_targets.id
                      AND (es.space_id = $2 OR es.space_id IS NULL)) AS recent_signal_count,
                  (SELECT max(r.created_at)
                     FROM evolution_selector_decisions esd
                     JOIN runs r ON r.id = esd.run_id AND r.space_id = esd.space_id
                    WHERE esd.target_id = evolution_targets.id AND esd.space_id = $2) AS last_run_at`,
      [
        targetId,
        identity.spaceId,
        optionalString(body.target_type),
        Object.hasOwn(body, "target_ref_type"),
        optionalString(body.target_ref_type),
        Object.hasOwn(body, "target_ref_id"),
        optionalString(body.target_ref_id),
        Object.hasOwn(body, "capability_key"),
        optionalString(body.capability_key),
        Object.hasOwn(body, "current_version_id"),
        optionalString(body.current_version_id),
        optionalString(body.risk_level),
        optionalString(body.status),
        typeof body.enabled === "boolean" ? body.enabled : null,
        Object.hasOwn(body, "engine_policy_json"),
        JSON.stringify(optionalObject(body.engine_policy_json) ?? {}),
        JSON.stringify(metadata),
        now,
      ],
    );
    return targetToOut(result.rows[0]!);
  }

  async listSignals(
    identity: SpaceUserIdentity,
    targetId: string | null,
    limit: number,
    offset: number,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.listSignalRows(identity, targetId, limit, offset);
    return rows.map(signalToOut);
  }

  async listSignalRows(
    identity: SpaceUserIdentity,
    targetId: string | null,
    limit: number,
    offset: number,
  ): Promise<EvolutionSignalRow[]> {
    const values: unknown[] = [identity.spaceId];
    const clauses = [
      "(et.space_id = $1 OR et.space_id IS NULL)",
      "(es.space_id = $1 OR es.space_id IS NULL)",
    ];
    if (targetId) {
      values.push(targetId);
      clauses.push(`es.target_id = $${values.length}`);
    }
    const rows = await this.db.query<EvolutionSignalRow>(
      `SELECT es.id, es.space_id, es.target_id,
              et.target_type, et.capability_key,
              et.metadata_json->>'target_name' AS target_name,
              es.signal_type, es.source_type, es.source_id, es.severity,
              es.summary, es.payload_json, es.triage_status, es.triaged_at,
              es.triaged_by_user_id, es.triage_note, es.created_at
         FROM evolution_signals es
         JOIN evolution_targets et ON et.id = es.target_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY es.created_at DESC, es.id DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    return rows.rows;
  }

  async createSignal(identity: SpaceUserIdentity, targetId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = await this.getTargetRow(identity, targetId);
    if (!target) throw new HttpError(404, "Evolution target not found");
    const now = new Date().toISOString();
    const result = await this.db.query<EvolutionSignalRow>(
      `WITH inserted AS (
         INSERT INTO evolution_signals (
           id, space_id, target_id, signal_type, source_type, source_id,
           severity, summary, payload_json, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         RETURNING id, space_id, target_id, signal_type, source_type, source_id,
                   severity, summary, payload_json, triage_status, triaged_at,
                   triaged_by_user_id, triage_note, created_at
       )
       SELECT i.id, i.space_id, i.target_id,
              et.target_type, et.capability_key, et.metadata_json->>'target_name' AS target_name,
              i.signal_type, i.source_type, i.source_id, i.severity, i.summary,
              i.payload_json, i.triage_status, i.triaged_at,
              i.triaged_by_user_id, i.triage_note, i.created_at
         FROM inserted i
         JOIN evolution_targets et ON et.id = i.target_id`,
      [
        randomUUID(),
        identity.spaceId,
        targetId,
        requiredBodyString(body.signal_type, "signal_type"),
        requiredBodyString(body.source_type, "source_type"),
        optionalString(body.source_id),
        optionalString(body.severity) ?? "info",
        optionalString(body.summary),
        JSON.stringify(optionalObject(body.payload_json) ?? {}),
        now,
      ],
    );
    return signalToOut(result.rows[0]!);
  }

  async updateSignalTriage(
    identity: SpaceUserIdentity,
    signalId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const status = signalTriageStatus(body.triage_status);
    if (!status) throw new HttpError(422, "triage_status must be one of: new, acknowledged, dismissed, actioned");
    const now = new Date().toISOString();
    const hasNote = Object.hasOwn(body, "triage_note");
    const note = hasNote ? optionalString(body.triage_note) : null;
    const result = await this.db.query(
      `UPDATE evolution_signals es
          SET triage_status = $3,
              triaged_at = CASE WHEN $3::varchar = 'new' THEN NULL ELSE $4::timestamptz END,
              triaged_by_user_id = CASE WHEN $3::varchar = 'new' THEN NULL ELSE $5 END,
              triage_note = CASE WHEN $6::boolean THEN $7 ELSE triage_note END
        FROM evolution_targets et
       WHERE es.id = $1
         AND es.space_id = $2
         AND es.target_id = et.id
         AND (et.space_id = $2 OR et.space_id IS NULL)`,
      [signalId, identity.spaceId, status, now, identity.userId, hasNote, note],
    );
    if ((result.rowCount ?? 0) === 0) throw new HttpError(404, "Evolution signal not found");
    const row = await this.getSignalRow(identity, signalId);
    if (!row) throw new HttpError(404, "Evolution signal not found");
    return signalToOut(row);
  }

  async dismissSignal(
    identity: SpaceUserIdentity,
    signalId: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.updateSignalTriage(identity, signalId, {
      ...body,
      triage_status: "dismissed",
    });
  }

  private async getSignalRow(identity: SpaceUserIdentity, signalId: string): Promise<EvolutionSignalRow | null> {
    const result = await this.db.query<EvolutionSignalRow>(
      `SELECT es.id, es.space_id, es.target_id,
              et.target_type, et.capability_key,
              et.metadata_json->>'target_name' AS target_name,
              es.signal_type, es.source_type, es.source_id, es.severity,
              es.summary, es.payload_json, es.triage_status, es.triaged_at,
              es.triaged_by_user_id, es.triage_note, es.created_at
         FROM evolution_signals es
         JOIN evolution_targets et ON et.id = es.target_id
        WHERE es.id = $1
          AND es.space_id = $2
          AND (et.space_id = $2 OR et.space_id IS NULL)
        LIMIT 1`,
      [signalId, identity.spaceId],
    );
    return result.rows[0] ?? null;
  }

  async listStrategies(
    identity: SpaceUserIdentity,
    filters: { status?: string | null; targetType?: string | null; limit: number; offset: number },
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.listStrategyRows(identity, filters);
    return rows.map(strategyAssetToOut);
  }

  async listStrategyRows(
    identity: SpaceUserIdentity,
    filters: { status?: string | null; targetType?: string | null; limit: number; offset: number },
  ): Promise<EvolutionStrategyAssetRow[]> {
    const values: unknown[] = [identity.spaceId];
    const clauses = ["(space_id = $1 OR space_id IS NULL)"];
    if (filters.status) {
      values.push(filters.status);
      clauses.push(`status = $${values.length}`);
    }
    if (filters.targetType) {
      values.push(filters.targetType);
      clauses.push(`(target_type = $${values.length} OR target_type = 'system')`);
    }
    const rows = await this.db.query<EvolutionStrategyAssetRow>(
      `SELECT id, space_id, strategy_key, name, description, category, target_type,
              status, risk_level, signals_match_json, preconditions_json,
              strategy_steps_json, constraints_json, validation_policy_json,
              tool_policy_json, routing_hint_json, provenance_type, source_ref_json,
              success_count, failure_count, confidence_score, last_selected_at,
              created_at, updated_at
         FROM evolution_strategy_assets
        WHERE ${clauses.join(" AND ")}
        ORDER BY CASE WHEN space_id IS NULL THEN 0 ELSE 1 END,
                 status, category, strategy_key
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, filters.limit, filters.offset],
    );
    return rows.rows;
  }

  async listRuns(identity: SpaceUserIdentity, limit: number, offset: number): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT r.id AS run_id,
              esd.target_id,
              et.metadata_json->>'target_name' AS target_name,
              et.target_type,
              et.capability_key,
              esa.strategy_key,
              r.adapter_type AS engine,
              r.status,
              r.created_at,
              r.started_at,
              (SELECT count(a.id)::int FROM artifacts a WHERE a.run_id = r.id AND a.space_id = r.space_id) AS artifact_count
         FROM runs r
         LEFT JOIN LATERAL (
           SELECT *
             FROM evolution_selector_decisions d
            WHERE d.space_id = r.space_id AND d.run_id = r.id
            ORDER BY d.created_at DESC
            LIMIT 1
         ) esd ON true
         LEFT JOIN evolution_targets et ON et.id = esd.target_id
         LEFT JOIN evolution_strategy_assets esa ON esa.id = esd.selected_strategy_asset_id
        WHERE r.space_id = $1 AND r.run_type = 'evolution'
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3`,
      [identity.spaceId, limit, offset],
    );
    return rows.rows.map((row) => ({
      run_id: row.run_id,
      target_id: row.target_id,
      target_name: row.target_name,
      target_type: row.target_type,
      capability_key: row.capability_key,
      strategy_key: row.strategy_key,
      engine: row.engine,
      status: row.status,
      created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
      started_at: dateIso(row.started_at),
      artifact_count: Number(row.artifact_count ?? 0),
    }));
  }

  async recordRunSetup(
    identity: SpaceUserIdentity,
    targetId: string,
    agentId: string,
    body: Record<string, unknown>,
  ): Promise<EvolutionRunSetupRecord> {
    const target = await this.getTargetRow(identity, targetId);
    if (!target) throw new HttpError(404, "Evolution target not found");
    assertTargetRunnable(target);
    const recentSignals = await this.listSignalRows(identity, targetId, 50, 0);
    const enginePolicy = objectValue(target.engine_policy_json);
    if (recentSignals.length === 0 && enginePolicy.allow_no_signal !== true) {
      throw new HttpError(422, "Evolution target has no recent signals. Record at least one signal before running, or set allow_no_signal=true in engine_policy_json.");
    }
    const strategyRows = await this.listStrategyRows(identity, {
      status: "active",
      targetType: null,
      limit: 200,
      offset: 0,
    });
    const selection = this.selector.select({
      target,
      signals: recentSignals,
      strategies: strategyRows,
    });
    if (!selection.selectedStrategy) {
      await this.insertSelectorDecision(identity, {
        targetId,
        runId: null,
        selectedStrategyAssetId: null,
        candidateStrategyIds: selection.candidateStrategyIds,
        inputSignalIds: selection.inputSignalIds,
        decisionReason: selection.decisionReason,
        scoreTrace: selection.scoreTrace,
        rejectedReasons: selection.rejectedReasons,
      });
      throw new HttpError(422, selection.decisionReason);
    }

    const input: PersistSelectedRunRequestInput = {
      identity,
      targetId,
      runMode: boundedRunMode(body.mode),
      runtimeProfileId: optionalString(body.runtime_profile_id),
      projectFolderId: optionalString(body.project_folder_id),
      projectId: optionalString(body.project_id),
      target,
      agentId,
      recentSignals,
      selectedStrategy: selection.selectedStrategy,
      selection,
    };
    if (isPgPool(this.db)) {
      return withTransaction(this.db, async (client) =>
        new EvolutionRepository(client).persistRunSetup(input),
      );
    }
    return this.persistRunSetup(input);
  }

  private async persistRunSetup(input: PersistSelectedRunRequestInput): Promise<EvolutionRunSetupRecord> {
    const {
      identity,
      targetId,
      target,
      agentId,
      recentSignals,
      selectedStrategy,
      selection,
    } = input;
    const initialPrompt = buildEvolutionPlanPrompt({
      target,
      selectedStrategy,
      recentSignals,
      selection,
    });
    const run = await this.runRepository.createQueuedRun({
      agent_id: agentId,
      space_id: identity.spaceId,
      user_id: identity.userId,
      mode: input.runMode,
      run_type: "evolution",
      trigger_origin: "manual",
      runtime_profile_id: input.runtimeProfileId,
      runtime_profile_selection_source: "default",
      project_folder_id: input.projectFolderId,
      project_id: input.projectId,
      prompt: initialPrompt.user,
      instruction: initialPrompt.system,
    });
    const signal = await this.createSignal(identity, targetId, {
      signal_type: "review_requested",
      source_type: "manual",
      source_id: run.id,
      severity: "low",
      summary: `Evolution plan requested with ${selectedStrategy.strategy_key}.`,
      payload_json: {
        run_id: run.id,
        strategy_key: selectedStrategy.strategy_key,
      },
    });
    const signalId = typeof signal.id === "string" ? signal.id : null;
    const decision = await this.insertSelectorDecision(identity, {
      targetId,
      runId: run.id,
      selectedStrategyAssetId: selectedStrategy.id,
      candidateStrategyIds: selection.candidateStrategyIds,
      inputSignalIds: [...selection.inputSignalIds, ...(signalId ? [signalId] : [])],
      decisionReason: selection.decisionReason,
      scoreTrace: selection.scoreTrace,
      rejectedReasons: selection.rejectedReasons,
    });
    await this.touchStrategySelected(selectedStrategy.id);
    const finalPrompt = buildEvolutionPlanPrompt({
      target,
      selectedStrategy,
      recentSignals,
      selection: {
        ...selection,
        inputSignalIds: [...selection.inputSignalIds, ...(signalId ? [signalId] : [])],
      },
      runId: run.id,
      selectorDecisionId: decision.id,
      requestSignalId: signalId,
    });
    await this.updateRunPrompt(identity.spaceId, run.id, finalPrompt);

    return {
      runId: run.id,
      targetId,
      agentId,
      selectorDecisionId: decision.id,
      selectedStrategyAssetId: selectedStrategy.id,
      selectedStrategyKey: selectedStrategy.strategy_key,
      signalId,
    };
  }

  async listSelectorDecisions(identity: SpaceUserIdentity, limit: number, offset: number): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<EvolutionSelectorDecisionRow>(
      `SELECT d.id, d.space_id, d.target_id,
              et.metadata_json->>'target_name' AS target_name,
              et.target_type,
              d.run_id,
              d.selected_strategy_asset_id,
              esa.strategy_key AS selected_strategy_key,
              esa.name AS selected_strategy_name,
              d.candidate_strategy_ids_json,
              d.input_signal_ids_json,
              d.decision_reason,
              d.score_trace_json,
              d.rejected_reasons_json,
              d.created_at
         FROM evolution_selector_decisions d
         JOIN evolution_targets et ON et.id = d.target_id
         LEFT JOIN evolution_strategy_assets esa ON esa.id = d.selected_strategy_asset_id
        WHERE d.space_id = $1
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT $2 OFFSET $3`,
      [identity.spaceId, limit, offset],
    );
    return rows.rows.map(selectorDecisionToOut);
  }

  async listExperiences(identity: SpaceUserIdentity, limit: number, offset: number): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<EvolutionExperienceRow>(
      `SELECT e.id, e.space_id,
              e.strategy_asset_id,
              esa.strategy_key,
              esa.name AS strategy_name,
              e.target_id,
              et.metadata_json->>'target_name' AS target_name,
              e.source_run_id,
              e.source_proposal_id,
              e.experience_key,
              e.summary,
              e.trigger_signals_json,
              e.outcome_status,
              e.confidence_score,
              e.blast_radius_json,
              e.validation_trace_json,
              e.execution_trace_json,
              e.lessons_json,
              e.anti_patterns_json,
              e.environment_fingerprint_json,
              e.provenance_type,
              e.created_at
         FROM evolution_experiences e
         LEFT JOIN evolution_strategy_assets esa ON esa.id = e.strategy_asset_id
         LEFT JOIN evolution_targets et ON et.id = e.target_id
        WHERE e.space_id = $1
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $2 OFFSET $3`,
      [identity.spaceId, limit, offset],
    );
    return rows.rows.map(experienceToOut);
  }

  async getExperienceByKey(spaceId: string, experienceKey: string): Promise<EvolutionExperienceRow | null> {
    const rows = await this.db.query<EvolutionExperienceRow>(
      `SELECT e.id, e.space_id,
              e.strategy_asset_id,
              esa.strategy_key,
              esa.name AS strategy_name,
              e.target_id,
              et.metadata_json->>'target_name' AS target_name,
              e.source_run_id,
              e.source_proposal_id,
              e.experience_key,
              e.summary,
              e.trigger_signals_json,
              e.outcome_status,
              e.confidence_score,
              e.blast_radius_json,
              e.validation_trace_json,
              e.execution_trace_json,
              e.lessons_json,
              e.anti_patterns_json,
              e.environment_fingerprint_json,
              e.provenance_type,
              e.created_at
         FROM evolution_experiences e
         LEFT JOIN evolution_strategy_assets esa ON esa.id = e.strategy_asset_id
         LEFT JOIN evolution_targets et ON et.id = e.target_id
        WHERE e.space_id = $1 AND e.experience_key = $2
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 1`,
      [spaceId, experienceKey],
    );
    return rows.rows[0] ?? null;
  }

  async createExperience(input: EvolutionExperienceCreateInput): Promise<EvolutionExperienceRow | null> {
    const now = new Date().toISOString();
    const result = await this.db.query<EvolutionExperienceRow>(
      `INSERT INTO evolution_experiences (
         id, space_id, strategy_asset_id, target_id, source_run_id,
         source_proposal_id, experience_key, summary, trigger_signals_json,
         outcome_status, confidence_score, blast_radius_json, validation_trace_json,
         execution_trace_json, lessons_json, anti_patterns_json,
         environment_fingerprint_json, provenance_type, created_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9::jsonb,
         $10, $11, $12::jsonb, $13::jsonb,
         $14::jsonb, $15::jsonb, $16::jsonb,
         $17::jsonb, $18, $19
       )
       ON CONFLICT (space_id, experience_key) DO NOTHING
       RETURNING id, space_id, strategy_asset_id, NULL::varchar AS strategy_key,
                 NULL::varchar AS strategy_name, target_id, NULL::varchar AS target_name,
                 source_run_id, source_proposal_id, experience_key, summary,
                 trigger_signals_json, outcome_status, confidence_score,
                 blast_radius_json, validation_trace_json, execution_trace_json,
                 lessons_json, anti_patterns_json, environment_fingerprint_json,
                 provenance_type, created_at`,
      [
        randomUUID(),
        input.spaceId,
        input.strategyAssetId ?? null,
        input.targetId ?? null,
        input.sourceRunId ?? null,
        input.sourceProposalId ?? null,
        input.experienceKey,
        input.summary,
        JSON.stringify(input.triggerSignals ?? []),
        input.outcomeStatus,
        input.confidenceScore ?? 0.5,
        JSON.stringify(input.blastRadius ?? {}),
        JSON.stringify(input.validationTrace ?? {}),
        JSON.stringify(input.executionTrace ?? {}),
        JSON.stringify(input.lessons ?? []),
        JSON.stringify(input.antiPatterns ?? []),
        JSON.stringify(input.environmentFingerprint ?? {}),
        input.provenanceType,
        now,
      ],
    );
    return result.rows[0] ?? null;
  }

  async getRunExperienceContext(spaceId: string, runId: string): Promise<EvolutionRunExperienceContext | null> {
    const rows = await this.db.query<{
      target_id: string | null;
      target_name: string | null;
      selected_strategy_asset_id: string | null;
      strategy_key: string | null;
      strategy_name: string | null;
      input_signal_ids_json: unknown;
      decision_reason: string | null;
    }>(
      `SELECT d.target_id,
              et.metadata_json->>'target_name' AS target_name,
              d.selected_strategy_asset_id,
              esa.strategy_key,
              esa.name AS strategy_name,
              d.input_signal_ids_json,
              d.decision_reason
         FROM evolution_selector_decisions d
         LEFT JOIN evolution_targets et ON et.id = d.target_id
         LEFT JOIN evolution_strategy_assets esa ON esa.id = d.selected_strategy_asset_id
        WHERE d.space_id = $1 AND d.run_id = $2
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT 1`,
      [spaceId, runId],
    );
    const row = rows.rows[0];
    if (!row) return null;
    return {
      spaceId,
      runId,
      targetId: row.target_id,
      targetName: row.target_name,
      strategyAssetId: row.selected_strategy_asset_id,
      strategyKey: row.strategy_key,
      strategyName: row.strategy_name,
      inputSignalIds: jsonArray(row.input_signal_ids_json),
      decisionReason: row.decision_reason,
    };
  }

  async updateStrategyExperienceStats(strategyAssetId: string, outcomeStatus: string): Promise<void> {
    await this.db.query(
      `UPDATE evolution_strategy_assets
          SET success_count = success_count + CASE WHEN $2 = 'success' THEN 1 WHEN $2 = 'partial' THEN 1 ELSE 0 END,
              failure_count = failure_count + CASE WHEN $2 = 'failed' THEN 1 ELSE 0 END,
              confidence_score = LEAST(1, GREATEST(0, confidence_score +
                CASE
                  WHEN $2 = 'success' THEN 0.03
                  WHEN $2 = 'partial' THEN 0.01
                  WHEN $2 = 'failed' THEN -0.05
                  ELSE 0
                END)),
              updated_at = $3
        WHERE id = $1`,
      [strategyAssetId, outcomeStatus, new Date().toISOString()],
    );
  }

  async listProposals(identity: SpaceUserIdentity, limit: number, offset: number): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT p.id, p.proposal_type, p.status, p.summary, p.created_at, p.created_by_run_id,
              (COALESCE(p.payload_json->>'incomplete_patch', 'false') = 'true') AS incomplete_patch,
              CASE WHEN jsonb_typeof(COALESCE(p.payload_json->'skipped_changes', 'null'::jsonb)) = 'array'
                   THEN jsonb_array_length(p.payload_json->'skipped_changes') ELSE 0 END AS skipped_count,
              p.payload_json->>'grant_id' AS grant_id,
              COALESCE(p.payload_json->>'required_approver_user_id', p.payload_json->>'granting_user_id') AS required_approver_user_id,
              p.payload_json->>'requires_approval_type' AS requires_approval_type,
              active_egress_approval.status AS egress_approval_status,
              pending_member.bundle_id,
              pending_member.status AS bundle_member_status,
              esd.target_id,
              et.metadata_json->>'target_name' AS target_name,
              et.target_type,
              et.capability_key
         FROM proposals p
         LEFT JOIN runs r ON r.id = p.created_by_run_id AND r.space_id = p.space_id
         LEFT JOIN evolution_bundle_members pending_member
           ON pending_member.proposal_id = p.id AND pending_member.status IN ('pending', 'released')
         LEFT JOIN LATERAL (
           SELECT pa.status
             FROM proposal_approvals pa
            WHERE pa.proposal_id = p.id
              AND pa.approval_type = 'egress_granting_user'
              AND pa.status = 'approved'
              AND pa.revoked_at IS NULL
            ORDER BY pa.created_at DESC
            LIMIT 1
         ) active_egress_approval ON true
         LEFT JOIN LATERAL (
           SELECT *
             FROM evolution_selector_decisions d
            WHERE d.space_id = p.space_id AND d.run_id = p.created_by_run_id
            ORDER BY d.created_at DESC
            LIMIT 1
         ) esd ON true
         LEFT JOIN evolution_targets et ON et.id = esd.target_id
        WHERE p.space_id = $1
          AND p.status = 'pending'
          AND ${contentReadSql("proposal", "p", "$2")}
        ORDER BY p.created_at DESC
        LIMIT $3 OFFSET $4`,
      [identity.spaceId, identity.userId, limit, offset],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      proposal_type: row.proposal_type,
      target_id: row.target_id,
      bundle_id: row.bundle_id ?? null,
      bundle_member_status: row.bundle_member_status ?? null,
      target_name: row.target_name,
      target_type: row.target_type,
      capability_key: row.capability_key,
      status: row.status,
      summary: row.summary,
      created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
      created_by_run_id: row.created_by_run_id,
      incomplete_patch: row.incomplete_patch === true,
      skipped_count: Number(row.skipped_count ?? 0),
      grant_id: row.grant_id ?? null,
      required_approver_user_id: row.required_approver_user_id ?? null,
      requires_approval_type: row.requires_approval_type ?? null,
      egress_approval_status: row.egress_approval_status ?? null,
    }));
  }

  async listValidationResults(identity: SpaceUserIdentity): Promise<EvolutionValidationResultRow[]> {
    const targets = await this.db.query<EvolutionTargetRow>(
      `SELECT ${TARGET_COLUMNS}
         FROM evolution_targets
        WHERE (space_id = $1 OR space_id IS NULL)
          AND status <> 'archived'
        ORDER BY updated_at DESC, created_at DESC`,
      [identity.spaceId],
    );
    const results: EvolutionValidationResultRow[] = [];
    for (const target of targets.rows) {
      const targetMetadata = objectValue(target.metadata_json);
      const validation = objectValue(targetMetadata.validation);
      const metrics = Array.isArray(validation.metrics) ? validation.metrics : [];
      const targetName = optionalString(targetMetadata.target_name);
      const window = optionalString(validation.window);
      for (const [index, rawMetric] of metrics.entries()) {
        const metric = objectValue(rawMetric);
        const evaluator = optionalString(metric.evaluator) ?? "unknown";
        if (evaluator === "count_signals") {
          results.push(await this.evaluateSignalCountMetric(identity, target, targetName, metric, index, window));
          continue;
        }
        results.push(unsupportedValidationMetric(target, targetName, metric, index, window, evaluator));
      }
    }
    return results;
  }

  private async evaluateSignalCountMetric(
    identity: SpaceUserIdentity,
    target: EvolutionTargetRow,
    targetName: string | null,
    metric: Record<string, unknown>,
    index: number,
    targetWindow: string | null,
  ): Promise<EvolutionValidationResultRow> {
    const signalType = optionalString(metric.signal_type);
    const severity = optionalString(metric.severity);
    const window = optionalString(metric.window) ?? targetWindow;
    const cutoff = validationWindowCutoff(window);
    const values: unknown[] = [target.id, identity.spaceId];
    const clauses = ["target_id = $1", "(space_id = $2 OR space_id IS NULL)"];
    if (signalType) {
      values.push(signalType);
      clauses.push(`signal_type = $${values.length}`);
    }
    if (severity) {
      values.push(severity);
      clauses.push(`severity = $${values.length}`);
    }
    if (cutoff) {
      values.push(cutoff);
      clauses.push(`created_at >= $${values.length}`);
    }
    const countRows = await this.db.query<{ total: string | number; latest_at: unknown }>(
      `SELECT count(id)::text AS total, max(created_at) AS latest_at
         FROM evolution_signals
        WHERE ${clauses.join(" AND ")}`,
      values,
    );
    const value = count(countRows.rows[0]);
    const goal = objectValue(metric.goal);
    return {
      metric_id: optionalString(metric.id) ?? `count_signals.${index + 1}`,
      label: optionalString(metric.label) ?? signalType ?? "Signal count",
      evaluator: "count_signals",
      target_id: target.id,
      target_name: targetName,
      value,
      status: statusForNumericGoal(value, goal),
      window,
      goal,
      sample_size: value,
      numerator_count: value,
      denominator_count: null,
      updated_at: dateIso(countRows.rows[0]?.latest_at),
      metadata_json: {
        source: optionalString(metric.source) ?? "signals",
        signal_type: signalType,
        severity,
      },
    };
  }

  private async insertSelectorDecision(
    identity: SpaceUserIdentity,
    input: {
      targetId: string;
      runId: string | null;
      selectedStrategyAssetId: string | null;
      candidateStrategyIds: string[];
      inputSignalIds: string[];
      decisionReason: string;
      scoreTrace: Record<string, unknown>;
      rejectedReasons: Array<Record<string, unknown>>;
    },
  ): Promise<{ id: string }> {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO evolution_selector_decisions (
         id, space_id, target_id, run_id, selected_strategy_asset_id,
         candidate_strategy_ids_json, input_signal_ids_json, decision_reason,
         score_trace_json, rejected_reasons_json, created_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::jsonb, $7::jsonb, $8,
         $9::jsonb, $10::jsonb, $11
       )`,
      [
        id,
        identity.spaceId,
        input.targetId,
        input.runId,
        input.selectedStrategyAssetId,
        JSON.stringify(input.candidateStrategyIds),
        JSON.stringify(input.inputSignalIds),
        input.decisionReason,
        JSON.stringify(input.scoreTrace),
        JSON.stringify(input.rejectedReasons),
        new Date().toISOString(),
      ],
    );
    return { id };
  }

  private async updateRunPrompt(
    spaceId: string,
    runId: string,
    prompt: { system: string; user: string },
  ): Promise<void> {
    await this.db.query(
      `UPDATE runs
          SET prompt = $3,
              instruction = $4,
              updated_at = now()
        WHERE id = $1 AND space_id = $2`,
      [runId, spaceId, prompt.user, prompt.system],
    );
  }

  private async touchStrategySelected(strategyAssetId: string): Promise<void> {
    await this.db.query(
      `UPDATE evolution_strategy_assets
          SET last_selected_at = $2, updated_at = $2
        WHERE id = $1`,
      [strategyAssetId, new Date().toISOString()],
    );
  }

}

function isPgPool(db: Queryable): db is Pool {
  return typeof (db as { connect?: unknown }).connect === "function";
}

export function targetToOut(row: EvolutionTargetRow): Record<string, unknown> {
  const metadata = objectValue(row.metadata_json);
  return {
    id: row.id,
    space_id: row.space_id,
    target_name: optionalString(metadata.target_name),
    target_type: row.target_type,
    target_ref_type: row.target_ref_type,
    target_ref_id: row.target_ref_id,
    capability_key: row.capability_key,
    current_version_id: row.current_version_id,
    current_version: optionalString(metadata.current_version),
    scope: optionalString(metadata.scope) ?? (row.space_id ? "space" : "system"),
    purpose: optionalString(metadata.purpose),
    risk_level: row.risk_level,
    status: row.status,
    enabled: row.enabled,
    recent_signal_count: count(row),
    last_run_at: dateIso(row.last_run_at),
    engine_policy_json: objectValue(row.engine_policy_json),
    metadata_json: metadata,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function signalToOut(row: EvolutionSignalRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    target_id: row.target_id,
    target_name: row.target_name,
    target_type: row.target_type,
    capability_key: row.capability_key,
    signal_type: row.signal_type,
    source_type: row.source_type,
    source_id: row.source_id,
    severity: row.severity,
    summary: row.summary,
    payload_json: objectValue(row.payload_json),
    triage_status: row.triage_status ?? "new",
    triaged_at: dateIso(row.triaged_at),
    triaged_by_user_id: row.triaged_by_user_id,
    triage_note: row.triage_note,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function signalTriageStatus(value: unknown): "new" | "acknowledged" | "dismissed" | "actioned" | null {
  const status = optionalString(value);
  return status === "new" || status === "acknowledged" || status === "dismissed" || status === "actioned"
    ? status
    : null;
}

function selectorDecisionToOut(row: EvolutionSelectorDecisionRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    target_id: row.target_id,
    target_name: row.target_name,
    target_type: row.target_type,
    run_id: row.run_id,
    selected_strategy_asset_id: row.selected_strategy_asset_id,
    selected_strategy_key: row.selected_strategy_key,
    selected_strategy_name: row.selected_strategy_name,
    candidate_strategy_ids: jsonArray(row.candidate_strategy_ids_json),
    input_signal_ids: jsonArray(row.input_signal_ids_json),
    decision_reason: row.decision_reason,
    score_trace_json: objectValue(row.score_trace_json),
    rejected_reasons_json: jsonArray(row.rejected_reasons_json),
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function experienceToOut(row: EvolutionExperienceRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    strategy_asset_id: row.strategy_asset_id,
    strategy_key: row.strategy_key,
    strategy_name: row.strategy_name,
    target_id: row.target_id,
    target_name: row.target_name,
    source_run_id: row.source_run_id,
    source_proposal_id: row.source_proposal_id,
    experience_key: row.experience_key,
    summary: row.summary,
    trigger_signals: jsonArray(row.trigger_signals_json),
    outcome_status: row.outcome_status,
    confidence_score: Number(row.confidence_score ?? 0),
    blast_radius_json: objectValue(row.blast_radius_json),
    validation_trace_json: objectValue(row.validation_trace_json),
    execution_trace_json: objectValue(row.execution_trace_json),
    lessons: jsonArray(row.lessons_json),
    anti_patterns: jsonArray(row.anti_patterns_json),
    environment_fingerprint_json: objectValue(row.environment_fingerprint_json),
    provenance_type: row.provenance_type,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function unsupportedValidationMetric(
  target: EvolutionTargetRow,
  targetName: string | null,
  metric: Record<string, unknown>,
  index: number,
  targetWindow: string | null,
  evaluator: string,
): EvolutionValidationResultRow {
  return {
    metric_id: optionalString(metric.id) ?? `${evaluator || "unknown"}.${index + 1}`,
    label: optionalString(metric.label) ?? "Unsupported validation metric",
    evaluator,
    target_id: target.id,
    target_name: targetName,
    value: null,
    status: "unsupported",
    window: optionalString(metric.window) ?? targetWindow,
    goal: objectValue(metric.goal),
    sample_size: 0,
    numerator_count: null,
    denominator_count: null,
    updated_at: null,
    metadata_json: { reason: "unsupported_evaluator" },
  };
}

function validationWindowCutoff(window: string | null): string | null {
  if (!window || window === "all") return null;
  const match = /^(\d+)([dhw])$/.exec(window.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2];
  const hours = unit === "d" ? amount * 24 : unit === "w" ? amount * 24 * 7 : amount;
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function statusForNumericGoal(value: number, goal: Record<string, unknown>): string {
  const direction = optionalString(goal.direction);
  const threshold = numberValue(goal.threshold);
  const min = numberValue(goal.min);
  const max = numberValue(goal.max);
  if (direction === "decrease" && threshold !== null) return value <= threshold ? "passed" : "failed";
  if (direction === "increase" && threshold !== null) return value >= threshold ? "passed" : "failed";
  if (min !== null && value < min) return "failed";
  if (max !== null && value > max) return "failed";
  if (min !== null || max !== null) return "passed";
  return "observed";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function count(row: { total?: unknown; recent_signal_count?: unknown } | undefined): number {
  const value = row?.total ?? row?.recent_signal_count;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}
