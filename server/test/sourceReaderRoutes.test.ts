import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject, seedSpaceMember } from './support/domainSeeds.js';
import { buildModuleServer } from './support/moduleServer.js';
import { readerModule } from '../src/modules/reader/index.js';
import { loadConfig } from '../src/config.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { PgAnnotationRepository, PgCommentRepository, PgReaderActionRepository } from '../src/modules/reader/repository.js';

const db = useTestDatabase(import.meta.filename);
const space = randomUUID(), owner = randomUUID(), project = randomUUID(), other = randomUUID();
const identity = {spaceId:space,userId:owner};
let app: FastifyInstance;
const annotations = () => new PgAnnotationRepository(db.pool);
const actions = () => new PgReaderActionRepository(db.pool);
const comments = () => new PgCommentRepository(db.pool);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool,['spaces','users'],{cascade:true});
  await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
  await seedSpaceMember(db.pool,{space,user:other});
  app = buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[readerModule]);
  __setAuthIdentityForTests(identity);
});
afterEach(async () => { __setAuthIdentityForTests(null); await app?.close(); });

async function document(visibility='space_shared', scoped=false) {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO source_items(id,space_id,project_id,owner_user_id,created_by_user_id,visibility,item_type,title,excerpt,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$4,$5,'external_url','Article','alpha beta gamma','metadata_only','metadata_only',now(),now(),now(),now())`,[id,space,scoped?project:null,owner,visibility]);
  return {document_type:'source_item',document_id:id,annotation_type:'excerpt',quote_text:'beta',anchor_json:{schema_version:1,quote_text:'beta',text_range:{start:6,end:10,unit:'utf16'},before_context:'alpha ',after_context:' gamma'}};
}
async function annotation(visibility='private',scoped=false) {
  const body=await document('space_shared',scoped);
  return annotations().createAnnotation(identity,{...body,visibility});
}

describe('Reader public route contract', () => {
  it('requires authentication for document reads and annotation writes',async () => {
    __setAuthIdentityForTests(null);
    expect((await app.inject({method:'GET',url:`/api/v1/reader/documents/source_item/${randomUUID()}`})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/v1/reader/annotations',payload:{}})).statusCode).toBe(401);
  });
  it('requires a Project for the Project annotation list',async () => {
    expect((await app.inject({method:'GET',url:'/api/v1/reader/annotations'})).statusCode).toBe(400);
  });
  it.each([[-1,4],[4,4]])('rejects an invalid quote range (%s,%s) without writing',async (start,end) => {
    const body=await document();body.anchor_json.text_range={start,end,unit:'utf16'};
    const result=await app.inject({method:'POST',url:'/api/v1/reader/annotations',payload:body,headers:{'idempotency-key':randomUUID()}});
    expect(result.statusCode,result.body).toBe(422);
    expect(result.json().error).toMatchObject({code:'operation_invalid_input',domain:'reader'});
    expect((await db.pool.query('SELECT id FROM reader_annotations')).rows).toEqual([]);
  });
});

describe('Reader annotation scope and visibility', () => {
  it('inherits Project scope and stays private by default',async () => {
    const body=await document('space_shared',true);
    const ann=await annotations().createAnnotation(identity,body);
    expect(ann).toMatchObject({project_id:project,visibility:'private',owner_user_id:owner});
    await expect(annotations().listAnnotations({spaceId:space,userId:other},body.document_type,body.document_id)).rejects.toMatchObject({statusCode:404});
  });
  it('rejects caller-owned Project placement and wider visibility',async () => {
    const body=await document('private');
    await expect(annotations().createAnnotation(identity,{...body,project_id:project})).rejects.toMatchObject({statusCode:422});
    await expect(annotations().createAnnotation(identity,{...body,visibility:'space_shared'})).rejects.toMatchObject({statusCode:422});
    expect((await db.pool.query('SELECT id FROM reader_annotations')).rows).toEqual([]);
  });
  it('inherits document readers only on explicit sharing',async () => {
    const body=await document('selected_users');
    await db.pool.query("INSERT INTO content_access_grants(id,space_id,resource_type,resource_id,grantee_user_id,granted_by_user_id,created_at,updated_at) VALUES($1,$2,'source_item',$3,$4,$5,now(),now())",[randomUUID(),space,body.document_id,other,owner]);
    const privateAnn=await annotations().createAnnotation(identity,body);
    const shared=await annotations().createAnnotation(identity,{...body,visibility:'selected_users'});
    expect((await db.pool.query("SELECT resource_id,grantee_user_id FROM content_access_grants WHERE resource_type='reader_annotation'")).rows).toEqual([{resource_id:shared.id,grantee_user_id:other}]);
    expect((await annotations().listAnnotations({spaceId:space,userId:other},body.document_type,body.document_id)).map(a=>a.id)).toEqual([shared.id]);
    expect(privateAnn.visibility).toBe('private');
  });
  it('does not list or comment on an annotation after its document is removed',async () => {
    const ann=await annotation();
    await db.pool.query('UPDATE source_items SET deleted_at=now() WHERE id=$1',[ann.document_id]);
    await expect(annotations().listAnnotations(identity,ann.document_type,ann.document_id)).rejects.toMatchObject({statusCode:404});
    await expect(comments().createComment(identity,ann.id,{body:'comment'})).rejects.toMatchObject({statusCode:404});
  });
  it('hides private annotations and comment threads from another member',async () => {
    const ann=await annotation();
    const stranger={spaceId:space,userId:other};
    await expect(comments().listThreads(stranger,ann.id)).rejects.toMatchObject({statusCode:404});
    await expect(actions().createEvidence(stranger,ann.id,{})).rejects.toMatchObject({statusCode:404});
    await expect(actions().createProposal(stranger,ann.id,{proposal_type:'memory_create'})).rejects.toMatchObject({statusCode:404});
  });
  it('does not treat annotation scope alone as a Project Source binding',async () => {
    const privateAnn=await annotation('private',true), shared=await annotation('space_shared',true);
    const listed=await actions().listProjectAnnotations(identity,project,20);
    expect(listed.map(a=>a.id)).not.toContain(shared.id);
    expect(listed.map(a=>a.id)).not.toContain(privateAnn.id);
    await expect(actions().listProjectAnnotations({spaceId:space,userId:other},project,20)).rejects.toMatchObject({statusCode:404});
  });
});

describe('Reader canonical derivation', () => {
  it.each(['private','space_shared'])('creates candidate Evidence under the annotation %s audience',async visibility => {
    const ann=await annotation(visibility);
    const evidence=await actions().createEvidence(identity,ann.id,{title:'Evidence title'});
    expect(evidence).toMatchObject({title:'Evidence title',status:'candidate',source_object_type:'reader_annotation',source_object_id:ann.id});
    expect((await db.pool.query('SELECT visibility,owner_user_id FROM extracted_evidence WHERE id=$1',[evidence.id])).rows[0]).toMatchObject({visibility,owner_user_id:owner});
    expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toEqual([]);
    expect((await db.pool.query('SELECT object_id FROM knowledge_items')).rows).toEqual([]);
  });
  it.each(['memory_create','knowledge_create'])('creates only a pending %s proposal with annotation provenance',async proposal_type => {
    const ann=await annotation();
    const proposal=await actions().createProposal(identity,ann.id,{proposal_type});
    expect(proposal).toMatchObject({proposal_type,status:'pending'});
    const row=(await db.pool.query('SELECT payload_json FROM proposals WHERE id=$1',[proposal.id])).rows[0];
    expect(JSON.stringify(row)).toContain(ann.id);
    expect(JSON.stringify(row)).toContain(ann.document_id);
    expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toEqual([]);
    expect((await db.pool.query('SELECT object_id FROM knowledge_items')).rows).toEqual([]);
  });
  it('refuses unsupported proposal types without a durable write',async () => {
    const ann=await annotation();
    await expect(actions().createProposal(identity,ann.id,{proposal_type:'other'})).rejects.toMatchObject({statusCode:422});
    expect((await db.pool.query('SELECT id FROM proposals')).rows).toEqual([]);
  });
  it('does not let missing or cross-Space annotation identities authorize derived writes',async () => {
    const ann=await annotation();
    for(const id of [randomUUID(),ann.id]) {
      const actor=id===ann.id?{spaceId:randomUUID(),userId:owner}:identity;
      await expect(actions().createEvidence(actor,id,{})).rejects.toMatchObject({statusCode:expect.any(Number)});
    }
    expect((await db.pool.query('SELECT id FROM extracted_evidence')).rows).toEqual([]);
  });
});
