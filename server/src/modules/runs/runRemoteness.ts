import type { Queryable } from "../routeUtils/common.js";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/index.js";

interface RemotenessInput {
  id: string;
  adapter_type?: string | null;
  workspace_location_id?: string | null;
  project_folder_id?: string | null;
  model_provider_id?: string | null;
  model_override_json?: unknown;
}

/**
 * Whether a run is handed to a host daemon rather than executed in-process.
 *
 * This is the runtime's question, not the host's. Every `local_cli` adapter is
 * dispatched to a daemon now — the built-in host's as much as a paired
 * machine's, since the built-in host *is* a daemon — while every other family
 * executes in-process on the server: a `model_api` run on a remote Folder
 * still calls the routed provider from here, because there is no subprocess to
 * hand anything to.
 *
 * That distinction decides more than where the process starts. A run handed to
 * a daemon gets no server-brokered Runtime Context (its agent pulls what it
 * needs through the `rainver` command in its work surface), no server-side CLI
 * continuity (the vendor session in its Agent profile is the continuity), and
 * no sandbox-level escalation (the daemon builds the namespace). A run that
 * executes in-process keeps all three, because nothing else can supply them.
 *
 * It used to take a `hostKind` and answer false for the server host. That was
 * the same question when the server host was an in-process boundary; it is the
 * wrong one now that it is a daemon like any other, and `hostKind` is left
 * meaning only *which machine* — which is still what decides whether a
 * server-brokered credential is in play.
 *
 * Callers that were three separate expressions once disagreed: the preflight
 * was corrected and the read model was not, which denied a provider that had
 * in fact been used. One function, so that cannot recur.
 */
export function dispatchesToHostDaemon(adapterType: string | null | undefined): boolean {
  return getRuntimeAdapterSpec(adapterType ?? undefined)?.executor_family === "local_cli";
}

function hasRecordedModel(run: RemotenessInput): boolean {
  if (run.model_provider_id) return true;
  const override = run.model_override_json;
  return Boolean(
    override && typeof override === "object" && !Array.isArray(override)
      && typeof (override as Record<string, unknown>).model === "string",
  );
}

/**
 * Which of these Runs execute somewhere other than the server host.
 *
 * Resolved from the Location the same way `resolveExecutionPort` picks its
 * adapter — Location first, else the Folder's single active Location —
 * because `runs.trust_mode` answers a narrower question: only the
 * thread-dispatch path writes it, so an Automation, Room, Workflow or
 * evolution run on a remote Folder has it null and still runs
 * remotely.
 *
 * Two economies keep this affordable on list endpoints, which render up to a
 * few hundred Runs: a Run with no recorded provider or model is skipped
 * outright (remoteness cannot change how it renders), and everything left is
 * answered in one query rather than one per Run.
 */
export async function resolveRunRemoteness(
  db: Queryable,
  runs: readonly RemotenessInput[],
): Promise<Set<string>> {
  // Every run reaching here already sits on a remote Location — that is what
  // the query below establishes — so the adapter is the remaining question.
  const relevant = runs.filter((run) => hasRecordedModel(run) && dispatchesToHostDaemon(run.adapter_type));
  if (relevant.length === 0) return new Set();

  const locationIds = [...new Set(relevant.flatMap((run) => run.workspace_location_id ? [run.workspace_location_id] : []))];
  const folderIds = [...new Set(
    relevant.flatMap((run) => !run.workspace_location_id && run.project_folder_id ? [run.project_folder_id] : []),
  )];
  if (locationIds.length === 0 && folderIds.length === 0) return new Set();

  const rows = await db.query<{ location_id: string | null; folder_id: string | null }>(
    `SELECT id AS location_id, NULL::varchar AS folder_id
       FROM workspace_locations
      WHERE id = ANY($1::varchar[]) AND execution_host_kind = 'remote'
     UNION ALL
     SELECT NULL::varchar AS location_id, project_folder_id AS folder_id
       FROM workspace_locations
      WHERE project_folder_id = ANY($2::varchar[])
        AND status = 'active' AND execution_host_kind = 'remote'`,
    [locationIds, folderIds],
  );
  const remoteLocations = new Set(rows.rows.flatMap((row) => row.location_id ? [row.location_id] : []));
  const remoteFolders = new Set(rows.rows.flatMap((row) => row.folder_id ? [row.folder_id] : []));

  return new Set(relevant.flatMap((run) => {
    const remote = run.workspace_location_id
      ? remoteLocations.has(run.workspace_location_id)
      : Boolean(run.project_folder_id && remoteFolders.has(run.project_folder_id));
    return remote ? [run.id] : [];
  }));
}
