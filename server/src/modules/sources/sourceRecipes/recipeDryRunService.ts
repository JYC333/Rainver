import type {
  SourcePolicyEnvelope,
  SourceRecipeDefinition,
  SourceRecipeDryRunResult,
} from "@agent-space/protocol";
import * as protocol from "@agent-space/protocol";
import type { ServerConfig } from "../../../config.js";
import {
  HttpError,
  optionalString,
  requiredString,
  type Pool,
  type SpaceUserIdentity,
} from "../../routeUtils/common.js";
import { PgCustomSourceHandlerRepository } from "../customSources/customSourceHandlerRepository.js";
import { CustomSourceCredentialService } from "../customSources/customSourceCredentialService.js";
import { fetchCustomSourceEndpointHtml } from "../customSources/customSourceEndpointFetch.js";
import { validateCustomSourceHandlerOutput } from "../customSources/customSourceContractValidator.js";
import { cleanupSandbox, effectiveCustomSourceLimits } from "../customSources/customSourceRunner.js";
import { sha256 } from "../sourceRepositoryMappers.js";
import { runSourceRecipe } from "./recipeInterpreter.js";
import {
  getSourceRecipeVersion,
  recipeVersionOut,
  recordSourceRecipeDryRunOutcome,
} from "./recipeVersionStore.js";

/**
 * Bounded, side-effect-free dry-run of a draft Source recipe version.
 *
 * A dry-run never writes active Source outputs — no `source_items`,
 * `source_snapshots`, `extracted_evidence`, or `artifacts` rows. Its only
 * durable write is the dry-run result recorded on the recipe version
 * (`test_result_json` + the draft/test_failed status transition). The
 * interpreter runs in `dry_run` mode (offline except the caller-owned
 * primary-endpoint pre-fetch, which a `fixture_content` body field replaces
 * for deterministic regression runs), and successful output still goes
 * through the shared source output contract validator so the sample preview
 * shows exactly what a live run would be allowed to materialize.
 *
 * On a non-succeeded outcome, a bounded failure fixture (content hash +
 * excerpt of the primary endpoint content) is captured inside the stored
 * result for later repair/reproduction.
 */
export class SourceRecipeDryRunService {
  constructor(
    private readonly pool: Pool,
    private readonly config: ServerConfig,
  ) {}

  async dryRunRecipeVersion(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    const connection = await this.requireRecipeConnection(identity, connectionId);
    const versionId = requiredString(body.recipe_version_id, "recipe_version_id");
    const versionRow = await getSourceRecipeVersion(this.pool, identity.spaceId, connectionId, versionId);
    if (!versionRow) throw new HttpError(404, "Recipe version not found");
    if (versionRow.status !== "draft" && versionRow.status !== "test_failed") {
      throw new HttpError(409, `Recipe version must be draft or test_failed to dry-run (was ${versionRow.status})`);
    }

    const recipeParse = protocol.SourceRecipeDefinitionSchema.safeParse(versionRow.recipe_json);
    if (!recipeParse.success) {
      throw new HttpError(422, "Stored recipe definition no longer passes schema validation");
    }
    const recipe: SourceRecipeDefinition = recipeParse.data;
    const envelope: SourcePolicyEnvelope = protocol.SourcePolicyEnvelopeSchema.parse(
      versionRow.policy_envelope_json,
    );

    const settings = await new PgCustomSourceHandlerRepository(this.pool, this.config).getEffectiveSettings(identity);
    const credential = await new CustomSourceCredentialService(this.pool, this.config).resolveCredentialHeader(
      identity.spaceId,
      envelope.credential_ref,
    );

    const startedAt = new Date().toISOString();
    const fixtureContent = optionalString(body.fixture_content);
    const primaryEndpointContent =
      fixtureContent ??
      (await fetchCustomSourceEndpointHtml(connection.endpoint_url, settings.runner, envelope, credential));

    const runResult = await runSourceRecipe(settings.runner, {
      policyEnvelope: envelope,
      recipe,
      mode: "dry_run",
      endpointUrl: connection.endpoint_url,
      sourceName: connection.name,
      primaryEndpointContent,
      credential,
    });

    let status: SourceRecipeDryRunResult["status"];
    let sampleItems: SourceRecipeDryRunResult["sample_items"] = [];
    let itemCount = 0;
    const errors: string[] = [];
    try {
      if (runResult.status === "failed") {
        status = "failed";
        errors.push(runResult.timed_out ? "recipe dry-run timed out" : (runResult.error ?? "recipe dry-run failed"));
      } else if (runResult.output_too_large || runResult.raw_output_json === null) {
        status = "failed";
        errors.push("recipe output exceeded max_output_bytes");
      } else {
        const validation = await validateCustomSourceHandlerOutput({
          raw: JSON.parse(runResult.raw_output_json),
          limits: effectiveCustomSourceLimits(settings.runner, envelope.limits),
          allowedNetworkOrigins: envelope.allowed_network_origins,
          sandboxFilesRoot: runResult.sandbox_files_root,
        });
        if (validation.ok) {
          status = "succeeded";
          itemCount = validation.output.items.length;
          sampleItems = validation.output.items.slice(0, SAMPLE_ITEM_LIMIT);
        } else {
          status = "validation_failed";
          errors.push(...validation.errors);
        }
      }
    } finally {
      await cleanupSandbox(runResult.sandbox_files_root).catch(() => undefined);
    }

    const dryRun: SourceRecipeDryRunResult = {
      status,
      item_count: itemCount,
      sample_items: sampleItems,
      followed_urls: runResult.followed_urls,
      skipped_urls: runResult.skipped_urls,
      warnings: runResult.warnings,
      errors,
      step_traces: runResult.step_traces,
      policy_envelope: envelope,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      ...(status !== "succeeded"
        ? {
            failure_fixture: {
              content_sha256: sha256(primaryEndpointContent),
              content_excerpt: primaryEndpointContent.slice(0, FAILURE_FIXTURE_EXCERPT_CHARS),
              captured_at: startedAt,
            },
          }
        : {}),
    };

    const updated = await recordSourceRecipeDryRunOutcome(this.pool, identity.spaceId, versionId, dryRun);
    if (!updated) throw new HttpError(409, "Recipe version is no longer testable");
    return { recipe_version: recipeVersionOut(updated), dry_run: dryRun };
  }

  private async requireRecipeConnection(identity: SpaceUserIdentity, connectionId: string) {
    const result = await this.pool.query<{
      id: string;
      name: string;
      endpoint_url: string | null;
      handler_kind: string;
    }>(
      `SELECT sc.id, sc.name, ch.endpoint_url, sc.handler_kind
         FROM source_connections sc
         JOIN source_channels ch ON ch.source_connection_id = sc.id AND ch.status <> 'archived'
        WHERE sc.space_id = $1 AND sc.id = $2 AND sc.deleted_at IS NULL
        ORDER BY ch.updated_at DESC LIMIT 1`,
      [identity.spaceId, connectionId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Source connection not found");
    if (row.handler_kind !== "recipe") {
      throw new HttpError(422, "Source connection is not a recipe source");
    }
    return row;
  }
}

const SAMPLE_ITEM_LIMIT = 5;
const FAILURE_FIXTURE_EXCERPT_CHARS = 16_384;
