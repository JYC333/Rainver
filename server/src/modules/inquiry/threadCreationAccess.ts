import {contentReadSql} from '../access/contentAccessSql.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
/** Same Note read gate used by ordinary Thread -> Note references. */
export async function assertLinkableNote(db:Queryable,identity:SpaceUserIdentity,noteId:string,options:{lock?:boolean;statusCode?:404|422}={}){
  const note=await db.query(`SELECT n.object_id FROM notes n
    JOIN space_objects o ON o.id=n.object_id AND o.space_id=n.space_id
    WHERE n.object_id=$1 AND n.space_id=$2 AND ${contentReadSql('space_object','o','$3')}
    ${options.lock?'FOR SHARE OF n,o':''}`,[noteId,identity.spaceId,identity.userId]);
  if(!note.rows[0])throw new InquiryNoteUnavailable(options.statusCode??422);
}
export class InquiryCreationConflict extends HttpError {
  constructor(){super(409,'producer_idempotency_key was already used for a different Inquiry Thread');}
}

export class InquiryNoteUnavailable extends HttpError {
  constructor(status:404|422=422){super(status,'Note not found in this Space');}
}
