import { randomUUID } from "node:crypto";
import { getRuntimeAdapterSpec, isLocalCliRuntimeAdapter } from "../runtimeAdapters";
import { contractRecord } from "../runs/contractSnapshot";
import type { RunRecord } from "../runs/runRepositoryTypes";
import type { Queryable } from "../routeUtils/common";
import { DeterministicRouteSelector, mergeRouteHints } from "./router";
import type { RouteCandidate, RouteHints } from "./types";

interface RuntimeCandidateRow {
  runtime_profile_id: string;
  profile_name: string;
  adapter_type: string;
  model_provider_id: string | null;
  model_name: string | null;
  credential_profile_id: string | null;
  credential_profile_owner_id: string | null;
  provider_enabled: boolean | null;
  provider_credential_id: string | null;
  provider_has_healthy_credential: boolean;
  enabled: boolean;
  is_default: boolean;
  runtime_config_json: unknown;
  runtime_policy_json: unknown;
  capabilities_json: unknown;
  estimated_cost_usd: number | string | null;
  estimated_latency_ms: number | string | null;
  historical_verification_pass_rate: number | string | null;
  conformance_status: "passed" | "failed" | "partial" | null;
  conformance_suite_version: string | null;
}

interface CliCredentialAvailability {
  availableProfiles(
    spaceId: string,
    userId: string,
  ): Promise<Record<string, unknown>[]>;
}

export class RouteSelectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RouteSelectionError";
  }
}

export class PgRouteDecisionRepository {
  constructor(
    private readonly db: Queryable,
    private readonly selector = new DeterministicRouteSelector(),
    private readonly cliCredentials: CliCredentialAvailability | null = null,
  ) {}

  async routeRun(run: RunRecord): Promise<RunRecord> {
    if (run.run_type === "system" || run.run_type === "validation") return run;
    const hints = routeHintsForRun(run);
    const requestedCredentialProfileId = conversationCredentialProfileId(run.model_override_json);
    const candidates = await this.listCandidates(
      run.space_id,
      run.agent_id,
      run.owner_user_id ?? null,
      requestedCredentialProfileId,
    );
    const attemptNumber = await this.currentAttemptNumber(run);
    const retryRoute = attemptNumber > 1 ? await this.retryRouteContext(run, attemptNumber) : null;
    const decision = this.selector.select({
      runtime_profile_id: run.requested_runtime_profile_id ?? null,
      runtime_profile_is_explicit: run.runtime_profile_selection_source === "explicit",
      excluded_runtime_profile_ids: retryRoute?.excludedProfileIds,
      fallback_runtime_profile_ids: retryRoute?.fallbackProfileIds,
      required_capabilities: stringArray(run.capabilities_json),
      required_tools: [],
      required_sandbox_level: routeSandboxLevel(run.required_sandbox_level),
      execution_mode: run.mode === "dry_run" ? "dry_run" : "live",
      risk_level: riskLevel(contractRecord(run.contract_snapshot_json).risk_level),
      workspace_available: Boolean(run.project_folder_id),
      hints,
    }, candidates);
    const now = new Date().toISOString();
    const existing = await this.db.query<{
      id: string;
      status: string;
      selected_runtime_profile_id: string | null;
    }>(
      `SELECT id, status, selected_runtime_profile_id
         FROM route_decisions WHERE space_id = $1 AND run_id = $2 AND attempt_number = $3`,
      [run.space_id, run.id, attemptNumber],
    );
    let selected = decision.selected?.candidate ?? null;
    let persistedDecisionId = existing.rows[0]?.id ?? null;
    if (existing.rows[0]) {
      if (existing.rows[0].status !== "selected") {
        throw new RouteSelectionError("route_no_candidate", "The persisted route decision has no eligible candidate.");
      }
      selected = candidates.find((candidate) => candidate.runtime_profile_id === existing.rows[0]?.selected_runtime_profile_id) ?? null;
      if (!selected) {
        throw new RouteSelectionError("route_selected_profile_unavailable", "The persisted route profile is no longer available.");
      }
    } else {
      persistedDecisionId = randomUUID();
      await this.db.query(
        `INSERT INTO route_decisions (
           id, space_id, run_id, attempt_number, status,
           selected_runtime_profile_id, selected_adapter_type, selected_model_provider_id,
           reason, hints_json, candidates_json, rejected_json, fallback_chain_json,
           score_trace_json, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
                   $12::jsonb, $13::jsonb, $14::jsonb, $15)`,
        [
          persistedDecisionId,
          run.space_id,
          run.id,
          attemptNumber,
          selected ? "selected" : "no_route",
          selected?.runtime_profile_id ?? null,
          selected?.adapter_type ?? null,
          selected?.model_provider_id ?? null,
          decision.reason,
          JSON.stringify(hints),
          JSON.stringify(decision.candidates.map((item) => ({
            runtime_profile_id: item.candidate.runtime_profile_id,
            adapter_type: item.candidate.adapter_type,
            model_provider_id: item.candidate.model_provider_id,
            baseline_trust_level: item.candidate.baseline_trust_level,
            effective_trust_level: item.candidate.effective_trust_level,
            conformance_status: item.candidate.conformance_status ?? null,
            conformance_suite_version: item.candidate.conformance_suite_version ?? null,
            score: item.score,
            score_trace: item.score_trace,
          }))),
          JSON.stringify(decision.rejected.map((item) => {
            const candidate = candidates.find((value) => value.runtime_profile_id === item.runtime_profile_id);
            return {
              ...item,
              baseline_trust_level: candidate?.baseline_trust_level ?? null,
              effective_trust_level: candidate?.effective_trust_level ?? null,
              conformance_status: candidate?.conformance_status ?? null,
              conformance_suite_version: candidate?.conformance_suite_version ?? null,
            };
          })),
          JSON.stringify(decision.fallback_chain),
          JSON.stringify(decision.candidates.map((item) => ({ runtime_profile_id: item.candidate.runtime_profile_id, score_trace: item.score_trace }))),
          now,
        ],
      );
    }
    if (!selected) {
      throw new RouteSelectionError("route_no_candidate", decision.reason);
    }
    if (!persistedDecisionId) {
      throw new RouteSelectionError("route_decision_not_persisted", "Route decision could not be persisted.");
    }

    const modelOverride = {
      ...record(run.model_override_json),
      ...(selected.model_name ? { model: selected.model_name } : {}),
      route_decision_id: persistedDecisionId,
      route_source: "deterministic_policy",
    };
    const routed = await this.db.query<RunRecord>(
      `UPDATE runs SET
         route_decision_id = $3,
         runtime_profile_id = $4,
         adapter_type = $5,
         model_provider_id = $6,
         model_override_json = $7::jsonb,
         runtime_profile_snapshot_json = $8::jsonb,
         updated_at = $9
       WHERE space_id = $1 AND id = $2
       RETURNING id, space_id, agent_id, agent_version_id, run_role,
                 requested_runtime_profile_id, runtime_profile_id,
                 context_snapshot_id, run_type, status, mode, prompt, instruction,
                 project_folder_id, session_id, parent_run_id, root_run_id, run_group_id,
                 delegation_id, project_id, scheduled_at, adapter_type, capability_id,
                 capabilities_json, model_provider_id, model_override_json,
                 runtime_profile_snapshot_json, required_sandbox_level,
                 contract_snapshot_json, workflow_version_id, route_decision_id, trigger_origin,
                 instructed_by_user_id, instructed_by_agent_id, error_message,
                 error_json, output_json, started_at, ended_at,
                 created_at, updated_at, owner_user_id, visibility, access_level,
                 runtime_profile_selection_source`,
      [
        run.space_id,
        run.id,
        persistedDecisionId,
        selected.runtime_profile_id,
        selected.adapter_type,
        selected.model_provider_id,
        JSON.stringify(modelOverride),
        JSON.stringify({
          id: selected.runtime_profile_id,
          name: selected.profile_name,
          adapter_type: selected.adapter_type,
          model_provider_id: selected.model_provider_id,
          model_name: selected.model_name,
          credential_profile_id: selected.credential_profile_id,
          runtime_config_json: {
            ...selected.runtime_config_json,
            ...(selected.credential_profile_id
              ? { credential_profile_id: selected.credential_profile_id }
              : {}),
          },
          runtime_policy_json: selected.runtime_policy_json,
          is_default: selected.is_default,
        }),
        now,
      ],
    );
    const result = routed.rows[0];
    if (!result) throw new RouteSelectionError("route_run_update_failed", "Route decision could not be stamped on the run");
    return result;
  }

  /**
   * Return whether the persisted C2 route decision has an untried fallback.
   * The supervisor uses this only to classify the durable decision; routeRun
   * remains the authority that filters and stamps the next candidate.
   */
  async hasFallbackRoute(run: Pick<RunRecord, "space_id" | "id">): Promise<boolean> {
    const latest = await this.db.query<{
      selected_runtime_profile_id: string | null;
      fallback_chain_json: unknown;
    }>(
      `SELECT selected_runtime_profile_id, fallback_chain_json
         FROM route_decisions
        WHERE space_id = $1 AND run_id = $2
        ORDER BY attempt_number DESC
        LIMIT 1`,
      [run.space_id, run.id],
    );
    const selected = latest.rows[0]?.selected_runtime_profile_id;
    if (!selected) return false;
    const chain = stringArray(latest.rows[0]?.fallback_chain_json);
    return chain.some((profileId) => profileId !== selected);
  }

  async listCandidates(
    spaceId: string,
    agentId: string,
    ownerUserId: string | null,
    requestedCredentialProfileId: string | null = null,
  ): Promise<RouteCandidate[]> {
    const result = await this.db.query<RuntimeCandidateRow>(
      `WITH verified_runs AS (
         SELECT vr.run_id, bool_and(vr.status = 'passed') AS passed
           FROM verification_results vr
           JOIN runs vh ON vh.id = vr.run_id AND vh.space_id = vr.space_id
          WHERE vh.space_id = $1 AND vh.agent_id = $2
            AND vh.created_at >= now() - interval '90 days'
          GROUP BY vr.run_id
       ), history AS (
         SELECT h.adapter_type,
                avg(usage.estimated_cost_usd)::float8 AS estimated_cost_usd,
                avg(h.runtime_seconds * 1000)::float8 AS estimated_latency_ms,
                CASE WHEN count(*) >= 3 THEN avg(CASE WHEN v.passed THEN 1.0 ELSE 0.0 END)::float8 ELSE NULL END AS historical_verification_pass_rate
           FROM runs h
           JOIN verified_runs v ON v.run_id = h.id
           LEFT JOIN LATERAL (
             SELECT sum(e.estimated_cost_usd)::numeric AS estimated_cost_usd
               FROM token_usage_events e
              WHERE e.space_id = h.space_id AND e.run_id = h.id
           ) usage ON true
          WHERE h.space_id = $1 AND h.agent_id = $2
            AND h.created_at >= now() - interval '90 days'
            AND h.status IN ('succeeded', 'degraded', 'failed')
          GROUP BY h.adapter_type
       )
      SELECT arp.id AS runtime_profile_id, arp.name AS profile_name,
              arp.adapter_type, arp.model_provider_id, arp.model_name,
              cp.id AS credential_profile_id, cp.owner_user_id AS credential_profile_owner_id,
              (mp.enabled AND mpg.enabled) AS provider_enabled,
              mp.credential_id AS provider_credential_id,
              EXISTS (
                SELECT 1 FROM model_provider_credentials mpc
                 WHERE mpc.provider_id = arp.model_provider_id
                   AND mpc.enabled = true AND mpc.healthy = true
                   AND (mpc.cooldown_until IS NULL OR mpc.cooldown_until <= now())
              ) AS provider_has_healthy_credential,
              arp.enabled, arp.is_default, arp.runtime_config_json,
              arp.runtime_policy_json,
              CASE
                WHEN jsonb_typeof(arp.runtime_config_json->'capabilities') = 'array'
                  THEN arp.runtime_config_json->'capabilities'
                WHEN jsonb_typeof(arp.runtime_policy_json->'capabilities') = 'array'
                  THEN arp.runtime_policy_json->'capabilities'
                WHEN jsonb_typeof(av.capabilities_json) = 'array'
                  THEN av.capabilities_json
                ELSE '[]'::jsonb
              END AS capabilities_json,
              history.estimated_cost_usd,
              history.estimated_latency_ms, history.historical_verification_pass_rate,
              conformance.status AS conformance_status,
              conformance.suite_version AS conformance_suite_version
         FROM agent_runtime_profiles arp
         JOIN agents a
           ON a.id = arp.agent_id AND a.space_id = arp.space_id
         LEFT JOIN agent_versions av
           ON av.id = a.current_version_id
          AND av.space_id = a.space_id
          AND av.agent_id = a.id
         LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
         LEFT JOIN model_provider_space_grants mpg
           ON mpg.provider_id = arp.model_provider_id
          AND mpg.space_id = arp.space_id
         LEFT JOIN LATERAL (
           SELECT profile.id, profile.owner_user_id
             FROM cli_credential_space_grants grant_row
             JOIN cli_credential_profiles profile
               ON profile.id = grant_row.profile_id
              AND profile.owner_user_id = grant_row.owner_user_id
            WHERE grant_row.space_id = $1
              AND grant_row.owner_user_id = $3
              AND grant_row.enabled = true
              AND profile.owner_user_id = $3
              AND profile.runtime = arp.adapter_type
              AND ($4::text IS NULL OR profile.id = $4)
            ORDER BY (profile.id = $4) DESC,
                     grant_row.is_default DESC,
                     profile.created_at ASC,
                     profile.id ASC
            LIMIT 1
         ) cp ON true
         LEFT JOIN history ON history.adapter_type = arp.adapter_type
         LEFT JOIN runtime_conformance_results conformance
           ON conformance.runtime_adapter_type = arp.adapter_type
          AND conformance.runtime_version = COALESCE(arp.runtime_config_json->>'runtime_tool_version', '')
        WHERE arp.space_id = $1 AND arp.agent_id = $2
        ORDER BY arp.is_default DESC, arp.created_at ASC, arp.id ASC`,
      [spaceId, agentId, ownerUserId, requestedCredentialProfileId],
    );
    const hasCliCandidates = result.rows.some((row) =>
      isLocalCliRuntimeAdapter(row.adapter_type));
    let loggedInCredentialIds: Set<string> | null = null;
    if (hasCliCandidates) {
      if (!ownerUserId || !this.cliCredentials) {
        throw new RouteSelectionError(
          "route_cli_eligibility_unavailable",
          "CLI routing requires the Run owner's live credential eligibility",
        );
      }
      const available = await this.cliCredentials.availableProfiles(spaceId, ownerUserId);
      loggedInCredentialIds = new Set(
        available
          .filter((profile) => profile.logged_in === true)
          .map((profile) => profile.id)
          .filter((id): id is string => typeof id === "string"),
      );
    }
    const candidates = result.rows.map((row) =>
      candidateFromRow(
        row,
        !isLocalCliRuntimeAdapter(row.adapter_type) ||
          Boolean(row.credential_profile_id && loggedInCredentialIds?.has(row.credential_profile_id)),
      ));
    return requestedCredentialProfileId
      ? candidates.filter(
          (candidate) => candidate.credential_profile_id === requestedCredentialProfileId,
        )
      : candidates;
  }

  async getDecision(spaceId: string, runId: string) {
    const result = await this.db.query(
      `SELECT id, space_id, run_id, attempt_number, status,
              selected_runtime_profile_id, selected_adapter_type,
              selected_model_provider_id, reason, hints_json, candidates_json,
              rejected_json, fallback_chain_json, score_trace_json, created_at
         FROM route_decisions WHERE space_id = $1 AND run_id = $2
        ORDER BY attempt_number DESC, created_at DESC LIMIT 1`,
      [spaceId, runId],
    );
    return result.rows[0] ?? null;
  }

  private async currentAttemptNumber(run: Pick<RunRecord, "space_id" | "id">): Promise<number> {
    const result = await this.db.query<{ attempt_number: number | string | null }>(
      `SELECT COALESCE(max(attempt_number), 1)::int AS attempt_number
         FROM run_attempts
        WHERE space_id = $1 AND run_id = $2`,
      [run.space_id, run.id],
    );
    const attemptNumber = Number(result.rows[0]?.attempt_number ?? 1);
    return Number.isInteger(attemptNumber) && attemptNumber > 0 ? attemptNumber : 1;
  }

  private async retryRouteContext(
    run: Pick<RunRecord, "space_id" | "id">,
    attemptNumber: number,
  ): Promise<{ excludedProfileIds: string[]; fallbackProfileIds: string[] }> {
    const result = await this.db.query<{
      selected_runtime_profile_id: string | null;
      fallback_chain_json: unknown;
    }>(
      `SELECT selected_runtime_profile_id, fallback_chain_json
         FROM route_decisions
        WHERE space_id = $1 AND run_id = $2 AND attempt_number < $3
        ORDER BY attempt_number DESC
        LIMIT 1`,
      [run.space_id, run.id, attemptNumber],
    );
    const previous = result.rows[0];
    if (!previous) return { excludedProfileIds: [], fallbackProfileIds: [] };

    const attempted = await this.db.query<{ selected_runtime_profile_id: string | null }>(
      `SELECT selected_runtime_profile_id
         FROM route_decisions
        WHERE space_id = $1 AND run_id = $2 AND attempt_number < $3
          AND selected_runtime_profile_id IS NOT NULL
        ORDER BY attempt_number ASC`,
      [run.space_id, run.id, attemptNumber],
    );
    const excludedProfileIds = unique(
      attempted.rows
        .map((row) => row.selected_runtime_profile_id)
        .filter((profileId): profileId is string => Boolean(profileId)),
    );
    const fallbackProfileIds = unique(stringArray(previous.fallback_chain_json))
      .filter((profileId) => !excludedProfileIds.includes(profileId));
    return {
      // An empty remainder means C2 has no alternate route; preserve the
      // existing route for a same-route retry instead of failing routing.
      excludedProfileIds: fallbackProfileIds.length > 0 ? excludedProfileIds : [],
      fallbackProfileIds,
    };
  }
}

export function routeHintsForRun(
  run: Pick<RunRecord, "contract_snapshot_json"> & {
    runtime_profile_id?: string | null;
    session_id?: string | null;
  },
): RouteHints {
  const contract = contractRecord(run.contract_snapshot_json);
  const raw = record(contract.route_hints_json);
  const sources: Array<{ source: string; value: unknown }> = [];
  if (raw.task_contract !== undefined) sources.push({ source: "task_contract", value: raw.task_contract });
  if (raw.workflow_node !== undefined) sources.push({ source: "workflow_node", value: raw.workflow_node });
  if (raw.evolution_strategy !== undefined) sources.push({ source: "evolution_strategy", value: raw.evolution_strategy });
  sources.push({ source: "contract", value: raw });
  const result = mergeRouteHints(sources);
  if (!result.execution_shape && run.session_id) {
    result.execution_shape = "conversational";
    result.sources.push("run_session");
  } else if (
    !result.execution_shape &&
    Object.keys(record(contract.structured_output_json)).length > 0
  ) {
    result.execution_shape = "structured_generation";
    result.sources.push("structured_output_contract");
  }
  if (run.runtime_profile_id && !result.preferred_runtime_profile_id) result.preferred_runtime_profile_id = run.runtime_profile_id;
  return result;
}

function candidateFromRow(
  row: RuntimeCandidateRow,
  cliCredentialLoggedIn = true,
): RouteCandidate {
  const spec = getRuntimeAdapterSpec(row.adapter_type);
  const runtimeConfig = record(row.runtime_config_json);
  const runtimePolicy = record(row.runtime_policy_json);
  const credentialAvailable = spec?.credentials.credential_mode === "none"
    ? true
    : isLocalCliRuntimeAdapter(row.adapter_type)
      ? spec?.credentials.credential_mode === "cli_profile_or_model_provider"
        ? Boolean(
            (cliCredentialLoggedIn && row.credential_profile_id && row.credential_profile_owner_id) ||
            (row.model_provider_id && row.provider_enabled && (row.provider_credential_id || row.provider_has_healthy_credential)),
          )
        : Boolean(cliCredentialLoggedIn && row.credential_profile_id && row.credential_profile_owner_id)
      : Boolean(row.provider_enabled && (row.provider_credential_id || row.provider_has_healthy_credential));
  return {
    runtime_profile_id: row.runtime_profile_id,
    profile_name: row.profile_name,
    adapter_type: row.adapter_type,
    model_provider_id: row.model_provider_id,
    model_name: row.model_name,
    credential_profile_id: row.credential_profile_id,
    runtime_config_json: runtimeConfig,
    runtime_policy_json: runtimePolicy,
    enabled: row.enabled && spec?.implementation_status === "implemented",
    is_default: row.is_default,
    credential_available: credentialAvailable,
    capabilities: stringArray(row.capabilities_json),
    tools: stringArray(runtimeConfig.tools ?? runtimeConfig.tool_ids ?? runtimePolicy.tools),
    minimum_sandbox_level: sandboxLevel(spec?.sandbox.minimum_sandbox_level),
    requires_workspace_for_execution: Boolean(spec?.sandbox.requires_workspace_for_execution),
    supports_workspace: Boolean(spec?.sandbox.supports_worktree),
    supports_one_shot_docker: Boolean(spec?.sandbox.supports_one_shot_docker),
    supports_live: runtimeConfig.supports_live !== false,
    supports_dry_run: runtimeConfig.supports_dry_run !== false,
    baseline_trust_level: trustLevel(spec?.baseline_trust_level),
    effective_trust_level: effectiveTrustLevel(spec, row.conformance_status),
    conformance_status: row.conformance_status,
    conformance_suite_version: row.conformance_suite_version,
    subagent_disable_mechanism: spec?.subagent_disable_mechanism ?? "unknown",
    estimated_cost_usd: numberOrNull(row.estimated_cost_usd),
    estimated_latency_ms: numberOrNull(row.estimated_latency_ms),
    historical_verification_pass_rate: numberOrNull(row.historical_verification_pass_rate),
  };
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function conversationCredentialProfileId(value: unknown): string | null {
  const backend = record(record(value).conversation_backend);
  const credentialProfileId = backend.credential_profile_id;
  return typeof credentialProfileId === "string" && credentialProfileId.trim()
    ? credentialProfileId
    : null;
}
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []; }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function numberOrNull(value: unknown): number | null { const number = typeof value === "string" ? Number(value) : value; return typeof number === "number" && Number.isFinite(number) ? number : null; }
function sandboxLevel(value: unknown): "none" | "dry_run" | "ephemeral" | "read_only" | "worktree" | "one_shot_docker" { return value === "dry_run" || value === "ephemeral" || value === "read_only" || value === "worktree" || value === "one_shot_docker" ? value : "none"; }
function routeSandboxLevel(value: unknown): "none" | "dry_run" | "ephemeral" | "read_only" | "worktree" | "one_shot_docker" {
  return sandboxLevel(value);
}
function trustLevel(value: unknown): "low" | "medium" | "high" { return value === "medium" || value === "high" ? value : "low"; }
function effectiveTrustLevel(
  spec: ReturnType<typeof getRuntimeAdapterSpec>,
  conformanceStatus: RuntimeCandidateRow["conformance_status"],
): "low" | "medium" | "high" {
  const baseline = trustLevel(spec?.baseline_trust_level);
  if (!spec || !isLocalCliRuntimeAdapter(spec.adapter_type)) return baseline;
  return conformanceStatus === "passed" && spec.subagent_disable_mechanism === "runtime_config"
    ? "medium"
    : "low";
}
function riskLevel(value: unknown): "low" | "medium" | "high" | "critical" { return value === "medium" || value === "high" || value === "critical" ? value : "low"; }
