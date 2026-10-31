import {READING_METHOD_FIXTURE,PROMPT_REVISION_FIXTURE} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {contentDecisionFromDb} from '../../access/contentAccessQuery.js';
import {projectReaderIds} from '../../projects/access.js';
import {agentReadingPolicy} from '../../sources/materialProcessing/policy.js';
import {readingItemContext} from '../../sources/index.js';
import {sha256Json} from '../hash.js';
type Context=Awaited<ReturnType<typeof readingItemContext>>;
type Pages=Array<{url:string;text:string}>;
interface Proof {kind:'synthetic'|'retained_source';artifact_id?:string;artifact_hash?:string}
const unavailable=()=>new HttpError(403,'Use the controlled synthetic fixture, or exact excerpts and supporting URLs from this Source-permitted retained Reader document. Arbitrary pasted Source content cannot bypass retention or egress.');
async function artifactHash(db:Queryable,spaceId:string,id:string){const row=(await db.query(`SELECT content,metadata_json,storage_path FROM artifacts WHERE id=$1 AND space_id=$2`,[id,spaceId])).rows[0];return row?sha256Json(row):null;}
/** No raw user paste becomes a new ungoverned export path. Real samples derive from the actual retained Source version. */
export async function prepareSampleAuthority(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,ctx:Context,pages:Pages):Promise<Proof>{
 if((sha256Json(pages)===sha256Json(READING_METHOD_FIXTURE.pages)||sha256Json(pages)===sha256Json(PROMPT_REVISION_FIXTURE.pages)))return {kind:'synthetic'};
 if(ctx.source&&!agentReadingPolicy(ctx.source).content)throw unavailable();
 let shown=await new (await import('../../reader/index.js')).PgReaderRepository(db,config).shownSourceItemVersion(identity,ctx.item.id);
 if(!shown)throw unavailable();
 await db.query(`SELECT id FROM artifacts WHERE id=$1 AND space_id=$2 FOR SHARE`,[shown.artifactId,identity.spaceId]);
 const verified=await new (await import('../../reader/index.js')).PgReaderRepository(db,config).shownSourceItemVersion(identity,ctx.item.id);if(!verified||verified.artifactId!==shown.artifactId)throw new HttpError(409,'Reader version changed while preparing the sample');shown=verified;
 const canonical=(value:string)=>{try{return new URL(value).href}catch{return null}};
 const urls=new Set([ctx.item.source_uri,...(Array.isArray(shown.content.metadata.reading_sources)?shown.content.metadata.reading_sources.filter((s):s is string=>typeof s==='string'):[])].filter((s):s is string=>typeof s==='string').map(canonical));
 if(pages.some(p=>!urls.has(canonical(p.url))||!shown.content.text.includes(p.text)))throw unavailable();
 const proof:Proof={kind:'retained_source',artifact_id:shown.artifactId,artifact_hash:(await artifactHash(db,identity.spaceId,shown.artifactId))!};
 await assertSampleAuthority(db,identity,ctx,{pages,authority_proof:proof});return proof;
}
export async function assertSampleAuthority(db:Queryable,identity:SpaceUserIdentity,ctx:Context,input:unknown,requireFresh=true){
 const value=input as {pages:Pages;authority_proof?:Proof};const proof=value.authority_proof;
 if(proof?.kind==='synthetic'&&(sha256Json(value.pages)===sha256Json(READING_METHOD_FIXTURE.pages)||sha256Json(value.pages)===sha256Json(PROMPT_REVISION_FIXTURE.pages)))return;
 if(proof?.kind!=='retained_source'||!proof.artifact_id||!proof.artifact_hash||(requireFresh&&await artifactHash(db,identity.spaceId,proof.artifact_id)!==proof.artifact_hash))throw unavailable();
 if(ctx.source&&!agentReadingPolicy(ctx.source).content)throw unavailable();
 for(const userId of ctx.projectId?await projectReaderIds(db,identity.spaceId,ctx.projectId):[identity.userId])if(await contentDecisionFromDb(db,{spaceId:identity.spaceId,userId},'artifact',proof.artifact_id,{includeOversight:false})!=='full')throw unavailable();
}

export async function sampleContentChanged(db:Queryable,spaceId:string,input:unknown){const p=(input as {authority_proof?:Proof})?.authority_proof;return p?.kind==='retained_source'&&await artifactHash(db,spaceId,p.artifact_id!)!==p.artifact_hash;}
