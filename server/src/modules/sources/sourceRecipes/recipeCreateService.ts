import type {
  CustomSourcePolicyEnvelope,
  SourcePolicyEnvelope,
  SourceRecipeDefinition,
} from "@agent-space/protocol";
import * as protocol from "@agent-space/protocol";
import type { ServerConfig } from "../../../config.js";
import {
  HttpError,
  objectValue,
  optionalString,
  requiredString,
  withDbTransaction,
  type Pool,
  type SpaceUserIdentity,
} from "../../routeUtils/common.js";
import { insertProposalRow } from "../../proposals/reviewPackets.js";
import { SourceChannelService } from "../channels/sourceChannelService.js";
import { PgCustomSourceHandlerRepository } from "../customSources/customSourceHandlerRepository.js";
import { CustomSourceCredentialService } from "../customSources/customSourceCredentialService.js";
import {
  parseSourceCapturePolicy,
  parseSourceRetentionPolicy,
  type SourceCapturePolicy,
  type SourceRetentionPolicy,
} from "../capturePolicy.js";
import { evaluateCustomSourceActivation } from "../customSources/customSourceCreateFlowService.js";
import { fetchAllowedOriginResponse, truncateToByteLimit } from "../customSources/customSourceEndpointFetch.js";
import { cleanupSandbox } from "../customSources/customSourceRunner.js";
import { analyzeSourceRecipe } from "./primitiveRegistry.js";
import { buildRecipeForSourceType, detectPlannedSourceType, type PlannedSourceType } from "./recipePlanner.js";
import { runSourceRecipe } from "./recipeInterpreter.js";
import {
  getSourceRecipeVersion,
  insertSourceRecipeVersion,
  recipeVersionOut,
  activateSourceRecipeVersionTx,
  RECIPE_VERSION_COLUMNS,
  type RecipeVersionRow,
} from "./recipeVersionStore.js";

/**
 * Conversation-first Source creation (Level 2 main path): plan -> create ->
 * dry-run (recipeDryRunService) -> activate. Planning is deterministic —
 * endpoint content sniffing plus fixed recipe shapes from the primitive
 * catalog; a caller-supplied recipe (e.g. LLM-proposed later) must validate
 * against `SourceRecipeDefinitionSchema` and stay inside the endpoint origin.
 *
 * Activation compares only the policy envelope: a within-envelope recipe
 * activates directly; a permission delta (credential request without Space
 * allowance, broadened capture/retention vs Space defaults or the active
 * version, larger limits, new network origins) creates a
 * `source_recipe_activation` proposal and parks the version
 * `pending_approval` until review.
 */
export class SourceRecipeCreateService {
  constructor(
    private readonly pool: Pool,
    private readonly config: ServerConfig,
  ) {}

  async planSource(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    const endpointUrl = requiredString(body.endpoint_url, "endpoint_url");
    const { settings, endpointOrigin } = await this.requireCreatorAndDomain(identity, endpointUrl, body);
    const envelope = this.buildEnvelope(identity, body, settings, endpointOrigin);
    const listSelector = optionalString(body.list_selector);

    const fixtureContent = optionalString(body.fixture_content);
    let contentSample = fixtureContent ?? "";
    let fetchWarning: string | null = null;
    if (fixtureContent === null) {
      try {
        const response = await fetchAllowedOriginResponse(endpointUrl, [endpointOrigin], {
          signal: AbortSignal.timeout(Math.min(15_000, settings.runner.timeout_ms_max)),
        });
        if (response.ok) {
          contentSample = truncateToByteLimit(await response.text(), settings.runner.download_bytes_max);
        } else {
          fetchWarning = `endpoint returned HTTP ${response.status} during planning`;
        }
      } catch (error) {
        fetchWarning = `endpoint fetch failed during planning: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const sourceType = detectPlannedSourceType({
      requested: optionalString(body.source_type) ?? null,
      contentSample,
      url: endpointUrl,
      listSelector,
    });
    const recipe = this.buildPlannedRecipe(sourceType, listSelector);
    const analysis = analyzeSourceRecipe(recipe);

    const preview = await runSourceRecipe(settings.runner, {
      policyEnvelope: envelope,
      recipe,
      mode: "dry_run",
      endpointUrl,
      sourceName: optionalString(body.name) ?? endpointUrl,
      primaryEndpointContent: contentSample,
    });
    await cleanupSandbox(preview.sandbox_files_root).catch(() => undefined);

    return {
      source_type: sourceType,
      recipe,
      policy_envelope: envelope,
      analysis,
      preview: {
        status: preview.status,
        item_count: preview.items.length,
        sample_items: preview.items.slice(0, 5),
        warnings: fetchWarning ? [fetchWarning, ...preview.warnings] : preview.warnings,
        step_traces: preview.step_traces,
        error: preview.error,
      },
      defaults: {
        fetch_frequency: optionalString(body.fetch_frequency) ?? "daily",
        capture_policy: envelope.capture_policy,
        retention_policy: envelope.retention_policy,
      },
    };
  }

  async createSource(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    const endpointUrl = requiredString(body.endpoint_url, "endpoint_url");
    const name = requiredString(body.name, "name");
    const { settings, endpointOrigin } = await this.requireCreatorAndDomain(identity, endpointUrl, body);
    const envelope = this.buildEnvelope(identity, body, settings, endpointOrigin);
    const listSelector = optionalString(body.list_selector);
    const sourceType = detectPlannedSourceType({
      requested: optionalString(body.source_type) ?? null,
      contentSample: "",
      url: endpointUrl,
      listSelector,
    });

    let recipe: SourceRecipeDefinition;
    if (body.recipe !== undefined) {
      const parsed = protocol.SourceRecipeDefinitionSchema.safeParse(body.recipe);
      if (!parsed.success) {
        throw new HttpError(422, "recipe does not validate against the source recipe schema");
      }
      recipe = parsed.data;
    } else {
      recipe = this.buildPlannedRecipe(sourceType, listSelector);
    }
    const analysis = analyzeSourceRecipe(recipe);
    for (const liveUrl of analysis.live_fetch_urls) {
      if (!originOf(liveUrl) || originOf(liveUrl) !== endpointOrigin) {
        throw new HttpError(422, `recipe fetches an origin outside the source endpoint: ${liveUrl}`);
      }
    }

    return withDbTransaction(this.pool, async (client) => {
      const channels = new SourceChannelService(client, this.config);
      const channel = await channels.create(
        identity,
        {
          project_id: optionalString(body.project_id),
          visibility: optionalString(body.visibility),
          provider_key: "custom_source",
          name,
          source_name: name,
          endpoint_url: endpointUrl,
          credential_id: optionalString(body.credential_id) ?? null,
          fetch_frequency: optionalString(body.fetch_frequency) ?? "daily",
          next_check_at: body.next_check_at,
          schedule_rule: body.schedule_rule,
          capture_policy: envelope.capture_policy,
          policy: { retention_policy: envelope.retention_policy },
          config: {
            ...objectValue(body.config),
            source_type: sourceType,
            list_selector: listSelector ?? null,
          },
          status: "paused",
          _initial_status: "paused",
          query: {},
        },
      );
      const now = new Date().toISOString();
      await client.query(
        `UPDATE source_connections
            SET handler_kind = 'recipe', status = 'paused', updated_at = $3
          WHERE id = $1 AND space_id = $2
          RETURNING id`,
        [channel.source_connection_id, identity.spaceId, now],
      );
      const version = await insertSourceRecipeVersion(client, {
        spaceId: identity.spaceId,
        connectionId: channel.source_connection_id,
        recipe,
        policyEnvelope: envelope,
        primitiveVersions: analysis.primitive_versions,
        createdByUserId: identity.userId,
      });
      return {
        connection: {
          ...channel,
          id: channel.source_connection_id,
          source_channel_id: channel.id,
          handler_kind: "recipe",
          status: "paused",
        },
        recipe_version: recipeVersionOut(version),
      };
    });
  }

  async activateRecipe(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    const connection = await this.requireRecipeConnection(identity, connectionId);
    const versionId = requiredString(body.recipe_version_id, "recipe_version_id");
    const versionRow = await getSourceRecipeVersion(this.pool, identity.spaceId, connectionId, versionId);
    if (!versionRow) throw new HttpError(404, "Recipe version not found");
    if (versionRow.status !== "draft") {
      throw new HttpError(409, `Recipe version must be in draft status to activate (was ${versionRow.status})`);
    }
    const testResult = versionRow.test_result_json as { status?: string } | null;
    if (testResult?.status !== "succeeded") {
      throw new HttpError(409, "Recipe version must pass a dry-run before activation");
    }

    const envelope: SourcePolicyEnvelope = protocol.SourcePolicyEnvelopeSchema.parse(
      versionRow.policy_envelope_json,
    );
    const settings = await new PgCustomSourceHandlerRepository(this.pool, this.config).getEffectiveSettings(identity);
    const activeVersionId = connection.active_recipe_version_id;
    const activeRow = activeVersionId
      ? await getSourceRecipeVersion(this.pool, identity.spaceId, connectionId, activeVersionId)
      : null;
    const activeEnvelope = activeRow
      ? protocol.SourcePolicyEnvelopeSchema.parse(activeRow.policy_envelope_json)
      : null;

    // The recipe envelope is the shared subset of the Level 3 envelope; the
    // capability/language fields the evaluator also inspects are simply
    // absent (never true) for recipes, so the shared delta logic applies.
    const evaluation = evaluateCustomSourceActivation(envelope as unknown as CustomSourcePolicyEnvelope, {
      activeEnvelope: activeEnvelope as unknown as CustomSourcePolicyEnvelope | null,
      spaceAllowedDomains: settings.space.allowed_domains,
      credentialedSourcesAllowed: settings.space.credentialed_sources_allowed,
      spaceDefaultCapturePolicy: settings.space.default_capture_policy,
      spaceDefaultRetentionPolicy: settings.space.default_retention_policy,
    });

    if (!evaluation.withinEnvelope) {
      const created = await withDbTransaction(this.pool, async (client) => {
        const payload: Record<string, unknown> = {
          proposal_type: "source_recipe_activation",
          source_connection_id: connectionId,
          recipe_version_id: versionId,
          current_recipe_version_id: activeVersionId,
          current_policy_envelope_json: activeEnvelope,
          proposed_policy_envelope_json: envelope,
          envelope_diff_json: { deltas: evaluation.deltas },
          requested_by_user_id: identity.userId,
          proposed_content: recipeProposalReviewText(connectionId, versionId, evaluation.deltas, envelope),
        };
        if (body.next_check_at !== undefined) payload.next_check_at = body.next_check_at;
        if (body.schedule_rule !== undefined) payload.schedule_rule = body.schedule_rule;
        const proposal = await insertProposalRow(client, {
          spaceId: identity.spaceId,
          proposalType: "source_recipe_activation",
          title: "Approve Source recipe activation",
          summary: `Source recipe requires approval: ${evaluation.deltas.join("; ")}`,
          payload,
          rationale: "Activating this Source recipe would broaden the approved policy envelope.",
          createdByUserId: identity.userId,
          visibility: "space_shared",
          riskLevel: envelope.credential_ref && !settings.space.credentialed_sources_allowed ? "high" : "medium",
          requiredApproverRole: "owner",
        });
        const updatedVersion = await client.query<RecipeVersionRow>(
          `UPDATE source_recipe_versions
              SET status = 'pending_approval', proposal_id = $3
            WHERE id = $1 AND space_id = $2 AND status = 'draft'
            RETURNING ${RECIPE_VERSION_COLUMNS}`,
          [versionId, identity.spaceId, proposal.id],
        );
        const row = updatedVersion.rows[0];
        if (!row) throw new HttpError(409, "Recipe version is no longer eligible for activation approval");
        return { proposal, version: row };
      });
      return {
        status: "pending_approval" as const,
        deltas: evaluation.deltas,
        proposal_id: created.proposal.id,
        recipe_version: recipeVersionOut(created.version),
      };
    }

    await withDbTransaction(this.pool, (client) =>
      activateSourceRecipeVersionTx(client, {
        spaceId: identity.spaceId,
        connectionId,
        versionId,
        previousActiveVersionId: activeVersionId,
        nextCheckAt: body.next_check_at,
        scheduleRule: body.schedule_rule,
      }),
    );
    const activated = await getSourceRecipeVersion(this.pool, identity.spaceId, connectionId, versionId);
    if (!activated) throw new HttpError(500, "Recipe version disappeared immediately after activation");
    return {
      status: "active" as const,
      deltas: [],
      proposal_id: null,
      recipe_version: recipeVersionOut(activated),
    };
  }

  // --- internals ---

  private async requireCreatorAndDomain(
    identity: SpaceUserIdentity,
    endpointUrl: string,
    body: Record<string, unknown>,
  ) {
    const endpointOrigin = originOf(endpointUrl);
    if (!endpointOrigin) throw new HttpError(422, "endpoint_url must be a valid HTTP(S) URL");
    const settingsRepo = new PgCustomSourceHandlerRepository(this.pool, this.config);
    const settings = await settingsRepo.getEffectiveSettings(identity);
    await settingsRepo.requireCustomSourceCreator(identity, settings.space.creator_roles);
    const hostname = new URL(endpointUrl).hostname;
    if (
      settings.space.allowed_domains.length > 0 &&
      !settings.space.allowed_domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
    ) {
      throw new HttpError(422, `Domain not allowed by Space Custom Source policy: ${hostname}`);
    }
    const credentialId = optionalString(body.credential_id);
    if (credentialId) {
      await new CustomSourceCredentialService(this.pool, this.config).requireOwnCredential(identity, credentialId);
    }
    return { settings, endpointOrigin };
  }

  private buildEnvelope(
    identity: SpaceUserIdentity,
    body: Record<string, unknown>,
    settings: Awaited<ReturnType<PgCustomSourceHandlerRepository["getEffectiveSettings"]>>,
    endpointOrigin: string,
  ): SourcePolicyEnvelope {
    return {
      allowed_network_origins: [endpointOrigin],
      capture_policy: requireCapturePolicy(optionalString(body.capture_policy) ?? settings.space.default_capture_policy),
      retention_policy: requireRetentionPolicy(optionalString(body.retention_policy) ?? settings.space.default_retention_policy),
      credential_ref: optionalString(body.credential_id) ?? null,
      log_redaction_enabled: true,
      limits: {
        timeout_ms: Math.min(30_000, settings.runner.timeout_ms_max),
        max_download_bytes: settings.runner.download_bytes_max,
        max_output_bytes: Math.min(1_048_576, settings.runner.output_bytes_max),
        max_files: Math.min(10, settings.runner.max_files),
        max_items: 50,
        max_evidence_items: 50,
        log_max_bytes: Math.min(65_536, settings.runner.log_bytes_max),
      },
    };
  }

  private buildPlannedRecipe(sourceType: PlannedSourceType, listSelector: string | null | undefined) {
    try {
      return buildRecipeForSourceType(sourceType, { listSelector });
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
  }

  private async requireRecipeConnection(identity: SpaceUserIdentity, connectionId: string) {
    const result = await this.pool.query<{
      id: string;
      endpoint_url: string | null;
      active_recipe_version_id: string | null;
      handler_kind: string;
    }>(
      `SELECT sc.id, ch.endpoint_url, sc.active_recipe_version_id, sc.handler_kind
         FROM source_connections sc
         JOIN source_channels ch ON ch.source_connection_id = sc.id AND ch.status <> 'archived'
        WHERE sc.space_id = $1 AND sc.id = $2 AND sc.deleted_at IS NULL
        ORDER BY ch.updated_at DESC LIMIT 1`,
      [identity.spaceId, connectionId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Source connection not found");
    if (row.handler_kind !== "recipe") throw new HttpError(422, "Source connection is not a recipe source");
    return row;
  }
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function requireCapturePolicy(value: string): SourceCapturePolicy {
  const parsed = parseSourceCapturePolicy(value);
  if (!parsed) throw new HttpError(422, "Unsupported Source Recipe capture policy");
  return parsed;
}

function requireRetentionPolicy(value: string): SourceRetentionPolicy {
  const parsed = parseSourceRetentionPolicy(value);
  if (!parsed) throw new HttpError(422, "Unsupported Source Recipe retention policy");
  return parsed;
}

function recipeProposalReviewText(
  connectionId: string,
  versionId: string,
  deltas: string[],
  envelope: SourcePolicyEnvelope,
): string {
  return [
    `Connection: ${connectionId}`,
    `Recipe version: ${versionId}`,
    "",
    "Approval is required for these policy-envelope changes:",
    ...deltas.map((delta) => `- ${delta}`),
    "",
    "Proposed envelope:",
    `- network origins: ${envelope.allowed_network_origins.join(", ") || "none"}`,
    `- capture policy: ${envelope.capture_policy}`,
    `- retention policy: ${envelope.retention_policy}`,
    `- credential ref: ${envelope.credential_ref ?? "none"}`,
    `- limits: ${JSON.stringify(envelope.limits)}`,
  ].join("\n");
}
