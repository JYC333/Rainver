import type { Queryable } from "../routeUtils/common";
import { objectValue } from "../routeUtils/common";
import { defaultExtractionProfileRegistry } from "../extractionProfiles/registry";

export interface ProjectScreeningCriteria {
  include_keywords: string[];
  exclude_keywords: string[];
  domain_criteria: Record<string, string[]>;
  date_range_start: string | null;
  date_range_end: string | null;
  source_restrictions: string[];
  required_evidence_fields: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export async function availableProjectDomainCriteria(
  db: Queryable,
  spaceId: string,
  projectId: string,
): Promise<string[]> {
  const bound = await db.query<{ profile_key: string }>(
    `SELECT DISTINCT extraction_policy_json->>'profile_key' AS profile_key
       FROM project_source_bindings
      WHERE space_id = $1 AND project_id = $2 AND status = 'active'
        AND extraction_policy_json ? 'profile_key'`,
    [spaceId, projectId],
  );
  return [...defaultExtractionProfileRegistry.domainCriteriaKeysFor(
    bound.rows.map((row) => row.profile_key),
  )].sort();
}

export async function loadProjectScreeningCriteria(
  db: Queryable,
  spaceId: string,
  projectId: string,
): Promise<ProjectScreeningCriteria> {
  const [stored, available] = await Promise.all([
    db.query<{
      include_keywords_json: unknown;
      exclude_keywords_json: unknown;
      domain_criteria_json: unknown;
      date_range_start: unknown;
      date_range_end: unknown;
      source_restrictions_json: unknown;
      required_evidence_fields_json: unknown;
    }>(
      `SELECT include_keywords_json, exclude_keywords_json, domain_criteria_json,
              date_range_start, date_range_end, source_restrictions_json,
              required_evidence_fields_json
         FROM project_research_screening_criteria
        WHERE space_id = $1 AND project_id = $2
        LIMIT 1`,
      [spaceId, projectId],
    ),
    availableProjectDomainCriteria(db, spaceId, projectId),
  ]);
  const row = stored.rows[0];
  if (!row) {
    return {
      include_keywords: [],
      exclude_keywords: [],
      domain_criteria: {},
      date_range_start: null,
      date_range_end: null,
      source_restrictions: [],
      required_evidence_fields: [],
    };
  }
  const rawDomain = objectValue(row.domain_criteria_json);
  const allowed = new Set(available);
  return {
    include_keywords: strings(row.include_keywords_json),
    exclude_keywords: strings(row.exclude_keywords_json),
    domain_criteria: Object.fromEntries(
      Object.entries(rawDomain)
        .filter(([key]) => allowed.has(key))
        .map(([key, value]) => [key, strings(value)]),
    ),
    date_range_start: typeof row.date_range_start === "string"
      ? row.date_range_start.slice(0, 10)
      : row.date_range_start instanceof Date ? row.date_range_start.toISOString().slice(0, 10) : null,
    date_range_end: typeof row.date_range_end === "string"
      ? row.date_range_end.slice(0, 10)
      : row.date_range_end instanceof Date ? row.date_range_end.toISOString().slice(0, 10) : null,
    source_restrictions: strings(row.source_restrictions_json),
    required_evidence_fields: strings(row.required_evidence_fields_json),
  };
}

export function hasProjectScreeningCriteria(criteria: ProjectScreeningCriteria): boolean {
  return criteria.include_keywords.length > 0
    || criteria.exclude_keywords.length > 0
    || Object.values(criteria.domain_criteria).some((values) => values.length > 0)
    || criteria.date_range_start !== null
    || criteria.date_range_end !== null
    || criteria.source_restrictions.length > 0
    || criteria.required_evidence_fields.length > 0;
}
