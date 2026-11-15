import {createHash,createHmac,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ServerConfig} from '../../src/config.js';
import {authModule} from '../../src/modules/auth/index.js';
import {sessionCookieName} from '../../src/modules/auth/identity.js';
import {seedSpaceMember} from './domainSeeds.js';
import {buildModuleServer} from './moduleServer.js';
/** Real account/session and the production admin disable endpoint; no identity
 * override. Useful for domain commit barriers that must fence account disable. */
export async function adminSession(pool:Pool,config:ServerConfig,space:string){
 const admin=randomUUID(),raw=randomUUID();
 await seedSpaceMember(pool,{space,user:admin,role:'admin'});
 const personal=randomUUID();
 await pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Admin personal','personal',now(),now())",[personal]);
 await pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),personal,admin]);
 const email=admin+'@example.test';
 await pool.query(`UPDATE users SET email=$2 WHERE id=$1`,[admin,email]);
 config={...config,instanceAdminEmail:email,betterAuthSecret:'test-admin-session-secret-for-domain-barriers'};
 await pool.query(`INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at,updated_at) VALUES($1,$2,$3,now(),now()+interval '1 day',now())`,[randomUUID(),admin,createHash('sha256').update(raw).digest('hex')]);
 const cookie=encodeURIComponent(raw+'.'+createHmac('sha256',config.betterAuthSecret!).update(raw).digest('base64'));
 const app=buildModuleServer(config,[authModule]);
 return {app,disable:(user:string)=>app.inject({method:'POST',url:`/api/v1/auth/admin/users/${user}/disable`,payload:{},headers:{'idempotency-key':randomUUID(),cookie:`${sessionCookieName(config)}=${cookie}`,origin:config.frontendUrl}})};
}
