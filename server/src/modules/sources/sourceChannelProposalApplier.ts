import type { ProposalApplierRegistry } from "../proposals/applierRegistry.js";
import { requiredString } from "../routeUtils/common.js";

export function registerSourceChannelProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("source_channel_activation", async (context) => {
    const { db, proposal } = context;
    const channelId = requiredString(proposal.payload_json?.source_channel_id, "source_channel_id");
    const expectedUpdatedAt = requiredString(proposal.payload_json?.draft_updated_at, "draft_updated_at");
    const current = await db.query<{ channel_updated_at: unknown; connection_id: string }>(
      `SELECT ch.updated_at AS channel_updated_at, ch.source_connection_id AS connection_id
         FROM source_channels ch
         JOIN source_connections sc ON sc.id = ch.source_connection_id
        WHERE ch.id=$1 AND ch.space_id=$2 AND ch.status='paused'
          AND sc.status='paused' AND sc.deleted_at IS NULL
        FOR UPDATE OF ch, sc`,
      [channelId, proposal.space_id],
    );
    if (!current.rows[0] || new Date(String(current.rows[0].channel_updated_at)).toISOString() !== new Date(expectedUpdatedAt).toISOString()) {
      throw new Error("Source Channel draft changed after proposal creation");
    }
    const now = new Date().toISOString();
    await db.query(
      `UPDATE source_connections SET status='active', updated_at=$3 WHERE id=$1 AND space_id=$2`,
      [current.rows[0].connection_id, proposal.space_id, now],
    );
    await db.query(
      `UPDATE source_channels SET status='active', updated_at=$3 WHERE id=$1 AND space_id=$2`,
      [channelId, proposal.space_id, now],
    );
    return {
      result_type: "source_channel",
      result: { source_channel_id: channelId, source_connection_id: current.rows[0].connection_id, status: "active" },
    };
  });
}
