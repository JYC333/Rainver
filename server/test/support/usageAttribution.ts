import type { UsageAttribution, UsageObservation } from "../../src/modules/usage";

export async function resolveTestUsageAttribution(
  input: UsageObservation,
): Promise<UsageAttribution> {
  return {
    owner_user_id: input.subject_user_id ?? "user-1",
    visibility: "private",
    access_level: "full",
    source_resource_type: input.source_resource_type ?? (input.run_id ? "run" : null),
    source_resource_id: input.source_resource_id ?? input.run_id ?? null,
    project_folder_id: null,
    project_id: null,
    grant_snapshots: [],
  };
}
