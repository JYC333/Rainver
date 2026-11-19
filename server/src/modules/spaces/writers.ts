import {randomUUID} from 'node:crypto';
import type {SpaceRetrievalSettingsUpdate} from '@rainver/protocol';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {hashOpaqueToken,normalizeAuthEmail} from '../auth/securityPolicy.js';
import {isSpaceOwnerOrAdmin,roleGrantRefusal,SPACE_ROLE_LADDER} from '../access/roles.js';
import {getOrCreateSpaceRetrievalSettings,updateSpaceRetrievalSettings} from '../retrieval/settings.js';
import {enqueueRetrievalEmbeddingBackfillWithQueue} from '../retrieval/embedding/job.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {seedSpaceDefaults} from './spaceSeeds.js';
import {lockSpaceAudienceForChange} from '../access/activePerson.js';

/** A deterministic Space refusal. 403/404 are hidden by the operation core; 409/422 are typed. */
export class SpaceCommandError extends Error {
  constructor(readonly statusCode:403|404|409|422,message:string){super(message);this.name='SpaceCommandError';}
}

/**
 * The person's live role in this Space, held until commit. Users before
 * memberships (the `lockActivePerson` order), so neither an account disable nor
 * a role change or exit can interleave with the write that relied on it.
 */
export async function lockSpaceRole(db:Queryable,spaceId:string,userId:string):Promise<string>{
  const user=await db.query(`SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE`,[userId]);
  const member=await db.query<{role:string}>(`SELECT role FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND status='active' FOR SHARE`,[spaceId,userId]);
  const role=member.rows[0]?.role;
  if(!user.rows.length||!role)throw new SpaceCommandError(404,'Space not found');
  return role;
}

async function lockSpaceManager(db:Queryable,spaceId:string,userId:string):Promise<string>{
  const role=await lockSpaceRole(db,spaceId,userId);
  if(!isSpaceOwnerOrAdmin(role))throw new SpaceCommandError(403,'Requires space owner or admin role');
  return role;
}

async function lockSpaceRow(db:Queryable,spaceId:string,update=false):Promise<{type:string}>{
  const row=(await db.query<{type:string}>(`SELECT type FROM spaces WHERE id=$1 ${update?'FOR UPDATE':'FOR SHARE'}`,[spaceId])).rows[0];
  if(!row)throw new SpaceCommandError(404,'Space not found');
  return row;
}

/** Household or team only: a personal Space is created at registration, never here. */
export async function createSpace(db:Queryable,userId:string,input:{name:string;type:'household'|'team';oversight_mode:string}):Promise<{space_id:string}>{
  return withQueryableTransaction(db,async tx=>{
    const user=await tx.query(`SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE`,[userId]);
    if(!user.rows.length)throw new SpaceCommandError(404,'Account unavailable');
    const spaceId=randomUUID();
    await tx.query(`INSERT INTO spaces(id,name,type,created_by_user_id,oversight_mode,egress_notifications_enabled,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,now(),now())`,
      [spaceId,input.name,input.type,userId,input.oversight_mode,input.type==='team']);
    await tx.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())`,[randomUUID(),spaceId,userId]);
    await seedSpaceDefaults(tx,spaceId,userId);
    return {space_id:spaceId};
  });
}

/**
 * Seven-day email-bound invitation into a non-personal Space, at no higher role
 * than the inviter's own. The caller supplied the secret; only its hash is kept.
 */
export async function createInvitation(db:Queryable,userId:string,spaceId:string,input:{email:string;role:string;token:string}){
  return withQueryableTransaction(db,async tx=>{
    const inviterRole=await lockSpaceRole(tx,spaceId,userId);
    if(!isSpaceOwnerOrAdmin(inviterRole))throw new SpaceCommandError(403,'Requires admin role to invite');
    const space=await lockSpaceRow(tx,spaceId);
    if(space.type==='personal')throw new SpaceCommandError(422,'Personal spaces cannot have additional members');
    const refusal=roleGrantRefusal(SPACE_ROLE_LADDER,inviterRole,input.role);
    if(refusal)throw new SpaceCommandError(422,refusal.detail);
    const invitedEmail=normalizeAuthEmail(input.email),id=randomUUID();
    const inserted=await tx.query<{status:string;expires_at:Date|string}>(
      `INSERT INTO user_invitations(id,space_id,invited_email,role,token_hash,status,invited_by_user_id,created_at,expires_at)
       VALUES($1,$2,$3,$4,$5,'available',$6,now(),now()+interval '7 days')
       ON CONFLICT (token_hash) DO NOTHING RETURNING status,expires_at`,
      [id,spaceId,invitedEmail,input.role,hashOpaqueToken(input.token),userId]);
    const row=inserted.rows[0];
    if(!row)throw new SpaceCommandError(409,'Invitation secret already used');
    return {invitation_id:id,space_id:spaceId,invited_email:invitedEmail,role:input.role,status:row.status,expires_at:new Date(row.expires_at).toISOString()};
  });
}

/** Atomic claim by the invited active account; the same refusal for every invalid case. */
export async function acceptInvitation(db:Queryable,userId:string,token:string):Promise<{space_id:string|null}>{
  return withQueryableTransaction(db,async tx=>{
    const user=(await tx.query<{email:string}>(`SELECT email FROM users WHERE id=$1 AND status='active' FOR UPDATE`,[userId])).rows[0];
    if(!user)throw new SpaceCommandError(404,'Account unavailable');
    const row=(await tx.query<{id:string;space_id:string|null;invited_email:string;role:string|null}>(
      `SELECT id,space_id,invited_email,role FROM user_invitations WHERE token_hash=$1 AND status='available' AND expires_at>now() FOR UPDATE`,[hashOpaqueToken(token)])).rows[0];
    if(!row||normalizeAuthEmail(row.invited_email)!==normalizeAuthEmail(user.email))throw new SpaceCommandError(422,'Invalid invitation');
    if(row.space_id){
      // The Space audience fence (taken directly, never upgraded from a share lock): a
      // decision resting on the whole membership waits for, or precedes, this new member.
      if(!await lockSpaceAudienceForChange(tx,row.space_id))throw new SpaceCommandError(404,'Space not found');
      const membership=await tx.query(
        `INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())
         ON CONFLICT (space_id,user_id) DO UPDATE SET role=EXCLUDED.role,status='active',updated_at=now() WHERE space_memberships.status<>'active' RETURNING id`,
        [randomUUID(),row.space_id,userId,row.role]);
      if(!membership.rowCount)throw new SpaceCommandError(409,'Already a member of this Space');
    }
    await tx.query(`UPDATE user_invitations SET status='accepted',accepted_at=now() WHERE id=$1`,[row.id]);
    return {space_id:row.space_id};
  });
}

export async function updateSnapshotDefaults(db:Queryable,userId:string,spaceId:string,data:{snapshot_retention_days_default:number|null;snapshot_max_count_default:number|null}):Promise<{space_id:string}>{
  return withQueryableTransaction(db,async tx=>{
    await lockSpaceManager(tx,spaceId,userId);
    await lockSpaceRow(tx,spaceId,true);
    await tx.query(`UPDATE spaces SET snapshot_retention_days_default=$1,snapshot_max_count_default=$2,updated_at=now() WHERE id=$3`,
      [data.snapshot_retention_days_default,data.snapshot_max_count_default,spaceId]);
    return {space_id:spaceId};
  });
}

/** Whether members may copy content out of this Space (ADR 0013 decision 9); owner/admin only. */
export async function updateContentEgress(db:Queryable,userId:string,spaceId:string,enabled:boolean):Promise<{space_id:string}>{
  return withQueryableTransaction(db,async tx=>{
    await lockSpaceManager(tx,spaceId,userId);
    await lockSpaceRow(tx,spaceId,true);
    await tx.query(`UPDATE spaces SET member_copy_out_enabled=$1,updated_at=now() WHERE id=$2`,[enabled,spaceId]);
    return {space_id:spaceId};
  });
}

/** Settings write and, when the embedding dimension changed, its existing backfill Job in the same transaction. */
export async function updateRetrievalSettings(db:Queryable,userId:string,spaceId:string,patch:SpaceRetrievalSettingsUpdate):Promise<{space_id:string;backfill_job_id:string|null}>{
  return withQueryableTransaction(db,async tx=>{
    await lockSpaceManager(tx,spaceId,userId);
    // The writer's own settings fence, taken first so the prior dimension cannot move before the write.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`runtime-egress-settings:${spaceId}`]);
    const before=(await getOrCreateSpaceRetrievalSettings(tx,spaceId)).embedding_dimensions;
    const result=await updateSpaceRetrievalSettings(tx,spaceId,patch,{actorUserId:userId});
    let backfill:string|null=null;
    if(before!==result.embedding_dimensions){
      backfill=(await enqueueRetrievalEmbeddingBackfillWithQueue(new PgJobQueueRepository(tx),{spaceId,userId,trigger:'retrieval_embedding_dimension_update'})).jobId;
    }
    return {space_id:spaceId,backfill_job_id:backfill};
  });
}
