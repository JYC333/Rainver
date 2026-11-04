import {researchMetadataReadableSql} from "../projectResearch/researchOperationMetadata.js";
import {ProjectOperationRepository} from "./projectOperationRepository.js";
import {objectValue,type Queryable} from "../routeUtils/common.js";

/** An Operation in one of these has stopped; everything else is still work. */
const FINISHED_STATUSES = ["completed", "failed", "cancelled"];

interface RunningProjectOperation {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  status: string;
  progress_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * The Project's unfinished Operations, for the front page.
 *
 * Only the fields the shared `researchOperationDetail`/`researchOperationPercent`
 * renderers read — the front page shows the same sentence the Research Area
 * does rather than a second, quieter version of it, and does so from its own
 * read model rather than by calling an Area's endpoint.
 */
export async function listRunningProjectOperations(
  db: Queryable,
  spaceId: string,
  projectId: string,
  userId?:string,
): Promise<RunningProjectOperation[]> {
  const rows = await db.query<{
    id: string; project_id: string; kind: string; title: string; status: string;bound:boolean;
    progress_json: Record<string, unknown> | null; created_at: Date | string; updated_at: Date | string;
  }>(
    `SELECT id, project_id, kind, title, status, progress_json, created_at, updated_at,research_call_json IS NOT NULL AS bound
       FROM project_operations op
      WHERE space_id = $1 AND project_id = $2 AND NOT (status = ANY ($3::varchar[])) AND (($4::varchar IS NULL AND research_call_json IS NULL) OR ($4::varchar IS NOT NULL AND ${researchMetadataReadableSql('op','$4')}))
      ORDER BY updated_at DESC
      LIMIT 6`,
    [spaceId, projectId, FINISHED_STATUSES,userId??null],
  );
  const repository=new ProjectOperationRepository(db),visible:RunningProjectOperation[]=[];
  for(const row of rows.rows){
    // Old unbound records retain their existing projection and status semantics.
    const op:Record<string,unknown>=userId&&row.bound?await repository.get({spaceId,userId},projectId,row.id):row;
    visible.push({id:String(op.id),project_id:String(op.project_id),kind:String(op.kind),title:String(op.title),status:String(op.status),progress_json:objectValue(op.progress_json),created_at:op.created_at instanceof Date?op.created_at.toISOString():String(op.created_at),updated_at:op.updated_at instanceof Date?op.updated_at.toISOString():String(op.updated_at)});
  }
  return visible;
}
