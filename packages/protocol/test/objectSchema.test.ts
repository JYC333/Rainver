import { describe, expect, it } from "vitest";
import {
  RETRIEVAL_OBJECT_TYPE_VALUES,
  RetrievalObjectTypeSchema,
  SpaceObjectProfileCreateProposalRequestSchema,
  ObjectSchemaExportManifestSchema,
  ObjectSchemaImportRequestSchema,
  ObjectSchemaSuggestionScanRequestSchema,
  ObjectSchemaSuggestionReportSchema,
  SpaceObjectProfileOutSchema,
  SpaceObjectProfileUpdateProposalRequestSchema,
} from "../src/index";

describe("object schema / object kind protocol contracts", () => {
  it("keeps retrieval object types fixed while adding object kinds underneath them", () => {
    expect([...RETRIEVAL_OBJECT_TYPE_VALUES]).toEqual([
      "knowledge_item",
      "note",
      "source",
      "claim",
      "memory_entry",
      "project_public_summary",
      "source_item",
      "extracted_evidence",
      "inquiry_thread",
    ]);
    expect(RetrievalObjectTypeSchema.parse("source_item")).toBe("source_item");
    expect(RetrievalObjectTypeSchema.parse("extracted_evidence")).toBe("extracted_evidence");
    expect(RetrievalObjectTypeSchema.safeParse("object_profile").success).toBe(false);
    expect(RetrievalObjectTypeSchema.safeParse("schema_pack").success).toBe(false);
  });

  it("parses object kind create proposals under a fixed base object type", () => {
    const request = SpaceObjectProfileCreateProposalRequestSchema.parse({
      key: "decision",
      label: "Decision",
      base_object_type: "knowledge_item",
      field_schema: { fields: [{ key: "risk", type: "string" }] },
    });

    expect(request).toMatchObject({
      key: "decision",
      label: "Decision",
      base_object_type: "knowledge_item",
      status: "active",
      extraction_policy: {},
      retrieval_policy: {},
      ui_config: {},
    });
  });

  it("parses source object kind create proposals under fixed source base types", () => {
    const itemKind = SpaceObjectProfileCreateProposalRequestSchema.parse({
      key: "feed_entry",
      label: "Feed entry",
      base_object_type: "source_item",
    });
    const evidenceKind = SpaceObjectProfileCreateProposalRequestSchema.parse({
      key: "excerpt",
      label: "Excerpt",
      base_object_type: "extracted_evidence",
    });

    expect(itemKind.base_object_type).toBe("source_item");
    expect(evidenceKind.base_object_type).toBe("extracted_evidence");
  });

  it("parses relation hints as declarative object schema config", () => {
    const request = SpaceObjectProfileCreateProposalRequestSchema.parse({
      key: "decision",
      label: "Decision",
      base_object_type: "knowledge_item",
      relation_hints: [{
        endpoint_object_type: "source",
        link_type: "references",
        direction: "from",
        confidence_default: 0.7,
        required: true,
      }],
    });

    expect(request.relation_hints).toEqual([
      expect.objectContaining({
        endpoint_object_type: "source",
        link_type: "references",
        direction: "from",
        confidence_default: 0.7,
        required: true,
      }),
    ]);
  });

  it("rejects unknown base object types for object kinds", () => {
    expect(
      SpaceObjectProfileCreateProposalRequestSchema.safeParse({
        key: "person",
        label: "Person",
        base_object_type: "person",
      }).success,
    ).toBe(false);
  });

  it("rejects object kind keys that do not match the canonical domain subtype", () => {
    expect(
      SpaceObjectProfileCreateProposalRequestSchema.safeParse({
        key: "vendor_profile",
        label: "Vendor profile",
        base_object_type: "knowledge_item",
      }).success,
    ).toBe(false);
  });

  it("rejects executable object schema config", () => {
    expect(
      SpaceObjectProfileCreateProposalRequestSchema.safeParse({
        key: "concept",
        label: "Bad kind",
        base_object_type: "knowledge_item",
        field_schema: { validation_regex: "^unsafe$" },
      }).success,
    ).toBe(false);
  });

  it("allows update proposals to activate drafts only", () => {
    expect(SpaceObjectProfileUpdateProposalRequestSchema.parse({ status: "active" }).status).toBe("active");
    expect(SpaceObjectProfileUpdateProposalRequestSchema.safeParse({ status: "archived" }).success).toBe(false);
    expect(SpaceObjectProfileUpdateProposalRequestSchema.safeParse({ status: "deprecated" }).success).toBe(false);
  });

  it("serializes object kind rows without secret fields", () => {
    expect(
      SpaceObjectProfileOutSchema.parse({
        id: "kind-1",
        space_id: "space-1",
        key: "decision",
        label: "Decision",
        description: null,
        base_object_type: "knowledge_item",
        status: "active",
        version: 1,
        field_schema: {},
        extraction_policy: {},
        retrieval_policy: {},
        ui_config: {},
        created_by_user_id: "user-1",
        created_from_proposal_id: "proposal-1",
        updated_from_proposal_id: "proposal-1",
        created_at: "2026-06-27T00:00:00.000Z",
        updated_at: "2026-06-27T00:00:00.000Z",
      }),
    ).toMatchObject({ key: "decision" });
  });

  it("parses object schema export/import manifests without runtime schema pack fields", () => {
    const manifest = ObjectSchemaExportManifestSchema.parse({
      format: "rainver.object_schema.v1",
      exported_at: "2026-06-27T00:00:00.000Z",
      object_schema_version: 3,
      object_profiles: [{
        key: "decision",
        label: "Decision",
        base_object_type: "knowledge_item",
        field_schema: {},
        relation_hints: [{
          endpoint_object_type: "source",
          link_type: "references",
        }],
      }],
    });

    expect(ObjectSchemaImportRequestSchema.parse({ manifest }).manifest.format).toBe("rainver.object_schema.v1");
    expect(manifest).not.toHaveProperty("schema_pack");
    expect(manifest.object_profiles[0]!.relation_hints[0]).toMatchObject({ direction: "from", confidence_default: 0.55 });
  });

  it("parses deterministic object schema suggestion reports", () => {
    expect(ObjectSchemaSuggestionScanRequestSchema.parse({})).toMatchObject({
      limit: 100,
      persist_artifact: true,
      review_scope: "private",
    });
    const report = ObjectSchemaSuggestionReportSchema.parse({
      findings: [{
        id: "finding-1",
        kind: "missing_object_profile",
        base_object_type: "knowledge_item",
        object_profile: "decision",
        title: "Create object kind draft: decision",
        reason: "Visible rows use decision.",
        confidence_tier: "high",
        visible_usage_count: 2,
        proposed_action: { proposal_type: "object_profile_create", status: "draft" },
      }],
      counts: { missing_object_profile: 1 },
      scanned: { visible_usage_rows: 1, registry_rows: 0 },
      access_safety: {
        only_visible_usage: true,
        raw_content_read: false,
        hidden_counts_included: false,
        provider_call_performed: false,
        canonical_write_performed: false,
      },
    });
    expect(report.findings[0]!.proposed_action).toMatchObject({ status: "draft" });
  });
});
