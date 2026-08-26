import { HttpError, objectValue } from "../routeUtils/common.js";

/**
 * Research execution is intentionally narrower than the general runtime API.
 * The managed provider/model selection lives under `execution`; runtime and
 * credential fields remain invalid at both the public and nested boundaries.
 */
export function rejectLegacyResearchRuntimeFields(body: Record<string, unknown>): void {
  const execution = objectValue(body.execution);
  const legacyTopLevel = [
    "adapter_type",
    "credential_profile_id",
    "agent_id",
    "runtime_profile_id",
    "model_provider_id",
    "model_name",
  ];
  const legacyExecution = [
    "adapter_type",
    "credential_profile_id",
    "agent_id",
    "runtime_profile_id",
  ];
  if (
    legacyTopLevel.some((key) => Object.hasOwn(body, key)) ||
    legacyExecution.some((key) => Object.hasOwn(execution, key))
  ) {
    throw new HttpError(422, "Auto Research accepts only a managed Model Provider and optional model");
  }
}
