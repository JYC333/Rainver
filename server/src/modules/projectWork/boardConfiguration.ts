import { randomUUID } from 'node:crypto';
import { BoardConfigurationInputSchema } from '@rainver/protocol';
import type { Pool } from '../../db/pool.js';
import { HttpError, withDbTransaction, type SpaceUserIdentity } from '../routeUtils/common.js';
import { assertProjectWriterForMutation, lockActiveProjectForMutation } from '../projects/access.js';
import { contentReadSql, contentAccessLevelSql } from '../access/contentAccessSql.js';
import { contentResourceDefinition } from '../access/contentAccessRegistry.js';
import { columnForTask, insertProjectBoard, readProjectColumns } from '../tasks/boardColumns.js';
import { PgTaskRepository } from '../tasks/repository.js';

/** Project lock serializes configuration with Task creation, movement and Run
 * admission. A failed task relocation rolls back the complete configuration. */
export async function configureProjectBoard(pool:Pool,identity:SpaceUserIdentity,projectId:string,input:unknown,origin?:{actorId:string;runId:string;projectId:string;reason:string}) {
  const parsed=BoardConfigurationInputSchema.safeParse(input);
  if(origin&&origin.projectId!==projectId)throw new HttpError(404,"Project not found");
  if(!parsed.success)throw new HttpError(422,'Invalid Board columns');
  const body=parsed.data;
  if(new Set(body.columns.map(c=>c.key)).size!==body.columns.length)throw new HttpError(422,'Column keys must be unique');
  await withDbTransaction(pool,async db=>{
    await lockActiveProjectForMutation(db,identity.spaceId,projectId);
    await assertProjectWriterForMutation(db,identity.spaceId,projectId,identity.userId);
    const before=await readProjectColumns(db,identity.spaceId,projectId);
    if(before.revision!==body.revision)throw new HttpError(409,'Board columns changed; reload before saving');
    const previous=new Map(before.columns.map(c=>[c.key,c]));
    for(const c of body.columns){
      const old=previous.get(c.key);
      if(!old && !c.key.startsWith('new:'))throw new HttpError(422,'Unknown column key');
    }
    const boardId=before.boardId??await insertProjectBoard(db,identity.spaceId,projectId,identity.userId);
    const ids=new Map<string,string>();
    for(const [position,c] of body.columns.entries()){
      const old=previous.get(c.key);
      const id=old?.board_id ? old.key : randomUUID();
      ids.set(c.key,id);
      if(old?.board_id)await db.query(`UPDATE board_columns SET name=$3,position=$4,wip_limit=$5,status_key=$6,is_done_column=$7,updated_at=now()
        WHERE space_id=$1 AND id=$2`,[identity.spaceId,id,c.label,position,c.wip_limit,c.status_key,c.status_key==='done']);
      else await db.query(`INSERT INTO board_columns(id,space_id,board_id,name,status_key,position,wip_limit,is_done_column,is_default_column,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())`,[id,identity.spaceId,boardId,c.label,c.status_key,position,c.wip_limit,c.status_key==='done',position===0]);
    }
    const tasks=(await db.query<{id:string;status:string;column_id:string|null;full:boolean}>(`SELECT t.id,t.status,t.column_id,
      (${contentReadSql('task','t','$3')} AND ${contentAccessLevelSql({definition:contentResourceDefinition('task')!,alias:'t',userExpr:'$3'})}='full') AS full
      FROM tasks t WHERE t.space_id=$1 AND t.project_id=$2 AND t.deleted_at IS NULL ORDER BY t.id FOR UPDATE OF t`,
      [identity.spaceId,projectId,identity.userId])).rows;
    const removed=before.columns.filter(c=>!ids.has(c.key));
    const repository=new PgTaskRepository(pool);
    const remapped=before.columns.filter(c=>body.columns.some(next=>next.key===c.key&&next.status_key!==c.status_key));
    for(const removedColumn of [...removed,...remapped]){
      const affected=tasks.filter(t=>columnForTask(t,before.columns)===removedColumn.key);
      const destination=body.columns.find(c=>c.key===(ids.has(removedColumn.key)?removedColumn.key:body.moves[removedColumn.key]));
      if(affected.length && !destination)throw new HttpError(409,'Choose a destination for tasks in the deleted column');
      for(const task of affected){
        if(!task.full)throw new HttpError(403,'The column contains Tasks you cannot move');
        await repository.updateTask(identity,task.id,{column_id:ids.get(destination!.key),board_id:boardId,status:task.status==='blocked'&&removedColumn.status_key==='in_progress'&&destination!.status_key==='in_progress'?'blocked':destination!.status_key},origin,db);
      }
    }
    // Materialized default columns keep their Tasks through the first save.
    for(const c of before.columns.filter(c=>ids.has(c.key) && !c.board_id)){
      const affected=tasks.filter(t=>columnForTask(t,before.columns)===c.key);
      if(affected.length)await db.query(`UPDATE tasks SET board_id=$3,column_id=$4 WHERE space_id=$1 AND id=ANY($2::varchar[])`,
        [identity.spaceId,affected.map(t=>t.id),boardId,ids.get(c.key)]);
    }
    const removedIds=removed.filter(c=>c.board_id).map(c=>c.key);
    if(removedIds.length){
      // Stale placement (e.g. a Run changed status) is not a workflow change.
      await db.query(`UPDATE tasks SET column_id=NULL WHERE space_id=$1 AND board_id=$2 AND column_id=ANY($3::varchar[])`,[identity.spaceId,boardId,removedIds]);
      await db.query(`UPDATE board_columns SET deleted_at=now(),updated_at=now() WHERE space_id=$1 AND id=ANY($2::varchar[])`,[identity.spaceId,removedIds]);
    }
    await db.query(`UPDATE boards SET updated_at=now() WHERE space_id=$1 AND id=$2`,[identity.spaceId,boardId]);
  });
}
