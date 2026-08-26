import type { ContentVisibility } from "../access/contentAccessTypes.js";

export interface ContextTaintInput {
  ownerUserId: string | null;
  visibility: ContentVisibility;
}

export interface RunContextTaintSummary {
  schema_version: 1;
  narrowest_visibility: ContentVisibility;
  input_owner_user_ids: string[];
  non_instructing_owner_user_ids: string[];
  personal_memory_grant_ids: string[];
}

interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

const VISIBILITY_RANK: Record<ContentVisibility, number> = {
  private: 0,
  selected_users: 1,
  space_shared: 2,
};

export function narrowestVisibility(
  values: readonly ContentVisibility[],
): ContentVisibility {
  return values.reduce<ContentVisibility>(
    (narrowest, value) => VISIBILITY_RANK[value] < VISIBILITY_RANK[narrowest] ? value : narrowest,
    "space_shared",
  );
}

export function buildRunContextTaintSummary(input: {
  items: readonly ContextTaintInput[];
  instructingUserId: string | null;
  runVisibility: ContentVisibility;
  personalMemoryGrantIds?: readonly string[];
}): RunContextTaintSummary {
  const owners = sortedUnique(input.items.flatMap((item) => item.ownerUserId ? [item.ownerUserId] : []));
  const taintingOwners = sortedUnique(input.items.flatMap((item) =>
    item.visibility !== "space_shared" && item.ownerUserId ? [item.ownerUserId] : []
  ));
  return {
    schema_version: 1,
    narrowest_visibility: narrowestVisibility([
      input.runVisibility,
      ...input.items.map((item) => item.visibility),
    ]),
    input_owner_user_ids: owners,
    non_instructing_owner_user_ids: taintingOwners.filter((owner) => owner !== input.instructingUserId),
    personal_memory_grant_ids: sortedUnique(input.personalMemoryGrantIds ?? []),
  };
}

export function outputVisibilityForTaint(input: {
  requestedVisibility: ContentVisibility;
  runVisibility: ContentVisibility;
  taint: RunContextTaintSummary | null;
}): ContentVisibility {
  if (input.taint?.non_instructing_owner_user_ids.length) return "selected_users";
  return narrowestVisibility([
    input.requestedVisibility,
    input.runVisibility,
    input.taint?.narrowest_visibility ?? "space_shared",
  ]);
}

export function parseRunContextTaint(value: unknown): RunContextTaintSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const visibility = row.narrowest_visibility;
  if (row.schema_version !== 1 || !isVisibility(visibility)) return null;
  return {
    schema_version: 1,
    narrowest_visibility: visibility,
    input_owner_user_ids: stringArray(row.input_owner_user_ids),
    non_instructing_owner_user_ids: stringArray(row.non_instructing_owner_user_ids),
    personal_memory_grant_ids: stringArray(row.personal_memory_grant_ids),
  };
}

export async function persistRunContextTaint(
  db: Queryable,
  input: {
    runId: string;
    spaceId: string;
    instructingUserId: string | null;
    runVisibility: ContentVisibility;
    items: readonly ContextTaintInput[];
    personalMemoryGrantIds?: readonly string[];
  },
): Promise<RunContextTaintSummary> {
  const previousResult = await db.query<{ context_taint_json: unknown }>(
    `SELECT context_taint_json FROM runs WHERE id=$1 AND space_id=$2 FOR UPDATE`,
    [input.runId, input.spaceId],
  );
  const previous = parseRunContextTaint(previousResult.rows[0]?.context_taint_json);
  const current = buildRunContextTaintSummary(input);
  const summary: RunContextTaintSummary = {
    schema_version: 1,
    narrowest_visibility: narrowestVisibility([
      current.narrowest_visibility,
      previous?.narrowest_visibility ?? "space_shared",
    ]),
    input_owner_user_ids: sortedUnique([
      ...(previous?.input_owner_user_ids ?? []),
      ...current.input_owner_user_ids,
    ]),
    non_instructing_owner_user_ids: sortedUnique([
      ...(previous?.non_instructing_owner_user_ids ?? []),
      ...current.non_instructing_owner_user_ids,
    ]),
    personal_memory_grant_ids: sortedUnique([
      ...(previous?.personal_memory_grant_ids ?? []),
      ...current.personal_memory_grant_ids,
    ]),
  };
  const hasTaint = summary.narrowest_visibility !== "space_shared"
    || summary.non_instructing_owner_user_ids.length > 0
    || summary.personal_memory_grant_ids.length > 0;
  await db.query(
    `UPDATE runs
        SET has_context_taint = $1,
            context_taint_json = $2::jsonb,
            updated_at = $3
      WHERE id = $4 AND space_id = $5`,
    [hasTaint, JSON.stringify(summary), new Date().toISOString(), input.runId, input.spaceId],
  );
  return summary;
}

function isVisibility(value: unknown): value is ContentVisibility {
  return value === "private" || value === "selected_users" || value === "space_shared";
}

function stringArray(value: unknown): string[] {
  return sortedUnique(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
