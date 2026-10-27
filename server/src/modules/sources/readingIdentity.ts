/** A frozen Sources capture identity survives metadata/raw/text hash changes.
 * Retained body conflicts or actual revisions partition that family by body.
 * Unknown material never joins by URL/title alone. */
export function readingFamilySql(alias: string): string {
  return `(CASE WHEN NULLIF(${alias}.canonical_uri,'') IS NOT NULL AND NULLIF(${alias}.reading_initial_hash,'') IS NOT NULL
    THEN 'capture:' || encode(sha256(convert_to(jsonb_build_array(${alias}.canonical_uri,${alias}.reading_initial_hash)::text,'UTF8')),'hex')
    ELSE 'item:' || ${alias}.id END)`;
}
export function readingIdentitySql(alias: string, family: string): string {
  const split = `${family}.split_body`;
  return `(CASE WHEN ${split} AND NULLIF(${alias}.canonical_uri,'') IS NOT NULL AND ${alias}.reading_body_hash IS NOT NULL
    THEN 'body:' || encode(sha256(convert_to(jsonb_build_array(${alias}.canonical_uri,${alias}.reading_body_hash)::text,'UTF8')),'hex')
    WHEN ${split} THEN 'item:' || ${alias}.id
    WHEN ${family}.shared_body THEN 'body:' || encode(sha256(convert_to(jsonb_build_array(${alias}.canonical_uri,${family}.sole_body)::text,'UTF8')),'hex')
    ELSE ${readingFamilySql(alias)} END)`;
}
/** NULL is an older writer: its own state timestamp decides whether a genuine
 * body transition occurred after that read. First extraction is revision zero. */
export function readingVersionCurrentSql(item: string, state: string): string {
  return `(${state}.read_body_revision=${item}.reading_body_revision OR
    (${state}.read_body_revision IS NULL AND (${item}.reading_body_changed_at IS NULL OR ${state}.updated_at>=${item}.reading_body_changed_at)))`;
}
export function readingStatusSql(item: string, state: string): string {
  return `(CASE WHEN ${readingVersionCurrentSql(item, state)}
    THEN COALESCE(${state}.read_status,'unread') ELSE 'unread' END)`;
}

/** Shared bulk identity resolution for queue reads and indexed state-family
 * lookups. Equal retained bodies may bridge different initial capture hashes;
 * conflicting bodies never bridge through an unknown teaser-only record. */
export function readingIdentityCtesSql(source: string, output: string): string {
  return `family_base AS (
    SELECT family_key,min(canonical_uri) AS canonical_uri,min(reading_body_hash) AS sole_body,
      count(DISTINCT reading_body_hash)>1 OR bool_or(reading_body_revision>0) AS split_body
    FROM ${source} GROUP BY family_key
  ), body_families AS (
    SELECT canonical_uri,reading_body_hash,count(DISTINCT family_key)>1 AS shared_body
    FROM ${source} WHERE reading_body_hash IS NOT NULL AND canonical_uri IS NOT NULL
    GROUP BY canonical_uri,reading_body_hash
  ), families AS (
    SELECT f.*,COALESCE(b.shared_body,false) AS shared_body FROM family_base f
      LEFT JOIN body_families b ON b.canonical_uri=f.canonical_uri AND b.reading_body_hash=f.sole_body
  ), ${output} AS MATERIALIZED (
    SELECT i.*,${readingIdentitySql('i', 'family')} AS reading_key
    FROM ${source} i JOIN families family ON family.family_key=i.family_key
  )`;
}
