import { ORDINARY_TOOL_CATALOG, type HostLaunchOrdinaryTools } from "@rainver/protocol";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../routeUtils/common.js";
import { normalizeHostCapabilities } from "../hosts/capabilities.js";
import { ordinaryAccountKey } from "../hosts/ordinaryToolAccountRoutes.js";

/**
 * What a Run on a Host gets of ordinary CLI tools, decided here so the daemon
 * is told only facts the control plane holds:
 *
 * - The account is the Run's instructing person's (`instructed_by_user_id`,
 *   the sender of the message that created it — B8A). Never the Room's
 *   creator, the Agent's owner or a value from a client. A Run with no
 *   instructing person gets no account; nothing stands in for one.
 * - A paired Host serves only its owner (B63); another person's key is never
 *   sent to it.
 * - A daemon that does not report `ordinary_tools_runs` is sent nothing.
 *
 * The instruction tells the Agent which commands this Host reported and how
 * the personal identity behaves; what a namespace actually provides is in the
 * Run's own `RAINVER_ORDINARY_TOOLS`.
 */
export async function ordinaryToolsForLaunch(
  databaseUrl: string | null | undefined,
  hostId: string,
  run: { instructed_by_user_id?: string | null },
  db?: Queryable,
): Promise<{ field: HostLaunchOrdinaryTools | undefined; instruction: string | null }> {
  if (!databaseUrl && !db) return { field: undefined, instruction: null };
  const host = (await (db ?? getDbPool(databaseUrl!)).query<{ kind: string; owner_user_id: string | null; capabilities_json: unknown }>(
    "SELECT kind, owner_user_id, capabilities_json FROM hosts WHERE id = $1 LIMIT 1",
    [hostId],
  )).rows[0];
  if (!host) return { field: undefined, instruction: null };
  const capabilities = normalizeHostCapabilities(host.capabilities_json);
  if (!capabilities.ordinary_tools_runs) return { field: undefined, instruction: null };
  const userId = typeof run.instructed_by_user_id === "string" && run.instructed_by_user_id ? run.instructed_by_user_id : null;
  const mayUseAccount = Boolean(userId)
    && capabilities.ordinary_tool_accounts?.supported === true
    && (host.kind === "server" || host.owner_user_id === userId);
  const field: HostLaunchOrdinaryTools = {
    accounts: mayUseAccount ? [{ tool_id: "lark_cli", account_key: ordinaryAccountKey(userId!) }] : [],
  };
  const reported = capabilities.ordinary_tools?.tools ?? [];
  const available = reported.filter((tool) => tool.status === "available")
    .map((tool) => `${ORDINARY_TOOL_CATALOG[tool.tool_id].executable}${tool.version ? ` ${tool.version}` : ""}`);
  const missing = reported.filter((tool) => tool.status !== "available").map((tool) => ORDINARY_TOOL_CATALOG[tool.tool_id].executable);
  const lines = [
    `Ordinary CLI tools this Host reported: ${available.length ? available.join(", ") : "none"}${missing.length ? `; not available: ${missing.join(", ")}` : ""}. `
      + "Use them through your normal terminal; `printenv RAINVER_ORDINARY_TOOLS` says what this Run's environment actually provides.",
  ];
  if (reported.some((tool) => tool.tool_id === "lark_cli" && tool.status === "available")) {
    lines.push(mayUseAccount
      ? "lark-cli runs as the person who asked for this work, with their own Feishu/Lark login (`--as user`). "
        + "Do not switch to the bot identity. If it reports that it is not configured or not logged in, "
        + "stop and ask that person to set it up or log in from the Host's CLI tools page; do not attempt the login yourself."
      : "lark-cli has no personal account in this Run; do not use it as anyone, and do not fall back to the bot identity.");
  }
  return { field, instruction: lines.join("\n") };
}
