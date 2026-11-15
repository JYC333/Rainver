import {lockActivePerson} from './activePerson.js';
import type {Queryable} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
/** Real canonical owned Personal Space, never a fabricated membership or target grant.
 * Caller locks the active person after Project audiences, before domain roots. */
export async function personalReceiptSpace(db:Queryable, userId:string):Promise<string> {
  const rows=(await db.query<{id:string}>(`SELECT s.id FROM spaces s JOIN space_memberships m ON m.space_id=s.id
    WHERE s.type='personal' AND m.user_id=$1 AND m.role='owner' AND m.status='active'
    ORDER BY s.created_at,s.id LIMIT 2`,[userId])).rows;
  if(rows.length!==1)throw new HttpError(404,'Personal Space not found');
  return rows[0]!.id;
}


/** Pin the real owned Personal Space without treating it as target authority. */
export async function lockPersonalReceiptSpace(db:Queryable,userId:string):Promise<string>{
 const personal=await personalReceiptSpace(db,userId);
 await lockActivePerson(db,personal,userId);
 if(await personalReceiptSpace(db,userId)!==personal)throw new HttpError(409,'Personal Space changed');
 return personal;
}
