/**
 * Setup authorizations: the standing authorization a person gives when they
 * set something up, which lets later work with nobody present spend a
 * ModelProvider key without a second approval.
 *
 * Two shapes carry one. A Run its owning product creates stamps a
 * `ManagedExecutionKind` in its immutable contract. A helper call made by an
 * unattended job names a `CredentialSetupKind`, and `authorizeCredentialSpend`
 * re-reads the record behind it at spend time. Either way the credential rule
 * allows the spend only from the one trigger origin the kind is registered
 * with, so a kind claimed from any other origin authorizes nothing. This module
 * is also the single place that defines the failure disposition for managed
 * Runs.
 */

export type ManagedExecutionKind = "source_post_processing" | "source_annotation" | "project_research";
export type CredentialSetupKind =
  | "source_post_processing"
  | "daily_report"
  | "imported_session_extraction"
  | "inquiry_advice"
  | "room_summary"
  | "context_checkpoint"
  | "conversation_title"
  | "retrieval_embedding"
  | "research_pipeline";
export type ManagedExecutionFailurePolicy = "fail_fast";

/** The one trigger origin each kind's authorization covers. */
const PRE_AUTHORIZED_ORIGIN: Readonly<Record<ManagedExecutionKind | CredentialSetupKind, "job" | "system">> = {
  source_post_processing: "job",
  source_annotation: "job",
  project_research: "system",
  daily_report: "job",
  imported_session_extraction: "job",
  inquiry_advice: "job",
  room_summary: "job",
  context_checkpoint: "job",
  conversation_title: "job",
  retrieval_embedding: "job",
  research_pipeline: "job",
};

export interface ManagedExecutionPolicyContext {
  managed_execution: ManagedExecutionKind;
  credential_pre_authorized: boolean;
  failure_policy: ManagedExecutionFailurePolicy;
}

export interface ManagedRunPolicyInput {
  trigger_origin: string;
  contract_snapshot_json?: unknown;
}

export function createManagedExecutionPolicy(
  managedExecution: ManagedExecutionKind,
  credentialPreAuthorized: boolean,
): ManagedExecutionPolicyContext {
  return {
    managed_execution: managedExecution,
    credential_pre_authorized: credentialPreAuthorized,
    failure_policy: "fail_fast",
  };
}

export function readManagedExecutionPolicy(value: unknown): ManagedExecutionPolicyContext | null {
  if (!isRecord(value)) return null;
  const managedExecution = value.managed_execution;
  const failurePolicy = value.failure_policy;
  if (!isManagedExecutionKind(managedExecution) || failurePolicy !== "fail_fast") return null;
  return {
    managed_execution: managedExecution,
    credential_pre_authorized: value.credential_pre_authorized === true,
    failure_policy: "fail_fast",
  };
}

export function managedExecutionPolicyFromContract(
  contractSnapshot: unknown,
): ManagedExecutionPolicyContext | null {
  if (!isRecord(contractSnapshot)) return null;
  return readManagedExecutionPolicy(contractSnapshot.policy_context_json);
}

/**
 * Whether a setup authorization covers this spend. The context is the flat
 * decision context: a Run's contract metadata or a helper's setup context.
 */
export function allowsManagedCredentialUse(
  triggerOrigin: string,
  context: unknown,
): boolean {
  if (!isRecord(context) || context.credential_pre_authorized !== true) return false;
  const kind = context.managed_execution;
  return isPreAuthorizableKind(kind) && PRE_AUTHORIZED_ORIGIN[kind] === triggerOrigin;
}

/** The decision context for a helper spend, from its setup re-read just now. */
export function credentialSetupContext(
  kind: CredentialSetupKind,
  stillAuthorized: boolean,
): Record<string, unknown> {
  return { managed_execution: kind, credential_pre_authorized: stillAuthorized };
}

export function isManagedFailFastRun(input: ManagedRunPolicyInput): boolean {
  const policy = managedExecutionPolicyFromContract(input.contract_snapshot_json);
  if (!policy) return false;
  return (
    (input.trigger_origin === "job" && policy.managed_execution === "source_post_processing")
    || (input.trigger_origin === "system" && policy.managed_execution === "project_research")
  );
}

export function credentialPolicyMetadata(
  context: ManagedExecutionPolicyContext | null,
): Record<string, unknown> {
  if (!context) return {};
  return {
    managed_execution: context.managed_execution,
    credential_pre_authorized: context.credential_pre_authorized,
    failure_policy: context.failure_policy,
  };
}

function isManagedExecutionKind(value: unknown): value is ManagedExecutionKind {
  return value === "source_post_processing" || value === "source_annotation" || value === "project_research";
}

function isPreAuthorizableKind(value: unknown): value is ManagedExecutionKind | CredentialSetupKind {
  return typeof value === "string" && Object.hasOwn(PRE_AUTHORIZED_ORIGIN, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
