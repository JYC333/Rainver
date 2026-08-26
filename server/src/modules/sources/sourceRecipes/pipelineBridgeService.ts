import type {
  CustomSourcePolicyEnvelope,
  SourcePolicyEnvelope,
} from "@agent-space/protocol";
import * as protocol from "@agent-space/protocol";
import type { ServerConfig } from "../../../config.js";
import {
  HttpError,
  objectValue,
  optionalString,
  withDbTransaction,
  type Pool,
  type SpaceUserIdentity,
} from "../../routeUtils/common.js";
import { SourceChannelService } from "../channels/sourceChannelService.js";
import { connectionColumnsForAlias, type SourceChannelConnectionRow } from "../sourceRepositoryRows.js";
import { PgCustomSourceHandlerRepository } from "../customSources/customSourceHandlerRepository.js";
import { analyzeSourceRecipe } from "./primitiveRegistry.js";
import { recipeFromPipelineDefinition } from "./recipeInterpreter.js";
import {
  insertSourceRecipeVersion,
  recipeVersionOut,
} from "./recipeVersionStore.js";

/**
 * Phase 7 compatibility bridge: existing `declarative_pipeline_v1` handler
 * versions remain readable/debuggable as Level 3 history, but an operator can
 * explicitly wrap one as a Level 2 recipe source. The bridge creates a new
 * paused recipe connection and draft recipe version; activation still requires
 * the normal recipe dry-run/activate path.
 */
export class SourceRecipePipelineBridgeService {
  constructor(
    private readonly pool: Pool,
    private readonly config: ServerConfig,
  ) {}

  async bridgePipelineHandler(identity: SpaceUserIdentity, sourceConnectionId: string, body: Record<string, unknown>) {
    const sourceConnection = await this.requireGeneratedCustomConnection(identity, sourceConnectionId);
    const handlerVersionId = optionalString(body.handler_version_id) ?? sourceConnection.active_handler_version_id;
    if (!handlerVersionId) {
      throw new HttpError(422, "handler_version_id is required when the source has no active pipeline handler version");
    }

    const handlerRepo = new PgCustomSourceHandlerRepository(this.pool, this.config);
    const handlerVersion = await handlerRepo.getHandlerVersion(identity, sourceConnectionId, handlerVersionId);
    if (!handlerVersion) throw new HttpError(404, "Handler version not found");
    if (handlerVersion.language !== "declarative_pipeline_v1") {
      throw new HttpError(422, "Only declarative_pipeline_v1 handler versions can be bridged into a recipe source");
    }

    const manifest = objectValue(handlerVersion.manifest_json);
    const parsedPipeline = protocol.CustomSourcePipelineDefinitionSchema.safeParse(manifest.pipeline);
    if (!parsedPipeline.success) {
      throw new HttpError(422, "Handler version has no valid declarative pipeline manifest");
    }
    const recipe = recipeFromPipelineDefinition(parsedPipeline.data);
    const parsedRecipe = protocol.SourceRecipeDefinitionSchema.safeParse(recipe);
    if (!parsedRecipe.success) {
      throw new HttpError(422, "Pipeline manifest cannot be represented as a Source recipe");
    }
    const parsedEnvelope = protocol.CustomSourcePolicyEnvelopeSchema.safeParse(handlerVersion.policy_envelope_json);
    if (!parsedEnvelope.success) {
      throw new HttpError(422, "Handler version has no valid Custom Source policy envelope");
    }
    const customEnvelope = parsedEnvelope.data as CustomSourcePolicyEnvelope;
    if (customEnvelope.language !== "declarative_pipeline_v1") {
      throw new HttpError(422, "Handler version policy envelope is not a declarative pipeline envelope");
    }
    const policyEnvelope = sourcePolicyEnvelopeFromCustom(customEnvelope);
    const analysis = analyzeSourceRecipe(parsedRecipe.data);
    for (const liveUrl of analysis.live_fetch_urls) {
      const origin = originOf(liveUrl);
      if (!origin || !policyEnvelope.allowed_network_origins.includes(origin)) {
        throw new HttpError(422, `pipeline fetches an origin outside the approved handler envelope: ${liveUrl}`);
      }
    }

    const bridgedName = optionalString(body.name) ?? `${sourceConnection.name} (Recipe)`;
    const bridgedConfig = {
      ...objectValue(sourceConnection.config_json),
      bridged_from: {
        source_connection_id: sourceConnection.id,
        handler_version_id: handlerVersion.id,
        handler_language: handlerVersion.language,
        handler_version_number: handlerVersion.version_number,
      },
      source_type: "pipeline_bridge",
    };

    return withDbTransaction(this.pool, async (client) => {
      const channels = new SourceChannelService(client, this.config);
      const channel = await channels.create(
        identity,
        {
          provider_key: "custom_source",
          name: bridgedName,
          // Keep the underlying governed connection distinct from the source
          // channel.  `name` is the channel label, while `source_name` is the
          // connection identity used by the connection uniqueness rule.
          source_name: bridgedName,
          endpoint_url: sourceConnection.endpoint_url,
          credential_id: sourceConnection.credential_id,
          fetch_frequency: optionalString(body.fetch_frequency) ?? sourceConnection.fetch_frequency,
          next_check_at: optionalString(body.next_check_at),
          schedule_rule: body.schedule_rule ?? sourceConnection.schedule_rule_json,
          capture_policy: policyEnvelope.capture_policy,
          trust_level: sourceConnection.trust_level,
          topic_hints: Array.isArray(sourceConnection.topic_hints_json) ? sourceConnection.topic_hints_json : undefined,
          consent: sourceConnection.consent_json,
          policy: {
            ...objectValue(sourceConnection.policy_json),
            retention_policy: policyEnvelope.retention_policy,
          },
          config: bridgedConfig,
          status: "paused",
          _initial_status: "paused",
          _force_create: true,
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
        recipe: parsedRecipe.data,
        policyEnvelope,
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
          config_json: bridgedConfig,
        },
        recipe_version: recipeVersionOut(version),
        bridged_from_connection_id: sourceConnection.id,
        bridged_from_handler_version_id: handlerVersion.id,
      };
    });
  }

  private async requireGeneratedCustomConnection(identity: SpaceUserIdentity, connectionId: string): Promise<SourceChannelConnectionRow> {
    const result = await this.pool.query<SourceChannelConnectionRow>(
      `SELECT ${connectionColumnsForAlias("sc")},
              ch.id AS source_channel_id, ch.endpoint_url, ch.fetch_frequency, ch.schedule_rule_json
         FROM source_connections sc
         JOIN source_channels ch ON ch.source_connection_id = sc.id AND ch.status <> 'archived'
        WHERE sc.space_id = $1 AND sc.id = $2 AND sc.deleted_at IS NULL`,
      [identity.spaceId, connectionId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Source connection not found");
    if (row.handler_kind !== "generated_custom") {
      throw new HttpError(422, "Only generated Custom Source connections can be bridged");
    }
    return row;
  }
}

function sourcePolicyEnvelopeFromCustom(envelope: CustomSourcePolicyEnvelope): SourcePolicyEnvelope {
  return {
    allowed_network_origins: envelope.allowed_network_origins,
    capture_policy: envelope.capture_policy,
    retention_policy: envelope.retention_policy,
    credential_ref: envelope.credential_ref ?? null,
    log_redaction_enabled: envelope.log_redaction_enabled ?? true,
    limits: envelope.limits,
  };
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
