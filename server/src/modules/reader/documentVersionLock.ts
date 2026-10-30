import { HttpError, type Queryable } from "../routeUtils/common.js";

/**
 * Holds the row whose update changes a document's content, for the rest of the
 * transaction (`FOR SHARE`: concurrent position writes proceed; a content
 * writer waits, or is waited for). Source items: `source_items` (the canonical
 * writer `saveSourceReadingDocument` locks and updates it); snapshots: their
 * row (content is an immutable artifact); research reports and notes: the row
 * that holds the content.
 */
export async function lockDocumentVersion(tx: Queryable, spaceId: string, documentType: string, documentId: string): Promise<void> {
  const table: Record<string, string> = {
    source_item: "SELECT 1 FROM source_items WHERE space_id=$1 AND id=$2 FOR SHARE",
    source_snapshot: "SELECT 1 FROM source_snapshots WHERE space_id=$1 AND id=$2 FOR SHARE",
    research_report: "SELECT 1 FROM project_research_reports WHERE space_id=$1 AND id=$2 FOR SHARE",
    research_notebook: "SELECT 1 FROM notes WHERE space_id=$1 AND object_id=$2 FOR SHARE",
  };
  const sql = table[documentType];
  if (!sql) throw new HttpError(400, `Unsupported document type: ${documentType}`);
  await tx.query(sql, [spaceId, documentId]);
}
