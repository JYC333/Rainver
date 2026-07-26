import { describe, expect, it } from "vitest";
import { RetrievalProjectionService } from "../src/modules/retrieval";
import { RetrievalFeedbackService, RetrievalSearchService } from "../src/modules/retrieval";
import { normalizeAlias, retrievalFeedbackQueryHash } from "../src/modules/retrieval";
import type { Queryable } from "../src/modules/routeUtils/common";
import type { RetrievalObjectType } from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";

const SPACE_A = "11111111-1111-4111-8111-111111111111";
const SPACE_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_A = "33333333-3333-4333-8333-333333333333";
const ITEM_B = "44444444-4444-4444-8444-444444444444";
const NOTE_A = "55555555-5555-4555-8555-555555555555";
const SOURCE_A = "66666666-6666-4666-8666-666666666666";
const SOURCE_CONNECTION_A = "77777777-7777-4777-8777-777777777777";
const CLAIM_A = "88888888-8888-4888-8888-888888888888";

interface SearchObject {
  space_id: string;
  object_type: RetrievalObjectType;
  object_id: string;
  object_kind?: string | null;
  object_kind_label?: string | null;
  title: string;
  status: string;
  visibility: string | null;
  owner_user_id: string | null;
  created_by_user_id: string | null;
  text: string | null;
  subject_text?: string | null;
  uri?: string | null;
  source_connection_ids_json?: unknown;
}

interface SearchAlias {
  space_id: string;
  object_type: RetrievalObjectType;
  object_id: string;
  alias: string;
  normalized_alias: string;
  alias_kind: string;
  confidence: number;
}

interface SearchEdge {
  space_id: string;
  from_object_type: RetrievalObjectType;
  from_object_id: string;
  to_object_type: RetrievalObjectType;
  to_object_id: string;
  relation_type: string;
  edge_origin: string;
  confidence: number;
}

interface FeedbackEvent {
  space_id: string;
  actor_user_id: string;
  surface: string;
  query_hash: string;
  object_type: RetrievalObjectType;
  object_id: string;
  signal_type: string;
  dwell_ms: number | null;
  created_at: string;
}

class SearchFakeDb implements Queryable {
  readonly objects: SearchObject[] = [];
  readonly aliases: SearchAlias[] = [];
  readonly edges: SearchEdge[] = [];
  readonly feedbackEvents: FeedbackEvent[] = [];
  readonly sourceConnections: Array<{
    id: string;
    owner_user_id: string;
    consent_json: unknown;
    policy_json: unknown;
  }> = [];

  addObject(input: SearchObject): void {
    this.objects.push(input);
  }

  addAlias(
    objectType: RetrievalObjectType,
    objectId: string,
    alias: string,
    aliasKind = "alias",
    confidence = 1,
    spaceId = SPACE_A,
  ): void {
    this.aliases.push({
      space_id: spaceId,
      object_type: objectType,
      object_id: objectId,
      alias,
      normalized_alias: normalizeAlias(alias),
      alias_kind: aliasKind,
      confidence,
    });
  }

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.includes("FROM retrieval_aliases ra")) {
      const [spaceId, objectTypes, normalized, objectKindFilter] = params as [
        string,
        RetrievalObjectType[],
        string[],
        string[] | null,
      ];
      const rows = this.aliases
        .filter((alias) =>
          alias.space_id === spaceId &&
          objectTypes.includes(alias.object_type) &&
          normalized.includes(alias.normalized_alias))
        .sort((a, b) => b.confidence - a.confidence)
        .map((alias, index) => {
          const object = this.objects.find((candidate) =>
            candidate.space_id === alias.space_id &&
            candidate.object_type === alias.object_type &&
            candidate.object_id === alias.object_id);
          if (!object || !matchesObjectKindFilter(object, objectKindFilter)) return null;
          return {
            object_type: alias.object_type,
            object_id: alias.object_id,
            object_kind: object.object_kind_label ? object.object_kind ?? null : null,
            object_kind_label: object.object_kind_label ?? null,
            title: object?.title ?? alias.alias,
            source_connection_ids_json: object?.source_connection_ids_json ?? [],
            snippet: object?.text ?? null,
            matched_text: alias.alias,
            matched_field: alias.alias_kind,
            rank: index + 1,
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
      return result(rows as Row[]);
    }
    if (norm.includes("FROM retrieval_chunks rc")) {
      const [spaceId, objectTypes, like, , objectKindFilter] = params as [
        string,
        RetrievalObjectType[],
        string,
        string,
        string[] | null,
      ];
      const needle = like.replace(/%/g, "").toLowerCase();
      const rows = this.objects
        .filter((object) =>
          object.space_id === spaceId &&
          objectTypes.includes(object.object_type) &&
          matchesObjectKindFilter(object, objectKindFilter) &&
          (object.text ?? "").toLowerCase().includes(needle))
        .map((object, index) => ({
          object_type: object.object_type,
          object_id: object.object_id,
          object_kind: object.object_kind_label ? object.object_kind ?? null : null,
          object_kind_label: object.object_kind_label ?? null,
          title: object.title,
          source_connection_ids_json: object.source_connection_ids_json ?? [],
          snippet: object.text,
          matched_text: object.text,
          matched_field: "plain_text",
          rank: index + 1,
        }));
      return result(rows as Row[]);
    }
    if (norm.includes("FROM retrieval_objects ro") && norm.includes("ro.object_id = $3")) {
      const [spaceId, objectType, objectId] = params as [string, RetrievalObjectType, string];
      const object = this.objects.find((candidate) =>
        candidate.space_id === spaceId &&
        candidate.object_type === objectType &&
        candidate.object_id === objectId);
      if (!object) return result([] as Row[]);
      return result([{
        object_type: object.object_type,
        object_id: object.object_id,
        object_kind: object.object_kind_label ? object.object_kind ?? null : null,
        object_kind_label: object.object_kind_label ?? null,
        title: object.title,
        source_connection_ids_json: object.source_connection_ids_json ?? [],
        snippet: object.text,
        matched_text: null,
        matched_field: null,
        updated_at: null,
        rank: 1,
      }] as Row[]);
    }
    if (norm.includes("FROM retrieval_edges e")) {
      const [spaceId, objectTypes, seeds] = params as [string, RetrievalObjectType[], string[]];
      const rows = this.edges
        .filter((edge) => edge.space_id === spaceId)
        .flatMap((edge, index) => {
          const fromKey = `${edge.from_object_type}:${edge.from_object_id}`;
          const toKey = `${edge.to_object_type}:${edge.to_object_id}`;
          const target = seeds.includes(fromKey)
            ? { object_type: edge.to_object_type, object_id: edge.to_object_id }
            : seeds.includes(toKey)
              ? { object_type: edge.from_object_type, object_id: edge.from_object_id }
              : null;
          if (!target || !objectTypes.includes(target.object_type)) return [];
          const object = this.objects.find((candidate) =>
            candidate.space_id === spaceId &&
            candidate.object_type === target.object_type &&
            candidate.object_id === target.object_id);
          if (!object) return [];
          return [{
            object_type: object.object_type,
            object_id: object.object_id,
            object_kind: object.object_kind_label ? object.object_kind ?? null : null,
            object_kind_label: object.object_kind_label ?? null,
            title: object.title,
            source_connection_ids_json: object.source_connection_ids_json ?? [],
            snippet: object.text,
            relation_type: edge.relation_type,
            edge_origin: edge.edge_origin,
            rank: index + 1,
          }];
        });
      return result(rows as Row[]);
    }
    if (norm.includes("FROM retrieval_feedback_events")) {
      const [spaceId, userId, surface, queryHash, objectTypes, objectIds, since] = params as [
        string,
        string,
        string,
        string,
        RetrievalObjectType[],
        string[],
        string,
      ];
      const sinceMs = Date.parse(since);
      const rows = this.feedbackEvents.filter((event) =>
        event.space_id === spaceId &&
        event.actor_user_id === userId &&
        event.surface === surface &&
        event.query_hash === queryHash &&
        objectTypes.includes(event.object_type) &&
        objectIds.includes(event.object_id) &&
        Date.parse(event.created_at) >= sinceMs);
      return result(rows as Row[]);
    }
    if (norm.includes("FROM knowledge_items")) {
      const batch = Array.isArray(params[1]);
      const spaceId = batch ? params[0] as string : params[1] as string;
      const ids = batch ? params[1] as string[] : [params[0] as string];
      const viewerUserId = batch ? params[2] as string : null;
      const rows = this.objects
        .filter((candidate) =>
          candidate.object_type === "knowledge_item" &&
          ids.includes(candidate.object_id) &&
          candidate.space_id === spaceId &&
          candidate.status === "active" &&
          (!viewerUserId || fakeContentVisible(candidate, viewerUserId)))
        .map((object) => ({
          id: object.object_id,
          title: object.title,
          status: object.status,
          visibility: object.visibility,
          owner_user_id: object.owner_user_id,
          created_by_user_id: object.created_by_user_id,
          excerpt: object.text,
          plain_text: object.text,
          content: object.text,
        }));
      return result(rows as Row[]);
    }
    if (norm.includes("FROM notes")) {
      const batch = Array.isArray(params[1]);
      const spaceId = batch ? params[0] as string : params[1] as string;
      const ids = batch ? params[1] as string[] : [params[0] as string];
      const viewerUserId = batch ? params[2] as string : null;
      const rows = this.objects
        .filter((candidate) =>
          candidate.object_type === "note" &&
          ids.includes(candidate.object_id) &&
          candidate.space_id === spaceId &&
          candidate.status === "active" &&
          (!viewerUserId || fakeContentVisible(candidate, viewerUserId)))
        .map((object) => ({
        id: object.object_id,
        title: object.title,
        status: object.status,
        excerpt: object.text,
        plain_text: object.text,
      }));
      return result(rows as Row[]);
    }
    if (norm.includes("FROM sources")) {
      const batch = Array.isArray(params[1]);
      const spaceId = batch ? params[0] as string : params[1] as string;
      const ids = batch ? params[1] as string[] : [params[0] as string];
      const viewerUserId = batch ? params[2] as string : null;
      const rows = this.objects
        .filter((candidate) =>
          candidate.object_type === "source" &&
          ids.includes(candidate.object_id) &&
          candidate.space_id === spaceId &&
          candidate.status !== "archived" &&
          (!viewerUserId || fakeContentVisible(candidate, viewerUserId)))
        .map((object) => ({
          id: object.object_id,
          title: object.title,
          status: object.status,
          uri: object.uri ?? null,
          raw_text: object.text,
          summary: object.text,
      }));
      return result(rows as Row[]);
    }
    if (norm.includes("FROM claims")) {
      const batch = Array.isArray(params[1]);
      const spaceId = batch ? params[0] as string : params[1] as string;
      const ids = batch ? params[1] as string[] : [params[0] as string];
      const viewerUserId = batch ? params[2] as string : null;
      const rows = this.objects
        .filter((candidate) =>
          candidate.object_type === "claim" &&
          ids.includes(candidate.object_id) &&
          candidate.space_id === spaceId &&
          candidate.status === "active" &&
          (!viewerUserId || fakeContentVisible(candidate, viewerUserId)))
        .map((object) => ({
          id: object.object_id,
          title: object.title,
          status: object.status,
          visibility: object.visibility,
          owner_user_id: object.owner_user_id,
          created_by_user_id: object.created_by_user_id,
          subject_text: object.subject_text ?? null,
          claim_text: object.text,
        }));
      return result(rows as Row[]);
    }
    if (norm.startsWith("SELECT id, owner_user_id, consent_json, policy_json FROM source_connections")) {
      const [, sourceIds] = params as [string, string[]];
      return result(this.sourceConnections.filter((connection) => sourceIds.includes(connection.id)) as Row[]);
    }
    if (norm.startsWith("SELECT role FROM space_memberships")) {
      return result([] as Row[]);
    }
    throw new Error(`unexpected SQL: ${norm}`);
  }
}

class ProjectionFakeDb implements Queryable {
  readonly retrievalEdges: Array<Record<string, unknown>> = [];
  readonly forbiddenWrites: string[] = [];
  readonly aliasTargets = new Map<string, Array<{ object_type: RetrievalObjectType; object_id: string }>>();
  readonly canonicalItems = new Map<string, Record<string, unknown>>([
    [ITEM_A, {
      id: ITEM_A,
      space_id: SPACE_A,
      project_folder_id: null,
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      visibility: "space_shared",
      status: "active",
      knowledge_kind: "concept",
      title: "Alpha",
      slug: "alpha",
      aliases_json: [],
      content: "Alpha links to [[Beta]] and [Source](https://example.test/source).",
      plain_text: "Alpha links to [[Beta]] and [Source](https://example.test/source).",
      excerpt: "Alpha links",
    }],
    [ITEM_B, {
      id: ITEM_B,
      space_id: SPACE_A,
      project_folder_id: null,
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      visibility: "space_shared",
      status: "active",
      knowledge_kind: "concept",
      title: "Beta",
      slug: "beta",
      aliases_json: [],
      content: "Beta target content.",
      plain_text: "Beta target content.",
      excerpt: "Beta target",
    }],
  ]);
  relationRows: Array<Record<string, unknown>> = [];

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.includes("INSERT INTO memory_entries") || norm.includes("INSERT INTO object_relations")) {
      this.forbiddenWrites.push(norm);
      throw new Error("forbidden canonical write");
    }
    if (norm.startsWith("SELECT ki.object_id AS id, so.project_folder_id")) {
      const objectId = params[1] as string;
      const row = this.canonicalItems.get(objectId);
      return result((row ? [row] : []) as Row[]);
    }
    if (norm.startsWith("SELECT pl.target_id,")) {
      return result([] as Row[]);
    }
    if (norm.startsWith("SELECT ki.object_id AS id FROM knowledge_items ki")) {
      return result([...this.canonicalItems.values()].map((row) => ({ id: row.id })) as Row[]);
    }
    if (
      norm.startsWith("SELECT n.object_id AS id FROM notes n") ||
      norm.startsWith("SELECT s.object_id AS id FROM sources s") ||
      norm.startsWith("SELECT c.object_id AS id FROM claims c")
    ) {
      return result([] as Row[]);
    }
    if (
      norm ===
      "DELETE FROM retrieval_edges WHERE space_id = $1 AND from_object_type = ANY($2::retrieval_object_type[])"
    ) {
      const [spaceId, objectTypes] = params as [string, RetrievalObjectType[]];
      removeWhere(
        this.retrievalEdges,
        (edge) => edge.space_id === spaceId && objectTypes.includes(edge.from_object_type as RetrievalObjectType),
      );
      return result([] as Row[]);
    }
    if (norm.startsWith("DELETE FROM retrieval_edges") && norm.includes("OR (to_object_type = $2")) {
      const [spaceId, objectType, objectId] = params;
      removeWhere(this.retrievalEdges, (edge) =>
        edge.space_id === spaceId &&
        ((edge.from_object_type === objectType && edge.from_object_id === objectId) ||
          (edge.to_object_type === objectType && edge.to_object_id === objectId)));
      return result([] as Row[]);
    }
    if (norm.startsWith("DELETE FROM retrieval_edges") && norm.includes("from_object_type = $2")) {
      const [spaceId, objectType, objectId] = params;
      removeWhere(this.retrievalEdges, (edge) =>
        edge.space_id === spaceId && edge.from_object_type === objectType && edge.from_object_id === objectId);
      return result([] as Row[]);
    }
    if (norm.startsWith("DELETE FROM retrieval_objects")) {
      return result([] as Row[]);
    }
    if (norm.startsWith("INSERT INTO retrieval_objects")) {
      return result([{ id: "retrieval-object-1" }] as Row[]);
    }
    if (norm.startsWith("INSERT INTO retrieval_aliases")) {
      const normalizedAlias = params[6] as string;
      const target = {
        object_type: params[3] as RetrievalObjectType,
        object_id: params[4] as string,
      };
      const rows = this.aliasTargets.get(normalizedAlias) ?? [];
      if (!rows.some((row) => row.object_type === target.object_type && row.object_id === target.object_id)) {
        rows.push(target);
      }
      this.aliasTargets.set(normalizedAlias, rows);
      return result([] as Row[]);
    }
    if (norm.startsWith("INSERT INTO retrieval_chunks")) {
      return result([] as Row[]);
    }
    if (norm.startsWith("SELECT DISTINCT object_type, object_id FROM retrieval_aliases")) {
      const candidates = params[1] as string[];
      const rows = dedupeTargets(candidates.flatMap((candidate) => this.aliasTargets.get(candidate) ?? []));
      return result(rows as Row[]);
    }
    if (norm.startsWith("SELECT source_type, source_id, target_type")) {
      return result([] as Row[]);
    }
    if (norm.startsWith("SELECT knowledge_item_id, source_id")) {
      return result([] as Row[]);
    }
    if (norm.startsWith("SELECT cs.claim_id, cs.source_object_id")) {
      return result([] as Row[]);
    }
    if (norm.startsWith("SELECT r.from_object_id")) {
      return result(this.relationRows as Row[]);
    }
    if (norm.startsWith("INSERT INTO retrieval_edges")) {
      const edge = {
        space_id: params[1],
        from_object_type: params[2],
        from_object_id: params[3],
        to_object_type: params[4],
        to_object_id: params[5],
        relation_type: params[6],
        edge_origin: params[7],
        edge_status: params[8],
      };
      removeWhere(this.retrievalEdges, (existing) =>
        existing.space_id === edge.space_id &&
        existing.from_object_type === edge.from_object_type &&
        existing.from_object_id === edge.from_object_id &&
        existing.to_object_type === edge.to_object_type &&
        existing.to_object_id === edge.to_object_id &&
        existing.relation_type === edge.relation_type &&
        existing.edge_origin === edge.edge_origin);
      this.retrievalEdges.push(edge);
      return result([] as Row[]);
    }
    throw new Error(`unexpected SQL: ${norm}`);
  }
}

describe("Knowledge zero-LLM retrieval", () => {
  it("returns a KnowledgeItem for exact title match", async () => {
    const db = searchDbWithKnowledge();
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
    });

    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      object_type: "knowledge_item",
      object_id: ITEM_A,
      evidence: { kind: "exact_title_match" },
    });
  });

  it("surfaces active object_kind metadata and filters within a fixed object_type", async () => {
    const db = searchDbWithKnowledge();
    db.objects[0]!.object_kind = "decision";
    db.objects[0]!.object_kind_label = "Decision";
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.addObject({
      space_id: SPACE_A,
      object_type: "knowledge_item",
      object_id: ITEM_B,
      object_kind: "risk",
      object_kind_label: null, // projected kind exists but is not active in the governed registry
      title: "Alpha risk",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Alpha risk body",
    });
    db.addAlias("knowledge_item", ITEM_B, "Alpha risk", "title");

    const all = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectTypes: ["knowledge_item"],
      query: "Alpha",
      maxResults: 10,
    });
    expect(all.items.find((item) => item.object_id === ITEM_A)).toMatchObject({
      object_kind: "decision",
      object_kind_label: "Decision",
    });
    expect(all.items.find((item) => item.object_id === ITEM_B)).toMatchObject({
      object_kind: null,
      object_kind_label: null,
    });

    const decisions = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectTypes: ["knowledge_item"],
      objectKinds: ["decision"],
      query: "Alpha",
      includeTrace: true,
      maxResults: 10,
    });

    expect(decisions.items.map((item) => item.object_id)).toEqual([ITEM_A]);
    expect(JSON.stringify(decisions.trace)).not.toContain("risk");
  });

  it("drops canonical-readable results when source consent denies the viewer", async () => {
    const db = searchDbWithKnowledge({
      ownerUserId: USER_A,
      sourceConnectionIds: [SOURCE_CONNECTION_A],
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.sourceConnections.push({
      id: SOURCE_CONNECTION_A,
      owner_user_id: USER_A,
      consent_json: {
        schema_version: 1,
        owner_user_id: USER_A,
        subject_user_ids: [USER_A],
        allowed_reader_user_ids: [USER_A],
        allowed_agent_ids: [],
        allow_space_admins: false,
        allow_local_provider_egress: false,
        allow_external_model_egress: false,
      },
      policy_json: {
        schema_version: 1,
        source_egress_class: "internal_only",
        retention_policy: "full_text",
        import_trust_level: "normal",
        derived_write_policy: "proposal_required",
        allowed_import_targets: ["knowledge"],
        revalidation: { required: true, viewer_scoped: true },
      },
    });

    const denied = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_B,
      query: "Alpha",
      includeTrace: true,
    });
    const allowed = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
    });

    expect(denied.items).toHaveLength(0);
    expect(JSON.stringify(denied.trace)).not.toContain("source_policy_denied");
    expect(allowed.items).toHaveLength(1);
  });

  it("returns a KnowledgeItem for alias match", async () => {
    const db = searchDbWithKnowledge();
    db.addAlias("knowledge_item", ITEM_A, "Hall of Light", "alias");

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "hall of light",
    });

    expect(out.items[0]).toMatchObject({
      object_id: ITEM_A,
      evidence: { kind: "alias_hit" },
      create_safety: "exists",
    });
  });

  it("returns a Note for lexical title/content search", async () => {
    const db = new SearchFakeDb();
    db.addObject({
      space_id: SPACE_A,
      object_type: "note",
      object_id: NOTE_A,
      title: "Retention note",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "The retrieval plan includes deterministic rank fusion.",
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectTypes: ["note"],
      query: "rank fusion",
    });

    expect(out.items[0]).toMatchObject({
      object_type: "note",
      object_id: NOTE_A,
      evidence: { kind: "lexical_match" },
    });
  });

  it("applies positive feedback without penalizing unselected candidates", async () => {
    const db = new SearchFakeDb();
    db.addObject({
      space_id: SPACE_A,
      object_type: "note",
      object_id: NOTE_A,
      title: "First rank fusion note",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "rank fusion feedback candidate one",
    });
    db.addObject({
      space_id: SPACE_A,
      object_type: "note",
      object_id: ITEM_B,
      title: "Second rank fusion note",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "rank fusion feedback candidate two",
    });

    const query = "rank fusion";
    const base = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectTypes: ["note"],
      query,
      maxResults: 10,
    });
    db.feedbackEvents.push({
      space_id: SPACE_A,
      actor_user_id: USER_A,
      surface: "knowledge_search",
      query_hash: retrievalFeedbackQueryHash(query),
      object_type: "note",
      object_id: ITEM_B,
      signal_type: "accepted",
      dwell_ms: null,
      created_at: "2026-06-23T00:00:00.000Z",
    });

    const boosted = await new RetrievalSearchService(db, knowledgeRetrievalRegistry, {
      feedbackService: new RetrievalFeedbackService(db),
    }).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectTypes: ["note"],
      query,
      maxResults: 10,
      feedbackSurface: "knowledge_search",
    });

    expect(boosted.items[0]?.object_id).toBe(ITEM_B);
    const baseUnselected = base.items.find((item) => item.object_id === NOTE_A)?.score;
    const boostedUnselected = boosted.items.find((item) => item.object_id === NOTE_A)?.score;
    expect(boostedUnselected).toBe(baseUnselected);
    expect(boosted.items.find((item) => item.object_id === ITEM_B)?.score).toBeGreaterThan(
      base.items.find((item) => item.object_id === ITEM_B)?.score ?? 0,
    );
  });

  it("does not let one weak implicit open outrank a strong exact match", async () => {
    const db = searchDbWithKnowledge();
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.addObject({
      space_id: SPACE_A,
      object_type: "note",
      object_id: NOTE_A,
      title: "Alpha body note",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Alpha appears only in the body here.",
    });
    db.feedbackEvents.push({
      space_id: SPACE_A,
      actor_user_id: USER_A,
      surface: "knowledge_search",
      query_hash: retrievalFeedbackQueryHash("Alpha"),
      object_type: "note",
      object_id: NOTE_A,
      signal_type: "opened",
      dwell_ms: null,
      created_at: "2026-06-23T00:00:00.000Z",
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry, {
      feedbackService: new RetrievalFeedbackService(db),
    }).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
      maxResults: 10,
      feedbackSurface: "knowledge_search",
    });

    expect(out.items[0]).toMatchObject({
      object_type: "knowledge_item",
      object_id: ITEM_A,
      evidence: { kind: "exact_title_match" },
    });
  });

  it("returns a Source for title or URL search", async () => {
    const db = new SearchFakeDb();
    db.addObject({
      space_id: SPACE_A,
      object_type: "source",
      object_id: SOURCE_A,
      title: "Research Source",
      status: "processed",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Source summary",
      uri: "https://example.test/source",
    });
    db.addAlias("source", SOURCE_A, "https://example.test/source", "url");

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectTypes: ["source"],
      query: "https://example.test/source",
    });

    expect(out.items[0]).toMatchObject({
      object_type: "source",
      object_id: SOURCE_A,
      evidence: { kind: "source_url_match" },
    });
  });

  it("returns a Claim for lexical claim search", async () => {
    const db = new SearchFakeDb();
    db.addObject({
      space_id: SPACE_A,
      object_type: "claim",
      object_id: CLAIM_A,
      title: "Preferred embedding dimension",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      subject_text: "Sensitive subject label",
      text: "The default retrieval embedding dimension is 2560.",
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectTypes: ["claim"],
      query: "embedding dimension",
    });

    expect(out.items[0]).toMatchObject({
      object_type: "claim",
      object_id: CLAIM_A,
      evidence: { kind: "lexical_match" },
      snippet: "The default retrieval embedding dimension is 2560.",
    });
    expect(out.items[0].snippet).not.toContain("Sensitive subject label");
  });

  it("creates retrieval edges from wikilinks and markdown links without canonical relation writes", async () => {
    const db = new ProjectionFakeDb();
    db.aliasTargets.set(normalizeAlias("Beta"), [{ object_type: "knowledge_item", object_id: ITEM_B }]);
    db.aliasTargets.set(normalizeAlias("https://example.test/source"), [{ object_type: "source", object_id: SOURCE_A }]);

    await new RetrievalProjectionService(db, knowledgeRetrievalRegistry).reindex(SPACE_A, "knowledge_item", ITEM_A);

    expect(db.retrievalEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to_object_type: "knowledge_item",
          to_object_id: ITEM_B,
          edge_origin: "wikilink",
          edge_status: "suggested",
        }),
        expect.objectContaining({
          to_object_type: "source",
          to_object_id: SOURCE_A,
          edge_origin: "markdown_link",
          edge_status: "suggested",
        }),
      ]),
    );
    expect(db.forbiddenWrites).toHaveLength(0);
  });

  it("projects an active ObjectRelation into a retrieval edge", async () => {
    const db = new ProjectionFakeDb();
    db.relationRows = [{
      from_object_id: ITEM_A,
      from_object_type: "knowledge_item",
      to_object_id: ITEM_B,
      to_object_type: "knowledge_item",
      relation_type: "supports",
      confidence: 0.8,
      evidence_summary: "accepted",
    }];

    await new RetrievalProjectionService(db, knowledgeRetrievalRegistry).reindex(SPACE_A, "knowledge_item", ITEM_A);

    expect(db.retrievalEdges).toContainEqual(expect.objectContaining({
      from_object_id: ITEM_A,
      to_object_id: ITEM_B,
      relation_type: "supports",
      edge_origin: "object_relation_projection",
      edge_status: "derived",
    }));
  });

  it("reindexing a linked target preserves inbound extracted retrieval edges", async () => {
    const db = new ProjectionFakeDb();
    db.retrievalEdges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: ITEM_A,
      to_object_type: "knowledge_item",
      to_object_id: ITEM_B,
      relation_type: "related_to",
      edge_origin: "wikilink",
      edge_status: "suggested",
    });

    await new RetrievalProjectionService(db, knowledgeRetrievalRegistry).reindex(SPACE_A, "knowledge_item", ITEM_B);

    expect(db.retrievalEdges).toContainEqual(expect.objectContaining({
      from_object_id: ITEM_A,
      to_object_id: ITEM_B,
      edge_origin: "wikilink",
    }));
  });

  it("full reindex clears stale projections and resolves links after all aliases are rebuilt", async () => {
    const db = new ProjectionFakeDb();
    db.aliasTargets.clear();
    db.retrievalEdges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: "stale-source",
      to_object_type: "knowledge_item",
      to_object_id: "stale-target",
      relation_type: "related_to",
      edge_origin: "stale",
      edge_status: "suggested",
    });
    db.retrievalEdges.push({
      space_id: SPACE_A,
      from_object_type: "memory_entry",
      from_object_id: "memory-source",
      to_object_type: "memory_entry",
      to_object_id: "memory-target",
      relation_type: "related_to",
      edge_origin: "memory-stale-but-other-registry",
      edge_status: "suggested",
    });

    const summary = await new RetrievalProjectionService(db, knowledgeRetrievalRegistry).reindexAll(SPACE_A);

    expect(summary).toMatchObject({ knowledge_item: 2 });
    expect(db.retrievalEdges).not.toContainEqual(expect.objectContaining({ edge_origin: "stale" }));
    expect(db.retrievalEdges).toContainEqual(expect.objectContaining({
      from_object_type: "memory_entry",
      edge_origin: "memory-stale-but-other-registry",
    }));
    expect(db.retrievalEdges).toContainEqual(expect.objectContaining({
      from_object_id: ITEM_A,
      to_object_id: ITEM_B,
      edge_origin: "wikilink",
    }));
  });

  it("returns exists create_safety for duplicate title or alias", async () => {
    const db = searchDbWithKnowledge();
    db.addAlias("knowledge_item", ITEM_A, "Hall of Light", "alias");

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).assessCreateSafety({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectType: "knowledge_item",
      aliases: ["Hall of Light"],
    });

    expect(out.create_safety).toBe("exists");
    expect(out.matches[0]?.object_id).toBe(ITEM_A);
  });

  it("does not return a cross-space stale projection", async () => {
    const db = searchDbWithKnowledge({ canonicalSpaceId: SPACE_B });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title", 1, SPACE_A);

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
    });

    expect(out.items).toHaveLength(0);
  });

  it("does not return private Knowledge to an unauthorized viewer", async () => {
    const db = searchDbWithKnowledge({
      visibility: "private",
      ownerUserId: USER_B,
      createdByUserId: USER_B,
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
    });

    expect(out.items).toHaveLength(0);
  });

  it("explains why a visible returned target matched without snippets or dropped ids", async () => {
    const db = searchDbWithKnowledge();
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).explainTarget({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
      targetObjectType: "knowledge_item",
      targetObjectId: ITEM_A,
      mode: "lexical",
    });

    expect(out).toMatchObject({
      target: {
        object_type: "knowledge_item",
        object_id: ITEM_A,
        visible: true,
        returned: true,
        rank: 1,
      },
      match: {
        matched_fields: expect.arrayContaining(["title"]),
        evidence_kind: "exact_title_match",
      },
      diagnostic_codes: expect.arrayContaining(["target_returned"]),
    });
    expect(JSON.stringify(out)).not.toContain("Alpha is the canonical page.");
    expect(JSON.stringify(out?.trace)).not.toContain(ITEM_A);
  });

  it("diagnoses a visible target that is not returned in the search window", async () => {
    const db = searchDbWithKnowledge();
    db.addAlias("knowledge_item", ITEM_B, "Beta", "title");
    db.addObject({
      space_id: SPACE_A,
      object_type: "knowledge_item",
      object_id: ITEM_B,
      title: "Beta",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Beta content",
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).explainTarget({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Beta",
      targetObjectType: "knowledge_item",
      targetObjectId: ITEM_A,
      mode: "lexical",
    });

    expect(out).toMatchObject({
      target: {
        object_type: "knowledge_item",
        object_id: ITEM_A,
        visible: true,
        returned: false,
      },
      match: { matched_fields: [] },
      diagnostic_codes: expect.arrayContaining(["visible_target_missed"]),
    });
  });

  it("does not leak stale archived canonical objects", async () => {
    const db = searchDbWithKnowledge({ status: "archived" });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
    });

    expect(out.items).toHaveLength(0);
  });

  it("projection does not create MemoryEntry or ObjectRelation rows", async () => {
    const db = new ProjectionFakeDb();

    await new RetrievalProjectionService(db, knowledgeRetrievalRegistry).reindex(SPACE_A, "knowledge_item", ITEM_A);

    expect(db.forbiddenWrites).toHaveLength(0);
    expect(db.retrievalEdges.every((edge) => edge.edge_status !== "active")).toBe(true);
  });

  it("expands graph neighbors from exact seeds", async () => {
    const db = searchDbWithKnowledge();
    db.addObject({
      space_id: SPACE_A,
      object_type: "knowledge_item",
      object_id: ITEM_B,
      title: "Beta",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Neighbor content",
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.edges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: ITEM_A,
      to_object_type: "knowledge_item",
      to_object_id: ITEM_B,
      relation_type: "supports",
      edge_origin: "object_relation_projection",
      confidence: 1,
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
      maxResults: 5,
    });

    expect(out.items.map((item) => item.object_id)).toContain(ITEM_B);
    expect(out.items.find((item) => item.object_id === ITEM_B)?.evidence.kind).toBe("graph_neighbor");
  });

  it("reports the max visible graph hop after source-policy-safe filtering", async () => {
    const db = searchDbWithKnowledge();
    const midId = "99999999-9999-4999-8999-999999999999";
    const farId = "99999999-9999-4999-8999-aaaaaaaaaaaa";
    db.addObject({
      space_id: SPACE_A,
      object_type: "knowledge_item",
      object_id: midId,
      title: "Beta",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Intermediate graph node.",
    });
    db.addObject({
      space_id: SPACE_A,
      object_type: "knowledge_item",
      object_id: farId,
      title: "Gamma",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Far graph node.",
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.edges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: ITEM_A,
      to_object_type: "knowledge_item",
      to_object_id: midId,
      relation_type: "supports",
      edge_origin: "object_relation_projection",
      confidence: 1,
    });
    db.edges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: midId,
      to_object_type: "knowledge_item",
      to_object_id: farId,
      relation_type: "supports",
      edge_origin: "object_relation_projection",
      confidence: 1,
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
      maxResults: 5,
      includeTrace: true,
    });

    expect(out.items.map((item) => item.object_id)).toEqual(expect.arrayContaining([midId, farId]));
    expect(out.trace).toMatchObject({ graph: { hops: 2 } });
  });

  it("uses relational intent to return sources connected to a visible seed", async () => {
    const db = searchDbWithKnowledge();
    db.addObject({
      space_id: SPACE_A,
      object_type: "source",
      object_id: SOURCE_A,
      title: "Alpha source",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Source material for Alpha.",
      uri: "https://example.test/alpha",
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.edges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: ITEM_A,
      to_object_type: "source",
      to_object_id: SOURCE_A,
      relation_type: "references",
      edge_origin: "source_link_projection",
      confidence: 1,
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "sources for Alpha",
      maxResults: 5,
      includeTrace: true,
    });

    expect(out.items.map((item) => item.object_id)).toContain(SOURCE_A);
    const source = out.items.find((item) => item.object_id === SOURCE_A);
    expect(source?.matched_fields).toContain("relational:sources_for");
    expect(source?.evidence).toMatchObject({ kind: "graph_neighbor", field: "references" });
    expect(JSON.stringify(out.trace)).not.toContain(ITEM_A);
    expect(JSON.stringify(out.trace)).not.toContain(SOURCE_A);
    expect(out.trace).toMatchObject({
      arms: { relational: 1 },
      relational: { intent: "sources_for", results: 1 },
    });
  });

  it("uses relational intent to resolve an explicit connection target", async () => {
    const db = searchDbWithKnowledge();
    db.addObject({
      space_id: SPACE_A,
      object_type: "knowledge_item",
      object_id: ITEM_B,
      title: "Beta",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Beta content",
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.addAlias("knowledge_item", ITEM_B, "Beta", "title");
    db.edges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: ITEM_A,
      to_object_type: "knowledge_item",
      to_object_id: ITEM_B,
      relation_type: "supports",
      edge_origin: "object_relation_projection",
      confidence: 1,
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "how is Alpha connected to Beta",
      maxResults: 5,
      includeTrace: true,
    });

    expect(out.items.map((item) => item.object_id)).toContain(ITEM_B);
    expect(out.items.find((item) => item.object_id === ITEM_B)?.matched_fields).toContain("relational:connection");
    expect(out.trace).toMatchObject({
      arms: { relational: 1 },
      relational: { intent: "connection", results: 1 },
    });
  });

  it("does not turn an unresolved connection target into arbitrary neighbors", async () => {
    const db = searchDbWithKnowledge();
    db.addObject({
      space_id: SPACE_A,
      object_type: "knowledge_item",
      object_id: ITEM_B,
      title: "Beta",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Beta content",
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.edges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: ITEM_A,
      to_object_type: "knowledge_item",
      to_object_id: ITEM_B,
      relation_type: "supports",
      edge_origin: "object_relation_projection",
      confidence: 1,
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "how is Alpha connected to Missing Target",
      maxResults: 5,
      includeTrace: true,
    });

    expect(out.items.map((item) => item.object_id)).not.toContain(ITEM_B);
    expect(out.trace).toMatchObject({
      arms: { relational: 0 },
      relational: { intent: "connection", seeds: 1, results: 0, hops: 0 },
    });
  });

  it("does not expand graph neighbors from a non-visible seed", async () => {
    const db = searchDbWithKnowledge({
      visibility: "private",
      ownerUserId: USER_B,
      createdByUserId: USER_B,
    });
    db.addObject({
      space_id: SPACE_A,
      object_type: "knowledge_item",
      object_id: ITEM_B,
      title: "Beta",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Readable neighbor content",
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.edges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: ITEM_A,
      to_object_type: "knowledge_item",
      to_object_id: ITEM_B,
      relation_type: "supports",
      edge_origin: "object_relation_projection",
      confidence: 1,
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
      maxResults: 5,
    });

    expect(out.items.map((item) => item.object_id)).not.toContain(ITEM_B);
  });

  it("does not expose graph hops for non-visible neighbors of a visible seed", async () => {
    const db = searchDbWithKnowledge();
    db.addObject({
      space_id: SPACE_A,
      object_type: "knowledge_item",
      object_id: ITEM_B,
      title: "Beta",
      status: "active",
      visibility: "private",
      owner_user_id: USER_B,
      created_by_user_id: USER_B,
      text: "Hidden neighbor content",
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.edges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: ITEM_A,
      to_object_type: "knowledge_item",
      to_object_id: ITEM_B,
      relation_type: "supports",
      edge_origin: "object_relation_projection",
      confidence: 1,
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
      maxResults: 5,
      includeTrace: true,
    });

    expect(out.items.map((item) => item.object_id)).not.toContain(ITEM_B);
    expect(JSON.stringify(out.trace)).not.toContain(ITEM_B);
    expect(out.trace).not.toMatchObject({ graph: { hops: expect.any(Number) } });
  });

  it("does not expand relational neighbors from a non-visible seed", async () => {
    const db = searchDbWithKnowledge({
      visibility: "private",
      ownerUserId: USER_B,
      createdByUserId: USER_B,
    });
    db.addObject({
      space_id: SPACE_A,
      object_type: "source",
      object_id: SOURCE_A,
      title: "Alpha source",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_A,
      created_by_user_id: USER_A,
      text: "Readable source content.",
      uri: "https://example.test/alpha",
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.edges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: ITEM_A,
      to_object_type: "source",
      to_object_id: SOURCE_A,
      relation_type: "references",
      edge_origin: "source_link_projection",
      confidence: 1,
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "sources for Alpha",
      maxResults: 5,
      includeTrace: true,
    });

    expect(out.items.map((item) => item.object_id)).not.toContain(SOURCE_A);
    expect(out.trace).toMatchObject({
      arms: { relational: 0 },
      relational: { intent: "sources_for", seeds: 0, results: 0 },
    });
  });

  it("does not expose relational hops for non-visible target neighbors", async () => {
    const db = searchDbWithKnowledge();
    db.addObject({
      space_id: SPACE_A,
      object_type: "source",
      object_id: SOURCE_A,
      title: "Alpha source",
      status: "active",
      visibility: "space_shared",
      owner_user_id: USER_B,
      created_by_user_id: USER_B,
      text: "Hidden source content.",
      uri: "https://example.test/hidden-alpha",
      source_connection_ids_json: [SOURCE_CONNECTION_A],
    });
    db.sourceConnections.push({
      id: SOURCE_CONNECTION_A,
      owner_user_id: USER_B,
      consent_json: {
        schema_version: 1,
        owner_user_id: USER_B,
        allowed_reader_user_ids: [USER_B],
        allowed_agent_ids: [],
        allow_space_admins: false,
        allow_local_provider_egress: false,
        allow_external_model_egress: false,
      },
      policy_json: {
        schema_version: 1,
        source_egress_class: "internal_only",
        retention_policy: "full_text",
        import_trust_level: "normal",
        derived_write_policy: "proposal_required",
        allowed_import_targets: ["knowledge"],
        revalidation: { required: true, viewer_scoped: true },
      },
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");
    db.edges.push({
      space_id: SPACE_A,
      from_object_type: "knowledge_item",
      from_object_id: ITEM_A,
      to_object_type: "source",
      to_object_id: SOURCE_A,
      relation_type: "references",
      edge_origin: "source_link_projection",
      confidence: 1,
    });

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "sources for Alpha",
      maxResults: 5,
      includeTrace: true,
    });

    expect(out.items.map((item) => item.object_id)).not.toContain(SOURCE_A);
    expect(out.trace).toMatchObject({
      arms: { relational: 0 },
      relational: { intent: "sources_for", results: 0, hops: 0 },
    });
    expect(JSON.stringify(out.trace)).not.toContain(SOURCE_A);
  });

  it("does not leak dropped object ids in the trace", async () => {
    const db = searchDbWithKnowledge({
      visibility: "private",
      ownerUserId: USER_B,
      createdByUserId: USER_B,
    });
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      query: "Alpha",
      includeTrace: true,
    });

    expect(out.items).toHaveLength(0);
    const trace = out.trace as { dropped: number } | undefined;
    expect(trace?.dropped).toBe(0);
    expect(JSON.stringify(out.trace)).not.toContain(ITEM_A);
    expect(JSON.stringify(out.trace)).not.toContain("canonical_revalidation_failed");
  });

  it("excludes the object being edited from its own create_safety check", async () => {
    const db = searchDbWithKnowledge();
    db.addAlias("knowledge_item", ITEM_A, "Alpha", "title");

    const out = await new RetrievalSearchService(db, knowledgeRetrievalRegistry).assessCreateSafety({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectType: "knowledge_item",
      title: "Alpha",
      excludeObjectId: ITEM_A,
    });

    expect(out.create_safety).toBe("unknown");
    expect(out.matches).toHaveLength(0);
  });
});

function searchDbWithKnowledge(overrides: {
  canonicalSpaceId?: string;
  visibility?: string;
  ownerUserId?: string;
  createdByUserId?: string;
  status?: string;
  sourceConnectionIds?: string[];
} = {}): SearchFakeDb {
  const db = new SearchFakeDb();
  db.addObject({
    space_id: overrides.canonicalSpaceId ?? SPACE_A,
    object_type: "knowledge_item",
    object_id: ITEM_A,
    title: "Alpha",
    status: overrides.status ?? "active",
    visibility: overrides.visibility ?? "space_shared",
    owner_user_id: overrides.ownerUserId ?? USER_A,
    created_by_user_id: overrides.createdByUserId ?? USER_A,
    text: "Alpha is the canonical page.",
    source_connection_ids_json: overrides.sourceConnectionIds ?? [],
  });
  return db;
}

function result<Row>(rows: Row[]) {
  return { rows, rowCount: rows.length };
}

function fakeContentVisible(object: SearchObject, userId: string): boolean {
  return object.owner_user_id === userId || object.visibility === "space_shared";
}

function matchesObjectKindFilter(
  object: Pick<SearchObject, "object_kind" | "object_kind_label">,
  objectKindFilter: string[] | null | undefined,
): boolean {
  if (!objectKindFilter?.length) return true;
  return Boolean(object.object_kind_label && object.object_kind && objectKindFilter.includes(object.object_kind));
}

function removeWhere<T>(items: T[], predicate: (item: T) => boolean): void {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) items.splice(index, 1);
  }
}

function dedupeTargets(
  rows: Array<{ object_type: RetrievalObjectType; object_id: string }>,
): Array<{ object_type: RetrievalObjectType; object_id: string }> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.object_type}:${row.object_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
