import { RunResourceWaitCodeSchema, type RunResourceWaitCode } from "@rainver/protocol";
import { sharedHostConnectionRegistry } from "../hosts/connectionRegistry.js";

/** The same transient directory/host admission fact consumed by the Turn reader. */
export function attentionWorkspaceWait(runId: string): boolean {
  return sharedHostConnectionRegistry.isWaitingForWorkspace(runId);
}
/** Structured Run/Room markers only. No output text enters the projection. */
export function attentionResourceWait(input: {
  status: string; workspace: boolean; quota: boolean; turn: boolean; scope: string | null;
}): RunResourceWaitCode | null {
  if (input.workspace) return "workspace";
  if (input.status === "queued" && input.quota) return "waiting_for_quota";
  if (input.status === "queued" && input.turn) return "waiting_for_turn";
  if (input.status === "waiting_for_dependency") {
    const scope = RunResourceWaitCodeSchema.safeParse(input.scope);
    return scope.success ? scope.data : "waiting_for_dependency";
  }
  return input.status === "queued" ? "queued" : null;
}
