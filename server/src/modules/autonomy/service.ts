import { randomUUID } from "node:crypto";
import { withQueryableTransaction, type Queryable } from "../routeUtils/common";
import type { AutomationRow } from "../automations/repository";
import { PgAutomationRepository } from "../automations/repository";
import { automationBudgetSource, automationContract } from "../automations/targetSupport";
import { PgJobQueueRepository } from "../jobs/repository";
import {
  assertBudgetSourcesAvailable,
  RunBudgetExceededError,
  RunBudgetSourceReferenceError,
} from "../runs/budgetEnforcement";
import {
  admitAutonomousRun,
  type AutonomousAdmissionDecision,
  type AutonomousAdmissionPolicy,
  type AutonomousQuotaSnapshot,
} from "../runs/autonomousAdmission";
import { PgRunRepository } from "../runs/repository";
import { canReadProject } from "../projects/access";
import { settleAutonomyCoordinator } from "./finalizationReconciler";
import {
  autonomyDiscovererRegistry,
  type AutonomyCandidateKind,
  type DiscoveredAutonomyCandidate,
} from "./registry";

export interface ObserveAutonomyTickInput {
  spaceId: string;
  automationId: string;
  ownerUserId: string;
  config?: Record<string, unknown> | null;
  now?: Date;
}

export interface AutonomyTickResult {
  tick_id: string;
  mode: "observe_only";
  status: "succeeded";
  candidates_seen: number;
  candidates_ranked: number;
  candidates_admitted: 0;
  candidates_launched: 0;
  candidate_ids: string[];
}

export interface LaunchAutonomyCandidatesInput {
  automation: AutomationRow;
  triggerType: string;
  preflightSnapshot: Record<string, unknown>;
  policy: AutonomousAdmissionPolicy;
  quota: AutonomousQuotaSnapshot;
  runtimeProfileId: string;
  now?: Date;
}

export interface AutonomyLaunchTickResult {
  tick_id: string;
  coordinator_run_id: string;
  automation_run_id: string;
  candidates_seen: number;
  candidates_admitted: number;
  candidates_launched: number;
  refused: Array<{ candidate_id: string; reason: string }>;
  launched_run_ids: string[];
}

export class AutonomyService {
  constructor(private readonly db: Queryable) {}

  async observeTick(input: ObserveAutonomyTickInput): Promise<AutonomyTickResult> {
    const now = input.now ?? new Date();
    const config = input.config ?? {};
    return withQueryableTransaction(this.db, async (client) => {
      const tickId = randomUUID();
      const nowIso = now.toISOString();
      await client.query(
        `INSERT INTO autonomy_ticks (
           id, space_id, automation_id, owner_user_id, mode, status,
           config_snapshot_json, started_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'observe_only', 'running', $5::jsonb, $6, $6, $6)`,
        [tickId, input.spaceId, input.automationId, input.ownerUserId, JSON.stringify(config), nowIso],
      );

      const discovered: DiscoveredAutonomyCandidate[] = [];
      for (const [, discoverer] of autonomyDiscovererRegistry.entries()) {
        discovered.push(...await discoverer.discover({
          db: client,
          spaceId: input.spaceId,
          ownerUserId: input.ownerUserId,
          now,
          config,
        }));
      }
      const ranked = [...discovered].sort((left, right) =>
        right.rankingScore - left.rankingScore
        || left.kind.localeCompare(right.kind)
        || left.key.localeCompare(right.key)
      );
      const candidateIds: string[] = [];
      for (const [index, candidate] of ranked.entries()) {
        const candidateId = randomUUID();
        const materialized = await client.query<{ id: string }>(
          `INSERT INTO autonomy_candidates (
             id, space_id, owner_user_id, project_id, candidate_kind,
             candidate_key, status, durable_fact_refs_json,
             discovery_snapshot_json, ranking_score, ranking_evidence_json,
             decision_reason, first_seen_tick_id, last_seen_tick_id,
             discovered_at, ranked_at, decided_at, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'observed', $7::jsonb, $8::jsonb,
             $9, $10::jsonb, 'observe_only', $11, $11, $12, $12, $12, $12, $12
           )
           ON CONFLICT (space_id, owner_user_id, candidate_kind, candidate_key)
           DO UPDATE SET
             project_id = EXCLUDED.project_id,
             durable_fact_refs_json = EXCLUDED.durable_fact_refs_json,
             discovery_snapshot_json = EXCLUDED.discovery_snapshot_json,
             ranking_score = EXCLUDED.ranking_score,
             ranking_evidence_json = EXCLUDED.ranking_evidence_json,
             last_seen_tick_id = EXCLUDED.last_seen_tick_id,
             ranked_at = EXCLUDED.ranked_at,
             updated_at = EXCLUDED.updated_at,
             -- A candidate whose launched Run failed keeps the identical
             -- candidate_key as long as its durable facts are unchanged (e.g.
             -- evolution_review hashes the exact signal set), so re-discovery
             -- hits this same row on conflict rather than inserting a new one.
             -- 'failed' must revert to 'observed' here, or a transient Run
             -- failure permanently blocks retry for that fact set: every later
             -- tick would re-materialize the identical row, still find
             -- run_id/status pointing at the dead Run, and refuse it as
             -- 'candidate_not_launchable' forever.
             status = CASE
               WHEN autonomy_candidates.status IN ('discovered', 'ranked', 'observed', 'refused', 'failed')
                 THEN 'observed'
               ELSE autonomy_candidates.status
             END,
             decision_reason = CASE
               WHEN autonomy_candidates.status IN ('discovered', 'ranked', 'observed', 'refused', 'failed')
                 THEN 'observe_only'
               ELSE autonomy_candidates.decision_reason
             END,
             -- Clear the dead attempt's bookkeeping so the next launch pass
             -- treats this as a fresh, unlaunched candidate.
             run_id = CASE
               WHEN autonomy_candidates.status = 'failed' THEN NULL
               ELSE autonomy_candidates.run_id
             END,
             launch_tick_id = CASE
               WHEN autonomy_candidates.status = 'failed' THEN NULL
               ELSE autonomy_candidates.launch_tick_id
             END,
             artifact_id = CASE
               WHEN autonomy_candidates.status = 'failed' THEN NULL
               ELSE autonomy_candidates.artifact_id
             END,
             admission_decision_json = CASE
               WHEN autonomy_candidates.status = 'failed' THEN '{}'::jsonb
               ELSE autonomy_candidates.admission_decision_json
             END,
             decided_at = CASE
               WHEN autonomy_candidates.status = 'failed' THEN NULL
               ELSE autonomy_candidates.decided_at
             END,
             launched_at = CASE
               WHEN autonomy_candidates.status = 'failed' THEN NULL
               ELSE autonomy_candidates.launched_at
             END,
             completed_at = CASE
               WHEN autonomy_candidates.status = 'failed' THEN NULL
               ELSE autonomy_candidates.completed_at
             END
           RETURNING id`,
          [
            candidateId,
            input.spaceId,
            input.ownerUserId,
            candidate.projectId,
            candidate.kind,
            candidate.key,
            JSON.stringify(candidate.durableFactRefs),
            JSON.stringify({
              ...candidate.discoverySnapshot,
              may_require_interactive_authorization: candidate.mayRequireInteractiveAuthorization,
            }),
            candidate.rankingScore,
            JSON.stringify(candidate.rankingEvidence),
            tickId,
            nowIso,
          ],
        );
        const persistedId = materialized.rows[0]!.id;
        const handler = autonomyDiscovererRegistry.get(candidate.kind);
        await handler?.onMaterialized?.(client, persistedId, candidate, now);
        candidateIds.push(persistedId);
        await client.query(
          `INSERT INTO autonomy_tick_candidates (
             id, space_id, tick_id, candidate_id, rank, ranking_score,
             decision, decision_reason, evidence_json, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'observed', 'observe_only', $7::jsonb, $8)`,
          [
            randomUUID(),
            input.spaceId,
            tickId,
            persistedId,
            index + 1,
            candidate.rankingScore,
            JSON.stringify(candidate.rankingEvidence),
            nowIso,
          ],
        );
      }
      const summary = {
        candidate_kinds: [...new Set(ranked.map((candidate) => candidate.kind))],
        zero_candidate_tick: ranked.length === 0,
        ranking: "deterministic_score_desc_kind_key",
      };
      await client.query(
        `UPDATE autonomy_ticks
            SET status = 'succeeded', candidates_seen = $3, candidates_ranked = $3,
                summary_json = $4::jsonb, completed_at = $5, updated_at = $5
          WHERE space_id = $1 AND id = $2`,
        [input.spaceId, tickId, ranked.length, JSON.stringify(summary), nowIso],
      );
      return {
        tick_id: tickId,
        mode: "observe_only",
        status: "succeeded",
        candidates_seen: ranked.length,
        candidates_ranked: ranked.length,
        candidates_admitted: 0,
        candidates_launched: 0,
        candidate_ids: candidateIds,
      };
    });
  }

  async launchCandidates(input: LaunchAutonomyCandidatesInput): Promise<AutonomyLaunchTickResult> {
    const now = input.now ?? new Date();
    const initialized = await withQueryableTransaction(this.db, async (client) => {
      const observed = await new AutonomyService(client).observeTick({
        spaceId: input.automation.space_id,
        automationId: input.automation.id,
        ownerUserId: input.automation.owner_user_id,
        config: input.automation.config_json,
        now,
      });
      const coordinator = await new PgRunRepository(client).createCoordinatorRun({
        space_id: input.automation.space_id,
        user_id: input.automation.owner_user_id,
        agent_id: input.automation.agent_id,
        project_folder_id: input.automation.project_folder_id,
        project_id: input.automation.project_id,
        mode: "live",
        run_type: "system",
        trigger_origin: "automation",
        visibility: "private",
        prompt: `Autonomous work tick: ${input.automation.name}`,
        instruction: "Coordinate bounded autonomous candidates and record every admission outcome.",
        contract_snapshot: {
          ...automationContract(input.automation),
          route_hints_json: {
            autonomy_tick_id: observed.tick_id,
            automation_id: input.automation.id,
            coordinator: true,
          },
        },
      });
      await client.query(
        `UPDATE runs SET status = 'waiting_for_dependency', updated_at = $3
          WHERE space_id = $1 AND id = $2`,
        [input.automation.space_id, coordinator.id, now.toISOString()],
      );
      const automationRunId = await new PgAutomationRepository(client).createAutomationRun({
        automationId: input.automation.id,
        runId: coordinator.id,
        triggeredByUserId: input.automation.owner_user_id,
        triggerType: input.triggerType,
        preflightSnapshot: input.preflightSnapshot,
        triggerContext: {
          target_type: "autonomous_tick",
          autonomy_tick_id: observed.tick_id,
          candidates_seen: observed.candidates_seen,
        },
      });
      await client.query(
        `UPDATE autonomy_ticks
            SET mode = 'launch', status = 'running',
                coordinator_run_id = $3, automation_run_id = $4,
                completed_at = NULL, updated_at = $5
          WHERE space_id = $1 AND id = $2`,
        [
          input.automation.space_id,
          observed.tick_id,
          coordinator.id,
          automationRunId,
          now.toISOString(),
        ],
      );
      return { observed, coordinatorRunId: coordinator.id, automationRunId };
    });

    const launchedRunIds: string[] = [];
    const refused: Array<{ candidate_id: string; reason: string }> = [];
    const automationBudget = automationBudgetSource(input.automation);
    for (const candidateId of initialized.observed.candidate_ids) {
      let decision: AutonomousAdmissionDecision<string>;
      try {
        decision = await admitAutonomousRun(this.db, {
        spaceId: input.automation.space_id,
        ownerUserId: input.automation.owner_user_id,
        policy: input.policy,
        quota: input.quota,
        now,
        recheckEligibility: async (db) => {
          const row = await db.query<{
            id: string;
            candidate_kind: string;
            project_id: string | null;
            discovery_snapshot_json: unknown;
          }>(
            `SELECT id, candidate_kind, project_id, discovery_snapshot_json
               FROM autonomy_candidates
              WHERE space_id = $1 AND id = $2
                AND owner_user_id = $3
                AND status IN ('observed', 'refused')
                AND run_id IS NULL
              FOR UPDATE`,
            [input.automation.space_id, candidateId, input.automation.owner_user_id],
          );
          const candidate = row.rows[0];
          const candidateKind = candidate?.candidate_kind as AutonomyCandidateKind | undefined;
          if (!candidate || !candidateKind || !autonomyDiscovererRegistry.get(candidateKind)) {
            return { eligible: false, reason: "candidate_not_launchable" };
          }
          const interactive = recordValue(candidate.discovery_snapshot_json)
            .may_require_interactive_authorization;
          if (interactive === true) return { eligible: false, reason: "interactive_authorization_possible" };
          if (candidate.project_id) {
            const project = await db.query(
              `SELECT 1 FROM projects
                WHERE space_id = $1 AND id = $2
                  AND status = 'active' AND deleted_at IS NULL
                LIMIT 1`,
              [input.automation.space_id, candidate.project_id],
            );
            if (!project.rows[0]) return { eligible: false, reason: "project_not_active" };
            if (!(await canReadProject(db, input.automation.space_id, candidate.project_id, input.automation.owner_user_id))) {
              return { eligible: false, reason: "project_access_revoked" };
            }
          }
          const grant = await db.query(
            `SELECT 1 FROM automation_credential_grants
              WHERE space_id = $1 AND automation_id = $2 AND status = 'active'
              LIMIT 1`,
            [input.automation.space_id, input.automation.id],
          );
          if (!grant.rows[0]) return { eligible: false, reason: "automation_credential_grant_missing" };
          return { eligible: true };
        },
        persistDecision: async (db, admission) => {
          if (!admission.allowed) {
            await persistCandidateDecision(db, {
              spaceId: input.automation.space_id,
              tickId: initialized.observed.tick_id,
              candidateId,
              status: "refused",
              decision: "refused",
              reason: admission.reason,
              trace: admission,
              now: now.toISOString(),
            });
          }
        },
        create: async (db, trace) => {
          await assertBudgetSourcesAvailable(
            db,
            input.automation.space_id,
            [automationBudget],
            { excludeExecutionRootId: initialized.coordinatorRunId },
          );
          const candidate = await db.query<{
            candidate_kind: AutonomyCandidateKind;
            project_id: string | null;
            discovery_snapshot_json: Record<string, unknown>;
          }>(
            `SELECT candidate_kind, project_id, discovery_snapshot_json
               FROM autonomy_candidates
              WHERE space_id = $1 AND id = $2 FOR UPDATE`,
            [input.automation.space_id, candidateId],
          );
          const snapshot = candidate.rows[0]?.discovery_snapshot_json ?? {};
          const kind = candidate.rows[0]?.candidate_kind;
          const launchSpec = kind
            ? autonomyDiscovererRegistry.get(kind)?.buildLaunch({
                candidateId,
                projectId: candidate.rows[0]?.project_id ?? null,
                discoverySnapshot: snapshot,
              })
            : null;
          if (!launchSpec) throw new Error(`No autonomous launch handler for candidate '${candidateId}'`);
          const run = await new PgRunRepository(db).createQueuedRun({
            space_id: input.automation.space_id,
            user_id: input.automation.owner_user_id,
            agent_id: input.automation.agent_id,
            runtime_profile_id: input.runtimeProfileId,
            runtime_profile_selection_source: "explicit",
            project_folder_id: input.automation.project_folder_id,
            project_id: candidate.rows[0]?.project_id ?? null,
            parent_run_id: initialized.coordinatorRunId,
            mode: "live",
            run_type: "system",
            trigger_origin: "autonomous",
            visibility: "private",
            capability_id: launchSpec.capabilityId,
            capabilities_json: launchSpec.capabilities,
            prompt: launchSpec.prompt,
            instruction: launchSpec.instruction,
            contract_snapshot: {
              source: { kind: "automation", id: input.automation.id },
              project_id: candidate.rows[0]?.project_id ?? null,
              project_folder_id: input.automation.project_folder_id,
              risk_level: "low",
              policy_context_json: {
                automation_id: input.automation.id,
                automation_pre_authorized: true,
                autonomy_tick_id: initialized.observed.tick_id,
                autonomy_candidate_id: candidateId,
                autonomous_admission: trace,
                output_visibility: "private",
                authoritative_mutation_allowed: false,
              },
              route_hints_json: {
                autonomy_tick_id: initialized.observed.tick_id,
                autonomy_candidate_id: candidateId,
                coordinator_run_id: initialized.coordinatorRunId,
              },
            },
          });
          await new PgJobQueueRepository(db).enqueue({
            job_type: "agent_run",
            payload: { run_id: run.id },
            space_id: input.automation.space_id,
            user_id: input.automation.owner_user_id,
            agent_id: input.automation.agent_id,
            project_folder_id: input.automation.project_folder_id,
          });
          await persistCandidateDecision(db, {
            spaceId: input.automation.space_id,
            tickId: initialized.observed.tick_id,
            candidateId,
            status: "launched",
            decision: "launched",
            reason: "admitted",
            trace: { allowed: true, reason: "admitted", trace },
            runId: run.id,
            now: now.toISOString(),
          });
          return run.id;
        },
        });
      } catch (error) {
        if (!(error instanceof RunBudgetExceededError) && !(error instanceof RunBudgetSourceReferenceError)) {
          throw error;
        }
        const reason = error.code;
        await withQueryableTransaction(this.db, async (db) => {
          await persistCandidateDecision(db, {
            spaceId: input.automation.space_id,
            tickId: initialized.observed.tick_id,
            candidateId,
            status: "refused",
            decision: "refused",
            reason,
            trace: { allowed: false, reason, error: error.message },
            now: now.toISOString(),
          });
        });
        refused.push({ candidate_id: candidateId, reason });
        continue;
      }
      if (decision.allowed) launchedRunIds.push(decision.value);
      else refused.push({ candidate_id: candidateId, reason: decision.reason });
    }

    await withQueryableTransaction(this.db, async (db) => {
      await db.query(
        `UPDATE autonomy_ticks
            SET status = 'succeeded',
                candidates_admitted = $3,
                candidates_launched = $3,
                summary_json = summary_json || $4::jsonb,
                completed_at = $5,
                updated_at = $5
          WHERE space_id = $1 AND id = $2`,
        [
          input.automation.space_id,
          initialized.observed.tick_id,
          launchedRunIds.length,
          JSON.stringify({ refused, launched_run_ids: launchedRunIds }),
          now.toISOString(),
        ],
      );
      await db.query(
        `UPDATE automation_runs
            SET trigger_context_json = COALESCE(trigger_context_json, '{}'::jsonb) || $2::jsonb
          WHERE id = $1`,
        [
          initialized.automationRunId,
          JSON.stringify({
            candidates_seen: initialized.observed.candidates_seen,
            candidates_ranked: initialized.observed.candidates_ranked,
            candidates_admitted: launchedRunIds.length,
            candidates_launched: launchedRunIds.length,
            refused,
            launched_run_ids: launchedRunIds,
          }),
        ],
      );
      if (launchedRunIds.length === 0) {
        await settleAutonomyCoordinator(
          db,
          input.automation.space_id,
          initialized.observed.tick_id,
          now.toISOString(),
        );
      }
    });
    return {
      tick_id: initialized.observed.tick_id,
      coordinator_run_id: initialized.coordinatorRunId,
      automation_run_id: initialized.automationRunId,
      candidates_seen: initialized.observed.candidates_seen,
      candidates_admitted: launchedRunIds.length,
      candidates_launched: launchedRunIds.length,
      refused,
      launched_run_ids: launchedRunIds,
    };
  }

}

async function persistCandidateDecision(
  db: Queryable,
  input: {
    spaceId: string;
    tickId: string;
    candidateId: string;
    status: "refused" | "launched";
    decision: "refused" | "launched";
    reason: string;
    trace: unknown;
    runId?: string | null;
    now: string;
  },
): Promise<void> {
  await db.query(
    `UPDATE autonomy_candidates
        SET status = $4::varchar, decision_reason = $5,
            admission_decision_json = $6::jsonb,
            run_id = COALESCE($7, run_id),
            launch_tick_id = CASE
              WHEN $4::varchar = 'launched' THEN COALESCE(launch_tick_id, $3)
              ELSE launch_tick_id
            END,
            decided_at = $8,
            launched_at = CASE WHEN $4::varchar = 'launched' THEN $8 ELSE launched_at END,
            updated_at = $8
      WHERE space_id = $1 AND id = $2
        AND run_id IS NULL
        AND status IN ('observed', 'refused')`,
    [input.spaceId, input.candidateId, input.tickId, input.status, input.reason, JSON.stringify(input.trace), input.runId ?? null, input.now],
  );
  await db.query(
    `UPDATE autonomy_tick_candidates
        SET decision = $4, decision_reason = $5,
            evidence_json = evidence_json || $6::jsonb
      WHERE space_id = $1 AND tick_id = $2 AND candidate_id = $3`,
    [input.spaceId, input.tickId, input.candidateId, input.decision, input.reason, JSON.stringify({ autonomous_admission: input.trace })],
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
