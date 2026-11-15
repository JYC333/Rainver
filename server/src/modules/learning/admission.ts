import {HttpError,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {lockSourceRetrievalRelease} from '../sources/retrievalReleaseLocks.js';
import {assertProjectReadableLocked,assertProjectWriter} from '../projects/access.js';
import {contentReadSql} from '../access/contentAccessSql.js';
type Kind='objective'|'item'|'review';
/** Complete authority-free discovery before Projects/person/objects/internal roots.
 * Kept on the actual writer path as well as core admission and cached replay. */
export async function authorizeLearning(db:Queryable,person:SpaceUserIdentity,kind:Kind,input:Record<string,unknown>):Promise<void>{
 const discover=async()=>{
  const item=kind==='review'?(await db.query<{project_id:string|null}>('SELECT project_id FROM learning_items WHERE id=$1 AND space_id=$2',[input.item_id,person.spaceId])).rows[0]:null;
  if(kind==='review'&&!item)throw new HttpError(404,'Learning Item not found');
  const objective=kind==='item'&&input.objective_id?(await db.query<{project_id:string|null}>('SELECT project_id FROM learning_objectives WHERE id=$1 AND space_id=$2',[input.objective_id,person.spaceId])).rows[0]:null;
  if(kind==='item'&&input.objective_id&&!objective)throw new HttpError(422,'objective_id not found in this Space');
  return {item:item??null,objective:objective??null};
 };
 const before=await discover();
 const destination=typeof input.project_id==='string'?input.project_id:null;
 const projects=[...new Set([destination,before.item?.project_id,before.objective?.project_id].filter((v):v is string=>!!v))].sort();
 const refs=kind==='item'?[{object_type:'space_object' as const,object_id:String(input.knowledge_item_id)}]:[];
 await lockSourceRetrievalRelease(db,person.spaceId,person.userId,refs,projects,undefined,[],[],[],kind==='review'?[]:projects);
 for(const project of projects){
  if(kind==='review')await assertProjectReadableLocked(db,person.spaceId,project,person.userId);
  else await assertProjectWriter(db,person.spaceId,project,person.userId);
 }
 if(kind==='item'&&input.objective_id)await db.query('SELECT id FROM learning_objectives WHERE id=$1 AND space_id=$2 FOR SHARE',[input.objective_id,person.spaceId]);
 if(kind==='review')await db.query('SELECT id FROM learning_items WHERE id=$1 AND space_id=$2 FOR SHARE',[input.item_id,person.spaceId]);
 if(JSON.stringify(before)!==JSON.stringify(await discover()))throw new HttpError(409,'Learning scope changed; read again');
 if(before.objective?.project_id&&before.objective.project_id!==destination)throw new HttpError(422,'objective_id belongs to a different Project');
 if(kind==='item'){
  const knowledge=await db.query(`SELECT ki.object_id FROM knowledge_items ki JOIN space_objects so ON so.id=ki.object_id AND so.space_id=ki.space_id WHERE ki.object_id=$1 AND ki.space_id=$2 AND so.visibility='space_shared' AND ${contentReadSql('space_object','so','$3')} FOR SHARE OF ki`,[input.knowledge_item_id,person.spaceId,person.userId]);
  if(!knowledge.rows[0])throw new HttpError(404,'Shared Knowledge item not found or inaccessible');
 }
}
