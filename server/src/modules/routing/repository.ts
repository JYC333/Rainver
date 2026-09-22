import { randomUUID } from "node:crypto";
import { stripSecretFields, type JsonValue } from "@rainver/protocol";
import { getRuntimeAdapterSpec, isLocalCliRuntimeAdapter, isRunnableAgentRuntime } from "../runtimeAdapters/index.js";
import {
  effectiveProviderDefault,
  isProviderEligibleForUser,
  providerCredentialEligibilitySql,
  type ProviderEligibilityRow,
} from "../providers/eligibility.js";
import { contractRecord } from "../runs/contractSnapshot.js";
import type { AgentRunRecord, RunRecord } from "../runs/runRepositoryTypes.js";
import type { Queryable } from "../routeUtils/common.js";
import { loadSystemActionRegistry } from "../systemActions/registry.js";
import { normalizeHostCapabilities } from "../hosts/capabilities.js";
import { projectRunRuntimeProfileSnapshot } from "../sessions/runtimeProfileSnapshot.js";
import { candidateForPersistedDecision, DeterministicRouteSelector, mergeRouteHints } from "./router.js";
import type { RouteCandidate, RouteHints } from "./types.js";

interface RuntimeCandidateRow extends ProviderEligibilityRow {
  agent_kind: string;
  runtime_profile_id: string;
  profile_name: string;
  runtime_key: string;
  execution_host_id: string | null;
  execution_host_kind: string | null;
  execution_host_owner_user_id: string | null;
  host_capabilities_json: unknown;
  workspace_location_id: string | null;
  workspace_mode: "location" | "managed" | null;
  runtime_installation: string | null;
  backend_mode: "runtime_native" | "model_provider";
  model_provider_id: string | null;
  provider_type: string | null;
  provider_credential_type: string | null;
  model_name: string | null;
  provider_is_default: boolean | null;
  enabled: boolean;
  is_default: boolean;
  runtime_config_json: unknown;
  runtime_policy_json: unknown;
  capabilities_json: unknown;
  estimated_cost_usd: number | string | null;
  estimated_latency_ms: number | string | null;
  historical_verification_pass_rate: number | string | null;
}

interface ConversationBindingSnapshot extends ProviderEligibilityRow {
  runtime_profile_id: string;
  backend_mode: "runtime_native" | "model_provider";
  model_name: string | null;
  model_provider_id: string | null;
  runtime_config_json: unknown;
  runtime_policy_json: unknown;
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
  ) {}

  async routeRun(run: AgentRunRecord): Promise<AgentRunRecord> {
    const hints = routeHintsForRun(run);
    const requiredCapabilities = await runtimeRequiredCapabilities(run.capabilities_json);
    const rawCandidates = await this.listCandidates(
      run.space_id,
      run.agent_id,
      run.owner_user_id ?? null,
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
    // Conversation-bound Room Runs also retain the generic thread FK for
    // continuity/event projection. The host_thread override identifies that
    // shared Conversation thread; only a Run without that host-bound pin is
    // required to reference a Task-owned thread here.
    const taskThreadRun = !hostBoundRun && Boolean(run.host_task_thread_id);
    const pinnedHostThread = hostBoundRun || taskThreadRun
      ? (await this.db.query<{
          execution_host_id: string;
          workspace_mode: "location" | "managed";
          workspace_location_id: string | null;
          runtime_key: string;
          runtime_installation: string;
          status: "active" | "session_reset" | "closed";
          container_kind: "conversation" | "direct" | null;
          container_user_id: string | null;
          session_id: string | null;
          task_id: string | null;
        }>(
          `SELECT execution_host_id, workspace_mode, workspace_location_id,
                  runtime_key, runtime_installation, status,
                  container_kind, container_user_id, session_id, task_id
             FROM host_threads
            WHERE id = $1
              AND (
                (task_id IS NULL AND space_id = $2 AND (
                  (container_kind = 'conversation' AND session_id = $3)
                  OR (container_kind = 'direct' AND container_user_id = $4)
                ))
                OR (task_id IS NOT NULL AND EXISTS (
                  SELECT 1
                    FROM task_runs task_run
                    JOIN tasks task ON task.id = task_run.task_id
                   WHERE task_run.run_id = $5
                     AND task_run.task_id = host_threads.task_id
                     AND task.space_id = $2
                ))
              )
            LIMIT 1`,
          [run.host_task_thread_id ?? hostThread.thread_id, run.space_id, run.session_id,
            run.owner_user_id ?? run.instructed_by_user_id ?? null, run.id],
        )).rows[0] ?? null
      : null;
    const pinnedThreadUnavailable = !pinnedHostThread || pinnedHostThread.status === "closed";
    if ((hostBoundRun || taskThreadRun) && pinnedThreadUnavailable) {
      throw new RouteSelectionError(
        taskThreadRun ? "task_runtime_thread_unavailable" : "conversation_runtime_continuity_missing",
        taskThreadRun
          ? "The Task runtime thread is unavailable; the Run cannot be dispatched."
          : "The Conversation runtime thread is unavailable; the Run cannot be dispatched.",
      );
    }
    const conversationSnapshot = hostBoundRun && pinnedHostThread?.container_kind === "conversation"
      ? (await this.db.query<ConversationBindingSnapshot>(
          `SELECT binding.runtime_profile_id,
                  binding.backend_mode_snapshot AS backend_mode,
                  binding.model_name_snapshot AS model_name,
                  binding.model_provider_id_snapshot AS model_provider_id,
                  binding.runtime_config_snapshot_json AS runtime_config_json,
                  binding.runtime_policy_snapshot_json AS runtime_policy_json,
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
          ? applyConversationSnapshot(
              candidate,
              conversationSnapshot,
              run.owner_user_id ?? run.instructed_by_user_id ?? null,
            )
          : candidate)
      : rawCandidates;
    if (taskThreadRun && (
      !pinnedHostThread?.task_id
      || pinnedHostThread.workspace_location_id !== run.workspace_location_id
    )) {
      throw new RouteSelectionError(
        "task_runtime_location_mismatch",
        "The Task Run Workspace Location does not match its pinned runtime thread.",
      );
    }
    // An unpinned Run needs a complete execution target, not the Server Host
    // specifically: the ACP runtime-authority cutover only removed the
    // Conversation HostThread from that path. A Profile whose deployment
    // authority names a paired Host stays admissible, and
    // `host_dispatch_permitted` — not this filter — decides whether the
    // responsible user may dispatch there, so the refusal appears in the
    // persisted decision instead of an empty candidate set.
    const candidates = allCandidates.filter((candidate) => pinnedHostThread
      ? candidate.host_bound === true
        && candidate.execution_host_id === pinnedHostThread!.execution_host_id
        && candidate.workspace_mode === pinnedHostThread!.workspace_mode
        && candidate.workspace_location_id === pinnedHostThread!.workspace_location_id
      : candidate.host_bound === true);
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
      workspace_available: Boolean(run.project_folder_id || candidates.some((candidate) => candidate.host_bound)),
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
      selected = candidateForPersistedDecision(decision, existing.rows[0].selected_runtime_profile_id ?? "");
      if (!selected) {
        throw new RouteSelectionError("route_selected_profile_unavailable", "The persisted route profile is no longer available.");
      }
    } else {
      persistedDecisionId = randomUUID();
      await this.db.query(
        `INSERT INTO route_decisions (
           id, space_id, run_id, attempt_number, status,
           selected_runtime_profile_id, selected_runtime_key, selected_model_provider_id,
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
          pinnedHostThread?.runtime_key ?? selected?.runtime_key ?? null,
          selected?.model_provider_id ?? null,
          decision.reason,
          JSON.stringify(hints),
          JSON.stringify(decision.candidates.map((item) => ({
            runtime_profile_id: item.candidate.runtime_profile_id,
            runtime_key: item.candidate.runtime_key,
            model_provider_id: item.candidate.model_provider_id,
            baseline_trust_level: item.candidate.baseline_trust_level,
            effective_trust_level: item.candidate.effective_trust_level,
            score: item.score,
            score_trace: item.score_trace,
          }))),
          JSON.stringify(decision.rejected.map((item) => {
            const candidate = candidates.find((value) => value.runtime_profile_id === item.runtime_profile_id);
            return {
              ...item,
              baseline_trust_level: candidate?.baseline_trust_level ?? null,
              effective_trust_level: candidate?.effective_trust_level ?? null,
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
    if (pinnedHostThread && (
      selected.runtime_profile_id !== run.requested_runtime_profile_id
      || selected.execution_host_id !== pinnedHostThread.execution_host_id
      || selected.workspace_mode !== pinnedHostThread.workspace_mode
      || selected.workspace_location_id !== pinnedHostThread.workspace_location_id
      || selected.runtime_key !== pinnedHostThread.runtime_key
      || selected.runtime_installation !== pinnedHostThread.runtime_installation
    )) {
      throw new RouteSelectionError(
        taskThreadRun ? "task_runtime_profile_changed" : "conversation_runtime_profile_changed",
        taskThreadRun
          ? "The Task runtime Profile no longer matches its pinned thread; start a new thread to change it."
          : "The pinned Conversation runtime Profile is no longer available; start a new Conversation to change it.",
      );
    }
    const selectedRuntimeKey = pinnedHostThread?.runtime_key ?? selected.runtime_key;
    const selectedExecutionHostId = pinnedHostThread?.execution_host_id ?? selected.execution_host_id ?? null;
    const selectedWorkspaceLocationId = pinnedHostThread?.workspace_location_id ?? selected.workspace_location_id ?? null;
    const selectedWorkspaceMode = pinnedHostThread?.workspace_mode ?? selected.workspace_mode ?? null;
    const selectedRuntimeInstallation = pinnedHostThread?.runtime_installation ?? selected.runtime_installation ?? null;

    const modelOverride = {
      ...record(run.model_override_json),
      ...(selected.model_name ? { model: selected.model_name } : {}),
      route_decision_id: persistedDecisionId,
      route_source: "deterministic_policy",
    };
    const routed = await this.db.query<AgentRunRecord>(
      `UPDATE runs SET
         route_decision_id = $3,
         runtime_profile_id = $4,
         runtime_key = $5,
         model_provider_id = $6,
         model_override_json = $7::jsonb,
         runtime_profile_snapshot_json = $8::jsonb,
         updated_at = $9
       WHERE space_id = $1 AND id = $2 AND execution_kind = 'agent'
       RETURNING id, space_id, agent_id, agent_version_id, run_role,
                 requested_runtime_profile_id, runtime_profile_id,
                 execution_kind, runtime_key,
                 run_type, status, mode, prompt, instruction,
                 project_folder_id, workspace_location_id, trust_mode, host_task_thread_id,
                 session_id, parent_run_id, root_run_id, run_group_id,
                 delegation_id, project_id, scheduled_at, capability_id,
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
        selectedRuntimeKey,
        selected.model_provider_id,
        JSON.stringify(modelOverride),
        // One projection, so the Run snapshot and a Conversation's frozen
        // binding carry the same keys — `backend_mode` above all, which the
        // provider lease, the execution-control gate and Runtime Context
        // planning each branch on.
        JSON.stringify(projectRunRuntimeProfileSnapshot({
          id: selected.runtime_profile_id,
          name: selected.profile_name,
          runtime_key: selectedRuntimeKey,
          backend_mode: selected.backend_mode,
          model_provider_id: selected.model_provider_id,
          model_name: selected.model_name,
          execution_host_id: selectedExecutionHostId,
          workspace_location_id: selectedWorkspaceLocationId,
          workspace_mode: selectedWorkspaceMode,
          runtime_installation: selectedRuntimeInstallation,
          runtime_config_json: selected.runtime_config_json,
          runtime_policy_json: selected.runtime_policy_json,
          ...(override.workspace ? { workspace: override.workspace } : {}),
          ...(workspaceAccess !== null ? { workspace_access: workspaceAccess } : {}),
          is_default: selected.is_default,
        })),
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
         SELECT h.runtime_key,
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
          GROUP BY h.runtime_key
       )
      SELECT a.agent_kind,
             arp.id AS runtime_profile_id, arp.name AS profile_name,
              arp.runtime_key, arp.backend_mode, arp.model_provider_id, arp.model_name,
              arp.execution_host_id, arp.workspace_location_id, arp.workspace_mode, arp.runtime_installation,
              execution_host.kind AS execution_host_kind,
              execution_host.owner_user_id AS execution_host_owner_user_id,
              execution_host.capabilities_json AS host_capabilities_json,
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
              -- Capabilities are AgentVersion authority: a deployment Profile
              -- never declares what the Agent may be asked to do, and no
              -- production writer fills a Profile capability bag. Reading one
              -- made every Version-declared capability unroutable.
              CASE
                WHEN jsonb_typeof(av.capabilities_json) = 'array'
                  THEN av.capabilities_json
                ELSE '[]'::jsonb
              END AS capabilities_json,
              history.estimated_cost_usd,
              history.estimated_latency_ms, history.historical_verification_pass_rate
         FROM agent_runtime_profiles arp
         JOIN agents a
           ON a.id = arp.agent_id AND a.space_id = arp.space_id
         LEFT JOIN agent_versions av
           ON av.id = a.current_version_id
          AND av.space_id = a.space_id
          AND av.agent_id = a.id
         LEFT JOIN hosts execution_host ON execution_host.id = arp.execution_host_id
         LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
         LEFT JOIN model_provider_space_grants mpg
           ON mpg.provider_id = arp.model_provider_id
          AND mpg.space_id = arp.space_id
         LEFT JOIN credentials provider_credential
           ON provider_credential.id = mp.credential_id
         LEFT JOIN history ON history.runtime_key = arp.runtime_key
        WHERE arp.space_id = $1 AND arp.agent_id = $2
        ORDER BY CASE WHEN a.agent_kind = 'system_assistant'
                      THEN COALESCE(mpg.is_default, false)
                      ELSE false END DESC,
                 arp.is_default DESC, arp.created_at ASC, arp.id ASC`,
      [spaceId, agentId],
    );
    return result.rows.map((row) => candidateFromRow(row, ownerUserId));
  }

  async getDecision(spaceId: string, runId: string) {
    const result = await this.db.query(
      `SELECT id, space_id, run_id, attempt_number, status,
              selected_runtime_profile_id, selected_runtime_key,
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
): RouteCandidate {
  const runtimeKey = row.runtime_key;
  const spec = getRuntimeAdapterSpec(runtimeKey);
  const hostBound = isHostBoundRuntime(row);
  const hostInstallationReady = isRuntimeInstallationReady({
    execution_host_kind: row.execution_host_kind,
    host_capabilities_json: row.host_capabilities_json,
    runtime_key: runtimeKey,
    runtime_installation: row.runtime_installation,
  });
  const runtimeConfig = secretFreeRecord(row.runtime_config_json);
  const runtimePolicy = secretFreeRecord(row.runtime_policy_json);
  const providerAvailable = row.model_provider_id !== null &&
    isProviderEligibleForUser(row, userId);
  const isDefault = row.agent_kind === "system_assistant"
    ? effectiveProviderDefault(row.provider_is_default, row.is_default)
    : row.is_default;
  const credentialAvailable = backendCredentialAvailable({
    backendMode: row.backend_mode,
    providerAvailable,
    hostBound,
    runtimeKey,
  });
  // One ownership fact, two consumers: whether the responsible user may
  // dispatch to this Host, and — on a paired Host — whether this Run is the
  // owner's own and therefore carries the owner's trust in their machine.
  const hostDispatchPermitted = row.execution_host_kind === "server"
    || (row.execution_host_owner_user_id !== null && row.execution_host_owner_user_id === userId);
  return {
    runtime_profile_id: row.runtime_profile_id,
    profile_name: row.profile_name,
    runtime_key: runtimeKey,
    host_bound: hostBound,
    workspace_location_id: row.workspace_location_id,
    execution_host_id: row.execution_host_id,
    execution_host_kind: row.execution_host_kind,
    workspace_mode: row.workspace_mode,
    runtime_installation: row.runtime_installation,
    backend_mode: row.backend_mode === "model_provider" ? "model_provider" : "runtime_native",
    model_provider_id: row.model_provider_id,
    model_name: row.model_name,
    runtime_config_json: runtimeConfig,
    runtime_policy_json: runtimePolicy,
    enabled: row.enabled,
    runtime_runnable: isRunnableAgentRuntime(runtimeKey),
    installation_ready: hostInstallationReady,
    host_dispatch_permitted: hostDispatchPermitted,
    is_default: isDefault,
    credential_available: credentialAvailable,
    capabilities: stringArray(row.capabilities_json),
    tools: stringArray(runtimeConfig.tools ?? runtimeConfig.tool_ids),
    minimum_sandbox_level: sandboxLevel(spec?.sandbox.minimum_sandbox_level),
    requires_file_access: Boolean(spec?.sandbox.requires_file_access),
    requires_workspace_for_execution: Boolean(spec?.sandbox.requires_workspace_for_execution),
    supports_workspace: Boolean(spec?.sandbox.supports_worktree),
    supports_one_shot_docker: Boolean(spec?.sandbox.supports_one_shot_docker),
    supports_live: runtimeConfig.supports_live !== false,
    supports_dry_run: runtimeConfig.supports_dry_run !== false,
    baseline_trust_level: trustLevel(spec?.baseline_trust_level),
    effective_trust_level: effectiveTrustLevel(spec, row.execution_host_kind, hostDispatchPermitted),
    subagent_disable_mechanism: spec?.subagent_disable_mechanism ?? "unknown",
    estimated_cost_usd: numberOrNull(row.estimated_cost_usd),
    estimated_latency_ms: numberOrNull(row.estimated_latency_ms),
    historical_verification_pass_rate: numberOrNull(row.historical_verification_pass_rate),
  };
}

/**
 * Whether the execution Host reports a usable installed copy of the Profile's
 * runtime. Only the Server Runtime's copies are Rainver-managed and checked
 * here: a paired Host's installations are its owner's own, installed by an
 * explicit action rather than an asynchronous provisioner.
 *
 * Exported because Automation preflight must answer readiness exactly as
 * routing does — a preflight that reported `executable: true` for a Server
 * copy still installing produced a Run that died `route_no_candidate`.
 */
export function isRuntimeInstallationReady(target: {
  execution_host_kind: string | null;
  host_capabilities_json: unknown;
  runtime_key: string;
  runtime_installation: string | null;
}): boolean {
  if (target.execution_host_kind !== "server") return true;
  const installationId = target.runtime_installation;
  if (!installationId || installationId === "managed:pending") return false;
  try {
    const installation = normalizeHostCapabilities(target.host_capabilities_json).installations[target.runtime_key]
      ?.find((copy) => copy.id === installationId);
    return Boolean(installation && (installationId === "own" || installation.health_check_protocol === "acp"));
  } catch {
    return false;
  }
}

function isHostBoundRuntime(row: Pick<RuntimeCandidateRow, "execution_host_id" | "workspace_mode" | "runtime_installation">): boolean {
  return Boolean(row.execution_host_id && row.workspace_mode && row.runtime_installation);
}

/**
 * Which credential the Run will actually spend, from the backend mode that
 * decides it. A `model_provider` binding is always host-bound, so asking the
 * Host first would skip Provider eligibility entirely and leave a disabled
 * Provider or a withdrawn Space grant to surface at launch, after dispatch, as
 * `model_provider_not_found`. A `runtime_native` binding carries its own login
 * on the host; one that names no host has nowhere to run at all (ADR 0016,
 * B46). Shared with `applyConversationSnapshot` because a Conversation's frozen
 * backend mode has to answer this question the same way the Profile's does.
 */
function backendCredentialAvailable(input: {
  backendMode: "runtime_native" | "model_provider";
  providerAvailable: boolean;
  hostBound: boolean;
  runtimeKey: string;
}): boolean {
  if (input.backendMode === "model_provider") return input.providerAvailable;
  if (input.hostBound) return true;
  if (getRuntimeAdapterSpec(input.runtimeKey)?.credentials.credential_mode === "none") return true;
  return isLocalCliRuntimeAdapter(input.runtimeKey) ? false : input.providerAvailable;
}

function applyConversationSnapshot(
  candidate: RouteCandidate,
  snapshot: ConversationBindingSnapshot,
  userId: string | null,
): RouteCandidate {
  const runtimeConfig = secretFreeRecord(snapshot.runtime_config_json);
  const runtimePolicy = secretFreeRecord(snapshot.runtime_policy_json);
  const spec = getRuntimeAdapterSpec(candidate.runtime_key);
  // The column is a varchar the Profile's own CHECK shape is mirrored onto, so
  // an unrecognized mode is a corrupt binding, not a `runtime_native` one.
  // Coercing it here would have spent whichever credential the Profile still
  // named while claiming the Conversation's frozen deployment decided it.
  if (snapshot.backend_mode !== "model_provider" && snapshot.backend_mode !== "runtime_native") {
    throw new RouteSelectionError(
      "conversation_backend_mode_invalid",
      "The pinned Conversation backend mode is not a recognized mode; the Run cannot be dispatched.",
    );
  }
  return {
    ...candidate,
    // A Conversation freezes its deployment inputs, not the Agent's
    // capabilities: those stay AgentVersion authority for every Run.
    backend_mode: snapshot.backend_mode,
    model_name: snapshot.model_name,
    model_provider_id: snapshot.model_provider_id,
    // Recomputed from the snapshot, never inherited: the candidate's value
    // answered for the Profile's current backend mode and Provider, which is
    // exactly what the Conversation is pinned against.
    credential_available: backendCredentialAvailable({
      backendMode: snapshot.backend_mode,
      providerAvailable: snapshot.model_provider_id !== null
        && isProviderEligibleForUser(snapshot, userId),
      hostBound: candidate.host_bound === true,
      runtimeKey: candidate.runtime_key,
    }),
    runtime_config_json: runtimeConfig,
    runtime_policy_json: runtimePolicy,
    tools: stringArray(runtimeConfig.tools ?? runtimeConfig.tool_ids),
    supports_live: runtimeConfig.supports_live !== false,
    supports_dry_run: runtimeConfig.supports_dry_run !== false,
    // `host_dispatch_permitted` carries the ownership fact `candidateFromRow`
    // already computed for this same responsible user, so the pinned path
    // derives the same trust as the unpinned one instead of asking again.
    effective_trust_level: effectiveTrustLevel(
      spec,
      candidate.execution_host_kind ?? null,
      candidate.host_dispatch_permitted === true,
    ),
  };
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function secretFreeRecord(value: unknown): Record<string, unknown> {
  return stripSecretFields(record(value) as JsonValue) as Record<string, unknown>;
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
/**
 * Trust is based on controls the current dispatch actually enforces, and the
 * thing that enforces them is the execution target, not the runtime registry.
 * A registry declaration that a vendor supports a setting is not evidence that
 * this Run received it — the ACP Host-daemon path never applied the legacy
 * subagent-deny config — so a runtime's own declarations never raise it.
 *
 * What is enforced is the built-in strict Server Host: every Run it accepts
 * runs in a fresh rootless bubblewrap namespace built from an empty root and
 * an explicit bind allowlist (B62, ADR 0016 section 2). That containment is
 * the control behind its `medium`.
 *
 * A paired Host reaches `medium` for a different reason and only for its own
 * owner: it is that owner's machine, and a Run they are responsible for
 * carries the trust they already extend to it by running an agent there
 * themselves (ADR 0016 section 3 and its 2026-09-21 owner-trust amendment).
 * That is a statement about who bears the risk, not about containment — the
 * spawn is still native with no namespace (B62). A Run on that Host by anyone
 * else is not the owner's own and stays at the runtime's baseline, as does an
 * unbound Profile with no execution target at all. Nothing here reaches
 * `high`, so `high`/`critical`-risk Agents still have no candidate anywhere.
 */
function effectiveTrustLevel(
  spec: ReturnType<typeof getRuntimeAdapterSpec>,
  executionHostKind: string | null,
  hostDispatchPermitted: boolean,
): "low" | "medium" | "high" {
  const baseline = trustLevel(spec?.baseline_trust_level);
  if (baseline === "high") return "high";
  if (executionHostKind === "server") return "medium";
  if (executionHostKind === "remote" && hostDispatchPermitted) return "medium";
  return baseline;
}
function riskLevel(value: unknown): "low" | "medium" | "high" | "critical" { return value === "medium" || value === "high" || value === "critical" ? value : "low"; }
