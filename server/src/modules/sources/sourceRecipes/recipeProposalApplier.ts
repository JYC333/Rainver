import type {
  ProposalApplierRegistry,
  ProposalApplyContext,
  ProposalApplyResult,
} from "../../proposals/applierRegistry.js";
import {
  RECIPE_VERSION_COLUMNS,
  activateSourceRecipeVersionTx,
  recipeVersionOut,
  type RecipeVersionRow,
} from "./recipeVersionStore.js";

/**
 * Applier for `source_recipe_activation` proposals — the Level 2 analogue of
 * the Custom Source policy-delta applier (customSourceProposalApplier.ts):
 * fail-closed on stale version/proposal bindings, a changed active pointer,
 * or a changed envelope snapshot, then activate the recipe version through
 * the same shared activation writes the inside-envelope path uses.
 */

export class SourceRecipeProposalApplyError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "SourceRecipeProposalApplyError";
  }
}

export function registerSourceRecipeProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("source_recipe_activation", applySourceRecipeActivation);
}

async function applySourceRecipeActivation(context: ProposalApplyContext): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  const connectionId = requiredString(payload.source_connection_id, "source_connection_id");
  const versionId = requiredString(payload.recipe_version_id, "recipe_version_id");

  const connectionResult = await context.db.query<{
    id: string;
    space_id: string;
    active_recipe_version_id: string | null;
    handler_kind: string;
    deleted_at: unknown;
  }>(
    `SELECT id, space_id, active_recipe_version_id, handler_kind, deleted_at
       FROM source_connections
      WHERE id = $1 AND space_id = $2
      FOR UPDATE`,
    [connectionId, context.proposal.space_id],
  );
  const connection = connectionResult.rows[0];
  if (!connection || connection.deleted_at !== null) {
    throw new SourceRecipeProposalApplyError(404, "Source connection not found");
  }
  if (connection.handler_kind !== "recipe") {
    throw new SourceRecipeProposalApplyError(422, "Source connection is not a recipe source");
  }

  const versionResult = await context.db.query<RecipeVersionRow>(
    `SELECT ${RECIPE_VERSION_COLUMNS}
       FROM source_recipe_versions
      WHERE id = $1 AND space_id = $2 AND source_connection_id = $3
      FOR UPDATE`,
    [versionId, context.proposal.space_id, connectionId],
  );
  const version = versionResult.rows[0];
  if (!version) throw new SourceRecipeProposalApplyError(404, "Recipe version not found");
  if (version.proposal_id !== context.proposal.id) {
    throw new SourceRecipeProposalApplyError(409, "Recipe version is not bound to this proposal");
  }
  if (version.status !== "pending_approval") {
    throw new SourceRecipeProposalApplyError(
      409,
      `Recipe version must be pending approval to apply (was ${version.status})`,
    );
  }
  const testResult = version.test_result_json as { status?: string } | null;
  if (testResult?.status !== "succeeded") {
    throw new SourceRecipeProposalApplyError(409, "Recipe version must have a successful dry-run result");
  }

  const expectedActiveId = nullableString(payload.current_recipe_version_id);
  if (connection.active_recipe_version_id !== expectedActiveId) {
    throw new SourceRecipeProposalApplyError(
      409,
      "Source active recipe version changed after this proposal was created",
    );
  }
  if (!jsonDeepEqual(version.policy_envelope_json, payload.proposed_policy_envelope_json)) {
    throw new SourceRecipeProposalApplyError(
      409,
      "Recipe version policy envelope changed after this proposal was created",
    );
  }
  if (expectedActiveId) {
    const activeResult = await context.db.query<{ policy_envelope_json: unknown }>(
      `SELECT policy_envelope_json FROM source_recipe_versions WHERE id = $1 AND space_id = $2`,
      [expectedActiveId, context.proposal.space_id],
    );
    if (!jsonDeepEqual(activeResult.rows[0]?.policy_envelope_json ?? null, payload.current_policy_envelope_json ?? null)) {
      throw new SourceRecipeProposalApplyError(
        409,
        "Source active policy envelope changed after this proposal was created",
      );
    }
  }

  await activateSourceRecipeVersionTx(context.db, {
    spaceId: context.proposal.space_id,
    connectionId,
    versionId,
    previousActiveVersionId: connection.active_recipe_version_id,
    nextCheckAt: payload.next_check_at,
    scheduleRule: payload.schedule_rule,
  });

  const activatedResult = await context.db.query<RecipeVersionRow>(
    `SELECT ${RECIPE_VERSION_COLUMNS} FROM source_recipe_versions WHERE id = $1 AND space_id = $2`,
    [versionId, context.proposal.space_id],
  );
  const now = new Date().toISOString();
  return {
    result_type: "source_recipe_version",
    result: {
      source_connection_id: connectionId,
      recipe_version_id: versionId,
      previous_recipe_version_id: connection.active_recipe_version_id,
      status: "active",
      recipe_version: recipeVersionOut(activatedResult.rows[0]!),
    },
    proposalPayloadPatch: {
      ...payload,
      accepted_by_user_id: context.userId,
      accepted_at: now,
      activated_recipe_version_id: versionId,
      previous_recipe_version_id: connection.active_recipe_version_id,
    },
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SourceRecipeProposalApplyError(422, `Proposal payload missing ${field}`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jsonDeepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value ?? null;
}
