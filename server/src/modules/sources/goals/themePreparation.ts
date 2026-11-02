import {PROJECT_THEME_LIMITS} from '@rainver/protocol';
import type {Queryable,SpaceUserIdentity} from '../../routeUtils/common.js';
import type {ServerConfig} from '../../../config.js';
import {PgSourcesRepository} from '../repository.js';
import {retainedAnalysisPolicySql} from '../materialProcessing/policy.js';
/** Deterministic extraction only, under existing retention/transport/quota
 * authority. Never asks an Agent to attest original text. Bounded per batch. */
export async function prepareThemeOriginals(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,goalId:string,itemIds:string[],auditId:string){
 if(!itemIds.length)return;
 const items=(await db.query<{id:string}>(`SELECT i.id FROM source_items i JOIN source_goals g ON g.space_id=i.space_id AND g.id=$2 JOIN source_connections c ON c.id=i.connection_id AND c.space_id=i.space_id WHERE i.space_id=$1 AND i.id=ANY($3::varchar[]) AND i.deleted_at IS NULL AND (NOT EXISTS(SELECT 1 FROM source_snapshots original JOIN artifacts body ON body.id=original.artifact_id AND body.space_id=original.space_id WHERE original.source_item_id=i.id AND original.space_id=i.space_id AND original.snapshot_type='extracted' AND original.reading_role IS DISTINCT FROM 'analysis' AND body.metadata_json->>'extraction_method' IN ('structured_html_v1','markdown_v1','plain_text_v1','pdf_text_v1')) OR EXISTS(SELECT 1 FROM source_goal_item_changes ch WHERE ch.space_id=i.space_id AND ch.goal_id=g.id AND ch.source_item_id=i.id AND ch.goal_run_id=$4)) AND g.project_id IS NOT NULL AND g.compatibility_json->'theme_analysis'->>'enabled'='true' AND g.compatibility_json->'theme_analysis'->>'version_id'=g.active_version_id AND ${retainedAnalysisPolicySql('c')} ORDER BY i.id LIMIT $5`,[identity.spaceId,goalId,itemIds,auditId,PROJECT_THEME_LIMITS.originalPreparations])).rows;
 for(const i of items)await new PgSourcesRepository(db,config).itemAction(identity,i.id,{action:'queue_content'});
}
