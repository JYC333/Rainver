/**
 * Core operations for the owner's Gmail connection (`source.gmail.connection.disconnect`,
 * `source.gmail.connection.forget`), legacy Project thread selections
 * (`source.gmail.selection.remove`) and monitors (`source.gmail.monitor.*`). User principal, `public_api` only, no
 * Agent tool, no approval mapping; outputs carry ids and status only. Authority
 * is ownership of the row in the actor's Space (the row outlives a disconnect,
 * so a same-key replay is admitted; a forgotten row is gone, so its replay is
 * the hidden 404 like any vanished connection).
 *
 * Disconnect is local only (no Google revoke; see `gmailConnections.ts`), so the
 * REST adapter and `/api/v1/actions` behave identically and a replay returns
 * the receipt.
 */
import type { OperationActor, OperationInput, RegisteredSystemActionDefinition } from "@rainver/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import { hidden } from "../../systemActions/operations/errors.js";
import type { OperationRegistration } from "../../systemActions/operations/types.js";
import { disconnectGmailConnectionIn, forgetGmailConnectionIn, lockGmailOwnerSpace, lockOwnedGmailConnection, setGmailAgentReadIn } from "./gmailConnections.js";
import { lockOwnedGmailSelection, removeGmailSelectionIn } from "./gmailSelections.js";
import { authorizeGmailMonitorCommand, deleteGmailMonitorIn, setGmailMonitorStatusIn } from "./gmailMonitors.js";
import { authorizeGmailDigestCommand, endGmailDigestIn, setGmailDigestStatusIn, setGmailDigestTimeIn } from "./gmailDigests.js";

const ids = ["source.gmail.connection.disconnect", "source.gmail.connection.forget"] as const;
type Input = OperationInput<typeof ids[number]>;
const person = (actor: OperationActor) => ({ spaceId: actor.space_id, userId: actor.on_behalf_of_user_id! });

async function assertOwned(db: Queryable, actor: OperationActor, connectionId: string): Promise<void> {
  const row = await db.query(`SELECT 1 FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR SHARE`,
    [connectionId, actor.space_id, actor.on_behalf_of_user_id]);
  if (!row.rows.length) throw hidden();
}

export function gmailConnectionRegistrations(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration[] {
  return ids.map((id): OperationRegistration => ({
    definition: definitions.get(id)!,
    async resolve(_db, raw) {
      const connectionId = (raw as Input).connection_id;
      return { authority: `gmail_connection:${connectionId}`, targets: { connection_id: connectionId }, resourceType: "gmail_connection", resourceId: connectionId };
    },
    async authorize(db, raw, actor) {
      if (actor.principal.kind !== "user") throw hidden();
      // After the core's actor pin: the owner + Space mutex, then the connection row in the
      // mode execute needs (FOR UPDATE), so no SHARE lock is ever upgraded (gmailConnections.ts lock order).
      await lockGmailOwnerSpace(db, person(actor));
      await lockOwnedGmailConnection(db, person(actor), (raw as Input).connection_id);
    },
    async authorizeResult(db, raw, actor) {
      const output = raw as { connection_id: string; space_id: string };
      if (output.space_id !== actor.space_id) throw hidden();
      if (id === "source.gmail.connection.disconnect") { await assertOwned(db, actor, output.connection_id); return; }
      // A forgotten row is gone; one that exists again under the id must still be the caller's.
      const other = await db.query(`SELECT 1 FROM gmail_connections WHERE id=$1 AND NOT (space_id=$2 AND owner_user_id=$3)`,
        [output.connection_id, actor.space_id, actor.on_behalf_of_user_id]);
      if (other.rows.length) throw hidden();
    },
    async execute(db, raw, actor) {
      const connectionId = (raw as Input).connection_id;
      return id === "source.gmail.connection.disconnect"
        ? disconnectGmailConnectionIn(db, person(actor), connectionId)
        : forgetGmailConnectionIn(db, person(actor), connectionId);
    },
  }));
}

/**
 * Legacy selection removal. Adding selections was retired with the manual
 * search/select flow (Gmail V2): existing references stay, readable and
 * removable by their owner only. Remove locks only the mutex and the caller's
 * own row, so it works after Project access is lost.
 */
export function gmailSelectionRegistrations(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration[] {
  type Remove = OperationInput<"source.gmail.selection.remove">;
  const remove: OperationRegistration = {
    definition: definitions.get("source.gmail.selection.remove")!,
    async resolve(_db, raw) {
      const selectionId = (raw as Remove).selection_id;
      return { authority: `gmail_selection:${selectionId}`, targets: { selection_id: selectionId }, resourceType: "gmail_thread_selection", resourceId: selectionId };
    },
    async authorize(db, raw, actor) {
      if (actor.principal.kind !== "user") throw hidden();
      await lockOwnedGmailSelection(db, person(actor), (raw as Remove).selection_id);
    },
    async authorizeResult(db, raw, actor) {
      const output = raw as { selection_id: string; space_id: string };
      if (output.space_id !== actor.space_id) throw hidden();
      const other = await db.query(`SELECT 1 FROM gmail_project_thread_selections WHERE id=$1 AND NOT (space_id=$2 AND owner_user_id=$3)`,
        [output.selection_id, actor.space_id, actor.on_behalf_of_user_id]);
      if (other.rows.length) throw hidden();
    },
    async execute(db, raw, actor) { return removeGmailSelectionIn(db, person(actor), (raw as Remove).selection_id); },
  };
  return [remove];
}

/**
 * The owner's monitor commands (`source.gmail.monitor.set_status`,
 * `source.gmail.monitor.delete`): user principal, `public_api` only, owner-only
 * hidden 404. `authorize` takes person → mutex → the monitor row `FOR UPDATE`,
 * the same order execute uses, so nothing is upgraded later. A replay of a
 * deleted monitor's receipt is the hidden 404 once the row is gone.
 */
export function gmailMonitorRegistrations(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration[] {
  return (["source.gmail.monitor.set_status", "source.gmail.monitor.delete"] as const).map((id): OperationRegistration => ({
    definition: definitions.get(id)!,
    async resolve(_db, raw) {
      const monitorId = (raw as { monitor_id: string }).monitor_id;
      return { authority: `gmail_monitor:${monitorId}`, targets: { monitor_id: monitorId }, resourceType: "gmail_monitor", resourceId: monitorId };
    },
    async authorize(db, raw, actor) {
      if (actor.principal.kind !== "user") throw hidden();
      await authorizeGmailMonitorCommand(db, person(actor), (raw as { monitor_id: string }).monitor_id);
    },
    async authorizeResult(db, raw, actor) {
      const output = raw as { monitor_id: string; space_id: string };
      if (output.space_id !== actor.space_id) throw hidden();
      // A deleted monitor is gone (its fresh result still releases); a row under the id must be the caller's.
      const rows = (await db.query<{ own: boolean }>(`SELECT (space_id=$2 AND owner_user_id=$3) AS own FROM gmail_monitor_rules WHERE id=$1`,
        [output.monitor_id, actor.space_id, actor.on_behalf_of_user_id])).rows;
      if (rows.some((row) => !row.own) || (id === "source.gmail.monitor.set_status" && !rows.length)) throw hidden();
    },
    async execute(db, raw, actor) {
      if (id === "source.gmail.monitor.delete") return deleteGmailMonitorIn(db, person(actor), (raw as { monitor_id: string }).monitor_id);
      const input = raw as OperationInput<"source.gmail.monitor.set_status">;
      return setGmailMonitorStatusIn(db, person(actor), input.monitor_id, input.status);
    },
  }));
}

/**
 * `source.gmail.connection.set_agent_read`: the owner's opt-in for on-demand
 * Agent reads (ADR 0032). User principal, `public_api` only, owner-only hidden
 * 404; person → mutex → connection `FOR UPDATE` like disconnect.
 */
export function gmailAgentReadSettingRegistration(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration {
  type SetAgentRead = OperationInput<"source.gmail.connection.set_agent_read">;
  return {
    definition: definitions.get("source.gmail.connection.set_agent_read")!,
    async resolve(_db, raw) {
      const connectionId = (raw as SetAgentRead).connection_id;
      return { authority: `gmail_connection:${connectionId}`, targets: { connection_id: connectionId }, resourceType: "gmail_connection", resourceId: connectionId };
    },
    async authorize(db, raw, actor) {
      if (actor.principal.kind !== "user") throw hidden();
      await lockGmailOwnerSpace(db, person(actor));
      await lockOwnedGmailConnection(db, person(actor), (raw as SetAgentRead).connection_id);
    },
    async authorizeResult(db, raw, actor) {
      const output = raw as { connection_id: string; space_id: string };
      if (output.space_id !== actor.space_id) throw hidden();
      await assertOwned(db, actor, output.connection_id);
    },
    async execute(db, raw, actor) {
      const input = raw as SetAgentRead;
      return setGmailAgentReadIn(db, person(actor), input.connection_id, input.enabled);
    },
  };
}

/**
 * The owner's digest commands (`source.gmail.digest.set_status`, `source.gmail.digest.end`): user
 * principal, `public_api` only, owner-only hidden 404; person → mutex → connection → digest `FOR UPDATE`.
 * Ending revokes the digest's consent; a replay returns the same receipt (the row stays as history).
 */
export function gmailDigestRegistrations(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration[] {
  return (["source.gmail.digest.set_status", "source.gmail.digest.set_time", "source.gmail.digest.end"] as const).map((id): OperationRegistration => ({
    definition: definitions.get(id)!,
    async resolve(_db, raw) {
      const digestId = (raw as { digest_id: string }).digest_id;
      return { authority: `gmail_digest:${digestId}`, targets: { digest_id: digestId }, resourceType: "gmail_digest", resourceId: digestId };
    },
    async authorize(db, raw, actor) {
      if (actor.principal.kind !== "user") throw hidden();
      await authorizeGmailDigestCommand(db, person(actor), (raw as { digest_id: string }).digest_id);
    },
    async authorizeResult(db, raw, actor) {
      const output = raw as { digest_id: string; space_id: string };
      if (output.space_id !== actor.space_id) throw hidden();
      const rows = (await db.query<{ own: boolean }>(`SELECT (space_id=$2 AND owner_user_id=$3) AS own FROM gmail_digests WHERE id=$1`,
        [output.digest_id, actor.space_id, actor.on_behalf_of_user_id])).rows;
      if (!rows.length || rows.some((row) => !row.own)) throw hidden();
    },
    async execute(db, raw, actor) {
      if (id === "source.gmail.digest.end") return endGmailDigestIn(db, person(actor), (raw as { digest_id: string }).digest_id);
      if (id === "source.gmail.digest.set_time") {
        const input = raw as OperationInput<"source.gmail.digest.set_time">;
        return setGmailDigestTimeIn(db, person(actor), input.digest_id, input.local_time);
      }
      const input = raw as OperationInput<"source.gmail.digest.set_status">;
      return setGmailDigestStatusIn(db, person(actor), input.digest_id, input.status);
    },
  }));
}
