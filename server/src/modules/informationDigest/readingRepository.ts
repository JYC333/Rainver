import {goalCollectionReadableSql,goalItemReadableSql} from '../sources/goals/itemVisibility.js';
import type { ReadingContribution, ReadingItem } from '@rainver/protocol';
import { escapeLikePattern, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { contentAccessLevelSql, projectReadAccessSql } from '../access/contentAccessSql.js';
import { contentResourceDefinition } from '../access/contentAccessRegistry.js';
import { sourceItemDocumentReadableClause, sourceItemFullContentReadClause } from '../sources/sourceItemAccess.js';
import { readingFamilySql, readingIdentityCtesSql, readingStatusSql, readingVersionCurrentSql } from '../sources/readingIdentity.js';
import { personalMaterialClause, projectMaterialRowsSql, projectReadingAudienceClause } from '../sources/readingMaterial.js';

const itemAccess = contentResourceDefinition('source_item')!;
export interface ReadingRow {
  topic_change?:ReadingItem['topic_change'];
  result_provenance?:'agent_provided_unverified'|null;
  key: string; source_item_id: string; source_item_ids: string[]; title: string; source_uri: string | null;
  occurred_at: string | null; summary: string | null; access_level: 'full' | 'summary';
  read_status: 'unread' | 'skimmed' | 'read' | 'discussed'; dismissed: boolean; available_at: string;
  contributions: ReadingContribution[]; material_links: ReadingItem['material_links']; topics: ReadingItem['topics'];
}

/** Query all eligible deliveries, then authorize, group, filter and paginate.
 * No per-source truncation. Every page re-evaluates live permissions/preferences.
 */
export class ReadingRepository {
  constructor(private readonly db: Queryable) {}
  async rows(identity: SpaceUserIdentity, enabled: string[], input: {
    view: string; limit: number; asOf: string; before?: { at: string; key: string };
    q?: string; projectId?: string; anchorId?: string; topic?: string; topicSelection?: 'important' | 'all';
    /** `oldest` pages from the longest-waiting item forward; the cursor's comparison flips with it. */
    sort?: 'newest' | 'oldest';
  }): Promise<{ rows: ReadingRow[]; total: number; fingerprint: string }> {
    const oldest = input.sort === 'oldest';
    const order = oldest ? 'available_at ASC,key ASC' : 'available_at DESC,key DESC';
    const full = sourceItemFullContentReadClause('i', '$2');
    const level = contentAccessLevelSql({ definition: itemAccess, alias: 'i', userExpr: '$2', includeOversight: false });
    const audience = projectReadingAudienceClause('i', 'delivery.project_id');
    // Directly followed collections are reading intake, not fabricated digest
    // recommendations. Eligibility comes only from server-recorded goal
    // membership (source_goal_items, written by the goal materializer from the
    // actual goal/binding/collection); model-authored metadata never counts.
    const goalScope = (goal: string) => `((\$10::varchar IS NOT NULL AND ${goal}.project_id=\$10)
          OR (\$10::varchar IS NULL AND ((${goal}.project_id IS NULL AND ${goal}.owner_user_id=\$2)
            OR ${goal}.project_id=ANY(\$3::varchar[]))))`;
    const followed = `EXISTS (
      SELECT 1 FROM source_goal_items membership
      JOIN source_goals goal ON goal.id=membership.goal_id AND goal.space_id=membership.space_id
      WHERE membership.space_id=i.space_id AND membership.source_item_id=i.id
        AND goal.project_id IS NOT DISTINCT FROM i.project_id AND ${goalScope('goal')}
    )`;

    const result = await this.db.query<{ payload: { rows: ReadingRow[]; total: number; fingerprint: string } }>(`
      WITH anchor AS (SELECT id,canonical_uri,reading_initial_hash FROM source_items WHERE space_id=$1 AND id=$11),
      base_items AS (
        SELECT i.* FROM source_items i WHERE i.space_id=$1 AND i.deleted_at IS NULL AND $11::varchar IS NULL
        UNION ALL
        SELECT i.* FROM source_items i WHERE i.space_id=$1 AND i.deleted_at IS NULL AND i.id=$11
        UNION ALL
        SELECT i.* FROM anchor a JOIN source_items i ON i.space_id=$1 AND i.canonical_uri=a.canonical_uri
          AND i.id<>a.id AND i.deleted_at IS NULL
      ), scoped AS MATERIALIZED (
        SELECT i.*,${readingFamilySql('i')} AS family_key,${level} AS effective_level
        FROM base_items i WHERE ${sourceItemDocumentReadableClause('i', '$2', { includeOversight: false })}
      ), ${readingIdentityCtesSql('scoped', 'members')}, states AS MATERIALIZED (
        SELECT DISTINCT ON(m.reading_key) m.reading_key,${readingStatusSql('m', 'us')} AS read_status,
          COALESCE((us.progress_json->>'reading_dismissed')::boolean,false) AS dismissed
        FROM members m JOIN source_item_user_states us ON us.space_id=m.space_id AND us.source_item_id=m.id AND us.user_id=$2
        WHERE ${readingVersionCurrentSql('m', 'us')}
        ORDER BY m.reading_key,(us.progress_json->>'reading_state_at')::timestamptz DESC NULLS LAST,
          us.read_status IN ('read','discussed') DESC,us.updated_at DESC,us.id DESC
      ), material_rows AS (${projectMaterialRowsSql('$1', '$10')}), material_by_item AS (
        SELECT source_item_id,jsonb_agg(DISTINCT jsonb_build_object('source_item_id',source_item_id,'kind',kind,'reference_id',reference_id,'project_id',project_id)) AS refs
        FROM material_rows GROUP BY source_item_id
      ), deliveries AS (
        SELECT di.source_item_id,di.id AS delivery_id,
          CASE WHEN dg.digest_type='personal' THEN 'personal_digest' ELSE 'project_digest' END AS kind,
          dg.project_id,dg.id AS digest_id,dg.digest_date,dg.timezone,dg.generated_at AS available_at,
          di.position,di.section,di.rationale,di.provenance_json->>'summary' AS frozen_summary
        FROM information_digests dg JOIN information_digest_items di ON di.space_id=dg.space_id AND di.digest_id=dg.id
        WHERE dg.space_id=$1 AND dg.status IN ('ready','empty') AND dg.generated_at <= $4::timestamptz
          AND ((dg.digest_type='personal' AND dg.owner_user_id=$2 AND $10::varchar IS NULL)
            OR (dg.digest_type='project' AND (($10::varchar IS NULL AND dg.project_id=ANY($3::varchar[])) OR dg.project_id=$10)))
        UNION ALL
        SELECT recommendation->>'id', op.id || ':' || (recommendation->>'id'),'project_initial',op.project_id,
          NULL::varchar,NULL::varchar,NULL::varchar,(op.progress_json->>'as_of')::timestamptz,
          ordinal::integer,NULL::varchar,recommendation->>'reason',recommendation->>'summary'
        FROM project_operations op
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(op.progress_json->'recommendations','[]')) WITH ORDINALITY AS saved(recommendation,ordinal)
        WHERE op.space_id=$1 AND op.status='completed' AND op.progress_json->>'purpose'='information_monitoring'
          AND COALESCE(op.progress_json->>'run_kind','initial')='initial'
          AND op.progress_json ? 'as_of' AND (op.progress_json->>'as_of')::timestamptz <= $4::timestamptz
          AND (($10::varchar IS NULL AND op.project_id=ANY($3::varchar[])) OR op.project_id=$10)
          AND op.progress_json->'recommendation_ids' ? (recommendation->>'id')
      ), authorized AS (
        SELECT i.*,
          delivery.delivery_id,delivery.kind,delivery.project_id AS delivery_project_id,p.name AS project_name,
          delivery.digest_id,delivery.digest_date,delivery.timezone,delivery.available_at,delivery.position,delivery.section,
          delivery.rationale,COALESCE(delivery.frozen_summary,a.summary) AS reading_summary, '[]'::jsonb AS material_refs
        FROM deliveries delivery JOIN members i ON i.id=delivery.source_item_id AND i.space_id=$1 AND i.deleted_at IS NULL
        LEFT JOIN source_item_annotations a ON a.space_id=i.space_id AND a.source_item_id=i.id
        LEFT JOIN projects p ON p.space_id=i.space_id AND p.id=delivery.project_id AND p.deleted_at IS NULL
        WHERE (delivery.project_id IS NULL OR (p.id IS NOT NULL AND ${projectReadAccessSql('i.space_id', 'delivery.project_id', '$2')}
            AND ${full} AND ${audience}))
        UNION ALL
        SELECT i.*,NULL::text,NULL::text,NULL::varchar,NULL::varchar,
          NULL::varchar,NULL::varchar,NULL::varchar,i.first_seen_at,0,NULL::varchar,NULL::text,a.summary,
          COALESCE(material.refs,'[]'::jsonb)
        FROM members i LEFT JOIN source_item_annotations a ON a.space_id=i.space_id AND a.source_item_id=i.id
        LEFT JOIN material_by_item material ON material.source_item_id=i.id
        WHERE i.space_id=$1 AND i.deleted_at IS NULL AND i.first_seen_at <= $4::timestamptz AND i.created_at <= $4::timestamptz AND ($5='all' OR ${followed})
          AND (($10::varchar IS NULL AND ${personalMaterialClause('i', '$2')})
            OR ($10::varchar IS NOT NULL AND material.source_item_id IS NOT NULL AND ${projectReadAccessSql('$1', '$10', '$2')}))
      ), grouped AS (
        SELECT reading_key AS key,min(available_at) AS available_at,
          (array_agg(id ORDER BY effective_level='full' DESC,kind='personal_digest' DESC NULLS LAST,available_at DESC,id))[1] AS source_item_id,
          array_agg(DISTINCT id ORDER BY id) AS source_item_ids,
          CASE WHEN bool_or(metadata_json->>'result_provenance'='agent_provided_unverified') THEN 'agent_provided_unverified' ELSE NULL END AS result_provenance,
          (array_agg(title ORDER BY effective_level='full' DESC,kind='personal_digest' DESC NULLS LAST,available_at DESC,id))[1] AS title,
          (array_agg(CASE WHEN effective_level='full' THEN COALESCE(source_uri,CASE WHEN metadata_json ? 'page_change' THEN metadata_json->>'page_uri' END) END ORDER BY effective_level='full' DESC,kind='personal_digest' DESC NULLS LAST,available_at DESC,id))[1] AS source_uri,
          (array_agg(occurred_at ORDER BY effective_level='full' DESC,kind='personal_digest' DESC NULLS LAST,available_at DESC,id))[1] AS occurred_at,
          (array_agg(effective_level ORDER BY effective_level='full' DESC,kind='personal_digest' DESC NULLS LAST,available_at DESC,id))[1] AS access_level,
          (array_agg(reading_summary ORDER BY available_at DESC,id))[1] AS summary,
          bool_or($9::text IS NULL OR title ILIKE $9 ESCAPE chr(92) OR reading_summary ILIKE $9 ESCAPE chr(92)
            OR source_domain ILIKE $9 ESCAPE chr(92) OR (effective_level='full' AND (source_uri ILIKE $9 ESCAPE chr(92) OR excerpt ILIKE $9 ESCAPE chr(92)))) AS search_match,
          COALESCE(jsonb_agg(jsonb_build_object('delivery_id',delivery_id,'source_item_id',id,'kind',kind,
            'project_id',delivery_project_id,'project_name',project_name,'digest_id',digest_id,'digest_date',digest_date,
            'timezone',timezone,'available_at',available_at,'position',position,'section',section,'summary',reading_summary,'rationale',rationale)
            ORDER BY available_at DESC,delivery_id) FILTER(WHERE delivery_id IS NOT NULL),'[]') AS contributions
        FROM authorized GROUP BY reading_key
      ), links AS (
        SELECT a.reading_key,jsonb_agg(DISTINCT ref) AS material_links
        FROM authorized a CROSS JOIN LATERAL jsonb_array_elements(a.material_refs) ref GROUP BY a.reading_key
      ), visible_topic_goals AS MATERIALIZED (
        -- Same visibility/scope as the topic links. Reuse it for main Reading
        -- arrival projection rather than scanning other people's collections.
        SELECT tg.* FROM source_goals tg WHERE tg.space_id=$1 AND tg.status<>'deleted'
          AND ${goalScope('tg')} AND (tg.project_id IS NULL OR ${projectReadAccessSql('tg.space_id', 'tg.project_id', '$2')})
      ), latest_topic_collections AS MATERIALIZED (
        -- Membership, never publication/observation time or model labels.
        SELECT DISTINCT ON (r.binding_id) r.id,r.space_id,r.goal_id,r.binding_id,r.status,r.started_at AS detected_at
        FROM source_goal_runs r JOIN visible_topic_goals vg ON vg.id=r.goal_id AND vg.space_id=r.space_id
        WHERE ($12::varchar IS NULL OR r.goal_id=$12) AND r.binding_id IS NOT NULL
          AND r.ended_at IS NOT NULL AND r.ended_at<=$4::timestamptz
          AND r.status NOT IN ('queued','running','accepted','materializing')
        ORDER BY r.binding_id,r.started_at DESC,r.id DESC
      ), topic_links AS MATERIALIZED (
        -- Only goals the viewer may see in this Reading scope; one row per
        -- reading key and goal, keeping the strongest selection of its members.
        SELECT DISTINCT ON (a.reading_key,membership.goal_id) a.reading_key,membership.goal_id,
          membership.selection_status,CASE WHEN a.effective_level='full' THEN membership.selection_reason END AS selection_reason,membership.judged_by,membership.delivery_kind,
          COALESCE(a.effective_level='full' AND latest.id=membership.first_goal_run_id AND latest.status IN ('succeeded','insufficient') AND ${goalCollectionReadableSql('latest','$2')},false) AS new_in_latest_collection,CASE WHEN a.effective_level='full' THEN membership.change_evidence_url END AS change_evidence_url,
          left(COALESCE(NULLIF(tg.compatibility_json->>'display_title',''),tg.compatibility_json->>'conversation_base_intent',tg.intent_json->>'intent',''),200) AS title,tg.project_id
        FROM (SELECT DISTINCT reading_key,id,space_id,effective_level FROM authorized) a
        JOIN source_goal_items membership ON membership.space_id=a.space_id AND membership.source_item_id=a.id
        JOIN visible_topic_goals tg ON tg.id=membership.goal_id AND tg.space_id=membership.space_id
        LEFT JOIN latest_topic_collections latest ON latest.binding_id=membership.binding_id AND latest.goal_id=membership.goal_id AND latest.space_id=membership.space_id
        ORDER BY a.reading_key,membership.goal_id,
          CASE membership.selection_status WHEN 'important' THEN 0 WHEN 'unjudged' THEN 1 WHEN 'judgment_failed' THEN 2 ELSE 3 END
      ), topics_by_key AS (
        SELECT reading_key,jsonb_agg(jsonb_build_object('goal_id',goal_id,'project_id',project_id,'title',title,'selection_status',selection_status,'selection_reason',selection_reason,'judged_by',judged_by,'delivery_kind',delivery_kind,'change_evidence_url',change_evidence_url) || CASE WHEN new_in_latest_collection THEN '{"new_in_latest_collection":true}'::jsonb ELSE '{}'::jsonb END ORDER BY goal_id) AS topics
        FROM topic_links GROUP BY reading_key
      ), fragments AS (
        SELECT key,available_at,to_jsonb(g)-'search_match' AS payload,
          NULL::text AS read_status,NULL::boolean AS dismissed,NULL::jsonb AS material_links,search_match
        FROM grouped g
        UNION ALL
        SELECT reading_key,NULL::timestamptz,NULL::jsonb,read_status,dismissed,NULL::jsonb,NULL::boolean FROM states
        UNION ALL
        SELECT reading_key,NULL::timestamptz,NULL::jsonb,NULL::text,NULL::boolean,material_links,NULL::boolean FROM links
      ), hydrated AS (
        SELECT key,max(available_at) AS available_at,
          (jsonb_agg(payload) FILTER(WHERE payload IS NOT NULL))->0 AS payload,
          COALESCE(max(read_status),'unread') AS read_status,COALESCE(bool_or(dismissed),false) AS dismissed,
          COALESCE((jsonb_agg(material_links) FILTER(WHERE material_links IS NOT NULL))->0,'[]'::jsonb) AS material_links,
          bool_or(search_match) AS search_match
        FROM fragments GROUP BY key HAVING count(payload)>0
      ), filtered AS (
        SELECT h.*,COALESCE(t.topics,'[]'::jsonb) AS topics FROM hydrated h LEFT JOIN topics_by_key t ON t.reading_key=h.key
        WHERE ($5='all' OR ($5='read' AND read_status IN ('read','discussed'))
          OR ($5='pending' AND read_status IN ('unread','skimmed') AND NOT dismissed)) AND search_match
          AND ($11::varchar IS NULL OR (payload->'source_item_ids') ? $11)
          AND ($12::varchar IS NULL OR EXISTS (SELECT 1 FROM topic_links tl WHERE tl.reading_key=h.key AND tl.goal_id=$12
            AND ($13::text='all' OR tl.selection_status='important')))
      ), change_deliveries AS MATERIALIZED (
        SELECT c.id,c.delivered_at AS available_at,'topic-change:'||c.id AS key,
         COALESCE(cs.read_status,'unread') AS read_status,COALESCE(cs.dismissed,0)=1 AS dismissed,
         jsonb_build_object('key','topic-change:'||c.id,'source_item_id',i.id,'source_item_ids',jsonb_build_array(i.id),
          'title',i.title,'source_uri',i.source_uri,'occurred_at',i.occurred_at,'summary',NULL,'access_level','full',
          'result_provenance',i.metadata_json->>'result_provenance','available_at',c.delivered_at,'contributions','[]'::jsonb,'material_links','[]'::jsonb,
          'topic_change',jsonb_build_object('id',c.id,'goal_id',g.id,'kind',c.change_kind,'evidence_url',c.evidence_url),
          'topics',jsonb_build_array(jsonb_build_object('goal_id',g.id,'project_id',g.project_id,'title',left(COALESCE(NULLIF(g.compatibility_json->>'display_title',''),g.compatibility_json->>'conversation_base_intent',g.intent_json->>'intent',''),200),
           'selection_status',CASE WHEN gi.selection_source='owner_feedback' THEN gi.selection_status ELSE c.selection_status END,
           'selection_reason',CASE WHEN gi.selection_source='owner_feedback' THEN gi.selection_reason ELSE c.selection_reason END,
           'judged_by',CASE WHEN gi.selection_source='owner_feedback' THEN gi.judged_by ELSE c.judged_by END,'delivery_kind','evidenced_change','change_evidence_url',c.evidence_url))) AS payload
        FROM source_goal_item_changes c JOIN members i ON i.space_id=c.space_id AND i.id=c.source_item_id
        JOIN source_goals g ON g.id=c.goal_id AND g.space_id=c.space_id
        JOIN source_goal_items gi ON gi.goal_id=c.goal_id AND gi.source_item_id=c.source_item_id
        LEFT JOIN source_goal_change_user_states cs ON cs.change_id=c.id AND cs.space_id=c.space_id AND cs.user_id=$2
        WHERE c.space_id=$1 AND c.delivered_at IS NOT NULL AND c.delivered_at<=$4::timestamptz AND g.status<>'deleted'
         AND ${goalScope('g')} AND (g.project_id IS NULL OR ${projectReadAccessSql('g.space_id','g.project_id','$2')})
         AND ${goalItemReadableSql('i','$2',true)} AND ${goalCollectionReadableSql('c','$2')} AND ($11::varchar IS NULL OR i.id=$11)
         AND ($12::varchar IS NULL OR c.goal_id=$12)
         AND ($12::varchar IS NULL OR $13::text='all' OR (CASE WHEN gi.selection_source='owner_feedback' THEN gi.selection_status ELSE c.selection_status END)='important')
         AND ($9::text IS NULL OR i.title ILIKE $9 ESCAPE chr(92) OR i.source_uri ILIKE $9 ESCAPE chr(92))
      ), queue AS (
        SELECT key,available_at,payload||jsonb_build_object('read_status',read_status,'dismissed',dismissed,'material_links',material_links,'topics',topics) AS item FROM filtered
        UNION ALL
        SELECT key,available_at,payload||jsonb_build_object('read_status',read_status,'dismissed',dismissed) FROM change_deliveries
         WHERE ($5='all' OR ($5='read' AND read_status IN ('read','discussed')) OR ($5='pending' AND read_status IN ('unread','skimmed') AND NOT dismissed))
      ), paged AS (
        SELECT key,available_at,item FROM queue WHERE ($6::timestamptz IS NULL OR (available_at,key)${oldest ? '>' : '<'}($6::timestamptz,$7::text))
        ORDER BY ${order} LIMIT $8
      ) SELECT jsonb_build_object('fingerprint',(SELECT md5(COALESCE(string_agg(reading_key || ':' || id || ':' || COALESCE(delivery_id,'') || ':' || effective_level,',' ORDER BY reading_key,id,delivery_id),'')) FROM authorized) || (SELECT md5(COALESCE(string_agg(reading_key || ':' || goal_id,',' ORDER BY reading_key,goal_id),'')) FROM topic_links) || (SELECT md5(COALESCE(string_agg(id || ':' || read_status || ':' || dismissed::text,',' ORDER BY id),'')) FROM change_deliveries),'total',(SELECT count(*) FROM queue),'rows',COALESCE((SELECT jsonb_agg(item ORDER BY ${order}) FROM paged),'[]')) AS payload
    `, [identity.spaceId, identity.userId, enabled, input.asOf, input.view, input.before?.at ?? null, input.before?.key ?? null, input.limit, input.q === undefined ? null : `%${escapeLikePattern(input.q)}%`, input.projectId ?? null, input.anchorId ?? null, input.topic ?? null, input.topicSelection ?? 'all']);
    return result.rows[0]!.payload;
  }
}
