import { randomUUID } from "node:crypto";
import { getRuntimeAdapterSpec, isLocalCliRuntimeAdapter } from "../runtimeAdapters/index.js";
import {
  effectiveProviderDefault,
  isProviderEligibleForUser,
  providerCredentialEligibilitySql,
  type ProviderEligibilityRow,
} from "../providers/eligibility.js";
import { contractRecord } from "../runs/contractSnapshot.js";
import type { RunRecord } from "../runs/runRepositoryTypes.js";
import type { Queryable } from "../routeUtils/common.js";
import { loadSystemActionRegistry } from "../systemActions/registry.js";
import { DeterministicRouteSelector, mergeRouteHints } from "./router.js";
import type { RouteCandidate, RouteHints } from "./types.js";

interface RuntimeCandidateRow extends ProviderEligibilityRow {
  agent_kind: string;
  runtime_profile_id: string;
  profile_name: string;
  adapter_type: string;
  execution_host_id: string | null;
  workspace_location_id: string | null;
  workspace_mode: "location" | "managed" | null;
  runtime_installation: string | null;
  model_provider_id: string | null;
  provider_type: string | null;
  provider_credential_type: string | null;
  model_name: string | null;
  credential_profile_id: string | null;
  credential_profile_owner_id: string | null;
  provider_is_default: boolean | null;
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

interface ConversationBindingSnapshot extends ProviderEligibilityRow {
  runtime_profile_id: string;
  model_name: string | null;
  model_provider_id: string | null;
  runtime_config_json: unknown;
  runtime_policy_json: unknown;
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
    const requiredCapabilities = await runtimeRequiredCapabilities(run.capabilities_json);
    const requestedCredentialProfileId = conversationCredentialProfileId(run.model_override_json);
    const rawCandidates = await this.listCandidates(
      run.space_id,
      run.agent_id,
      run.owner_user_id ?? null,
      requestedCredentialProfileId,
    );
    const override = record(run.model_override_json);
    const workspaceAccess = workspaceAccessFromOverride(override.workspace_access);
    const hostThread = record(override.host_thread);
    // The host_thread override is the discriminator, not the surface: a Room
    // turn and a direct chat both pin their run to a host thread, while
    // execution_mode differs per surface (room_conversation.v1 vs the chat
    // path's conversation_lightweight.v1). Keying on the mode filtered every
    // host-bound candidate out of a direct chat, which then failed routing
    // with an empty candidate set.
    const hostBoundRun = hostThread.schema_version === "host_thread.v1";
    const pinnedHostThread = hostBoundRun
      ? (await this.db.query<{
          execution_host_id: string;
          workspace_mode: "location" | "managed";
          workspace_location_id: string | null;
          adapter_type: string;
          runtime_installation: string;
          status: "active" | "session_reset" | "closed";
          container_kind: "conversation" | "direct" | null;
          container_user_id: string | null;
          session_id: string | null;
        }>(
          `SELECT execution_host_id, workspace_mode, workspace_location_id,
                  adapter_type, runtime_installation, status,
                  container_kind, container_user_id, session_id
             FROM host_threads
            WHERE id = $1 AND space_id = $2
              AND (
                (container_kind = 'conversation' AND session_id = $3)
                OR (container_kind = 'direct' AND container_user_id = $4)
              )
            LIMIT 1`,
          [hostThread.thread_id, run.space_id, run.session_id, run.owner_user_id ?? run.instructed_by_user_id ?? null],
        )).rows[0] ?? null
      : null;
    if (hostBoundRun && (!pinnedHostThread || pinnedHostThread.status === "closed")) {
      throw new RouteSelectionError(
        "conversation_runtime_continuity_missing",
        "The Conversation runtime thread is unavailable; the Run cannot be dispatched.",
      );
    }
    const conversationSnapshot = hostBoundRun && pinnedHostThread?.container_kind === "conversation"
      ? (await this.db.query<ConversationBindingSnapshot>(
          `SELECT binding.runtime_profile_id,
                  binding.model_name_snapshot AS model_name,
                  binding.model_provider_id_snapshot AS model_provider_id,
                  binding.runtime_config_snapshot_json AS runtime_config_json,
                  binding.runtime_policy_snapshot_json AS runtime_policy_json,
                  conformance.status AS conformance_status,
                  conformance.suite_version AS conformance_suite_version,
                  provider.provider_type,
                  provider.enabled AS provider_enabled,
                  provider_grant.enabled AS provider_grant_enabled,
                  provider.owner_user_id AS provider_owner_user_id,
                  provider_credential.credential_type AS provider_credential_type,
                  ${providerCredentialEligibilitySql("provider.id", "provider.credential_id", "provider_credential")}
                    AS provider_has_eligible_credential
             FROM session_conversation_backends binding
             LEFT JOIN model_providers provider
               ON provider.id = binding.model_provider_id_snapshot
             LEFT JOIN model_provider_space_grants provider_grant
               ON provider_grant.provider_id = binding.model_provider_id_snapshot
              AND provider_grant.space_id = binding.space_id
             LEFT JOIN credentials provider_credential
               ON provider_credential.id = provider.credential_id
             JOIN host_threads thread
               ON thread.space_id = binding.space_id
              AND thread.session_id = binding.session_id
              AND thread.agent_id = binding.agent_id
              AND thread.container_kind = 'conversation'
              AND thread.status IN ('active', 'session_reset')
             LEFT JOIN runtime_conformance_results conformance
               ON conformance.runtime_adapter_type = thread.adapter_type
              AND conformance.runtime_version = COALESCE(binding.runtime_config_snapshot_json->>'runtime_tool_version', '')
            WHERE binding.space_id = $1
              AND binding.session_id = $2
              AND binding.agent_id = $3
              AND binding.runtime_profile_id = $4
            LIMIT 1`,
          [run.space_id, run.session_id, run.agent_id, run.requested_runtime_profile_id],
        )).rows[0] ?? null
      : null;
    if (hostBoundRun && pinnedHostThread?.container_kind === "conversation" && !conversationSnapshot) {
      throw new RouteSelectionError(
        "conversation_runtime_snapshot_missing",
        "The pinned Conversation runtime snapshot is unavailable; the Run cannot be dispatched.",
      );
    }
    if (conversationSnapshot?.model_provider_id && !isProviderEligibleForUser(
      conversationSnapshot,
      run.owner_user_id ?? run.instructed_by_user_id ?? null,
    )) {
      throw new RouteSelectionError(
        "conversation_model_provider_unavailable",
        "The pinned Conversation model provider is unavailable; the Run cannot be dispatched.",
      );
    }
    const allCandidates = conversationSnapshot
      ? rawCandidates.map((candidate) => candidate.runtime_profile_id === conversationSnapshot.runtime_profile_id
          ? applyConversationSnapshot(candidate, conversationSnapshot)
          : candidate)
      : rawCandidates;
    const candidates = allCandidates.filter((candidate) => hostBoundRun
      ? candidate.host_bound === true
        && candidate.execution_host_id === pinnedHostThread!.execution_host_id
        && candidate.workspace_mode === pinnedHostThread!.workspace_mode
        && candidate.workspace_location_id === pinnedHostThread!.workspace_location_id
      : candidate.host_bound !== true);
    const attemptNumber = await this.currentAttemptNumber(run);
    const retryRoute = attemptNumber > 1 ? await this.retryRouteContext(run, attemptNumber) : null;
    const decision = this.selector.select({
      runtime_profile_id: run.requested_runtime_profile_id ?? null,
      runtime_profile_is_explicit: run.runtime_profile_selection_source === "explicit",
      excluded_runtime_profile_ids: retryRoute?.excludedProfileIds,
      fallback_runtime_profile_ids: retryRoute?.fallbackProfileIds,
      required_capabilities: requiredCapabilities,
      required_tools: [],
      required_sandbox_level: routeSandboxLevel(run.required_sandbox_level),
      execution_mode: run.mode === "dry_run" ? "dry_run" : "live",
      risk_level: riskLevel(contractRecord(run.contract_snapshot_json).risk_level),
      workspace_available: Boolean(run.project_folder_id || allCandidates.some((candidate) => candidate.host_bound)),
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
          pinnedHostThread?.adapter_type ?? selected?.adapter_type ?? null,
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
    if (hostBoundRun && pinnedHostThread && (
      selected.runtime_profile_id !== run.requested_runtime_profile_id
      || selected.execution_host_id !== pinnedHostThread.execution_host_id
      || selected.workspace_mode !== pinnedHostThread.workspace_mode
      || selected.workspace_location_id !== pinnedHostThread.workspace_location_id
      || selected.adapter_type !== pinnedHostThread.adapter_type
      || selected.runtime_installation !== pinnedHostThread.runtime_installation
    )) {
      throw new RouteSelectionError(
        "conversation_runtime_profile_changed",
        "The pinned Conversation CLI runtime is no longer available; start a new Conversation to change it.",
      );
    }
    const selectedAdapterType = pinnedHostThread?.adapter_type ?? selected.adapter_type;
    const selectedExecutionHostId = pinnedHostThread?.execution_host_id ?? selected.execution_host_id;
    const selectedWorkspaceLocationId = pinnedHostThread?.workspace_location_id ?? selected.workspace_location_id;
    const selectedWorkspaceMode = pinnedHostThread?.workspace_mode ?? selected.workspace_mode;
    const selectedRuntimeInstallation = pinnedHostThread?.runtime_installation ?? selected.runtime_installation;

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
                 run_type, status, mode, prompt, instruction,
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
        selectedAdapterType,
        selected.model_provider_id,
        JSON.stringify(modelOverride),
        JSON.stringify({
          id: selected.runtime_profile_id,
          name: selected.profile_name,
          adapter_type: selectedAdapterType,
          model_provider_id: selected.model_provider_id,
          model_name: selected.model_name,
          execution_host_id: selectedExecutionHostId,
          workspace_location_id: selectedWorkspaceLocationId,
          workspace_mode: selectedWorkspaceMode,
          runtime_installation: selectedRuntimeInstallation,
          credential_profile_id: selected.credential_profile_id,
          runtime_config_json: {
            ...selected.runtime_config_json,
            ...(selected.credential_profile_id
              ? { credential_profile_id: selected.credential_profile_id }
              : {}),
          },
          runtime_policy_json: selected.runtime_policy_json,
          ...(override.workspace ? { workspace: override.workspace } : {}),
          ...(workspaceAccess !== null ? { workspace_access: workspaceAccess } : {}),
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
      SELECT a.agent_kind,
             arp.id AS runtime_profile_id, arp.name AS profile_name,
              arp.adapter_type, arp.model_provider_id, arp.model_name,
              arp.execution_host_id, arp.workspace_location_id, arp.workspace_mode, arp.runtime_installation,
              cp.id AS credential_profile_id, cp.owner_user_id AS credential_profile_owner_id,
              mp.provider_type,
              mp.enabled AS provider_enabled,
              mpg.enabled AS provider_grant_enabled,
              mp.owner_user_id AS provider_owner_user_id,
              provider_credential.credential_type AS provider_credential_type,
              ${providerCredentialEligibilitySql("mp.id", "mp.credential_id", "provider_credential")}
                AS provider_has_eligible_credential,
              mpg.is_default AS provider_is_default,
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
         LEFT JOIN credentials provider_credential
           ON provider_credential.id = mp.credential_id
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
        ORDER BY CASE WHEN a.agent_kind = 'system_assistant'
                      THEN COALESCE(mpg.is_default, false)
                      ELSE false END DESC,
                 arp.is_default DESC, arp.created_at ASC, arp.id ASC`,
      [spaceId, agentId, ownerUserId, requestedCredentialProfileId],
    );
    const hasCliCandidates = result.rows.some((row) =>
      isLocalCliRuntimeAdapter(row.adapter_type) && !isHostBoundRuntime(row));
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
        ownerUserId,
        isHostBoundRuntime(row) ||
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
  userId: string | null,
  cliCredentialLoggedIn = true,
): RouteCandidate {
  const spec = getRuntimeAdapterSpec(row.adapter_type);
  const hostBound = isHostBoundRuntime(row);
  const runtimeConfig = record(row.runtime_config_json);
  const runtimePolicy = record(row.runtime_policy_json);
  const providerAvailable = row.model_provider_id !== null &&
    isProviderEligibleForUser(row, userId);
  const isDefault = row.agent_kind === "system_assistant"
    ? effectiveProviderDefault(row.provider_is_default, row.is_default)
    : row.is_default;
  const credentialAvailable = hostBound
    ? true
    : spec?.credentials.credential_mode === "none"
    ? true
    : isLocalCliRuntimeAdapter(row.adapter_type)
      ? spec?.credentials.credential_mode === "cli_profile_or_model_provider"
        ? Boolean(
            (cliCredentialLoggedIn && row.credential_profile_id && row.credential_profile_owner_id) ||
            providerAvailable,
          )
        : Boolean(cliCredentialLoggedIn && row.credential_profile_id && row.credential_profile_owner_id)
      : providerAvailable;
  return {
    runtime_profile_id: row.runtime_profile_id,
    profile_name: row.profile_name,
    adapter_type: row.adapter_type,
    host_bound: hostBound,
    workspace_location_id: row.workspace_location_id,
    execution_host_id: row.execution_host_id,
    workspace_mode: row.workspace_mode,
    runtime_installation: row.runtime_installation,
    model_provider_id: row.model_provider_id,
    model_name: row.model_name,
    credential_profile_id: row.credential_profile_id,
    runtime_config_json: runtimeConfig,
    runtime_policy_json: runtimePolicy,
    enabled: row.enabled && spec?.implementation_status === "implemented",
    is_default: isDefault,
    credential_available: credentialAvailable,
    capabilities: stringArray(row.capabilities_json),
    tools: stringArray(runtimeConfig.tools ?? runtimeConfig.tool_ids ?? runtimePolicy.tools),
    minimum_sandbox_level: sandboxLevel(spec?.sandbox.minimum_sandbox_level),
    requires_file_access: Boolean(spec?.sandbox.requires_file_access),
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

function isHostBoundRuntime(row: Pick<RuntimeCandidateRow, "execution_host_id" | "workspace_mode" | "runtime_installation">): boolean {
  return Boolean(row.execution_host_id && row.workspace_mode && row.runtime_installation);
}

function applyConversationSnapshot(
  candidate: RouteCandidate,
  snapshot: ConversationBindingSnapshot,
): RouteCandidate {
  const runtimeConfig = record(snapshot.runtime_config_json);
  const runtimePolicy = record(snapshot.runtime_policy_json);
  const rawSnapshotCapabilities = runtimeConfig.capabilities ?? runtimePolicy.capabilities;
  const hasSnapshotCapabilities = Array.isArray(rawSnapshotCapabilities);
  const spec = getRuntimeAdapterSpec(candidate.adapter_type);
  return {
    ...candidate,
    model_name: snapshot.model_name,
    model_provider_id: snapshot.model_provider_id,
    runtime_config_json: runtimeConfig,
    runtime_policy_json: runtimePolicy,
    capabilities: hasSnapshotCapabilities ? stringArray(rawSnapshotCapabilities) : candidate.capabilities,
    tools: stringArray(runtimeConfig.tools ?? runtimeConfig.tool_ids ?? runtimePolicy.tools),
    supports_live: runtimeConfig.supports_live !== false,
    supports_dry_run: runtimeConfig.supports_dry_run !== false,
    effective_trust_level: effectiveTrustLevel(spec, snapshot.conformance_status),
    conformance_status: snapshot.conformance_status,
    conformance_suite_version: snapshot.conformance_suite_version,
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

function workspaceAccessFromOverride(
  value: unknown,
): Array<{ workspace_location_id: string; access_mode: "read" | "write" }> | null {
  const hasValue = value !== undefined;
  if (!hasValue) return null;
  if (!Array.isArray(value)) {
    throw new RouteSelectionError(
      "conversation_workspace_access_invalid",
      "The Conversation workspace access snapshot is invalid; refusing to route the Run.",
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RouteSelectionError(
        "conversation_workspace_access_invalid",
        `The Conversation workspace access entry ${index} is invalid; refusing to route the Run.`,
      );
    }
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.workspace_location_id === "string"
      ? candidate.workspace_location_id.trim()
      : "";
    const accessMode = candidate.access_mode;
    if (!id || (accessMode !== "read" && accessMode !== "write") || seen.has(id)) {
      throw new RouteSelectionError(
        "conversation_workspace_access_invalid",
        `The Conversation workspace access entry ${index} is invalid; refusing to route the Run.`,
      );
    }
    seen.add(id);
    return { workspace_location_id: id, access_mode: accessMode };
  });
}
export async function runtimeRequiredCapabilities(value: unknown): Promise<string[]> {
  const declared = stringArray(value);
  if (declared.length === 0) return declared;
  const systemActions = await loadSystemActionRegistry();
  const systemActionIds = new Set<string>(systemActions.keys());
  // `runs.capabilities_json` currently carries both runtime capabilities and
  // server-owned System Action declarations. System Actions execute through
  // SystemActionDispatcher and are authorized by `permission_snapshot_json`;
  // they are not capabilities that a runtime profile must duplicate. Keeping
  // them in the runtime hard filter makes a Room's own tool allowance reject
  // every otherwise-valid candidate before the conversation can start.
  return declared.filter((capability) => !systemActionIds.has(capability));
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
