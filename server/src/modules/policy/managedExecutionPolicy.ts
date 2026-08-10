/**
 * Policy facts for server-managed executions.
 *
 * These facts are captured by trusted run creators in the immutable run
 * contract. They are deliberately narrow: a managed execution may avoid a
 * second credential approval only when its owning product has already
 * recorded the user's setup authorization. This module is also the single
 * place that defines the failure disposition for those executions.
 */

export type ManagedExecutionKind = "source_post_processing" | "source_annotation" | "project_research";
export type ManagedExecutionFailurePolicy = "fail_fast";

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

export function allowsManagedCredentialUse(
  triggerOrigin: string,
  context: unknown,
): boolean {
  const policy = readManagedExecutionPolicy(context);
  if (!policy?.credential_pre_authorized) return false;
  return (
    (triggerOrigin === "job" && policy.managed_execution === "source_post_processing")
    || (triggerOrigin === "system" && policy.managed_execution === "project_research")
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
