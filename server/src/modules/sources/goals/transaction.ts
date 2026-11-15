import {HttpError,withQueryableTransaction,type Queryable,type QueryResult} from '../../routeUtils/common.js';
/** The goal writers' row access (rows untyped unless named, as on a pg client),
 * now joining a caller's transaction — an operation's, or opening one on a pool. */
export interface GoalTx extends Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<Row=any>(sql:string,params?:readonly unknown[]):Promise<QueryResult<Row>>;
}
export const goalTransaction=<T>(db:Queryable,fn:(tx:GoalTx)=>Promise<T>):Promise<T>=>withQueryableTransaction(db,tx=>fn(tx as GoalTx));
/**
 * The Goal writer lock, in the canonical cross-domain closure order (Project
 * audience before context roots; DATABASE_AND_TRANSACTIONS.md): the owning
 * Project row first, then the Goal row. Every Goal writer, the collection
 * commit and a briefing/reading Delivery (Project share → Goal share) take the
 * two in this order, so none of them can hold the Goal while waiting for the
 * Project. A Goal moved to another Project between discovery and lock is a
 * conflict, never a lock taken on the wrong Project.
 */
export async function lockGoal(db:Queryable,goalId:string,mode:'update'|'share'='update',spaceId?:string):Promise<void>{
  const lock=mode==='update'?'FOR UPDATE':'FOR SHARE',scope=spaceId?' AND space_id=$2':'',args=spaceId?[goalId,spaceId]:[goalId];
  const before=(await db.query<{space_id:string;project_id:string|null}>(`SELECT space_id,project_id FROM source_goals WHERE id=$1${scope}`,args)).rows[0];
  if(!before)return;
  if(before.project_id)await db.query(`SELECT id FROM projects WHERE id=$1 AND space_id=$2 ${lock}`,[before.project_id,before.space_id]);
  const locked=(await db.query<{project_id:string|null}>(`SELECT project_id FROM source_goals WHERE id=$1${scope} ${lock}`,args)).rows[0];
  if(locked&&locked.project_id!==before.project_id)throw new HttpError(409,'Goal Project changed; try again');
}
