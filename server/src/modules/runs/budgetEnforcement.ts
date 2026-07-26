import {
  contractRecord,
  resolveBudgetSources,
  type RunBudgetSource,
  type RunContractSource,
} from "./contractSnapshot";
import type { Queryable, RunRecord } from "./runRepositoryTypes";

export class RunBudgetExceededError extends Error {
  readonly statusCode = 409;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunBudgetExceededError";
  }
}

export class RunBudgetSourceReferenceError extends Error {
  readonly statusCode = 422;

  constructor(
    readonly code: "budget_source_id_required" | "budget_source_not_found" | "budget_source_unsupported",
    message: string,
  ) {
    super(message);
    this.name = "RunBudgetSourceReferenceError";
  }
}

export interface RunBudgetCheckResult {
  allowed: boolean;
  error_code?: string;
  error_message?: string;
}

/**
 * Admission check used before creating a new logical execution. The caller
 * must execute this inside the transaction that creates the logical
 * execution; this function takes the stable advisory locks needed for
 * concurrent admission serialization.
 */
export async function assertBudgetSourcesAvailable(
  db: Queryable,
  spaceId: string,
  sources: RunBudgetSource[],
  options: { excludeExecutionRootId?: string | null } = {},
): Promise<void> {
  await assertBudgetSourceReferences(db, spaceId, sources);
  const effectiveSources = effectiveMaxRunsSources(sources);
  if (effectiveSources.length === 0) return;
  // Lock every effective source in a stable order. A Task may inherit an
  // Automation/Workflow cap, so locking only the first resolver winner would
  // allow a concurrent admission through the other equally-effective source.
  for (const source of [...effectiveSources].sort(sourceOrder)) {
    await db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [budgetLockKey(spaceId, source.source)],
    );
  }
  const counts = await Promise.all(effectiveSources.map(async (source) => ({
    source,
    total: await countSourceRuns(
      db,
      spaceId,
      source.source,
      options.excludeExecutionRootId ?? null,
    ),
  })));
  const exceeded = counts.find(({ source, total }) => total >= (source.max_runs as number));
  if (exceeded) {
    throw new RunBudgetExceededError(
      `${exceeded.source.source.kind}_max_runs_exceeded`,
      `${exceeded.source.source.kind} contract max_runs=${exceeded.source.max_runs} has already admitted ${exceeded.total} execution(s).`,
    );
  }
}

/**
 * Validate every durable budget source before it can participate in an
 * admission decision. A missing source must never look like a source with
 * zero previous executions, even when a malformed declaration carries no
 * numeric cap.
 */
export async function assertBudgetSourceReferences(
  db: Queryable,
  spaceId: string,
  sources: RunBudgetSource[],
): Promise<void> {
  for (const source of sources) {
    const { kind, id } = source.source;
    if (kind === "direct" || kind === "delegation") {
      if (source.max_runs !== null && source.max_runs !== undefined) {
        throw new RunBudgetSourceReferenceError(
          "budget_source_unsupported",
          `Budget source kind '${kind}' cannot enforce max_runs without a durable source identity.`,
        );
      }
      continue;
    }
    if (!id) {
      throw new RunBudgetSourceReferenceError(
        "budget_source_id_required",
        `Budget source kind '${kind}' requires a source id when a budget is declared.`,
      );
    }
    const exists = await budgetSourceExists(db, spaceId, kind, id);
    if (!exists) {
      throw new RunBudgetSourceReferenceError(
        "budget_source_not_found",
        `Budget source '${kind}:${id}' does not exist in the active space or is not visible to it.`,
      );
    }
  }
}

/**
 * Dispatch check for an immutable Run snapshot. A plan child carries the
 * coordinator's root_run_id so all children in one workflow execution are
 * counted as one Automation/Workflow admission rather than one execution per
 * child.
 */
export async function checkRunBudget(
  db: Queryable,
  run: Pick<RunRecord, "space_id" | "id" | "root_run_id" | "contract_snapshot_json">,
): Promise<RunBudgetCheckResult> {
  const contract = contractRecord(run.contract_snapshot_json);
  const sources = budgetSourcesFromSnapshot(contract);
  const executionRootId = run.root_run_id ?? run.id;
  try {
    await assertBudgetSourceReferences(db, run.space_id, sources);
  } catch (error) {
    if (error instanceof RunBudgetSourceReferenceError) {
      return {
        allowed: false,
        error_code: error.code,
        error_message: error.message,
      };
    }
    throw error;
  }
  const effectiveSources = effectiveMaxRunsSources(sources);
  if (effectiveSources.length === 0) return { allowed: true };
  const counts = await Promise.all(effectiveSources.map(async (source) => ({
    source,
    total: await countSourceRuns(
      db,
      run.space_id,
      source.source,
      executionRootId,
    ),
  })));
  const exceeded = counts.find(({ source, total }) => total >= (source.max_runs as number));
  if (!exceeded) return { allowed: true };
  return {
    allowed: false,
    error_code: `${exceeded.source.source.kind}_max_runs_exceeded`,
    error_message: `${exceeded.source.source.kind} contract max_runs=${exceeded.source.max_runs} has already admitted ${exceeded.total} execution(s).`,
  };
}

function budgetSourcesFromSnapshot(contract: ReturnType<typeof contractRecord>): RunBudgetSource[] {
  if (Array.isArray(contract.budget_sources)) {
    const sources = contract.budget_sources.filter(isBudgetSource);
    if (sources.length > 0) return sources;
  }
  if (typeof contract.max_runs !== "number" || !Number.isFinite(contract.max_runs)) return [];
  const source = contract.source && isSource(contract.source)
    ? contract.source
    : { kind: "direct" as const, id: null };
  return [{ source, max_runs: contract.max_runs }];
}

function effectiveMaxRunsSources(sources: RunBudgetSource[]): RunBudgetSource[] {
  const resolved = resolveBudgetSources(sources);
  if (resolved.effective.max_runs === null) return [];
  const candidates = resolved.sources.filter((source) => source.max_runs !== null && source.max_runs !== undefined);
  const explicit = candidates.filter((source) => source.precedence !== null && source.precedence !== undefined);
  const eligible = explicit.length > 0
    ? explicit.filter((source) => source.precedence === Math.max(...explicit.map((item) => item.precedence as number)))
    : candidates;
  const unique = new Map<string, RunBudgetSource>();
  for (const source of eligible) {
    if (source.max_runs !== resolved.effective.max_runs) continue;
    unique.set(sourceKey(source.source), source);
  }
  return [...unique.values()];
}

function sourceKey(source: RunContractSource): string {
  return `${source.kind}:${source.id ?? "none"}`;
}

function sourceOrder(left: RunBudgetSource, right: RunBudgetSource): number {
  return sourceKey(left.source).localeCompare(sourceKey(right.source));
}

function budgetLockKey(spaceId: string, source: RunContractSource): string {
  return `run-budget:${spaceId}:${sourceKey(source)}`;
}

async function budgetSourceExists(
  db: Queryable,
  spaceId: string,
  kind: RunContractSource["kind"],
  id: string,
): Promise<boolean> {
  if (kind === "task") {
    const result = await db.query(
      `SELECT 1 FROM tasks WHERE id = $1 AND space_id = $2 LIMIT 1`,
      [id, spaceId],
    );
    return result.rows.length > 0;
  }
  if (kind === "automation") {
    const result = await db.query(
      `SELECT 1 FROM automations WHERE id = $1 AND space_id = $2 LIMIT 1`,
      [id, spaceId],
    );
    return result.rows.length > 0;
  }
  if (kind === "plan") {
    const result = await db.query(
      `SELECT 1 FROM plans WHERE id = $1 AND space_id = $2 LIMIT 1`,
      [id, spaceId],
    );
    return result.rows.length > 0;
  }
  if (kind === "workflow") {
    const result = await db.query(
      `SELECT 1
         FROM evolvable_asset_versions v
         JOIN evolvable_assets a ON a.id = v.asset_id
        WHERE v.id = $1
          AND a.asset_type = 'workflow_template'
          AND a.status = 'active'
          AND v.status = 'approved'
          AND (
            (
              a.space_id IS NULL
              AND a.owner_scope_type = 'system'
              AND a.owner_scope_id IS NULL
              AND v.space_id IS NULL
              AND v.scope_type = 'system'
              AND v.scope_id IS NULL
            )
            OR (
              a.space_id = $2
              AND a.owner_scope_type <> 'system'
              AND (
                (a.owner_scope_type = 'space' AND a.owner_scope_id IS NULL)
                OR (
                  a.owner_scope_type = 'project'
                  AND a.owner_scope_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM projects ap
                     WHERE ap.id = a.owner_scope_id AND ap.space_id = $2
                  )
                )
                OR (
                  a.owner_scope_type = 'agent'
                  AND a.owner_scope_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM agents aa
                     WHERE aa.id = a.owner_scope_id AND aa.space_id = $2
                  )
                )
                OR (
                  a.owner_scope_type = 'user'
                  AND a.owner_scope_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                      FROM space_memberships owner_membership
                     WHERE owner_membership.space_id = $2
                       AND owner_membership.user_id = a.owner_scope_id
                       AND owner_membership.status = 'active'
                  )
                )
              )
              AND v.space_id = $2
              AND (
                (
                  a.owner_scope_type <> 'user'
                  AND v.scope_type = 'system'
                  AND v.scope_id IS NULL
                )
                OR (
                  a.owner_scope_type <> 'user'
                  AND v.scope_type = 'space'
                  AND v.scope_id = $2
                )
                OR (
                  a.owner_scope_type <> 'user'
                  AND v.scope_type = 'project'
                  AND v.scope_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM projects p
                     WHERE p.id = v.scope_id AND p.space_id = $2
                  )
                )
                OR (
                  a.owner_scope_type <> 'user'
                  AND v.scope_type = 'agent'
                  AND v.scope_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM agents ag
                     WHERE ag.id = v.scope_id AND ag.space_id = $2
                  )
                )
                OR (
                  v.scope_type = 'user'
                  AND v.scope_id IS NOT NULL
                  AND (
                    (
                      a.owner_scope_type = 'user'
                      AND a.owner_scope_id = v.scope_id
                    )
                    OR (
                      a.owner_scope_type <> 'user'
                      AND a.metadata_json->>'allow_user_override' = 'true'
                    )
                  )
                  AND EXISTS (
                    SELECT 1
                      FROM space_memberships sm
                     WHERE sm.space_id = $2
                       AND sm.user_id = v.scope_id
                       AND sm.status = 'active'
                  )
                )
              )
            )
          )
        LIMIT 1`,
      [id, spaceId],
    );
    return result.rows.length > 0;
  }
  return false;
}

async function countSourceRuns(
  db: Queryable,
  spaceId: string,
  source: RunContractSource,
  executionRootId: string | null,
): Promise<number> {
  if (!source.id) throw new RunBudgetSourceReferenceError(
    "budget_source_id_required",
    `Budget source kind '${source.kind}' cannot be counted without a source id.`,
  );
  const nativeExecutions = source.kind === "task"
    ? `SELECT tr.run_id AS execution_root_id
         FROM task_runs tr
        WHERE tr.space_id = $1 AND tr.task_id = $3`
    : source.kind === "automation"
      ? `SELECT ar.run_id AS execution_root_id
           FROM automation_runs ar
           JOIN automations a ON a.id = ar.automation_id AND a.space_id = $1
          WHERE ar.automation_id = $3`
      : `SELECT NULL::varchar AS execution_root_id WHERE false`;
  const result = await db.query<{ total: string }>(
    `WITH source_executions AS (
       ${nativeExecutions}
       UNION
       SELECT COALESCE(r.root_run_id, r.id) AS execution_root_id
         FROM runs r
        WHERE r.space_id = $1
          AND (
            (
              r.contract_snapshot_json->'source'->>'kind' = $2
              AND r.contract_snapshot_json->'source'->>'id' = $3
            )
            OR EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(r.contract_snapshot_json->'budget_sources', '[]'::jsonb)) budget
               WHERE budget->'source'->>'kind' = $2
                 AND budget->'source'->>'id' = $3
            )
          )
     )
     SELECT count(*)::text AS total
       FROM source_executions
      WHERE execution_root_id <> COALESCE($4, '')`,
    [spaceId, source.kind, source.id, executionRootId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

function isBudgetSource(value: unknown): value is RunBudgetSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = (value as { source?: unknown }).source;
  return !!source && isSource(source);
}

function isSource(value: unknown): value is RunContractSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "direct" || kind === "task" || kind === "automation"
    || kind === "workflow" || kind === "delegation" || kind === "plan";
}
