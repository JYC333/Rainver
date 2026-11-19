import {HttpError,type Queryable} from '../routeUtils/common.js';

/** Call after Project audience/member locks and before domain roots. The auth
 * disable writer updates users, so this fence covers it as well as Space exit.
 * Keep users before memberships, as lockProjectAudience does. */
export async function lockActivePerson(db:Queryable,spaceId:string,userId:string):Promise<void>{
 const user=await db.query(`SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE`,[userId]);
 const member=await db.query(`SELECT id FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND status='active' FOR SHARE`,[spaceId,userId]);
 if(!user.rows.length||!member.rows.length)throw new HttpError(403,'Active user and Space membership required');
}

/** Multi-person work pins all user roots before any membership row. */
export async function lockActivePeople(db:Queryable,spaceId:string,userIds:readonly string[]):Promise<void>{
 const ids=[...new Set(userIds)].sort();
 const users=await db.query<{id:string}>("SELECT id FROM users WHERE id=ANY($1::varchar[]) AND status='active' ORDER BY id FOR SHARE",[ids]);
 const members=await db.query<{user_id:string}>("SELECT user_id FROM space_memberships WHERE space_id=$1 AND user_id=ANY($2::varchar[]) AND status='active' ORDER BY id FOR SHARE",[spaceId,ids]);
 if(users.rows.length!==ids.length||new Set(members.rows.map(r=>r.user_id)).size!==ids.length)throw new HttpError(403,'Active users and Space memberships required');
}

/**
 * The Space audience fence, the Space-level counterpart of the Project one
 * (`lockProjectAudience` / `lockProjectAudienceForChange`). Every writer that adds an
 * active Space membership (invitation acceptance, invited registration) takes the
 * Space row `FOR NO KEY UPDATE` before inserting it. A decision resting on the
 * Space's whole current membership — who besides a person can read an object,
 * Space oversight included — holds the Space row `FOR SHARE` before enumerating the
 * members, so a new member (an oversight admin among them) either joins first and
 * is seen, or waits until that decision commits. Existing members' rows are locked
 * by the reader itself; updates to them conflict there.
 */
export async function lockSpaceAudienceForChange(db:Queryable,spaceId:string):Promise<boolean>{
 return (await db.query(`SELECT id FROM spaces WHERE id=$1 FOR NO KEY UPDATE`,[spaceId])).rows.length>0;
}
