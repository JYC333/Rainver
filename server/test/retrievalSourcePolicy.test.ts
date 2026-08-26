import { describe, expect, it } from "vitest";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { loadSourcePolicySnapshots, sourceConnectionIdsFromMetadata, sourceConnectionIdsFromSourceRefs, sourcePolicyAllowsRead } from "../src/modules/retrieval/sourcePolicy.js";

const SPACE = "space-1";
const SOURCE = "source-1";
const OWNER = "owner-1";
const READER = "reader-1";
const AGENT = "agent-1";

describe("retrieval source policy", () => {
  it("extracts source connection ids from explicit metadata and source refs", () => {
    expect(sourceConnectionIdsFromMetadata({
      source_connection_id: SOURCE,
      source_connection_ids: [SOURCE, "source-2", ""],
    })).toEqual([SOURCE, "source-2"]);
    expect(sourceConnectionIdsFromSourceRefs([
      { source_type: "source_connection", source_id: SOURCE },
      { source_connection_id: "source-2" },
      { source_type: "source_item", source_id: "source-1" },
    ])).toEqual([SOURCE, "source-2"]);
  });

  it("strictly loads snapshots and enforces reader, admin, and agent gates", async () => {
    const snapshots = await loadSourcePolicySnapshots(new SourcePolicyFakeDb(), SPACE, [SOURCE, "broken"]);
    expect([...snapshots.keys()]).toEqual([SOURCE]);
    const snapshot = snapshots.get(SOURCE)!;

    expect(sourcePolicyAllowsRead(snapshot, { viewerUserId: OWNER })).toBe(true);
    expect(sourcePolicyAllowsRead(snapshot, { viewerUserId: READER })).toBe(true);
    expect(sourcePolicyAllowsRead(snapshot, { viewerUserId: "admin-1", viewerSpaceRole: "admin" })).toBe(true);
    expect(sourcePolicyAllowsRead(snapshot, { viewerUserId: READER, agentId: "other-agent" })).toBe(false);
    expect(sourcePolicyAllowsRead(snapshot, { viewerUserId: READER, agentId: AGENT })).toBe(true);
    expect(sourcePolicyAllowsRead(snapshot, { viewerUserId: "member-1", viewerSpaceRole: "member" })).toBe(false);
  });
});

class SourcePolicyFakeDb implements Queryable {
  async query<Row = Record<string, unknown>>(): Promise<{ rows: Row[]; rowCount: number }> {
    const rows = [
      {
        id: SOURCE,
        owner_user_id: OWNER,
        consent_json: {
          schema_version: 1,
          owner_user_id: OWNER,
          subject_user_ids: [OWNER],
          allowed_reader_user_ids: [READER],
          allowed_agent_ids: [AGENT],
          allow_space_admins: true,
          allow_local_provider_egress: true,
          allow_external_model_egress: false,
        },
        policy_json: {
          schema_version: 1,
          source_egress_class: "local_provider_allowed",
          retention_policy: "full_text",
          import_trust_level: "normal",
          derived_write_policy: "proposal_required",
          allowed_import_targets: ["knowledge"],
          revalidation: { required: true, viewer_scoped: true },
        },
      },
      {
        id: "broken",
        owner_user_id: OWNER,
        consent_json: { schema_version: 1, owner_user_id: "somebody-else" },
        policy_json: { schema_version: 1, source_egress_class: "external_provider_allowed" },
      },
    ];
    return { rows: rows as Row[], rowCount: rows.length };
  }
}
