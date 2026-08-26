import { describe, expect, it } from "vitest";
import { scanObjectSchemaSuggestions } from "../src/modules/ontology/objectSchemaSuggestions.js";
import type { QueryResult, Queryable } from "../src/modules/routeUtils/common.js";

class FakeObjectSchemaSuggestionDb implements Queryable {
  async query<Row = Record<string, unknown>>(sql: string): Promise<QueryResult<Row>> {
    // Ignore quoted enum/string literals (for example the canonical access
    // predicate's `'summary'` level) while still rejecting raw content column
    // selections such as `SELECT content`.
    const sqlWithoutStringLiterals = sql.replace(/'(?:''|[^'])*'/g, "''");
    if (/\b(?:content|plain_text|raw_text|claim_text|summary)\b/.test(sqlWithoutStringLiterals)) {
      throw new Error("object schema suggestion scan must not select raw content columns");
    }
    // Inverted by ADR 0012: domain status left the root, so a reader that
    // knows its object type must read the extension table's own column.
    if (/so\.status/.test(sql)) throw new Error("status must be read from the owning extension table, not space_objects");
    if (/FROM sources s/.test(sql) && /so\.status = 'active'/.test(sql)) {
      throw new Error("source space_object status must use the source lifecycle, not active");
    }
    if (/FROM space_object_profiles/.test(sql)) {
      return {
        rows: [
          {
            id: "kind-decision",
            key: "decision",
            label: "Decision",
            base_object_type: "knowledge_item",
            status: "deprecated",
            version: 2,
          },
          {
            id: "kind-lesson",
            key: "lesson",
            label: "Lesson",
            base_object_type: "knowledge_item",
            status: "active",
            version: 1,
          },
        ] as Row[],
        rowCount: 2,
      };
    }
    if (/FROM knowledge_items ki/.test(sql)) {
      return {
        rows: [
          { object_id: "decision-1", object_profile: "decision" },
          { object_id: "decision-2", object_profile: "decision" },
          { object_id: "decision-3", object_profile: "decision" },
          { object_id: "procedure-1", object_profile: "procedure" },
          { object_id: "procedure-2", object_profile: "procedure" },
          { object_id: "summary-hidden", object_profile: "summary" },
        ] as Row[],
        rowCount: 6,
      };
    }
    if (/FROM provenance_links pl/.test(sql)) {
      return {
        rows: [{ target_id: "summary-hidden", source_connection_id: "source-restricted" }] as Row[],
        rowCount: 1,
      };
    }
    if (/FROM source_connections/.test(sql)) {
      return {
        rows: [{
          id: "source-restricted",
          owner_user_id: "owner-1",
          consent_json: {
            schema_version: 1,
            owner_user_id: "owner-1",
            allowed_reader_user_ids: ["owner-1"],
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
        }] as Row[],
        rowCount: 1,
      };
    }
    if (/SELECT\s+role\s+FROM space_memberships/.test(sql)) {
      return { rows: [{ role: "member" }] as Row[], rowCount: 1 };
    }
    if (/FROM claims c/.test(sql)) {
      return {
        rows: [
          { object_id: "claim-1", object_profile: "fact" },
          { object_id: "claim-hidden", object_profile: "belief" },
        ] as Row[],
        rowCount: 2,
      };
    }
    if (/FROM claim_sources/.test(sql)) {
      return {
        rows: [
          {
            claim_id: "claim-hidden",
            source_connection_id: "source-restricted",
            source_metadata_json: {},
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (/FROM sources s/.test(sql)) {
      return {
        rows: [
          { object_id: "source-1", object_profile: "paper", metadata_json: {} },
          {
            object_id: "source-hidden",
            object_profile: "email",
            metadata_json: { source_connection_id: "source-restricted" },
          },
        ] as Row[],
        rowCount: 2,
      };
    }
    if (/FROM source_items/.test(sql)) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    return { rows: [] as Row[], rowCount: 0 };
  }
}

describe("scanObjectSchemaSuggestions", () => {
  it("creates deterministic review findings from visible kind usage only", async () => {
    const report = await scanObjectSchemaSuggestions(new FakeObjectSchemaSuggestionDb(), {
      spaceId: "space-1",
      userId: "user-1",
      request: {
        base_object_types: ["knowledge_item"],
        limit: 100,
        persist_artifact: false,
        review_scope: "private",
      },
    });

    expect(report.findings.map((finding) => finding.kind).sort()).toEqual([
      "deprecated_profile_usage",
      "missing_object_profile",
      "unused_active_profile",
    ]);
    expect(report.findings.find((finding) => finding.kind === "missing_object_profile")?.proposed_action).toMatchObject({
      proposal_type: "object_profile_create",
      key: "procedure",
      status: "draft",
    });
    expect(report.findings.some((finding) => finding.object_profile === "summary")).toBe(false);
    expect(report.counts).toMatchObject({
      missing_object_profile: 1,
      deprecated_profile_usage: 1,
      unused_active_profile: 1,
    });
    expect(report.access_safety).toEqual({
      only_visible_usage: true,
      raw_content_read: false,
      hidden_counts_included: false,
      provider_call_performed: false,
      canonical_write_performed: false,
    });
  });

  it("default scan covers claim/sources SQL without reading raw content", async () => {
    const report = await scanObjectSchemaSuggestions(new FakeObjectSchemaSuggestionDb(), {
      spaceId: "space-1",
      userId: "user-1",
      request: {
        limit: 100,
        persist_artifact: false,
        review_scope: "private",
      },
    });

    const objectProfiles = report.findings.map((finding) => finding.object_profile);
    expect(objectProfiles).toEqual(expect.arrayContaining(["fact", "paper"]));
    expect(objectProfiles).not.toEqual(expect.arrayContaining(["summary", "belief", "email"]));
    expect(report.access_safety.raw_content_read).toBe(false);
  });
});
