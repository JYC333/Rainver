import { MODEL_CHANNEL_LOOPBACK_PORT } from "@rainver/protocol";
import { normalizeHostCapabilities } from "../hosts/capabilities.js";
import type { Queryable } from "../routeUtils/common.js";
import { projectBoundPin } from "../plugins/coreDataTools.js";

/**
 * Whether this dispatch launches the Run network-isolated with a model-only
 * channel (ADR 0030 §4a) — the one launch whose record lets sensitive plugin
 * data be released to it.
 *
 * Decided here from facts the control plane holds, never from a request,
 * plugin or Host claim:
 *
 * - the Run's own frozen snapshot pins at least one `sensitive` plugin tool
 *   (written by the server when the Run was created; a Run without one keeps
 *   its ordinary egress and nothing changes for it). A Project-bound core
 *   tool (ADR 0033 §6, Gmail) does not count: it runs on the conversation's
 *   own selected runtime;
 * - the Run is bound to a ModelProvider, so its model is reached through a
 *   lease this server issued and can revoke — a CLI's own vendor login has no
 *   such channel and stays on ordinary egress, where sensitive reads refuse;
 * - the Host is the built-in strict one (`hosts.kind = 'server'`), whose
 *   daemon applies the namespace; a paired Host never qualifies;
 * - that daemon reports `model_channel`; an older one is not sent the field
 *   and its Run keeps ordinary egress, so sensitive reads still refuse.
 *
 * When selected, egress is `none` whatever else the dispatch carried: the
 * sensitive Run's isolation narrows, never widens.
 */
export async function selectModelChannelLaunch(
  db: Queryable,
  hostId: string,
  run: { permission_snapshot_json?: unknown; contract_snapshot_json?: unknown },
  providerBound: boolean,
): Promise<{ loopback_port: number } | null> {
  if (!providerBound || !runPinsSensitivePluginTool(run)) return null;
  const host = (await db.query<{ kind: string; capabilities_json: unknown }>(
    "SELECT kind, capabilities_json FROM hosts WHERE id = $1 LIMIT 1",
    [hostId],
  )).rows[0];
  if (host?.kind !== "server" || normalizeHostCapabilities(host.capabilities_json).model_channel !== 1) return null;
  return { loopback_port: MODEL_CHANNEL_LOOPBACK_PORT };
}

/**
 * The Run continues a conversation an earlier Run read sensitive data in
 * (ADR 0032): that data is already in its context, so it launches isolated
 * or not at all (`requireIsolatedLaunch`).
 */
export function runInSensitiveConversation(run: { permission_snapshot_json?: unknown }): boolean {
  const snapshot = run.permission_snapshot_json;
  return !!snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    && (snapshot as { sensitive_conversation?: unknown }).sensitive_conversation === true;
}

/**
 * The Run's frozen snapshot pins a sensitive plugin tool, or continues a sensitive conversation. A
 * Project-bound core tool's pin (ADR 0033 §6) is not one.
 */
export function runPinsSensitivePluginTool(run: { permission_snapshot_json?: unknown }): boolean {
  if (runInSensitiveConversation(run)) return true;
  const snapshot = run.permission_snapshot_json;
  const pins = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as { plugin_tool_pins?: unknown }).plugin_tool_pins
    : null;
  if (!pins || typeof pins !== "object" || Array.isArray(pins)) return false;
  return Object.entries(pins as Record<string, unknown>).some(([actionId, pin]) =>
    Boolean(pin) && typeof pin === "object" && (pin as { data_class?: unknown }).data_class === "sensitive"
    && !projectBoundPin(actionId, pin));
}
