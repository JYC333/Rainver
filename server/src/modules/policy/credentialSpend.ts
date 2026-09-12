import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/runRepositoryTypes.js";
import { loadActionRegistry } from "./actionRegistry.js";
import {
  credentialPolicyMetadata,
  credentialSetupContext,
  managedExecutionPolicyFromContract,
  type CredentialSetupKind,
} from "./managedExecutionPolicy.js";
import { enforce, type EnforceResult } from "./service.js";

/**
 * Why a ModelProvider key is being spent. Every spend names one, and
 * `authorizeCredentialSpend` decides it before any key is resolved or any
 * proxy lease is minted.
 */
export type CredentialSpendBasis =
  /** A person asked for this in the request being served. */
  | { kind: "person"; user_id: string }
  /**
   * A Run spends for itself. Decided on the top of its parent chain: whoever
   * set the whole tree going, since a delegated, scheduled or autonomous child
   * carries no authority of its own.
   */
  | { kind: "run"; run: CredentialSpendRun }
  /** An unattended job spends on a setup a person recorded. */
  | {
      kind: "setup";
      setup: CredentialSetupKind;
      /** The record that authorizes the spend, named in the audit row. */
      record_id: string;
      /** Whose setup it is. */
      user_id: string;
      /**
       * Re-reads that record now, at spend time. False means it no longer
       * authorizes the spend — switched off, or its person lost the access it
       * rested on.
       */
      still_authorized: () => Promise<boolean>;
    };

export type CredentialSpendRun = Pick<
  RunRecord,
  "id" | "space_id" | "parent_run_id" | "trigger_origin" | "contract_snapshot_json"
>;

declare const credentialSpendAuthorized: unique symbol;

/**
 * Proof that one spend was decided: by whom (the Run, when a Run spends) and
 * on which provider. Only `authorizeCredentialSpend` makes one.
 */
export interface CredentialSpendAuthorization {
  readonly [credentialSpendAuthorized]: true;
  readonly space_id: string;
  readonly run_id: string | null;
  readonly provider_id: string | null;
  readonly trigger_origin: string;
  readonly policy_decision_record_id: string | null;
}

export class CredentialSpendDeniedError extends Error {
  readonly code = "policy_denied_runtime_use_credential";
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = "CredentialSpendDeniedError";
  }
}

export interface CredentialSpendDeps {
  /** Reads a child Run's root and the automation grant; defaults to the configured pool. */
  db?: Queryable;
  /**
   * Reads a Run by id, for the walk up a child's parent chain. The Run
   * executor passes its own repository so the decision reads Runs the way the
   * rest of execution does; everyone else reads the database.
   */
  readRun?: (spaceId: string, runId: string) => Promise<CredentialSpendRun | null>;
  /** The Run executor's policy seam; defaults to the policy service. */
  enforcer?: (request: Parameters<typeof enforce>[2]) => Promise<EnforceResult>;
}

interface SpendFacts {
  trigger_origin: string;
  actor_type: "user" | "run";
  actor_id: string;
  actor_ref: Record<string, unknown> | null;
  run_id: string | null;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/**
 * The one decision on spending a ModelProvider key: the `runtime.use_credential`
 * rule, fed the effective trigger origin and the authorization record as it
 * stands now. Throws `CredentialSpendDeniedError` unless the rule allows.
 */
export async function authorizeCredentialSpend(
  config: ServerConfig,
  input: { space_id: string; provider_id: string | null; basis: CredentialSpendBasis },
  deps: CredentialSpendDeps = {},
): Promise<CredentialSpendAuthorization> {
  const facts = await spendFacts(config, input.space_id, input.basis, deps);
  const request: Parameters<typeof enforce>[2] = {
    action: "runtime.use_credential",
    actor_type: facts.actor_type,
    actor_id: facts.actor_id,
    actor_ref: facts.actor_ref,
    space_id: input.space_id,
    resource_type: "model_provider",
    resource_id: input.provider_id,
    resource_space_id: input.space_id,
    run_id: facts.run_id,
    context: { trigger_origin: facts.trigger_origin, ...facts.context },
    metadata_json: {
      spend_basis: input.basis.kind,
      trigger_origin: facts.trigger_origin,
      credential_kind: "model_provider",
      provider_id: input.provider_id,
      ...facts.metadata,
    },
    force_record: false,
  };
  const result = deps.enforcer
    ? await deps.enforcer(request)
    : await enforce(config, await loadActionRegistry(), request);
  if (result.status !== "allow") {
    throw new CredentialSpendDeniedError(result.message ?? "runtime.use_credential denied by policy.");
  }
  return {
    space_id: input.space_id,
    run_id: facts.run_id,
    provider_id: input.provider_id,
    trigger_origin: facts.trigger_origin,
    policy_decision_record_id: result.policy_decision_record_id ?? null,
  } as CredentialSpendAuthorization;
}

async function spendFacts(
  config: ServerConfig,
  spaceId: string,
  basis: CredentialSpendBasis,
  deps: CredentialSpendDeps,
): Promise<SpendFacts> {
  if (basis.kind === "person") {
    return {
      trigger_origin: "manual",
      actor_type: "user",
      actor_id: basis.user_id,
      actor_ref: null,
      run_id: null,
      context: {},
      metadata: {},
    };
  }
  if (basis.kind === "setup") {
    const stillAuthorized = await basis.still_authorized();
    return {
      // A setup authorizes a background job, and the credential rule
      // registers every setup kind against `job`.
      trigger_origin: "job",
      actor_type: "user",
      actor_id: basis.user_id,
      actor_ref: { setup: basis.setup, record_id: basis.record_id },
      run_id: null,
      context: credentialSetupContext(basis.setup, stillAuthorized),
      metadata: {
        setup: basis.setup,
        setup_record_id: basis.record_id,
        setup_still_authorized: stillAuthorized,
      },
    };
  }
  if (basis.run.space_id !== spaceId) {
    throw new CredentialSpendDeniedError("This Run belongs to another Space.");
  }
  const root = await rootRun(config, basis.run, deps);
  const origin = root.trigger_origin;
  const context: Record<string, unknown> = {
    ...credentialPolicyMetadata(managedExecutionPolicyFromContract(root.contract_snapshot_json)),
  };
  const metadata: Record<string, unknown> = { root_run_id: root.id };
  if (origin === "automation" || origin === "autonomous") {
    const grant = await automationGrant(config, spaceId, root.id, deps.db);
    context.automation_pre_authorized = grant.granted;
    metadata.automation_id = grant.automation_id;
  }
  return {
    trigger_origin: origin,
    actor_type: "run",
    actor_id: basis.run.id,
    actor_ref: { run_id: basis.run.id, root_run_id: root.id, trigger_origin: origin },
    run_id: basis.run.id,
    context,
    metadata,
  };
}

const MAX_LINEAGE_DEPTH = 32;

/**
 * The Run that set this one's tree going: the top of its parent chain.
 * Walked rather than read from `root_run_id`, which not every creator writes —
 * an autonomy candidate names its coordinator only as its parent.
 */
async function rootRun(
  config: ServerConfig,
  run: CredentialSpendRun,
  deps: CredentialSpendDeps,
): Promise<CredentialSpendRun> {
  let current = run;
  for (let depth = 0; current.parent_run_id; depth += 1) {
    if (depth >= MAX_LINEAGE_DEPTH) {
      throw new CredentialSpendDeniedError("This Run descends from too many Runs to decide its spend.");
    }
    const parent = await readRun(config, deps, run.space_id, current.parent_run_id);
    if (!parent) throw new CredentialSpendDeniedError("A Run this one descends from no longer exists.");
    current = parent;
  }
  return current;
}

async function readRun(
  config: ServerConfig,
  deps: CredentialSpendDeps,
  spaceId: string,
  runId: string,
): Promise<CredentialSpendRun | null> {
  if (deps.readRun) return deps.readRun(spaceId, runId);
  const result = await requireDb(config, deps.db).query<CredentialSpendRun>(
    `SELECT id, space_id, parent_run_id, trigger_origin, contract_snapshot_json
       FROM runs
      WHERE space_id = $1 AND id = $2`,
    [spaceId, runId],
  );
  return result.rows[0] ?? null;
}

/**
 * The Automation that fired this root Run and whether it holds an active
 * credential grant now. Read live on every spend, so a revoked grant stops a
 * Run that was queued while it was active. The link is `automation_runs`,
 * which every Automation fire writes for the Run it creates.
 */
async function automationGrant(
  config: ServerConfig,
  spaceId: string,
  rootRunId: string,
  db: Queryable | undefined,
): Promise<{ automation_id: string | null; granted: boolean }> {
  const result = await requireDb(config, db).query<{ automation_id: string; granted: boolean }>(
    `SELECT link.automation_id,
            EXISTS (
              SELECT 1 FROM automation_credential_grants grant_row
               WHERE grant_row.space_id = automation.space_id
                 AND grant_row.automation_id = automation.id
                 AND grant_row.status = 'active'
            ) AS granted
       FROM automation_runs link
       JOIN automations automation ON automation.id = link.automation_id
      WHERE link.run_id = $2 AND automation.space_id = $1
      LIMIT 1`,
    [spaceId, rootRunId],
  );
  const row = result.rows[0];
  return { automation_id: row?.automation_id ?? null, granted: row?.granted === true };
}

function requireDb(config: ServerConfig, db: Queryable | undefined): Queryable {
  if (db) return db;
  if (!config.databaseUrl) {
    throw new CredentialSpendDeniedError("Credential spend cannot be authorized without the database.");
  }
  return getDbPool(config.databaseUrl);
}
