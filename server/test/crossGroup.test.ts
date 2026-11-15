import {randomUUID} from 'node:crypto';
import {seedSpaceOwnerProject,seedSpaceMember,seedMainlineRoomsForAllProjects} from './support/domainSeeds.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {artifactsModule} from '../src/modules/artifacts/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { crossSpaceRetrievalModule } from "../src/modules/crossSpaceRetrieval/index.js";
import { __setCrossSpaceRetrievalServiceFactoryForTests } from "../src/modules/crossSpaceRetrieval/routes.js";
import { CrossSpaceRetrievalService, PERSONAL_AGGREGATED_RESOURCE_TYPES, personalAggregatedRetrievalRegistry } from "../src/modules/crossSpaceRetrieval/service.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("crossSpaceRetrievalDb", () => {
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PERSONAL = "11111111-1111-4111-8111-111111111111";
  const SPACE_A = "22222222-2222-4222-8222-222222222222";
  const SPACE_B = "33333333-3333-4333-8333-333333333333";
  const A_SHARED = "44444444-4444-4444-8444-444444444444";
  const A_PRIVATE = "55555555-5555-4555-8555-555555555555";
  const B_SHARED = "66666666-6666-4666-8666-666666666666";
  const B_PRIVATE = "77777777-7777-4777-8777-777777777777";


  const db = useTestDatabase(`${import.meta.filename}#crossSpaceRetrievalDb`, { max: 4 });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["cross_space_retrieval_sessions", "cross_space_egress_disclosures", "content_egress_records", "space_member_notifications", "retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "artifacts", "knowledge_items", "space_objects", "space_memberships", "users", "spaces"],
      { cascade: true },
    );
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ($1, 'Viewer', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system'),
              ($2, 'Other', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
      [USER, OTHER],
    );
    await db.pool.query(
      `INSERT INTO spaces
         (id, name, type, created_by_user_id, egress_notifications_enabled,
          created_at, updated_at)
       VALUES ($1, 'Personal', 'personal', $4, false, now(), now()),
              ($2, 'Space A', 'team', $4, true, now(), now()),
              ($3, 'Space B', 'team', $5, true, now(), now())`,
      [PERSONAL, SPACE_A, SPACE_B, USER, OTHER],
    );
    await db.pool.query(
      `INSERT INTO space_memberships
         (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES
         ('personal-viewer', $1, $4, 'owner', 'active', now(), now()),
         ('a-viewer', $2, $4, 'admin', 'active', now(), now()),
         ('a-other', $2, $5, 'member', 'active', now(), now()),
         ('b-viewer', $3, $4, 'member', 'active', now(), now()),
         ('b-other', $3, $5, 'member', 'active', now(), now())`,
      [PERSONAL, SPACE_A, SPACE_B, USER, OTHER],
    );
    await seedKnowledge(A_SHARED, SPACE_A, "Boundary alpha shared", "boundary alpha shared material", "space_shared", null);
    await seedKnowledge(A_PRIVATE, SPACE_A, "Boundary alpha private", "boundary alpha private material", "private", OTHER);
    await seedKnowledge(B_SHARED, SPACE_B, "Boundary beta shared", "boundary beta shared material", "space_shared", null);
    await seedKnowledge(B_PRIVATE, SPACE_B, "Boundary beta private", "boundary beta private material", "private", USER);
  });

  async function seedKnowledge(
    id: string,
    spaceId: string,
    title: string,
    content: string,
    visibility: string,
    ownerUserId: string | null,
  ): Promise<void> {
    await insertKnowledgeItem(db.pool, {
      id,
      spaceId,
      title,
      content,
      slug: id,
      visibility,
      ownerUserId,
      createdByUserId: ownerUserId ?? USER,
    });
    await new RetrievalProjectionService(db.pool, personalAggregatedRetrievalRegistry)
      .reindex(spaceId, "knowledge_item", id);
  }

  function service(): CrossSpaceRetrievalService {
    return new CrossSpaceRetrievalService(db.pool);
  }

  describe("personal cross-Space aggregated retrieval", () => {
    it("applies every contributing Space's live content predicate independently", async () => {
      if (!db.available) return;
      const result = await service().search({
        userId: USER,
        query: "boundary",
        resourceTypes: ["knowledge_item"],
        maxResults: 20,
      });

      const refs = result.items.map((item) => `${item.pointer.space_id}:${item.pointer.id}`);
      expect(refs).toContain(`${SPACE_A}:${A_SHARED}`);
      expect(refs).not.toContain(`${SPACE_A}:${A_PRIVATE}`);
      expect(refs).toContain(`${SPACE_B}:${B_SHARED}`);
      expect(refs).toContain(`${SPACE_B}:${B_PRIVATE}`);
      expect(result.fused_conclusion).toBeNull();
      expect(result.canonical_write_performed).toBe(false);

      const stored = await db.pool.query<{ row: Record<string, unknown> }>(
        `SELECT to_jsonb(p) AS row FROM cross_space_retrieval_pointers p`,
      );
      expect(stored.rows).toHaveLength(3);
      for (const row of stored.rows) {
        expect(Object.keys(row.row).sort()).toEqual([
          "created_at", "id", "resource_id", "resource_space_id", "resource_type", "session_id", "user_id",
        ]);
        expect(JSON.stringify(row.row)).not.toContain("boundary");
      }
    });

    it("makes a stored pointer unresolvable immediately after membership revocation", async () => {
      if (!db.available) return;
      const result = await service().search({
        userId: USER,
        query: "alpha shared",
        resourceTypes: ["knowledge_item"],
      });
      const pointer = result.items.find((item) => item.pointer.space_id === SPACE_A)!.pointer;

      const otherPersonal=randomUUID();
      await db.pool.query("INSERT INTO spaces(id,name,type,created_by_user_id,created_at,updated_at) VALUES($1,'Other personal','personal',$2,now(),now())",[otherPersonal,OTHER]);
      await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),otherPersonal,OTHER]);
      const otherUserResolution = await service().resolve(OTHER, [pointer.pointer_id]);
      expect(otherUserResolution.items).toEqual([]);
      expect(otherUserResolution.unresolved_pointer_ids).toEqual([pointer.pointer_id]);

      await db.pool.query(
        `UPDATE space_memberships SET status = 'revoked', updated_at = now()
          WHERE space_id = $1 AND user_id = $2`,
        [SPACE_A, USER],
      );
      const resolved = await service().resolve(USER, [pointer.pointer_id]);
      expect(resolved.items).toEqual([]);
      expect(resolved.unresolved_pointer_ids).toEqual([pointer.pointer_id]);
      expect((await db.pool.query(`SELECT 1 FROM cross_space_retrieval_pointers WHERE id = $1`, [pointer.pointer_id])).rowCount).toBe(1);
    });

    it("persists no fused conclusion until disclosure and an explicit user store", async () => {
      if (!db.available) return;
      const result = await service().search({
        userId: USER,
        query: "boundary shared",
        resourceTypes: ["knowledge_item"],
        maxResults: 20,
      });
      const pointerIds = [SPACE_A, SPACE_B].map((spaceId) =>
        result.items.find((item) => item.pointer.space_id === spaceId)!.pointer.pointer_id);

      expect((await db.pool.query(`SELECT 1 FROM artifacts`)).rowCount).toBe(0);
      expect((await db.pool.query(`SELECT 1 FROM content_egress_records`)).rowCount).toBe(0);

      await expect(service().storeFusedConclusion({
        userId: USER,
        disclosureId: "99999999-9999-4999-8999-999999999999",
        pointerIds,
        conclusion: "must not persist without prior disclosure",
      })).rejects.toMatchObject({ statusCode: 404 });
      expect((await db.pool.query(`SELECT 1 FROM artifacts`)).rowCount).toBe(0);

      const disclosure = await service().discloseEgress(USER, pointerIds);
      expect(disclosure.source_spaces.map((space) => space.space_id).sort()).toEqual([SPACE_A, SPACE_B]);
      expect(disclosure.source_spaces.every((space) => space.egress_notifications_enabled)).toBe(true);
      expect((await db.pool.query(`SELECT 1 FROM artifacts`)).rowCount).toBe(0);

      const conclusion = "A private fused conclusion that must never enter source-Space egress rows.";
      const stored = await service().storeFusedConclusion({
        userId: USER,
        disclosureId: disclosure.disclosure_id,
        pointerIds,
        conclusion,
      });
      expect(stored.egress_record_ids).toHaveLength(2);
      const artifact = await db.pool.query<{ space_id: string; visibility: string; content: string }>(
        `SELECT space_id, visibility, content FROM artifacts WHERE id = $1`,
        [stored.artifact_id],
      );
      expect(artifact.rows[0]).toMatchObject({ space_id: PERSONAL, visibility: "private", content: conclusion });
      const egress = await db.pool.query<{ source_space_id: string; source_pointers_json: unknown }>(
        `SELECT source_space_id, source_pointers_json FROM content_egress_records ORDER BY source_space_id`,
      );
      expect(egress.rows.map((row) => row.source_space_id)).toEqual([SPACE_A, SPACE_B]);
      expect(JSON.stringify(egress.rows)).not.toContain(conclusion);
      const notifications = await db.pool.query<{ pointer_metadata_json: unknown }>(
        `SELECT pointer_metadata_json FROM space_member_notifications WHERE event_type = 'content_egress'`,
      );
      expect(notifications.rowCount).toBe(4);
      expect(JSON.stringify(notifications.rows)).not.toContain(conclusion);

      const staleDisclosure = await service().discloseEgress(USER, pointerIds);
      await service().updateEgressNotificationSetting(USER, SPACE_A, false);
      await expect(service().storeFusedConclusion({
        userId: USER,
        disclosureId: staleDisclosure.disclosure_id,
        pointerIds,
        conclusion: "must not use a stale disclosure",
      })).rejects.toMatchObject({ statusCode: 409 });
      expect((await db.pool.query(
        `SELECT 1 FROM artifacts WHERE content = 'must not use a stale disclosure'`,
      )).rowCount).toBe(0);
      const prior = await db.pool.query<{ notification_enabled: boolean }>(
        `SELECT notification_enabled FROM content_egress_records
          WHERE target_artifact_id = $1 AND source_space_id = $2`,
        [stored.artifact_id, SPACE_A],
      );
      expect(prior.rows[0]?.notification_enabled).toBe(true);
      const disclosedAfterChange = await service().discloseEgress(USER, pointerIds);
      expect(disclosedAfterChange.source_spaces.find((space) => space.space_id === SPACE_A))
        .toMatchObject({ egress_notifications_enabled: false });
      const beforeSecondNoticeCount = Number((await db.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM space_member_notifications
          WHERE space_id = $1 AND event_type = 'content_egress'`,
        [SPACE_A],
      )).rows[0]?.count ?? 0);
      const second = await service().storeFusedConclusion({
        userId: USER,
        disclosureId: disclosedAfterChange.disclosure_id,
        pointerIds,
        conclusion: "second explicit conclusion",
      });
      const secondA = await db.pool.query<{ notification_enabled: boolean }>(
        `SELECT notification_enabled FROM content_egress_records
          WHERE target_artifact_id = $1 AND source_space_id = $2`,
        [second.artifact_id, SPACE_A],
      );
      expect(secondA.rows[0]?.notification_enabled).toBe(false);
      const afterSecondNoticeCount = Number((await db.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM space_member_notifications
          WHERE space_id = $1 AND event_type = 'content_egress'`,
        [SPACE_A],
      )).rows[0]?.count ?? 0);
      expect(afterSecondNoticeCount).toBe(beforeSecondNoticeCount);
    });

    it("writes single-source summaries back to that Space and broadcasts setting changes forward-only", async () => {
      if (!db.available) return;
      const result = await service().search({
        userId: USER,
        query: "alpha shared",
        resourceTypes: ["knowledge_item"],
      });
      const pointerId = result.items.find((item) => item.pointer.space_id === SPACE_A)!.pointer.pointer_id;
      await expect(service().updateEgressNotificationSetting(OTHER, SPACE_A, false))
        .rejects.toMatchObject({ statusCode: 403 });
      const summary = await service().storeSingleSourceSummary(USER, [pointerId], "Personal summary of A");
      const artifact = await db.pool.query<{ space_id: string; owner_user_id: string; visibility: string }>(
        `SELECT space_id, owner_user_id, visibility FROM artifacts WHERE id = $1`,
        [summary.artifact_id],
      );
      expect(artifact.rows[0]).toEqual({ space_id: SPACE_A, owner_user_id: USER, visibility: "private" });

      const changed = await service().updateEgressNotificationSetting(USER, SPACE_A, false);
      expect(changed.egress_notifications_enabled).toBe(false);
      const notices = await db.pool.query<{ pointer_metadata_json: Record<string, unknown> }>(
        `SELECT pointer_metadata_json FROM space_member_notifications
          WHERE space_id = $1 AND event_type = 'egress_notification_setting_changed'`,
        [SPACE_A],
      );
      expect(notices.rowCount).toBe(2);
      expect(notices.rows.every((row) => row.pointer_metadata_json.egress_notifications_enabled === false)).toBe(true);
      expect(JSON.stringify(notices.rows)).not.toContain("Personal summary of A");

      const unchanged = await service().updateEgressNotificationSetting(USER, SPACE_A, false);
      expect(unchanged.updated_at).toBe(changed.updated_at);
      expect((await db.pool.query(
        `SELECT 1 FROM space_member_notifications
          WHERE space_id = $1 AND event_type = 'egress_notification_setting_changed'`,
        [SPACE_A],
      )).rowCount).toBe(2);
    });
  });
  describe('personal retrieval core family (real PG)',()=>{
    let app:FastifyInstance;
    beforeEach(()=>{
      if(!db.available)return;
      __setAuthIdentityForTests({spaceId:SPACE_B,userId:USER});
      app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[crossSpaceRetrievalModule,systemActionsModule,artifactsModule]);
    });
    afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
    const call=(path:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/me/retrieval/'+path,payload,headers:{'idempotency-key':key}});
    const pointers=async()=>{
      const found=await service().search({userId:USER,query:'boundary',resourceTypes:['knowledge_item']});
      const a=found.items.find(i=>i.pointer.id===A_SHARED)!.pointer.pointer_id;
      const b=found.items.find(i=>i.pointer.id===B_SHARED)!.pointer.pointer_id;
      return {a,b};
    };
    it('retains all five URL fields, private placement, lineage and keyed single effects',async()=>{
      const key=randomUUID(),search=await call('search',{query:'boundary',resource_types:['knowledge_item'],max_results:10},key);
      expect(search.statusCode,search.body).toBe(200);
      const result=search.json().data;expect(result).toMatchObject({canonical_write_performed:false,fused_conclusion:null});
      expect((await call('search',{query:'boundary',resource_types:['knowledge_item'],max_results:10},key)).json()).toEqual(search.json());
      const a=result.items.find((i:any)=>i.pointer.id===A_SHARED).pointer.pointer_id;
      const b=result.items.find((i:any)=>i.pointer.id===B_SHARED).pointer.pointer_id;
      for(const [path,payload,status] of [
        ['pointers/resolve',{pointer_ids:[a,b,randomUUID()]},200],
        ['summaries',{pointer_ids:[a],summary:'source summary'},201],
        ['egress/disclose',{pointer_ids:[a,b]},200],
      ] as const){
        const k=randomUUID(),r=await call(path,payload,k);expect(r.statusCode,r.body).toBe(status);
        expect((await call(path,payload,k)).json()).toEqual(r.json());
        if(path==='summaries')expect((await db.pool.query('SELECT space_id,owner_user_id,visibility FROM artifacts WHERE id=$1',[r.json().data.artifact_id])).rows[0]).toEqual({space_id:SPACE_A,owner_user_id:USER,visibility:'private'});
      }
      const disclosure=(await call('egress/disclose',{pointer_ids:[a,b]})).json().data;
      const payload={pointer_ids:[a,b],disclosure_id:disclosure.disclosure_id,conclusion:'explicit fused conclusion'},k=randomUUID();
      const fused=await call('fused-conclusions',payload,k);expect(fused.statusCode,fused.body).toBe(201);
      expect((await call('fused-conclusions',payload,k)).json()).toEqual(fused.json());
      expect((await db.pool.query('SELECT space_id,owner_user_id,visibility FROM artifacts WHERE id=$1',[fused.json().data.artifact_id])).rows[0]).toEqual({space_id:PERSONAL,owner_user_id:USER,visibility:'private'});
      expect((await db.pool.query('SELECT source_pointers_json FROM content_egress_records')).rows).toHaveLength(2);
      expect((await db.pool.query('SELECT id FROM cross_space_retrieval_sessions')).rows).toHaveLength(1);
      expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(6);
    });
    it('requires explicit keys and strict DTOs at every retained URL',async()=>{
      const id=randomUUID();
      for(const [path,payload] of [['search',{query:'boundary'}],['pointers/resolve',{pointer_ids:[id]}],['summaries',{pointer_ids:[id],summary:'x'}],['egress/disclose',{pointer_ids:[id,randomUUID()]}],['fused-conclusions',{pointer_ids:[id,randomUUID()],disclosure_id:id,conclusion:'x'}]] as const){
        expect((await app.inject({method:'POST',url:'/api/v1/me/retrieval/'+path,payload})).statusCode).toBe(422);
        expect((await call(path,{...payload,space_id:SPACE_B})).statusCode).toBe(422);
      }
      expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
    });
    it('withholds all five cached results after source membership withdrawal',async()=>{
      const {a,b}=await pointers();
      const disclosure=(await call('egress/disclose',{pointer_ids:[a,b]})).json().data;
      const cases=[['search',{query:'boundary',resource_types:['knowledge_item']}],['pointers/resolve',{pointer_ids:[a,b]}],['summaries',{pointer_ids:[a],summary:'x'}],['egress/disclose',{pointer_ids:[a,b]}],['fused-conclusions',{pointer_ids:[a,b],disclosure_id:disclosure.disclosure_id,conclusion:'x'}]] as const;
      for(const [path,payload] of cases){
        const key=randomUUID(),r=await call(path,payload,key);expect(r.statusCode,r.body).toBe(path==='summaries'||path==='fused-conclusions'?201:200);
        await db.pool.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[SPACE_A,USER]);
        const denied=await call(path,payload,key);expect(denied.statusCode,denied.body).toBe(404);expect(denied.json().data).toBeUndefined();
        await db.pool.query("UPDATE space_memberships SET status='active' WHERE space_id=$1 AND user_id=$2",[SPACE_A,USER]);
      }
    });
    it.each(['search','summaries','fused-conclusions'])('rolls back %s domain state, B11 audit and receipts on a late mandatory audit fault',async path=>{
      const {a,b}=await pointers();
      const disclosure=await service().discloseEgress(USER,[a,b]);
      const counts=async()=>(await db.pool.query(`SELECT (SELECT count(*) FROM artifacts)::int artifacts,(SELECT count(*) FROM cross_space_retrieval_sessions)::int sessions,(SELECT count(*) FROM content_egress_records)::int egress,(SELECT count(*) FROM content_access_logs)::int reads,(SELECT count(*) FROM operation_idempotency)::int receipts`)).rows[0];
      const before=await counts();
      await db.pool.query("CREATE FUNCTION reject_personal_retrieval_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late audit failure'; END $$");
      await db.pool.query('CREATE CONSTRAINT TRIGGER reject_personal_retrieval_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_personal_retrieval_audit()');
      const body=path==='search'?{query:'boundary'}:path==='summaries'?{pointer_ids:[a],summary:'rollback'}:{pointer_ids:[a,b],disclosure_id:disclosure.disclosure_id,conclusion:'rollback'};
      const key=randomUUID();
      try{const r=await call(path,body,key);expect(r.statusCode,r.body).toBe(503);expect(await counts()).toEqual(before);expect((await db.pool.query('SELECT consumed_at FROM cross_space_egress_disclosures WHERE id=$1',[disclosure.disclosure_id])).rows[0].consumed_at).toBeNull();}
      finally{await db.pool.query('DROP TRIGGER reject_personal_retrieval_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION reject_personal_retrieval_audit()');}
      expect((await call(path,body,key)).statusCode).toBe(path==='search'?200:201);
    });
    it('preserves legitimate summary-only search and fresh resolve while refusing an older full-content receipt',async()=>{
      const {a,b}=await pointers(),key=randomUUID(),body={pointer_ids:[a]};
      const original=await call('pointers/resolve',body,key);expect(original.statusCode,original.body).toBe(200);
      const oldArtifact=await service().storeSingleSourceSummary(USER,[a],'OLD full-derived body');
      await db.pool.query("UPDATE space_objects SET owner_user_id=$2,created_by_user_id=$2,access_level='summary',summary='public boundary synopsis' WHERE id=$1",[A_SHARED,OTHER]);
      expect((await call('pointers/resolve',body,key)).statusCode).toBe(404);
      const current=await call('pointers/resolve',body);expect(current.statusCode,current.body).toBe(200);expect(current.json().data.items[0].snippet).toBe('public boundary synopsis');
      const search=await call('search',{query:'boundary',resource_types:['knowledge_item']});expect(search.statusCode,search.body).toBe(200);
      expect(search.json().data.items.find((i:any)=>i.pointer.id===A_SHARED).snippet).toBe('public boundary synopsis');
      expect(search.body).not.toContain('boundary alpha shared material');
      const stored=await call('summaries',{pointer_ids:[a],summary:'based on public synopsis'});expect(stored.statusCode,stored.body).toBe(201);
      __setAuthIdentityForTests({spaceId:SPACE_A,userId:USER});
      const visible=await app.inject({method:'GET',url:'/api/v1/artifacts/'+stored.json().data.artifact_id});expect(visible.statusCode,visible.body).toBe(200);expect(visible.body).toContain('based on public synopsis');
      expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+oldArtifact.artifact_id})).body).not.toContain('OLD full-derived body');
      const disclosure=await call('egress/disclose',{pointer_ids:[a,b]});expect(disclosure.statusCode,disclosure.body).toBe(200);
      const fused=await call('fused-conclusions',{pointer_ids:[a,b],disclosure_id:disclosure.json().data.disclosure_id,conclusion:'public-level fused body'});expect(fused.statusCode,fused.body).toBe(201);
      __setAuthIdentityForTests({spaceId:PERSONAL,userId:USER});
      expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+fused.json().data.artifact_id})).body).toContain('public-level fused body');

    });
    it('ordinary Artifact and Reader reads reauthorize cross-Space stored lineage after source withdrawal',async()=>{
      const {a,b}=await pointers(),disclosure=await service().discloseEgress(USER,[a,b]);
      const summary=await service().storeSingleSourceSummary(USER,[a],'PRIVATE summary body');
      const fused=await service().storeFusedConclusion({userId:USER,disclosureId:disclosure.disclosure_id,pointerIds:[a,b],conclusion:'PRIVATE fused body'});
      const {assertArtifactReadable}=await import('../src/modules/reader/repository.js');
      for(const [artifact,space,text] of [[summary.artifact_id,SPACE_A,'PRIVATE summary body'],[fused.artifact_id,PERSONAL,'PRIVATE fused body']] as const){
        __setAuthIdentityForTests({spaceId:space,userId:USER});
        const before=await app.inject({method:'GET',url:'/api/v1/artifacts/'+artifact});expect(before.statusCode,before.body).toBe(200);expect(before.body).toContain(text);
        await assertArtifactReadable(db.pool,{spaceId:space,userId:USER},artifact,"Not found");
        await db.pool.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[SPACE_B,USER]);
        if(space===SPACE_A)await db.pool.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[SPACE_A,USER]);
        const after=await app.inject({method:'GET',url:'/api/v1/artifacts/'+artifact});expect(after.body).not.toContain(text);
        await expect(assertArtifactReadable(db.pool,{spaceId:space,userId:USER},artifact,"Not found")).rejects.toMatchObject({statusCode:404});
        await db.pool.query("UPDATE space_memberships SET status='active' WHERE user_id=$1",[USER]);
      }
    });
    it('replay rereads current per-object grant authority and resolve withholds withdrawn content',async()=>{
      await db.pool.query("UPDATE space_objects SET visibility='selected_users',owner_user_id=$2,created_by_user_id=$2 WHERE id=$1",[A_SHARED,OTHER]);
      const grant=randomUUID();await db.pool.query("INSERT INTO content_access_grants(id,space_id,resource_type,resource_id,grantee_user_id,granted_by_user_id,access_level,created_at,updated_at) VALUES($1,$2,'space_object',$3,$4,$5,'full',now(),now())",[grant,SPACE_A,A_SHARED,USER,OTHER]);
      const {a}=await pointers(),key=randomUUID(),body={pointer_ids:[a]};
      expect((await call('pointers/resolve',body,key)).json().data.items).toHaveLength(1);
      await db.pool.query('UPDATE content_access_grants SET revoked_at=now() WHERE id=$1',[grant]);
      expect((await call('pointers/resolve',body,key)).statusCode).toBe(404);
      const current=await call('pointers/resolve',body);expect(current.statusCode,current.body).toBe(200);
      expect(current.json().data).toMatchObject({items:[],unresolved_pointer_ids:[a]});
    });
    it('pins all contributing Project audiences before waiting on either Space content root',async()=>{
      const pa=randomUUID(),pb=randomUUID();
      for(const [project,space,object] of [[pa,SPACE_A,A_SHARED],[pb,SPACE_B,B_SHARED]]){
        await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Scoped','active',now(),now())",[project,space,OTHER]);
        await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,USER]);
        await db.pool.query('UPDATE space_objects SET primary_project_id=$2 WHERE id=$1',[object,project]);
      }
      await seedMainlineRoomsForAllProjects(db.pool);
      const {a,b}=await pointers(),key=randomUUID(),payload={pointer_ids:[b,a]};
      expect((await call('pointers/resolve',payload,key)).statusCode).toBe(200);
      const holder=await db.pool.connect(),probe=await db.pool.connect();let pending:Promise<unknown>|undefined,settled=false;
      await holder.query('BEGIN');
      try{
        const pid=Number((await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid);
        await holder.query('SELECT id FROM space_objects WHERE id=$1 FOR UPDATE',[A_SHARED]);
        pending=service().resolve(USER,[b,a]).then(v=>{settled=true;return v;},e=>{settled=true;return e;});
        await waitForBlockedBy(db.pool,pid,{settled:()=>settled});expect(settled).toBe(false);
        await probe.query('BEGIN');
        await expect(probe.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE NOWAIT',[pb])).rejects.toMatchObject({code:'55P03'});
        await probe.query('ROLLBACK');await holder.query('COMMIT');expect(await pending).toMatchObject({unresolved_pointer_ids:[]});
      }finally{await probe.query('ROLLBACK');probe.release();await holder.query('ROLLBACK');holder.release();await pending;}
      await db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[pb,USER]);
      expect((await call('pointers/resolve',payload,key)).statusCode).toBe(404);
    });
    it('canonical summary waits on a grant revocation and refuses the committed withdrawal',async()=>{
      await db.pool.query("UPDATE space_objects SET visibility='selected_users',owner_user_id=$2,created_by_user_id=$2 WHERE id=$1",[A_SHARED,OTHER]);
      const grant=randomUUID();await db.pool.query("INSERT INTO content_access_grants(id,space_id,resource_type,resource_id,grantee_user_id,granted_by_user_id,access_level,created_at,updated_at) VALUES($1,$2,'space_object',$3,$4,$5,'full',now(),now())",[grant,SPACE_A,A_SHARED,USER,OTHER]);
      const {a}=await pointers(),holder=await db.pool.connect();let pending:Promise<unknown>|undefined,settled=false;
      await holder.query('BEGIN');
      try{
        const pid=Number((await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid);
        await holder.query('UPDATE content_access_grants SET revoked_at=now() WHERE id=$1',[grant]);
        pending=service().storeSingleSourceSummary(USER,[a],'must not persist').then(v=>{settled=true;return v;},e=>{settled=true;return e;});
        await waitForBlockedBy(db.pool,pid,{settled:()=>settled});expect(settled).toBe(false);
        await holder.query('COMMIT');expect(await pending).toMatchObject({statusCode:409});
        expect((await db.pool.query("SELECT id FROM artifacts WHERE content='must not persist'")).rows).toHaveLength(0);
      }finally{await holder.query('ROLLBACK');holder.release();await pending;}
    });
    it('canonical summary pins Source consent and withholds the committed archive',async()=>{
      const {seedArxivSourceChain}=await import('./support/researchSeeds.js');
      const connection=randomUUID(),source=randomUUID();
      await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel:randomUUID(),space:SPACE_A,owner:OTHER,now:new Date().toISOString()});
      await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,visibility,access_level,connection_id,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,'space_shared','full',$4,'external_url','Source',now(),now(),'excerpt_saved','summary_only',now(),now())",[source,SPACE_A,OTHER,connection]);
      await db.pool.query("INSERT INTO provenance_links(id,space_id,target_type,target_id,source_type,source_id,created_at) VALUES($1,$2,'knowledge',$3,'source_item',$4,now())",[randomUUID(),SPACE_A,A_SHARED,source]);
      const {a}=await pointers(),holder=await db.pool.connect();let pending:Promise<unknown>|undefined,settled=false;
      const receiptKey=randomUUID(),receiptBody={pointer_ids:[a],summary:'before Source archive'};
      expect((await call('summaries',receiptBody,receiptKey)).statusCode).toBe(201);
      await holder.query('BEGIN');
      try{
        const pid=Number((await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid);
        await holder.query("UPDATE source_connections SET status='archived' WHERE id=$1",[connection]);
        pending=service().storeSingleSourceSummary(USER,[a],'must not export').then(v=>{settled=true;return v;},e=>{settled=true;return e;});
        await waitForBlockedBy(db.pool,pid,{settled:()=>settled});expect(settled).toBe(false);
        await holder.query('COMMIT');expect(await pending).toMatchObject({statusCode:404});
        expect((await db.pool.query("SELECT id FROM artifacts WHERE content='must not export'")).rows).toHaveLength(0);
        expect((await call('summaries',receiptBody,receiptKey)).statusCode).toBe(404);
      }finally{await holder.query('ROLLBACK');holder.release();await pending;}
    });
  });

});

describe("crossSpaceRetrievalRoutes", () => {
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SPACE_A = "11111111-1111-4111-8111-111111111111";

  let app: FastifyInstance | undefined;
  const fake = {
    search: vi.fn(),
    resolve: vi.fn(),
    storeSingleSourceSummary: vi.fn(),
    discloseEgress: vi.fn(),
    storeFusedConclusion: vi.fn(),
    updateEgressNotificationSetting: vi.fn(),
    listNotifications: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __setAuthIdentityForTests({ spaceId: SPACE_A, userId: USER });
    __setCrossSpaceRetrievalServiceFactoryForTests(() => fake);
    app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db/rainver" }), [crossSpaceRetrievalModule]);
  });

  afterEach(async () => {
    __setAuthIdentityForTests(null);
    __setCrossSpaceRetrievalServiceFactoryForTests(null);
    await app?.close();
    app = undefined;
  });

  describe("cross-Space retrieval routes", () => {
    it("registers exactly the enumerated retrieval exception types", () => {
      expect(personalAggregatedRetrievalRegistry.objectTypes().sort()).toEqual(
        [...PERSONAL_AGGREGATED_RESOURCE_TYPES].sort(),
      );
    });

    it("reads current member notifications", async () => {
      fake.listNotifications.mockResolvedValue({ items: [] });
      const notices = await app!.inject({ method: "GET", url: "/api/v1/me/notifications" });
      expect(notices.statusCode).toBe(200);
      expect(notices.json()).toEqual({ items: [] });
    });
  });
});

describe('Space egress notification core operation',()=>{
 const db=useTestDatabase(`${import.meta.filename}#egressCore`,{max:5});
 let space:string,owner:string,member:string,otherSpace:string,app:FastifyInstance|undefined;
 const write=(enabled=false,key=randomUUID())=>app!.inject({method:'PATCH',url:`/api/v1/spaces/${space}/egress-notifications`,payload:{egress_notifications_enabled:enabled},headers:{'idempotency-key':key}});
 const notices=()=>db.pool.query('SELECT * FROM space_member_notifications');
 beforeEach(async()=>{
  if(!db.available)return;
  await resetTables(db.pool,['spaces','users'],{cascade:true});
  space=randomUUID();owner=randomUUID();member=randomUUID();otherSpace=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space,owner,project:randomUUID(),spaceType:'team'});
  await seedSpaceMember(db.pool,{space,user:member});
  await db.pool.query('UPDATE spaces SET egress_notifications_enabled=true WHERE id=$1',[space]);
  await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Other','team',now(),now())",[otherSpace]);
  app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[crossSpaceRetrievalModule,systemActionsModule,artifactsModule]);
  __setAuthIdentityForTests({spaceId:space,userId:owner});
 });
 afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();app=undefined;});
 it('atomically changes the setting and pointer-only notifications; REST/generic replay and no-op emit nothing extra',async()=>{
  const key=randomUUID(),first=await write(false,key);expect(first.statusCode,first.body).toBe(200);
  expect(first.json().data).toMatchObject({space_id:space,egress_notifications_enabled:false});
  expect((await notices()).rows).toHaveLength(2);
  const replay=await app!.inject({method:'POST',url:'/api/v1/actions/space.egress_notifications.update',payload:{space_id:space,egress_notifications_enabled:false},headers:{'idempotency-key':key}});
  expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data);
  expect((await write()).statusCode).toBe(200);expect((await notices()).rows).toHaveLength(2);
  expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toHaveLength(2);
  expect((await db.pool.query("SELECT * FROM policy_decision_records WHERE action='space.settings.update' AND decision='allow'")).rows.length).toBeGreaterThan(0);
 });
 it.each(['role','membership','account'])('replay rechecks current %s without disclosing cached data',async kind=>{
  const key=randomUUID();expect((await write(false,key)).statusCode).toBe(200);
  if(kind==='role')await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  if(kind==='membership')await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  if(kind==='account')await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);
  const r=await write(false,key);expect(r.statusCode,r.body).toBe(404);expect(r.json().data).toBeUndefined();expect((await notices()).rows).toHaveLength(2);
 });
 it('refuses a different Space, member authority, input injection and missing keys',async()=>{
  for(const payload of [{egress_notifications_enabled:false,space_id:otherSpace},{egress_notifications_enabled:false,user_id:member},{egress_notifications_enabled:'false'}]){
   const r=await app!.inject({method:'PATCH',url:`/api/v1/spaces/${space}/egress-notifications`,payload,headers:{'idempotency-key':randomUUID()}});expect(r.statusCode,r.body).toBe(422);
  }
  expect((await app!.inject({method:'PATCH',url:`/api/v1/spaces/${space}/egress-notifications`,payload:{egress_notifications_enabled:false}})).statusCode).toBe(422);
  __setAuthIdentityForTests({spaceId:space,userId:member});expect((await write()).statusCode).toBe(404);
  expect((await app!.inject({method:'POST',url:'/api/v1/actions/space.egress_notifications.update',payload:{space_id:otherSpace,egress_notifications_enabled:false},headers:{'idempotency-key':randomUUID()}})).statusCode).toBe(404);
  expect((await notices()).rows).toEqual([]);
 });
 it('late audit failure rolls back the actual setting, notifications and receipt',async()=>{
  await db.pool.query("CREATE FUNCTION reject_egress_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late audit failure'; END $$");
  await db.pool.query('CREATE CONSTRAINT TRIGGER reject_egress_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_egress_audit()');
  const key=randomUUID();
  try{const r=await write(false,key);expect(r.statusCode,r.body).toBe(503);expect((await notices()).rows).toEqual([]);expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toEqual([]);expect((await db.pool.query('SELECT egress_notifications_enabled FROM spaces WHERE id=$1',[space])).rows[0].egress_notifications_enabled).toBe(true);}
  finally{await db.pool.query('DROP TRIGGER reject_egress_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION reject_egress_audit()');}
  expect((await write(false,key)).statusCode).toBe(200);
 });
 it('the canonical writer blocks on a role revocation and observes it before effects',async()=>{
  const hold=await db.pool.connect();let pending:Promise<unknown>|undefined;
  try{
   await hold.query('BEGIN');const pid=(await hold.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   await hold.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
   pending=new CrossSpaceRetrievalService(db.pool).updateEgressNotificationSetting(owner,space,false).catch(e=>e);
   await waitForBlockedBy(db.pool,pid);await hold.query('COMMIT');
   expect(await pending).toMatchObject({statusCode:403});expect((await notices()).rows).toEqual([]);
  }finally{await hold.query('ROLLBACK');hold.release();await pending;}
 });
});
