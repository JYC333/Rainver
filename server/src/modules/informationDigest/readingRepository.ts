import type { ReadingContribution, ReadingItem } from '@rainver/protocol';
import { escapeLikePattern, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { contentAccessLevelSql, projectReadAccessSql } from '../access/contentAccessSql.js';
import { contentResourceDefinition } from '../access/contentAccessRegistry.js';
import { sourceItemDocumentReadableClause, sourceItemFullContentReadClause } from '../sources/sourceItemAccess.js';
import { readingFamilySql, readingIdentityCtesSql, readingStatusSql, readingVersionCurrentSql } from '../sources/readingIdentity.js';
import { personalMaterialClause, projectMaterialRowsSql, projectReadingAudienceClause } from '../sources/readingMaterial.js';

const itemAccess = contentResourceDefinition('source_item')!;
export interface ReadingRow {
  key: string; source_item_id: string; source_item_ids: string[]; title: string; source_uri: string | null;
  occurred_at: string | null; summary: string | null; access_level: 'full' | 'summary';
  read_status: 'unread' | 'skimmed' | 'read' | 'discussed'; dismissed: boolean; available_at: string;
  contributions: ReadingContribution[]; material_links: ReadingItem['material_links'];
}

/** Query all eligible deliveries, then authorize, group, filter and paginate.
 * No per-source truncation. Every page re-evaluates live permissions/preferences.
 */
export class ReadingRepository {
  constructor(private readonly db: Queryable) {}
  async rows(identity: SpaceUserIdentity, enabled: string[], input: {
    view: string; limit: number; asOf: string; before?: { at: string; key: string };
    q?: string; projectId?: string; anchorId?: string;
  }): Promise<{ rows: ReadingRow[]; total: number; fingerprint: string }> {
    const full = sourceItemFullContentReadClause('i', '$2');
    const level = contentAccessLevelSql({ definition: itemAccess, alias: 'i', userExpr: '$2', includeOversight: false });
    const audience = projectReadingAudienceClause('i', 'delivery.project_id');
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
        WHERE i.space_id=$1 AND i.deleted_at IS NULL AND i.first_seen_at <= $4::timestamptz AND i.created_at <= $4::timestamptz AND $5='all'
          AND (($10::varchar IS NULL AND ${personalMaterialClause('i', '$2')})
            OR ($10::varchar IS NOT NULL AND material.source_item_id IS NOT NULL AND ${projectReadAccessSql('$1', '$10', '$2')}))
      ), grouped AS (
        SELECT reading_key AS key,min(available_at) AS available_at,
          (array_agg(id ORDER BY effective_level='full' DESC,kind='personal_digest' DESC NULLS LAST,available_at DESC,id))[1] AS source_item_id,
          array_agg(DISTINCT id ORDER BY id) AS source_item_ids,
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
        SELECT * FROM hydrated WHERE ($5='all' OR ($5='read' AND read_status IN ('read','discussed'))
          OR ($5='pending' AND read_status IN ('unread','skimmed') AND NOT dismissed)) AND search_match
          AND ($11::varchar IS NULL OR (payload->'source_item_ids') ? $11)
      ), paged AS (
        SELECT key,available_at,payload||jsonb_build_object('read_status',read_status,'dismissed',dismissed,'material_links',material_links) AS item
        FROM filtered WHERE ($6::timestamptz IS NULL OR (available_at,key)<($6::timestamptz,$7::text))
        ORDER BY available_at DESC,key DESC LIMIT $8
      ) SELECT jsonb_build_object('fingerprint',(SELECT md5(COALESCE(string_agg(reading_key || ':' || id || ':' || COALESCE(delivery_id,'') || ':' || effective_level,',' ORDER BY reading_key,id,delivery_id),'')) FROM authorized),'total',(SELECT count(*) FROM filtered),'rows',COALESCE((SELECT jsonb_agg(item ORDER BY available_at DESC,key DESC) FROM paged),'[]')) AS payload
    `, [identity.spaceId, identity.userId, enabled, input.asOf, input.view, input.before?.at ?? null, input.before?.key ?? null, input.limit, input.q === undefined ? null : `%${escapeLikePattern(input.q)}%`, input.projectId ?? null, input.anchorId ?? null]);
    return result.rows[0]!.payload;
  }
}
