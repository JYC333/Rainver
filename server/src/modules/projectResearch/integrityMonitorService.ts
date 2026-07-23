import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";
import { objectValue, optionalString, withQueryableTransaction } from "../routeUtils/common";
import { PgJobQueueRepository } from "../jobs/repository";

export type ResearchIntegrityEventType = "retraction" | "correction" | "expression_of_concern" | "reinstatement";
export type ResearchIntegrityAlert = {
  doi: string;
  source_item_id: string | null;
  event_key: string;
  event_type: ResearchIntegrityEventType;
  source: string;
  notice_doi: string | null;
  detail: Record<string, unknown>;
};

type CrossrefFetcher = (doi: string) => Promise<unknown>;

export class ProjectResearchIntegrityMonitorService {
  constructor(private readonly db: Queryable, private readonly fetcher: CrossrefFetcher = fetchCrossrefWork) {}

  async check(input: { spaceId: string; projectId: string; workflowId: string; userId: string | null }) {
    const workflow = await this.db.query<{ id: string }>(
      `SELECT id FROM project_research_workflows WHERE id=$1 AND space_id=$2 AND project_id=$3`,
      [input.workflowId, input.spaceId, input.projectId],
    );
    if (!workflow.rows[0]) throw new Error("Research integrity monitor workflow does not belong to the project");
    const cited = await this.referencedDois(input.spaceId, input.projectId);
    const discovered: ResearchIntegrityAlert[] = [];
    let failed = 0;
    for (const citation of cited) {
      try {
        const response = await this.fetcher(citation.doi);
        discovered.push(...parseCrossrefIntegrityEvents(citation.doi, citation.sourceItemId, response));
      } catch {
        // One unavailable DOI must not suppress checks for the rest of the project.
        failed += 1;
      }
    }
    if (cited.length > 0 && failed === cited.length) throw new Error("Crossref integrity lookup failed for every cited DOI");
    if (discovered.length === 0) return { checked: cited.length, failed, alerts: [], checkpointId: null, checklistItemIds: [] };
    return withQueryableTransaction(this.db, async (db) => {
      const now = new Date().toISOString();
      const inserted: Array<ResearchIntegrityAlert & { id: string }> = [];
      for (const alert of discovered) {
        const id = randomUUID();
        const result = await db.query<{ id: string }>(
          `INSERT INTO research_integrity_alerts (
             id,space_id,project_id,source_item_id,doi,event_key,event_type,source,notice_doi,detail_json,detected_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
           ON CONFLICT (space_id,project_id,event_key) DO NOTHING RETURNING id`,
          [id, input.spaceId, input.projectId, alert.source_item_id, alert.doi, alert.event_key,
            alert.event_type, alert.source, alert.notice_doi, JSON.stringify(alert.detail), now],
        );
        if (result.rows[0]) inserted.push({ ...alert, id });
      }
      if (inserted.length === 0) return { checked: cited.length, failed, alerts: [], checkpointId: null, checklistItemIds: [] };
      const digestAlerts = inserted.map((alert) => ({
        id: alert.id, doi: alert.doi, event_type: alert.event_type, source: alert.source,
        notice_doi: alert.notice_doi, detected_at: now,
      }));
      for (const alert of digestAlerts) await db.query(
        `INSERT INTO research_scan_summaries (
           id,space_id,project_id,workflow_id,operation_id,scan_key,scanned_at,
           new_item_count,relevant_count,maybe_count,excluded_count,supports_count,
           contradicts_count,new_direction_count,comparisons_json,integrity_alerts_json,created_at
         ) VALUES ($1,$2,$3,$4,NULL,$5,$6,0,0,0,0,0,0,0,'[]'::jsonb,$7::jsonb,$6)`,
        [randomUUID(), input.spaceId, input.projectId, input.workflowId,
          `integrity:${alert.id}`, now, JSON.stringify([alert])],
      );
      const checkpointId = randomUUID();
      await db.query(
        `INSERT INTO project_research_checkpoints (
           id,space_id,project_id,workflow_id,stage_key,checkpoint_type,status,machine_result_json,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,'monitoring','integrity_gate','pending',$5::jsonb,$6,$6)`,
        [checkpointId, input.spaceId, input.projectId, input.workflowId,
          JSON.stringify({ alert_ids: inserted.map((alert) => alert.id), alerts: digestAlerts }), now],
      );
      const checklistItemIds: string[] = [];
      for (const alert of inserted) {
        const itemId = randomUUID();
        await db.query(
          `INSERT INTO research_checklist_items (id,space_id,project_id,text,status,sort_order,origin,created_at,updated_at)
           SELECT $1::varchar,$2::varchar,$3::varchar,$4::text,'open',COALESCE(max(sort_order)+1,0),'agent',$5::timestamptz,$5::timestamptz FROM research_checklist_items WHERE space_id=$2::varchar AND project_id=$3::varchar`,
          [itemId, input.spaceId, input.projectId,
            `Review ${humanEventType(alert.event_type)} notice for DOI ${alert.doi}${alert.notice_doi ? ` (${alert.notice_doi})` : ""}`.slice(0, 2000), now],
        );
        checklistItemIds.push(itemId);
      }
      return { checked: cited.length, failed, alerts: inserted, checkpointId, checklistItemIds };
    });
  }

  private async referencedDois(spaceId: string, projectId: string): Promise<Array<{ doi: string; sourceItemId: string | null }>> {
    const sourceRefs = new Set<string>();
    const evidenceRefs = new Set<string>();
    const directDois = new Set<string>();
    const sections = await this.db.query<{ refs_json: unknown }>(
      `SELECT n.refs_json FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
        WHERE so.space_id=$1 AND so.primary_project_id=$2 AND so.status='active'`,
      [spaceId, projectId],
    );
    for (const row of sections.rows) {
      if (Array.isArray(row.refs_json)) {
        for (const value of row.refs_json) if (typeof value === "string" && value.trim()) sourceRefs.add(value.trim());
      }
      collectReferenceValues(row.refs_json, sourceRefs, evidenceRefs, directDois);
    }
    const reports = await this.db.query<{ content_json: unknown }>(
      `SELECT content_json FROM project_research_reports WHERE space_id=$1 AND project_id=$2 AND status <> 'rejected'`,
      [spaceId, projectId],
    );
    for (const row of reports.rows) collectReferenceValues(row.content_json, sourceRefs, evidenceRefs, directDois);
    if (evidenceRefs.size > 0) {
      const evidence = await this.db.query<{ source_item_id: string | null }>(
        `SELECT DISTINCT source_item_id FROM extracted_evidence
          WHERE space_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL`,
        [spaceId, [...evidenceRefs]],
      );
      for (const row of evidence.rows) if (row.source_item_id) sourceRefs.add(row.source_item_id);
    }
    const mapped = sourceRefs.size > 0 ? await this.db.query<{ source_item_id: string; doi: string | null }>(
      `SELECT DISTINCT pcis.source_item_id,
              COALESCE(ap.doi,NULLIF(si.metadata_json->>'doi','')) AS doi
         FROM project_corpus_item_sources pcis
         JOIN project_corpus_items pci ON pci.id=pcis.corpus_item_id AND pci.space_id=pcis.space_id
         JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
         LEFT JOIN academic_papers ap ON ap.object_id=pci.object_id AND ap.space_id=pci.space_id
        WHERE pcis.space_id=$1 AND pcis.project_id=$2 AND pcis.source_item_id=ANY($3::text[])`,
      [spaceId, projectId, [...sourceRefs]],
    ) : { rows: [] as Array<{ source_item_id: string; doi: string | null }> };
    const values = new Map<string, string | null>();
    for (const row of mapped.rows) if (row.doi) values.set(normalizeDoi(row.doi), row.source_item_id);
    for (const doi of directDois) if (!values.has(normalizeDoi(doi))) values.set(normalizeDoi(doi), null);
    return [...values].filter(([doi]) => doi.length > 0).map(([doi, sourceItemId]) => ({ doi, sourceItemId }));
  }
}

export async function enqueueDueResearchIntegrityChecks(db: Queryable, now = new Date()): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const due = await db.query<{ space_id: string; project_id: string; workflow_id: string; user_id: string | null }>(
    `SELECT DISTINCT ON (w.space_id,w.project_id) w.space_id,w.project_id,w.id AS workflow_id,w.started_by_user_id AS user_id
       FROM project_research_workflows w
      WHERE w.status='active' AND w.current_stage='monitoring'
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.space_id=w.space_id AND j.job_type='project_research_integrity_monitor'
             AND j.payload_json->>'project_id'=w.project_id
             AND j.payload_json->>'schedule_day'=$1
        )
      ORDER BY w.space_id,w.project_id,w.updated_at DESC`,
    [day],
  );
  const queue = new PgJobQueueRepository(db);
  for (const row of due.rows) await queue.enqueue({
    job_type: "project_research_integrity_monitor",
    space_id: row.space_id,
    user_id: row.user_id,
    payload: { project_id: row.project_id, workflow_id: row.workflow_id, schedule_day: day },
  }, now);
  return due.rows.length;
}

export function parseCrossrefIntegrityEvents(doi: string, sourceItemId: string | null, response: unknown): ResearchIntegrityAlert[] {
  const message = objectValue(objectValue(response).message);
  const entries = [
    ...(Array.isArray(message["updated-by"]) ? message["updated-by"] : []),
    ...(Array.isArray(message["update-to"]) ? message["update-to"] : []),
  ];
  const alerts: ResearchIntegrityAlert[] = [];
  for (const raw of entries) {
    const entry = objectValue(raw);
    const eventType = normalizeEventType(optionalString(entry.type));
    if (!eventType) continue;
    const noticeDoi = optionalString(entry.DOI) ?? optionalString(entry.doi);
    const source = (optionalString(entry.source) ?? "crossref").slice(0, 64);
    const detail = { ...entry, queried_doi: normalizeDoi(doi) };
    const eventKey = createHash("sha256").update(JSON.stringify({
      doi: normalizeDoi(doi), eventType, noticeDoi: noticeDoi ? normalizeDoi(noticeDoi) : null, source,
    })).digest("hex");
    alerts.push({ doi: normalizeDoi(doi), source_item_id: sourceItemId, event_key: eventKey,
      event_type: eventType, source, notice_doi: noticeDoi ? normalizeDoi(noticeDoi) : null, detail });
  }
  return [...new Map(alerts.map((alert) => [alert.event_key, alert])).values()];
}

async function fetchCrossrefWork(doi: string): Promise<unknown> {
  const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { accept: "application/json", "user-agent": "AgentSpace/1.0 (mailto:admin@localhost)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Crossref returned HTTP ${response.status}`);
  return response.json();
}

function collectReferenceValues(value: unknown, sourceRefs: Set<string>, evidenceRefs: Set<string>, dois: Set<string>): void {
  if (Array.isArray(value)) { for (const item of value) collectReferenceValues(item, sourceRefs, evidenceRefs, dois); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const sourceItemId = optionalString(record.source_item_id);
  const evidenceId = optionalString(record.evidence_id);
  const doi = optionalString(record.doi);
  if (sourceItemId) sourceRefs.add(sourceItemId);
  if (evidenceId) evidenceRefs.add(evidenceId);
  if (doi) dois.add(doi);
  for (const child of Object.values(record)) collectReferenceValues(child, sourceRefs, evidenceRefs, dois);
}

function normalizeEventType(value: string | null): ResearchIntegrityEventType | null {
  const normalized = value?.trim().toLowerCase().replace(/[ -]+/g, "_") ?? "";
  return ["retraction", "correction", "expression_of_concern", "reinstatement"].includes(normalized)
    ? normalized as ResearchIntegrityEventType : null;
}
function normalizeDoi(value: string): string { return value.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").slice(0, 512); }
function humanEventType(value: ResearchIntegrityEventType): string { return value.replaceAll("_", " "); }
