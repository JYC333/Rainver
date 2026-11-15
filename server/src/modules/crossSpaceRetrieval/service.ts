import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {excerptAroundQuery} from '../retrieval/normalize.js';
import {lockRetrievalReleaseBatch,withheldPinnedReleaseRefs,releaseRootResource,type ReleaseRef} from '../retrieval/releaseClosure.js';
import {personalReceiptSpace} from '../access/personalSpace.js';
import {canonical} from '../systemActions/operations/repository.js';
import {lockSpaceRole} from '../spaces/writers.js';
import { randomUUID } from "node:crypto";
import type {
  CrossSpaceResolvedItem,
  CrossSpaceRetrievalResponse,
  RetrievalObjectType,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";

import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import { knowledgeRetrievalAdapter } from "../knowledge/retrievalAdapter.js";
import { memoryRetrievalAdapter } from "../memory/retrievalAdapter.js";
import { projectRetrievalAdapter } from "../projects/retrievalAdapter.js";
import { inquiryRetrievalAdapter } from "../inquiry/retrievalAdapter.js";
import { RetrievalRegistry } from "../retrieval/registry.js";
import { RetrievalSearchService } from "../retrieval/searchService.js";
import { sourceRetrievalAdapter } from "../sources/retrievalAdapter.js";
import { HttpError, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import {
  ContentAccessAuditService,
  contentResourceTypeForRetrievalObject,
} from "../contentAccess/audit.js";

const DISCLOSURE_TTL_MS = 15 * 60 * 1000;

export const personalAggregatedRetrievalRegistry = new RetrievalRegistry();
for (const adapter of [
  knowledgeRetrievalAdapter,
  memoryRetrievalAdapter,
  projectRetrievalAdapter,
  sourceRetrievalAdapter,
  inquiryRetrievalAdapter,
]) {
  personalAggregatedRetrievalRegistry.register(adapter);
}
export const PERSONAL_AGGREGATED_RESOURCE_TYPES = [
  "knowledge_item",
  "note",
  "source",
  "claim",
  "memory_entry",
  "project_public_summary",
  "source_item",
  "extracted_evidence",
  "inquiry_thread",
] as const satisfies readonly RetrievalObjectType[];

const registeredTypes = personalAggregatedRetrievalRegistry.objectTypes().sort();
const exceptionTypes = [...PERSONAL_AGGREGATED_RESOURCE_TYPES].sort();
if (JSON.stringify(registeredTypes) !== JSON.stringify(exceptionTypes)) {
  throw new Error("personal aggregated retrieval registry must match its explicit exception list");
}

interface SpaceRow {
  id: string;
  name: string;
  type: string;
  created_by_user_id: string | null;
  role: string;
  egress_notifications_enabled: boolean;
}

interface PointerRow {
  pointer_id: string;
  space_id: string;
  resource_type: RetrievalObjectType;
  resource_id: string;
  space_name: string;
  egress_notifications_enabled: boolean;
}

export class CrossSpaceRetrievalService {
  constructor(private readonly pool: Queryable,private readonly auditReads=true) {}


  static fromConfig(config: ServerConfig): CrossSpaceRetrievalService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new CrossSpaceRetrievalService(getDbPool(config.databaseUrl));
  }

  async prepareSearch(input: {userId:string;query:string;resourceTypes?:RetrievalObjectType[];maxResults?:number}) {
    const spaces = await this.activeSpaces(input.userId);
    const personalSpace = requirePersonalSpace(spaces, input.userId);
    const resourceTypes = input.resourceTypes ?? [...PERSONAL_AGGREGATED_RESOURCE_TYPES];
    assertExceptionTypes(resourceTypes);
    const maxResults = Math.min(Math.max(input.maxResults ?? 20, 1), 50);

    const recall=async()=>{
    const perSpace = [];
    for(const space of spaces){
      const result = await new RetrievalSearchService(
        this.pool,
        personalAggregatedRetrievalRegistry,
      ).search({
        spaceId: space.id,
        viewerUserId: input.userId,
        objectTypes: resourceTypes,
        query: input.query,
        maxResults,
        mode: "lexical",
        skipAudit: true,
      });
      perSpace.push(result.items.map((item) => ({ space, item })));
    }

    return perSpace.flat()
      .sort((a, b) => b.item.score - a.item.score || a.space.id.localeCompare(b.space.id)
        || a.item.object_id.localeCompare(b.item.object_id))
      .slice(0, maxResults);

    };
    let selected=await recall();
    await this.pinRefs(input.userId, selected.map(({space,item})=>({space_id:space.id,object_type:item.object_type,object_id:item.object_id})),spaces.map(s=>s.id));
    const after=await this.activeSpaces(input.userId);
    if(canonical(spaces)!==canonical(after))throw new HttpError(409,'Retrieval Space scope changed');
    for(const {space,item} of selected)if(await this.withheld(input.userId,space.id,[{object_type:item.object_type,object_id:item.object_id}]))throw new HttpError(409,'Retrieval authority changed');
    const current=await recall();
    const identities=(rows:typeof selected)=>rows.map(r=>[r.space.id,r.item.object_type,r.item.object_id]);
    if(canonical(identities(selected))!==canonical(identities(current)))throw new HttpError(409,'Retrieval results changed; search again');
    selected=current;
    const prepared={spaces,personalSpace,selected};
    return prepared;
  }

  private async pinRefs(userId:string,refs:readonly {space_id:string;object_type:ReleaseRef['object_type'];object_id:string}[],extraSpaces:readonly string[]=[],artifacts:readonly {space_id:string;id:string}[]=[]):Promise<void>{
    const personal=await personalReceiptSpace(this.pool,userId);
    const spaceIds=[...new Set([personal,...extraSpaces,...artifacts.map(r=>r.space_id),...refs.map(r=>r.space_id)])].sort();
    await lockRetrievalReleaseBatch(this.pool,spaceIds.map(space=>({space,user:userId,...(space!==personal?{allowInactiveViewer:true as const}:{}),groups:[{registry:personalAggregatedRetrievalRegistry,refs:refs.filter(r=>r.space_id===space)}],additional:artifacts.filter(a=>a.space_id===space).map(a=>({object_type:'artifact' as const,object_id:a.id}))})));
    if(await personalReceiptSpace(this.pool,userId)!==personal)throw new HttpError(409,'Personal Space changed');
  }

  private async withheld(userId:string,spaceId:string,refs:readonly ReleaseRef[]):Promise<number>{
    const allowed=await new RetrievalSearchService(this.pool,personalAggregatedRetrievalRegistry).revalidateCanonicalForRelease({spaceId,viewerUserId:userId},refs);
    return refs.filter(r=>!allowed.has(r.object_type+':'+r.object_id)).length;
  }

  /** Receipt admission is independent of source authority. Discovery is repeated
   * after the complete global lock set; missing pointers remain unresolved. */
  async preparePointers(userId:string,pointerIds:string[],artifacts:readonly {space_id:string;id:string}[]=[]):Promise<void>{
    const before=await this.loadPointerRows(userId,pointerIds);
    await this.pinRefs(userId,before.map(r=>({space_id:r.space_id,object_type:r.resource_type,object_id:r.resource_id})),[],artifacts);
    if(canonical(before)!==canonical(await this.loadPointerRows(userId,pointerIds)))throw new HttpError(409,'Retrieval pointers changed');
  }

  async authorizeStoredResult(userId:string,output:unknown):Promise<void>{
    const out=output as {items?:CrossSpaceResolvedItem[];artifact_id?:string;disclosure_id?:string;source_space_ids?:string[];session_id?:string};
    let query:string|undefined;
    if(out.session_id){
      const session=(await this.pool.query<{query:string}>('SELECT query FROM cross_space_retrieval_sessions WHERE id=$1 AND user_id=$2',[out.session_id,userId])).rows[0];
      if(!session)throw new HttpError(404,'Retrieval session not found');query=session.query;
    }
    let pointerIds=out.items?.map(i=>i.pointer.pointer_id)??[];
    let artifact: {space_id:string;metadata_json:{source_pointers?:Array<{pointer_id:string}>;source_access_levels?:Array<{pointer_id:string;access_level:string}>}}|undefined;
    if(out.artifact_id){
      const row=(await this.pool.query<{space_id:string;metadata_json:{source_pointers?:Array<{pointer_id:string}>;source_access_levels?:Array<{pointer_id:string;access_level:string}>}}>("SELECT space_id,metadata_json FROM artifacts WHERE id=$1 AND owner_user_id=$2 AND visibility='private'",[out.artifact_id,userId])).rows[0];
      if(!row)throw new HttpError(404,'Artifact not found');
      artifact=row;
      if(!Array.isArray(row.metadata_json?.source_pointers)||!row.metadata_json.source_pointers.length||row.metadata_json.source_pointers.some(p=>typeof p?.pointer_id!=='string'))throw new HttpError(404,'Artifact lineage not found');
      pointerIds=row.metadata_json.source_pointers.map(p=>p.pointer_id);
    }
    if(out.disclosure_id){
      const row=(await this.pool.query<{pointer_ids_json:string[]}>('SELECT pointer_ids_json FROM cross_space_egress_disclosures WHERE id=$1 AND user_id=$2',[out.disclosure_id,userId])).rows[0];
      if(!row)throw new HttpError(404,'Disclosure not found');
      pointerIds=row.pointer_ids_json;
    }
    await this.preparePointers(userId,pointerIds,artifact?[{space_id:artifact.space_id,id:out.artifact_id!}]:[]);
    if(artifact){
      const current=(await this.pool.query("SELECT space_id,metadata_json FROM artifacts WHERE id=$1 AND owner_user_id=$2 AND visibility='private'",[out.artifact_id,userId])).rows[0];
      if(canonical(artifact)!==canonical(current))throw new HttpError(409,'Stored retrieval lineage changed');
    }
    const rows=await this.loadPointerRows(userId,pointerIds);
    if(rows.length!==pointerIds.length)throw new HttpError(404,'Retrieval pointer not found');
    const resolved=[];
    for(const row of rows){
      const requirements=artifact?.metadata_json.source_access_levels;
      if(requirements&&(!Array.isArray(requirements)||requirements.length!==pointerIds.length||requirements.some(r=>!pointerIds.includes(r.pointer_id)||!['summary','full'].includes(r.access_level))||new Set(requirements.map(r=>r.pointer_id)).size!==pointerIds.length))throw new HttpError(404,'Artifact lineage not found');
      // Older artifacts have no access snapshot, so their derived body needs full.
      const requireFull=Boolean(artifact&&(!requirements||requirements.find(r=>r.pointer_id===row.pointer_id)?.access_level==='full'));
      const item=await this.revalidatePointer(userId,row,this.pool,requireFull);
      if(!item)throw new HttpError(404,'Retrieval pointer not found');
      const released=out.items?.find(i=>i.pointer.pointer_id===row.pointer_id);
      const snippet=query===undefined?item.snippet:item.snippet?excerptAroundQuery(item.snippet,query):null;
      if(released&&(released.title!==item.title||released.space_name!==item.space_name||released.snippet!==snippet))throw new HttpError(404,'Retrieval content changed');
      resolved.push(item);
    }
    if(out.disclosure_id&&!sameSettingsSnapshot((output as {source_spaces:unknown}).source_spaces,groupResolved(resolved,await this.activeSpaces(userId))))throw new HttpError(409,'Source Space egress settings changed; disclose again');
    await this.recordPointerReads(userId,rows.map(r=>({spaceId:r.space_id,resourceType:r.resource_type,resourceId:r.resource_id})));
  }

  async search(input: {
    userId: string;
    query: string;
    resourceTypes?: RetrievalObjectType[];
    maxResults?: number;
  }, prepared?:Awaited<ReturnType<CrossSpaceRetrievalService["prepareSearch"]>>): Promise<CrossSpaceRetrievalResponse> {
    return withQueryableTransaction(this.pool,async client=>{
    const owner=new CrossSpaceRetrievalService(client,this.auditReads);
    const {personalSpace,selected}=prepared??await owner.prepareSearch(input);
    await owner.recordPointerReads(input.userId,selected.map(({space,item})=>({spaceId:space.id,resourceType:item.object_type,resourceId:item.object_id})));
    const sessionId = randomUUID();
    const pointerIds = selected.map(() => randomUUID());
      await client.query(
        `INSERT INTO cross_space_retrieval_sessions
           (id, user_id, personal_space_id, query, created_at)
         VALUES ($1, $2, $3, $4, now())`,
        [sessionId, input.userId, personalSpace.id, input.query],
      );
      for (let i = 0; i < selected.length; i += 1) {
        const selectedItem = selected[i]!;
        await client.query(
          `INSERT INTO cross_space_retrieval_pointers
             (id, session_id, user_id, resource_space_id, resource_type, resource_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [pointerIds[i], sessionId, input.userId, selectedItem.space.id,
            selectedItem.item.object_type, selectedItem.item.object_id],
        );
      }

    return {
      session_id: sessionId,
      items: selected.map((entry, index) => ({
        pointer: {
          pointer_id: pointerIds[index]!,
          space_id: entry.space.id,
          resource_type: entry.item.object_type,
          id: entry.item.object_id,
        },
        space_name: entry.space.name,
        title: entry.item.title,
        snippet: entry.item.snippet,
        score: entry.item.score,
      })),
      source_space_ids: [...new Set(selected.map((entry) => entry.space.id))],
      fused_conclusion: null,
      canonical_write_performed: false,
    };
    });
  }

  async resolve(userId: string, pointerIds: string[]): Promise<{
    items: CrossSpaceResolvedItem[];
    unresolved_pointer_ids: string[];
  }> {
    return withQueryableTransaction(this.pool, async (client) => {
      await new CrossSpaceRetrievalService(client,this.auditReads).preparePointers(userId,pointerIds);
      const rows = await this.loadPointerRows(userId, pointerIds, client);
      const byId = new Map(rows.map((row) => [row.pointer_id, row]));
      const items: CrossSpaceResolvedItem[] = [];
      const unresolved: string[] = [];
      for (const pointerId of pointerIds) {
        const row = byId.get(pointerId);
        if (!row) {
          unresolved.push(pointerId);
          continue;
        }
        const resolved = await this.revalidatePointer(userId, row, client);
        if (!resolved) {
          unresolved.push(pointerId);
          continue;
        }
        items.push(resolved);
      }
      await this.recordPointerReads(userId, refsForAccessAudit(items), client);
      return { items, unresolved_pointer_ids: unresolved };
    });
  }

  async storeSingleSourceSummary(userId: string, pointerIds: string[], summary: string): Promise<{
    artifact_id: string;
    source_space_id: string;
  }> {
    return withQueryableTransaction(this.pool, async (client) => {
      await new CrossSpaceRetrievalService(client,this.auditReads).preparePointers(userId,pointerIds);
      const resolved = await this.resolveAll(userId, pointerIds, client);
      const sourceSpaces = new Set(resolved.map((item) => item.pointer.space_id));
      if (sourceSpaces.size !== 1) {
        throw new HttpError(422, "single-source summary requires pointers from exactly one Space");
      }
      const sourceSpaceId = resolved[0]!.pointer.space_id;
      const artifactId = await insertArtifactRow(client, {
        spaceId: sourceSpaceId,
        ownerUserId: userId,
        artifactType: "cross_space_source_summary",
        title: "Personal source summary",
        content: summary,
        metadata: {
          kind: "cross_space_source_summary",
          source_pointers: resolved.map((item) => item.pointer),
          source_access_levels: await this.readLevels(userId,resolved,client),
        },
        canonicalFormat: "cross_space_source_summary.v1",
        visibility: "private",
      });
      return { artifact_id: artifactId, source_space_id: sourceSpaceId };
    });
  }

  async discloseEgress(userId: string, pointerIds: string[]): Promise<{
    disclosure_id: string;
    expires_at: string;
    source_spaces: Array<{
      space_id: string;
      space_name: string;
      egress_notifications_enabled: boolean;
      pointers: Array<{ resource_type: RetrievalObjectType; id: string }>;
    }>;
  }> {
    return withQueryableTransaction(this.pool, async (client) => {
      await new CrossSpaceRetrievalService(client,this.auditReads).preparePointers(userId,pointerIds);
      const resolved = await this.resolveAll(userId, pointerIds, client);
      const spaces = await this.activeSpaces(userId, client);
      const personalSpace = requirePersonalSpace(spaces, userId);
      const bySpace = groupResolved(resolved, spaces);
      if (bySpace.length < 2) throw new HttpError(422, "fused conclusion requires at least two source Spaces");
      const disclosureId = randomUUID();
      const expiresAt = new Date(Date.now() + DISCLOSURE_TTL_MS).toISOString();
      await client.query(
        `INSERT INTO cross_space_egress_disclosures
           (id, user_id, personal_space_id, pointer_ids_json, settings_snapshot_json,
            disclosed_at, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, now(), $6)`,
        [disclosureId, userId, personalSpace.id, JSON.stringify(normalizeIds(pointerIds)),
          JSON.stringify(bySpace), expiresAt],
      );
      return { disclosure_id: disclosureId, expires_at: expiresAt, source_spaces: bySpace };
    });
  }

  async storeFusedConclusion(input: {
    userId: string;
    disclosureId: string;
    pointerIds: string[];
    conclusion: string;
  }): Promise<{ artifact_id: string; egress_record_ids: string[] }> {
    return withQueryableTransaction(this.pool, async (client) => {
      await new CrossSpaceRetrievalService(client,this.auditReads).preparePointers(input.userId,input.pointerIds);
      const disclosure = await client.query<{
        personal_space_id: string;
        pointer_ids_json: unknown;
        settings_snapshot_json: unknown;
        expires_at: Date | string;
        consumed_at: Date | string | null;
      }>(
        `SELECT personal_space_id, pointer_ids_json, settings_snapshot_json,
                expires_at, consumed_at
           FROM cross_space_egress_disclosures
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [input.disclosureId, input.userId],
      );
      const row = disclosure.rows[0];
      if (!row) throw new HttpError(404, "egress disclosure not found");
      if (row.consumed_at) throw new HttpError(409, "egress disclosure already consumed");
      if (new Date(row.expires_at).getTime() <= Date.now()) throw new HttpError(409, "egress disclosure expired");
      if (!sameIds(row.pointer_ids_json, input.pointerIds)) {
        throw new HttpError(422, "pointer_ids must match the disclosed set");
      }

      const resolved = await this.resolveAll(input.userId, input.pointerIds, client);
      const contributingSpaceIds = [...new Set(
        resolved.map((item) => item.pointer.space_id),
      )];
      const activeSpaces = await this.activeSpaces(
        input.userId,
        client,
        true,
        contributingSpaceIds,
      );
      if(requirePersonalSpace(await this.activeSpaces(input.userId,client),input.userId).id!==row.personal_space_id)throw new HttpError(409,'Personal Space changed');
      const bySpace = groupResolved(resolved, activeSpaces);
      if (bySpace.length < 2) throw new HttpError(422, "fused conclusion requires at least two source Spaces");
      if (!sameSettingsSnapshot(row.settings_snapshot_json, bySpace)) {
        throw new HttpError(409, "source Space egress settings changed; disclose again");
      }

      const artifactId = await insertArtifactRow(client, {
        spaceId: row.personal_space_id,
        ownerUserId: input.userId,
        artifactType: "cross_space_fused_conclusion",
        title: "Stored cross-Space conclusion",
        content: input.conclusion,
        metadata: {
          kind: "cross_space_fused_conclusion",
          source_pointers: resolved.map((item) => item.pointer),
          source_access_levels: await this.readLevels(input.userId,resolved,client),
          disclosure_id: input.disclosureId,
        },
        canonicalFormat: "cross_space_fused_conclusion.v1",
        visibility: "private",
      });

      const egressRecordIds: string[] = [];
      for (const source of bySpace) {
        const egressId = randomUUID();
        egressRecordIds.push(egressId);
        const sourcePointers = resolved
          .filter((item) => item.pointer.space_id === source.space_id)
          .map((item) => item.pointer);
        await client.query(
          `INSERT INTO content_egress_records
             (id, source_space_id, actor_user_id, target_personal_space_id,
              target_artifact_id, disclosure_id, source_pointers_json,
              notification_enabled, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())`,
          [egressId, source.space_id, input.userId, row.personal_space_id,
            artifactId, input.disclosureId, JSON.stringify(sourcePointers),
            source.egress_notifications_enabled],
        );
        if (source.egress_notifications_enabled) {
          await broadcast(client, source.space_id, "content_egress", {
            actor_user_id: input.userId,
            egress_record_id: egressId,
            source_pointers: sourcePointers,
            created_at: new Date().toISOString(),
          });
        }
      }
      await client.query(
        `UPDATE cross_space_egress_disclosures SET consumed_at = now() WHERE id = $1`,
        [input.disclosureId],
      );
      return { artifact_id: artifactId, egress_record_ids: egressRecordIds };
    });
  }

  async updateEgressNotificationSetting(userId: string, spaceId: string, enabled: boolean): Promise<{
    space_id: string;
    egress_notifications_enabled: boolean;
    updated_at: string;
  }> {
    return withQueryableTransaction(this.pool, client => updateEgressNotificationSetting(client, userId, spaceId, enabled));
  }

  async listNotifications(userId: string): Promise<{ items: Array<Record<string, unknown>> }> {
    const result = await this.pool.query<{
      id: string;
      space_id: string;
      event_type: string;
      pointer_metadata_json: Record<string, unknown>;
      created_at: Date | string;
      read_at: Date | string | null;
    }>(
      `SELECT n.id, n.space_id, n.event_type, n.pointer_metadata_json,
              n.created_at, n.read_at
         FROM space_member_notifications n
         JOIN space_memberships m
           ON m.space_id = n.space_id AND m.user_id = $1 AND m.status = 'active'
        WHERE n.recipient_user_id = $1
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT 100`,
      [userId],
    );
    return { items: result.rows.map((row) => ({
      id: row.id,
      space_id: row.space_id,
      event_type: row.event_type,
      pointer_metadata: row.pointer_metadata_json,
      created_at: new Date(row.created_at).toISOString(),
      read_at: row.read_at ? new Date(row.read_at).toISOString() : null,
    })) };
  }

  private async activeSpaces(
    userId: string,
    db: Queryable = this.pool,
    lockForEgress = false,
    spaceIds?: readonly string[],
  ): Promise<SpaceRow[]> {
    if (spaceIds?.length === 0) return [];
    const params: unknown[] = [userId];
    const spaceFilter = spaceIds
      ? "AND s.id = ANY($2::varchar[])"
      : "";
    if (spaceIds) params.push(spaceIds);
    const result = await db.query<SpaceRow>(
      `SELECT s.id, s.name, s.type, s.created_by_user_id, m.role,
              s.egress_notifications_enabled
         FROM space_memberships m
         JOIN spaces s ON s.id = m.space_id
        WHERE m.user_id = $1 AND m.status = 'active'
        ${spaceFilter}
        ORDER BY s.id
        ${lockForEgress ? "FOR SHARE OF s" : ""}`,
      params,
    );
    return result.rows;
  }

  private async loadPointerRows(userId: string, pointerIds: string[], db: Queryable = this.pool): Promise<PointerRow[]> {
    if (pointerIds.length === 0) return [];
    const result = await db.query<PointerRow>(
      `SELECT p.id AS pointer_id, p.resource_space_id AS space_id,
              p.resource_type, p.resource_id, s.name AS space_name,
              s.egress_notifications_enabled
         FROM cross_space_retrieval_pointers p
         JOIN spaces s ON s.id = p.resource_space_id
        WHERE p.user_id = $1 AND p.id = ANY($2::varchar[])`,
      [userId, pointerIds],
    );
    return result.rows;
  }

  private async revalidatePointer(userId: string, row: PointerRow, db: Queryable = this.pool, requireFull=false): Promise<CrossSpaceResolvedItem | null> {
    const adapter = personalAggregatedRetrievalRegistry.adapterFor(row.resource_type);
    if (!adapter || !PERSONAL_AGGREGATED_RESOURCE_TYPES.includes(row.resource_type as never)) return null;
    if(requireFull&&await withheldPinnedReleaseRefs(db,{spaceId:row.space_id,userId},[{registry:personalAggregatedRetrievalRegistry,refs:[{object_type:row.resource_type,object_id:row.resource_id}]}],null,{canonical:true}))return null;
    const allowed=await new RetrievalSearchService(db,personalAggregatedRetrievalRegistry).revalidateCanonicalForRelease({spaceId:row.space_id,viewerUserId:userId},[{object_type:row.resource_type,object_id:row.resource_id}]);
    if(!allowed.has(row.resource_type+':'+row.resource_id))return null;
    const object = await adapter.revalidate(db, row.space_id, row.resource_type, row.resource_id, userId);
    if (!object) return null;
    return {
      pointer: { pointer_id: row.pointer_id, space_id: row.space_id, resource_type: row.resource_type, id: row.resource_id },
      space_name: row.space_name,
      title: object.title,
      snippet: object.text,
      score: 0,
    };
  }

  private async resolveAll(userId: string, pointerIds: string[], db: Queryable = this.pool): Promise<CrossSpaceResolvedItem[]> {
    const rows = await this.loadPointerRows(userId, pointerIds, db);
    const byId = new Map(rows.map((row) => [row.pointer_id, row]));
    const resolved: CrossSpaceResolvedItem[] = [];
    for (const pointerId of pointerIds) {
      const row = byId.get(pointerId);
      const item = row ? await this.revalidatePointer(userId, row, db) : null;
      if (!item) throw new HttpError(404, "one or more retrieval pointers are no longer resolvable");
      resolved.push(item);
    }
    await this.recordPointerReads(userId, refsForAccessAudit(resolved), db);
    return resolved;
  }

  /** An explicit user summary may be based on a legitimate summary-only read.
   * Persist its required access separately from the strict pointer wire DTO. */
  private async readLevels(userId:string,items:readonly CrossSpaceResolvedItem[],db:Queryable){
    const levels=[];
    for(const item of items){
      const root=releaseRootResource(item.pointer.resource_type);
      const level=root?await contentDecisionFromDb(db,{spaceId:item.pointer.space_id,userId},root,item.pointer.id):'full';
      if(level!=='full'&&level!=='summary')throw new HttpError(404,'Retrieval pointer not found');
      levels.push({pointer_id:item.pointer.pointer_id,access_level:level});
    }
    return levels;
  }

  private async recordPointerReads(userId: string, refs: Array<{
    spaceId: string;
    resourceType: RetrievalObjectType;
    resourceId: string;
  }>, db: Queryable = this.pool): Promise<void> {
    if(!this.auditReads)return;
    const grouped = new Map<string, { spaceId: string; resourceType: string; ids: string[] }>();
    for (const ref of refs) {
      const resourceType = contentResourceTypeForRetrievalObject(ref.resourceType);
      if (!resourceType) continue;
      const key = `${ref.spaceId}:${resourceType}`;
      const current = grouped.get(key) ?? { spaceId: ref.spaceId, resourceType, ids: [] };
      current.ids.push(ref.resourceId);
      grouped.set(key, current);
    }
    const audit = new ContentAccessAuditService(db);
    for (const group of grouped.values()) {
      await audit.recordReads({
        spaceId: group.spaceId,
        resourceType: group.resourceType,
        resourceIds: group.ids,
        viewerUserId: userId,
        accessType: "explicit_read",
        reason: "cross-space retrieval pointer resolution",
      });
    }
  }
}

function refsForAccessAudit(items: CrossSpaceResolvedItem[]): Array<{
  spaceId: string;
  resourceType: RetrievalObjectType;
  resourceId: string;
}> {
  return items.map((item) => ({
    spaceId: item.pointer.space_id,
    resourceType: item.pointer.resource_type,
    resourceId: item.pointer.id,
  }));
}

function assertExceptionTypes(types: readonly RetrievalObjectType[]): void {
  if (types.some((type) => !PERSONAL_AGGREGATED_RESOURCE_TYPES.includes(type as never))) {
    throw new HttpError(422, "resource type is not allowed for personal aggregated retrieval");
  }
}

function requirePersonalSpace(spaces: SpaceRow[], userId: string): SpaceRow {
  const personal = spaces.filter((space) =>
    space.type === "personal"
    && space.created_by_user_id === userId
    && space.role === "owner");
  if (personal.length !== 1) throw new HttpError(409, "user must have exactly one active Personal Space");
  return personal[0]!;
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return [];
  return [...new Set(value)].sort();
}

function sameIds(stored: unknown, supplied: string[]): boolean {
  return JSON.stringify(normalizeIds(stored)) === JSON.stringify(normalizeIds(supplied));
}

function sameSettingsSnapshot(
  stored: unknown,
  current: Array<{
    space_id: string;
    egress_notifications_enabled: boolean;
    pointers: Array<{ resource_type: RetrievalObjectType; id: string }>;
  }>,
): boolean {
  if (!Array.isArray(stored)) return false;
  const normalize = (rows: unknown[]) => rows.map((entry) => {
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return {
      space_id: typeof row.space_id === "string" ? row.space_id : "",
      egress_notifications_enabled: row.egress_notifications_enabled === true,
      pointers: normalizeResourcePointers(row.pointers),
    };
  }).sort((a, b) => a.space_id.localeCompare(b.space_id));
  return JSON.stringify(normalize(stored)) === JSON.stringify(normalize(current));
}

function groupResolved(resolved: CrossSpaceResolvedItem[], spaces: SpaceRow[]) {
  const spaceById = new Map(spaces.map((space) => [space.id, space]));
  const grouped = new Map<string, {
    space_id: string;
    space_name: string;
    egress_notifications_enabled: boolean;
    pointers: Array<{ resource_type: RetrievalObjectType; id: string }>;
  }>();
  for (const item of resolved) {
    const space = spaceById.get(item.pointer.space_id);
    if (!space) throw new HttpError(404, "source Space membership is no longer active");
    const group = grouped.get(space.id) ?? {
      space_id: space.id,
      space_name: space.name,
      egress_notifications_enabled: space.egress_notifications_enabled,
      pointers: [],
    };
    if (!group.pointers.some((pointer) =>
      pointer.resource_type === item.pointer.resource_type && pointer.id === item.pointer.id)) {
      group.pointers.push({ resource_type: item.pointer.resource_type, id: item.pointer.id });
    }
    grouped.set(space.id, group);
  }
  return [...grouped.values()]
    .map((group) => ({ ...group, pointers: normalizeResourcePointers(group.pointers) }))
    .sort((a, b) => a.space_id.localeCompare(b.space_id));
}

function normalizeResourcePointers(value: unknown): Array<{
  resource_type: RetrievalObjectType;
  id: string;
}> {
  if (!Array.isArray(value)) return [];
  const keyed = new Map<string, { resource_type: RetrievalObjectType; id: string }>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.resource_type !== "string" || typeof row.id !== "string") continue;
    if (!PERSONAL_AGGREGATED_RESOURCE_TYPES.includes(row.resource_type as never)) continue;
    keyed.set(`${row.resource_type}\u0000${row.id}`, {
      resource_type: row.resource_type as RetrievalObjectType,
      id: row.id,
    });
  }
  return [...keyed.values()].sort((a, b) =>
    a.resource_type.localeCompare(b.resource_type) || a.id.localeCompare(b.id));
}

async function broadcast(
  db: Queryable,
  spaceId: string,
  eventType: "egress_notification_setting_changed" | "content_egress",
  pointerMetadata: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO space_member_notifications
       (id, space_id, recipient_user_id, event_type, pointer_metadata_json, created_at)
     SELECT gen_random_uuid()::text, $1::varchar, m.user_id, $2::varchar, $3::jsonb, now()
       FROM space_memberships m
      WHERE m.space_id = $1::varchar AND m.status = 'active'`,
    [spaceId, eventType, JSON.stringify(pointerMetadata)],
  );
}

/** The canonical setting writer; both REST operations and direct callers use its transaction. */
export async function lockEgressNotificationManager(db: Queryable, userId: string, spaceId: string): Promise<void> {
  const role = await lockSpaceRole(db, spaceId, userId);
  if (role !== 'owner' && role !== 'admin') throw new HttpError(403, 'Requires Space owner or admin role');
}

export async function updateEgressNotificationSetting(db: Queryable, userId: string, spaceId: string, enabled: boolean): Promise<{
  space_id: string; egress_notifications_enabled: boolean; updated_at: string;
}> {
  return withQueryableTransaction(db, async db => {
    await lockEgressNotificationManager(db, userId, spaceId);
    const current = await db.query<{
      egress_notifications_enabled: boolean;
      updated_at: Date | string;
    }>(
      `SELECT egress_notifications_enabled, updated_at
         FROM spaces
        WHERE id = $1
        FOR UPDATE`,
      [spaceId],
    );
    const currentRow = current.rows[0];
    if (!currentRow) throw new HttpError(404, "Space not found");
    if (currentRow.egress_notifications_enabled === enabled) {
      return {
        space_id: spaceId,
        egress_notifications_enabled: enabled,
        updated_at: new Date(currentRow.updated_at).toISOString(),
      };
    }
    const result = await db.query<{ updated_at: Date | string }>(
      `UPDATE spaces
          SET egress_notifications_enabled = $1, updated_at = now()
        WHERE id = $2
        RETURNING updated_at`,
      [enabled, spaceId],
    );
    const updatedAt = new Date(result.rows[0]!.updated_at).toISOString();
    await broadcast(db, spaceId, "egress_notification_setting_changed", {
      changed_by_user_id: userId,
      egress_notifications_enabled: enabled,
      effective_from: updatedAt,
    });
    return { space_id: spaceId, egress_notifications_enabled: enabled, updated_at: updatedAt };
  });
}
