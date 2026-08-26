import type { ProviderFailureClass } from "../invocation/resilience.js";
import type { UsageAttribution, UsageObservation } from "../../usage/index.js";

export type RotationStrategy = "fill_first" | "round_robin" | "least_used" | "random";

export class ProviderCommandValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "ProviderCommandValidationError";
  }
}

export class ProviderCommandNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = "ProviderCommandNotFoundError";
  }
}

export class ProviderCommandForbiddenError extends Error {
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = "ProviderCommandForbiddenError";
  }
}

export interface ModelProviderCreateInput {
  name: string;
  provider_type: string;
  base_url: string;
  network_profile_id?: string | null;
  claude_compatible_base_url?: string | null;
  openai_compatible_base_url?: string | null;
  api_key?: string | null;
  default_model?: string | null;
  available_models?: string[];
  enabled?: boolean;
  is_default?: boolean;
}

export interface ModelProviderUpdateInput {
  name?: string;
  provider_type?: string;
  base_url?: string | null;
  network_profile_id?: string | null;
  claude_compatible_base_url?: string | null;
  openai_compatible_base_url?: string | null;
  api_key?: string | null;
  default_model?: string | null;
  available_models?: string[];
  enabled?: boolean;
  is_default?: boolean;
}

export interface ProviderInfo {
  id: string;
  space_id: string;
  owner_user_id?: string | null;
  name: string;
  provider_type: string;
  base_url: string | null;
  network_profile_id: string | null;
  claude_compatible_base_url?: string | null;
  openai_compatible_base_url?: string | null;
  default_model: string | null;
  available_models: string[];
  enabled: boolean;
  is_default: boolean;
}

export interface PoolKeyCandidate {
  member_id: string | null;
  credential_id: string | null;
  api_key: string | null;
  credential_kind?: "api_key" | "subscription_oauth" | "none";
}

export interface InvocationTarget {
  provider: ProviderInfo;
  network_profile: import("../../networkProfiles/index.js").ResolvedNetworkProfile | null;
  rotation_strategy: RotationStrategy;
  fallback_provider_ids: string[];
  candidates: PoolKeyCandidate[];
}

export type PoolOutcome =
  | { kind: "success" }
  | { kind: "failure"; failure_class: ProviderFailureClass; cooldown_seconds?: number; unhealthy?: boolean };

export interface ProviderPoolCredentialAddInput {
  api_key: string;
  name?: string;
  position?: number;
}

export interface ProviderPoolConfigUpdateInput {
  rotation_strategy?: RotationStrategy;
  fallback_provider_ids?: string[];
}

export interface ProviderTaskChainEntry {
  provider_id: string;
  model?: string | null;
}

export interface ProviderTaskAttemptRefs {
  invocation_id: string;
  control_id: string;
  delivery_id: string;
  invocation_snapshot_id: string;
  usage_source_id: string;
  attempt: number;
}

export interface ProviderTaskAttemptStart {
  space_id: string;
  task: string;
  owner_domain: string;
  provider_id: string;
  model: string | null;
  input_fingerprint: string;
  metering: UsageObservation;
}

export interface ProviderSpaceGrantInput {
  space_id: string;
  enabled?: boolean;
  is_default?: boolean;
  network_profile_id?: string | null;
}

export interface CliCredentialAuditInput {
  space_id: string;
  run_id?: string | null;
  runtime_adapter_type?: string | null;
  credential_profile_id?: string | null;
  trigger_origin?: string | null;
  fallback_used?: boolean;
  fallback_reason?: string | null;
  broker_error?: boolean;
  cleanup_status?: string;
  action?: string;
}

export interface ProviderCommandStore {
  createProvider(spaceId: string, userId: string, input: ModelProviderCreateInput): Promise<unknown>;
  updateProvider(
    spaceId: string,
    userId: string,
    providerId: string,
    input: ModelProviderUpdateInput,
  ): Promise<unknown>;
  deleteProvider(spaceId: string, userId: string, providerId: string): Promise<void>;
  grantProviderToSpace(
    activeSpaceId: string,
    userId: string,
    providerId: string,
    input: ProviderSpaceGrantInput,
  ): Promise<unknown>;
  revokeProviderGrant(
    activeSpaceId: string,
    userId: string,
    providerId: string,
    grantSpaceId: string,
  ): Promise<void>;
  getInvocationTarget(
    spaceId: string,
    providerId?: string | null,
    subjectUserId?: string | null,
  ): Promise<InvocationTarget>;
  recordPoolOutcome(memberId: string, outcome: PoolOutcome): Promise<void>;
  resolveUsageAttribution(input: UsageObservation): Promise<UsageAttribution>;
  recordUsageObservation(input: UsageObservation, attribution: UsageAttribution): Promise<void>;
  beginProviderTaskAttempt?(input: ProviderTaskAttemptStart): Promise<ProviderTaskAttemptRefs>;
  completeProviderTaskAttempt?(
    refs: ProviderTaskAttemptRefs,
    result: { status: "accepted" | "failed"; error_code?: string | null },
  ): Promise<void>;
  resolveProviderApiKey(spaceId: string, providerId: string): Promise<string>;
  resolveCredentialApiKey(spaceId: string, credentialId: string): Promise<string>;
  listConfiguredModels(spaceId: string, providerId: string): Promise<string[]>;
  recordCliCredentialUsage(input: CliCredentialAuditInput): Promise<string>;
  listPool(spaceId: string, providerId: string): Promise<unknown>;
  addPoolCredential(
    spaceId: string,
    userId: string,
    providerId: string,
    input: ProviderPoolCredentialAddInput,
  ): Promise<unknown>;
  removePoolCredential(
    spaceId: string,
    userId: string,
    providerId: string,
    memberId: string,
  ): Promise<void>;
  updatePoolConfig(
    spaceId: string,
    userId: string,
    providerId: string,
    input: ProviderPoolConfigUpdateInput,
  ): Promise<unknown>;
  getTaskChain(spaceId: string, task: string): Promise<ProviderTaskChainEntry[] | null>;
  listTaskPolicies(spaceId: string): Promise<unknown[]>;
  putTaskPolicy(
    spaceId: string,
    userId: string,
    task: string,
    chain: ProviderTaskChainEntry[],
    enabled?: boolean,
  ): Promise<unknown>;
  deleteTaskPolicy(spaceId: string, userId: string, task: string): Promise<void>;
}
