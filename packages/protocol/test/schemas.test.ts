import { describe, it, expect } from "vitest";
import {
  ActivityDTOSchema,
  ProposalDTOSchema,
  RunDTOSchema,
  RunEventDTOSchema,
  ArtifactDTOSchema,
  MemoryDTOSchema,
  KnowledgeItemDTOSchema,
  SpaceRefSchema,
  UserRefSchema,
} from "../src/schemas";
import {
  VisibilitySchema,
  isVisibility,
  isSpaceType,
  isSpaceOversightMode,
  SpaceOversightModeSchema,
} from "../src/common";

describe("DTO schema validation", () => {
  it("accepts autonomous as a first-class Run trigger origin", () => {
    const parsed = RunDTOSchema.parse({
      id: "run-autonomous",
      space_id: "space-1",
      agent_id: "agent-1",
      agent_version_id: "version-1",
      run_role: "execution",
      status: "queued",
      run_type: "system",
      trigger_origin: "autonomous",
      mode: "live",
      required_sandbox_level: "read_only",
      visibility: "private",
      created_at: "2026-07-26T12:00:00.000Z",
    });
    expect(parsed.trigger_origin).toBe("autonomous");
  });

  it("parses a representative ActivityDTO (snake_case public API)", () => {
    const parsed = ActivityDTOSchema.parse({
      id: "a1",
      space_id: "s1",
      activity_type: "user_capture",
      title: "note",
      content: "hello",
      visibility: "space_shared",
      occurred_at: "2026-06-09T12:00:00+00:00",
      created_at: "2026-06-09T12:00:00+00:00",
    });
    expect(parsed.id).toBe("a1");
    expect(parsed.space_id).toBe("s1");
  });

  it("rejects an ActivityDTO missing required scoping fields", () => {
    const result = ActivityDTOSchema.safeParse({
      id: "a1",
      activity_type: "user_capture",
      visibility: "space_shared",
      occurred_at: "2026-06-09T12:00:00+00:00",
      created_at: "2026-06-09T12:00:00+00:00",
    });
    expect(result.success).toBe(false);
  });

  it("parses ProposalDTO / RunDTO / RunEventDTO / ArtifactDTO / MemoryDTO / KnowledgeItemDTO", () => {
    expect(
      ProposalDTOSchema.parse({
        id: "p1",
        space_id: "s1",
        user_id: "u1",
        proposal_type: "memory_create",
        status: "pending",
        risk_level: "low",
        visibility: "space_shared",
        proposed_title: "t",
        proposed_content: "c",
        rationale: "r",
        expired: false,
        created_at: "2026-06-09T12:00:00+00:00",
      }).id,
    ).toBe("p1");

    expect(
      RunDTOSchema.parse({
        id: "r1",
        space_id: "s1",
        agent_id: "ag1",
        agent_version_id: "av1",
        run_role: "execution",
        status: "queued",
        run_type: "agent",
        trigger_origin: "user",
        mode: "auto",
        parent_run_id: "parent-run",
        root_run_id: "root-run",
        run_group_id: "group-1",
        delegation_id: "delegation-1",
        instructed_by_agent_id: "agent-manager",
        required_sandbox_level: "none",
        visibility: "space_shared",
        created_at: "2026-06-09T12:00:00+00:00",
      }).status,
    ).toBe("queued");

    expect(
      RunEventDTOSchema.parse({
        id: "e1",
        space_id: "s1",
        run_id: "r1",
        event_index: 0,
        event_type: "run.started",
        status: "ok",
        created_at: "2026-06-09T12:00:00+00:00",
      }).event_index,
    ).toBe(0);

    expect(
      ArtifactDTOSchema.parse({
        id: "art1",
        space_id: "s1",
        artifact_type: "text",
        title: "out",
        exportable: true,
        preview: false,
        visibility: "space_shared",
        created_at: "2026-06-09T12:00:00+00:00",
        updated_at: "2026-06-09T12:00:00+00:00",
      }).title,
    ).toBe("out");

    expect(
      MemoryDTOSchema.parse({
        id: "m1",
        space_id: "s1",
        scope: "user",
        type: "fact",
        status: "active",
        visibility: "space_shared",
        sensitivity_level: "normal",
        confidence: 0.9,
        importance: 0.5,
        version: 1,
        created_at: "2026-06-09T12:00:00+00:00",
        updated_at: "2026-06-09T12:00:00+00:00",
      }).scope,
    ).toBe("user");

    expect(
      KnowledgeItemDTOSchema.parse({
        id: "k1",
        space_id: "s1",
        knowledge_kind: "concept",
        title: "T",
        content: "C",
        status: "active",
        visibility: "space_shared",
        version: 1,
        created_at: "2026-06-09T12:00:00+00:00",
        updated_at: "2026-06-09T12:00:00+00:00",
      }).title,
    ).toBe("T");
  });

  it("parses references", () => {
    expect(SpaceRefSchema.parse({ id: "s1", name: "Home", type: "personal" }).type).toBe(
      "personal",
    );
    expect(SpaceRefSchema.parse({ id: "s1", name: "Home", type: "team" }).oversight_mode).toBe("none");
    expect(SpaceRefSchema.parse({ id: "s1", name: "Home", type: "team", oversight_mode: "full" }).oversight_mode).toBe("full");
    expect(SpaceOversightModeSchema.safeParse("summary").success).toBe(true);
    expect(isSpaceOversightMode("invalid")).toBe(false);
    expect(UserRefSchema.parse({ id: "u1", display_name: "Ann" }).display_name).toBe("Ann");
  });

  it("treats coded fields permissively but documents known value sets", () => {
    // Unknown status/type strings are accepted (forward-compatible).
    expect(
      MemoryDTOSchema.safeParse({
        id: "m1",
        space_id: "s1",
        scope: "user",
        type: "some_future_type",
        status: "some_future_status",
        visibility: "some_future_visibility",
        sensitivity_level: "normal",
        confidence: 0,
        importance: 0,
        version: 1,
        created_at: "2026-06-09T12:00:00+00:00",
        updated_at: "2026-06-09T12:00:00+00:00",
      }).success,
    ).toBe(true);

    // But the documented enums are available for consumers that want them.
    expect(VisibilitySchema.safeParse("space_shared").success).toBe(true);
    expect(VisibilitySchema.safeParse("nope").success).toBe(false);
    expect(isVisibility("private")).toBe(true);
    expect(isVisibility("nope")).toBe(false);
    expect(isSpaceType("team")).toBe(true);
  });
});
