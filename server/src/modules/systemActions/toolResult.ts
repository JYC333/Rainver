/**
 * Result returned by an authorized System Action to an ACP runtime tool call.
 * Provider/model iteration belongs to the external runtime; a dispatch returns
 * one bounded result and never suspends or drives another loop in the Server.
 */
export interface SystemActionDispatchResult {
  modelResult: unknown;
  summary: Record<string, unknown>;
  artifact?: unknown;
}
