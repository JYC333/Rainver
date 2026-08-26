type QueryResult<Row> = { rows: Row[]; rowCount: number };

export function handleSourceRetrievalTestSql<Row = Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): QueryResult<Row> | null {
  const norm = sql.replace(/\s+/g, " ").trim();

  if (
    (
      norm.startsWith("SELECT id, connection_id, item_type, title, source_uri, canonical_uri,") ||
      norm.startsWith("SELECT id, owner_user_id, visibility, access_level, connection_id,") ||
      norm.startsWith("SELECT id, space_id, connection_id, item_type, title")
    ) &&
    norm.includes("FROM source_items")
  ) {
    return empty<Row>();
  }
  if (
    (
      norm.startsWith("SELECT ee.id, ee.source_item_id, ss.connection_id AS source_snapshot_connection_id,") ||
      norm.startsWith("SELECT ee.id, ee.owner_user_id, ee.visibility, ee.access_level,")
    ) &&
    norm.includes("FROM extracted_evidence ee")
  ) {
    return empty<Row>();
  }
  if (
    norm.startsWith("SELECT id FROM extracted_evidence") ||
    norm.startsWith("SELECT source_item_id FROM extracted_evidence")
  ) {
    return empty<Row>();
  }
  if (
    norm.startsWith("SELECT pl.target_id,") &&
    norm.includes("FROM provenance_links pl")
  ) {
    return empty<Row>();
  }
  if (
    norm.startsWith("SELECT cs.claim_id, cs.source_object_id,") &&
    norm.includes("FROM claim_sources cs")
  ) {
    return empty<Row>();
  }
  if (
    norm.startsWith("SELECT r.from_object_id, from_so.object_type AS from_object_type,") &&
    norm.includes("FROM object_relations r")
  ) {
    return empty<Row>();
  }
  if (
    norm.startsWith("DELETE FROM retrieval_edges") ||
    norm.startsWith("DELETE FROM retrieval_objects")
  ) {
    return empty<Row>();
  }
  if (norm.startsWith("INSERT INTO retrieval_objects")) {
    return {
      rows: [{ id: "retrieval-object-test" } as Row],
      rowCount: 1,
    };
  }
  if (
    norm.startsWith("INSERT INTO retrieval_aliases") ||
    norm.startsWith("INSERT INTO retrieval_chunks") ||
    norm.startsWith("INSERT INTO retrieval_edges")
  ) {
    return { rows: [] as Row[], rowCount: 1 };
  }
  if (norm.startsWith("SELECT DISTINCT object_type, object_id FROM retrieval_aliases")) {
    return empty<Row>();
  }
  if (norm.startsWith("SELECT id, space_id, user_id, project_folder_id, agent_id, job_type, status")) {
    return empty<Row>();
  }
  if (norm.startsWith("INSERT INTO jobs")) {
    return {
      rows: [jobRow(params) as Row],
      rowCount: 1,
    };
  }
  if (norm.startsWith("INSERT INTO project_corpus_items")) {
    return { rows: [] as Row[], rowCount: 0 };
  }

  return null;
}

function empty<Row>(): QueryResult<Row> {
  return { rows: [] as Row[], rowCount: 0 };
}

function jobRow(params: readonly unknown[]): Record<string, unknown> {
  const now = String(params[10] ?? new Date(0).toISOString());
  return {
    id: String(params[0]),
    space_id: String(params[1]),
    user_id: nullableString(params[2]),
    project_folder_id: nullableString(params[3]),
    agent_id: nullableString(params[4]),
    job_type: String(params[5]),
    status: "pending",
    priority: typeof params[6] === "number" ? params[6] : 0,
    payload_json: parseJsonObject(params[7]),
    result_json: null,
    error: null,
    attempts: 0,
    max_attempts: typeof params[8] === "number" ? params[8] : 3,
    scheduled_at: String(params[9] ?? now),
    claimed_by: null,
    claimed_at: null,
    started_at: null,
    completed_at: null,
    heartbeat_at: null,
    created_at: now,
    updated_at: now,
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
