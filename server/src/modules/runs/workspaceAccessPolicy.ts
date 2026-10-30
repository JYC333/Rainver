import { dispatchesToHostDaemon } from "./runRemoteness.js";

/** Shared admission/execution check. Host changes after admission still fail closed. */
export function readOnlyWorkspaceHostRefusal(access: "read" | "write", runtimeKey: string | null | undefined, hostKind: string | null | undefined): string | null {
  if (access !== "read" || !dispatchesToHostDaemon(runtimeKey) || hostKind === "server") return null;
  return "This Conversation is pinned to a Host that cannot enforce a read-only workspace. Start a Conversation on the server Host with the intended workspace available there, then delegate the review again. Do not retry as writable or move workspace files automatically.";
}
