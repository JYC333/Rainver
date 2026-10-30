import {canWriteProject} from '../projects/access.js';
import {materialSourcePolicyHash} from './materialProcessing/consent.js';
import type {SourceConnectionRow} from './sourceRepositoryRows.js';
import {assertSourceConnectionManageable} from './sourceConnectionAccess.js';
import type { ProposalApplierRegistry } from "../proposals/applierRegistry.js";
import { requiredString } from "../routeUtils/common.js";

export function registerSourceChannelProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register('source_material_retention',async({db,proposal,userId})=>{
    const id=requiredString(proposal.payload_json?.source_connection_id,'source_connection_id');const identity={spaceId:proposal.space_id,userId};await assertSourceConnectionManageable(db,identity,id);
    const source=(await db.query<SourceConnectionRow>("SELECT * FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL AND status<>'archived' FOR UPDATE",[id,proposal.space_id])).rows[0];
    if(!source||source.owner_user_id!==userId||source.project_id&&!await canWriteProject(db,proposal.space_id,source.project_id,userId)||materialSourcePolicyHash(source)!==proposal.payload_json?.expected_policy_sha256)throw new Error('Source owner or policy changed; review again');
    await db.query("UPDATE source_connections SET capture_policy=CASE WHEN capture_policy='reference_only' THEN 'extract_text' ELSE capture_policy END,policy_json=COALESCE(policy_json,'{}'::jsonb)||'{\"retention_policy\":\"full_text\"}'::jsonb,updated_at=now() WHERE id=$1 AND space_id=$2",[id,proposal.space_id]);
    return {result_type:'source_connection',result:{source_connection_id:id,retention_policy:'full_text'}};
  });
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
    const updatedAt = current.rows[0]?.channel_updated_at;
    const currentTimestamp = updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt ? new Date(String(updatedAt)).toISOString() : null;
    if (!current.rows[0] || currentTimestamp !== new Date(expectedUpdatedAt).toISOString()) {
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
