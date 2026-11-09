import { BoardColumnSelectionSchema } from "@rainver/protocol";
import { createHash, randomUUID } from "node:crypto";
import type { ProjectBoardColumn } from "@rainver/protocol";
import { DEFAULT_COLUMNS } from "./taskRepositoryRows.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";

export class BoardMutationError extends HttpError {}

export type BoardColumn = Omit<ProjectBoardColumn, "count">;
export const UNASSIGNED_COLUMN = "unassigned";

export async function readProjectColumns(db: Queryable, spaceId: string, projectId: string) {
  const board = (await db.query<{id:string}>(`SELECT id FROM boards WHERE space_id=$1 AND project_id=$2
    AND deleted_at IS NULL AND status='active' ORDER BY sort_order NULLS LAST,created_at,id LIMIT 1`, [spaceId,projectId])).rows[0];
  const rows = board ? (await db.query<{id:string;name:string;status_key:string;wip_limit:number|null}>(
    `SELECT id,name,status_key,wip_limit FROM board_columns WHERE space_id=$1 AND board_id=$2 AND deleted_at IS NULL ORDER BY position,id`, [spaceId,board.id])).rows : [];
  const columns: BoardColumn[] = rows.length ? rows.map(c=>({key:c.id,label:c.name,status_key:c.status_key,wip_limit:c.wip_limit,board_id:board!.id}))
    : DEFAULT_COLUMNS.map(c=>({key:c.status_key,label:c.name,status_key:c.status_key,wip_limit:null,board_id:null}));
  const revision = createHash('sha256').update(JSON.stringify(columns)).digest('hex');
  return {boardId:board?.id??null,columns,revision};
}

/** Placement is honoured only while it agrees with the Task's lifecycle.
 * Agent/settlement status changes therefore cannot strand a card in Done. */
export function columnForTask(task:{status:string;column_id:string|null}, columns:BoardColumn[]):string {
  const status = task.status==='blocked' && !columns.some(c=>c.status_key==='blocked') ? 'in_progress' : task.status;
  return columns.find(c=>c.key===task.column_id && (c.status_key===task.status || task.status==='blocked' && c.status_key==='in_progress'))?.key
    ?? columns.find(c=>c.status_key===status)?.key ?? UNASSIGNED_COLUMN;
}

export async function selectBoardColumn(db:Queryable,spaceId:string,projectId:string|null,input:unknown){
  const parsed=BoardColumnSelectionSchema.safeParse(input);
  if(!parsed.success)throw new BoardMutationError(422,"Invalid Board column selection");
  if(!projectId)throw new BoardMutationError(422,"A Board column requires a Project");
  const board=await readProjectColumns(db,spaceId,projectId);
  if(board.revision!==parsed.data.columns_revision)throw new BoardMutationError(409,"Board columns changed; read board.read again");
  const column=board.columns.find(c=>c.key===parsed.data.column_key);
  if(!column)throw new BoardMutationError(404,"Board column not found");
  return column;
}

/** Validate placement in the Task's Project; never infer authority from a column ID. */
export async function taskColumnPlacement(db:Queryable,spaceId:string,projectId:string|null,body:Record<string,unknown>) {
  if (!body.column_id) return body;
  if(typeof body.column_id!=="string")throw new BoardMutationError(422,"Invalid column ID");
  const row = (await db.query<{board_id:string;status_key:string}>(`SELECT c.board_id,c.status_key FROM board_columns c
    JOIN boards b ON b.id=c.board_id AND b.space_id=c.space_id WHERE c.space_id=$1 AND c.id=$2
    AND c.deleted_at IS NULL AND b.deleted_at IS NULL AND b.status='active' AND b.project_id IS NOT DISTINCT FROM $3::varchar`,
    [spaceId,body.column_id,projectId])).rows[0];
  if (!row || body.board_id && body.board_id!==row.board_id) throw new BoardMutationError(404,'Board column not found');
  const blockedOverlay=body.status==='blocked' && row.status_key==='in_progress';
  if (body.status && body.status!==row.status_key && !blockedOverlay) throw new BoardMutationError(422,'Task status must match the destination column');
  return {...body,board_id:row.board_id,status:blockedOverlay?'blocked':row.status_key};
}

export async function insertProjectBoard(db:Queryable,spaceId:string,projectId:string,userId:string) {
  const id=randomUUID();
  await db.query(`INSERT INTO boards(id,space_id,project_id,name,board_type,status,created_by_user_id,created_at,updated_at)
    VALUES($1,$2,$3,'Board','project','active',$4,now(),now())`,[id,spaceId,projectId,userId]);
  return id;
}
