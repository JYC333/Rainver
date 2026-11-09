import {assertProjectReadable} from '../projects/access.js';
import {assertResearchCallReadable} from './researchCallAccess.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
/** Canonical bounded current-Project discovery; private calls are filtered by their owning read gate. */
export async function listResearchOperationRefs(db:Queryable,identity:SpaceUserIdentity,projectId:string,includeTerminal=false):Promise<Array<{operation_id:string;title:string;status:string}>> {
    // As the instructing person would read it (`ProjectOperationService.list`):
    // a Run outlives a membership revoked mid-turn, this read does not.
    await assertProjectReadable(db, identity.spaceId, projectId, identity.userId);
    const rows = await db.query<{ id: string; title: string | null; status: string;research_call_json:unknown }>(
      `SELECT id, title, status,research_call_json FROM project_operations
        WHERE space_id=$1 AND project_id=$2 AND kind='research'
          ${includeTerminal ? "" : "AND status NOT IN ('completed','cancelled','failed')"}
        ORDER BY updated_at DESC LIMIT 50`,
      [identity.spaceId, projectId],
    );
    const visible=[];
    for(const row of rows.rows){
     try{const call=await assertResearchCallReadable(db,identity,projectId,row.research_call_json,undefined,"stop");visible.push({operation_id:row.id,title:call?"Research invocation":row.title??"Research operation",status:row.status,...(call?{thread_id:call.thread_id}:{})});}
     catch(error){if(!(error instanceof HttpError)||error.statusCode!==404)throw error;}
    }
    return visible;
}
