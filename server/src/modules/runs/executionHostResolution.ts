import type { Queryable } from "../routeUtils/common.js";
import type { HostKind } from "./orchestrationService.js";

interface ExecutionHostResolution {
  hostKind: HostKind;
  hostId: string;
  workspaceLocationId: string | null;
}

/**
 * Which host a Run executes on, and the Location it works in. A Location the
 * Run names wins; then the host its Runtime Profile pins, which names a host
 * and no Location; then the Folder's active Location. With none of these it is
 * the server host with no Location, which the daemon serves from a Run-scoped
 * working directory.
 */
export async function resolveExecutionHost(
  db: Queryable,
  input: { executionHostId: string | null; workspaceLocationId: string | null; projectFolderId: string | null; spaceId: string },
): Promise<ExecutionHostResolution> {
  type Row = { id: string | null; execution_host_kind: string; execution_host_id: string };
  const result = input.workspaceLocationId
    ? await db.query<Row>(
        `SELECT id, execution_host_kind, execution_host_id FROM workspace_locations WHERE id = $1 AND space_id = $2 LIMIT 1`,
        [input.workspaceLocationId, input.spaceId],
      )
    : input.executionHostId
    ? await db.query<Row>(
        // A host is not a Location: the pinned-host branch resolves no Location id.
        `SELECT NULL::varchar AS id, kind AS execution_host_kind, id AS execution_host_id FROM hosts WHERE id = $1 LIMIT 1`,
        [input.executionHostId],
      )
    : input.projectFolderId
    ? await db.query<Row>(
        `SELECT id, execution_host_kind, execution_host_id FROM workspace_locations WHERE project_folder_id = $1 AND space_id = $2 AND status = 'active' LIMIT 1`,
        [input.projectFolderId, input.spaceId],
      )
    : { rows: [] as Row[] };
  const row = result.rows[0];
  return {
    hostKind: (row?.execution_host_kind as HostKind | undefined) ?? "server",
    hostId: row?.execution_host_id ?? "",
    workspaceLocationId: row?.execution_host_kind === "remote" && !input.workspaceLocationId ? null : row?.id ?? null,
  };
}
