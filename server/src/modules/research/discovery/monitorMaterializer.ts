import type {
  MaterializeResearchQueryStrategyResponse,
  ResearchCompiledQuery,
  ResearchProviderKey,
} from "@rainver/protocol";
import * as protocol from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { assertProjectWriter } from "../../projects/access.js";
import { ProjectSourceBindingService } from "../../projects/projectSourceBindingService.js";
import {
  HttpError,
  type Queryable,
  type SpaceUserIdentity,
  withQueryableTransaction,
} from "../../routeUtils/common.js";
import { SourceChannelService } from "../../sources/channels/sourceChannelService.js";
import { ResearchStrategyActivationService, type ResearchStrategyActivationReason } from "./strategyActivationService.js";

interface SelectedAttemptRow {
  provider_key: string;
  attempt_id: string;
  compiled_query_json: unknown;
}

interface MaterializedRow {
  provider_key: string;
  research_query_attempt_id: string;
  source_channel_id: string;
  project_source_binding_id: string;
  query_fingerprint: string;
}

export class ResearchMonitorMaterializer {
  constructor(private readonly db: Queryable, private readonly config: ServerConfig) {}

  async materialize(
    identity: SpaceUserIdentity,
    strategyId: string,
    input: {
      providerKeys: ResearchProviderKey[];
      credentials?: Partial<Record<ResearchProviderKey, string>>;
      activationReason?: ResearchStrategyActivationReason;
      proposalId?: string | null;
    },
  ): Promise<MaterializeResearchQueryStrategyResponse> {
    const requested = [...new Set(input.providerKeys)];
    if (requested.length === 0) throw new HttpError(422, "At least one provider must be materialized");
    return withQueryableTransaction(this.db, async (tx) => {
      const strategy = await tx.query<{ project_id: string; status: string }>(
        `SELECT project_id,status
           FROM research_query_strategies
          WHERE id=$1 AND space_id=$2
          FOR UPDATE`,
        [strategyId, identity.spaceId],
      );
      const strategyRow = strategy.rows[0];
      if (!strategyRow) throw new HttpError(404, "Research query strategy not found");
      await assertProjectWriter(tx, identity.spaceId, strategyRow.project_id, identity.userId);
      if (!['selected', 'materialized'].includes(strategyRow.status)) {
        throw new HttpError(409, "Research query strategy has no selected query to materialize");
      }
      const attempts = await tx.query<SelectedAttemptRow>(
        `SELECT p.provider_key,s.attempt_id,a.compiled_query_json
           FROM research_query_provider_plans p
           JOIN research_query_provider_selections s ON s.provider_plan_id=p.id AND s.space_id=p.space_id
           JOIN research_query_attempts a ON a.id=s.attempt_id AND a.space_id=s.space_id
          WHERE p.strategy_id=$1 AND p.space_id=$2 AND p.provider_key=ANY($3::text[])
          ORDER BY p.created_at,p.provider_key
          FOR SHARE OF p,a`,
        [strategyId, identity.spaceId, requested],
      );
      const found = new Set(attempts.rows.map((row) => row.provider_key));
      const missing = requested.filter((provider) => !found.has(provider));
      if (missing.length > 0) {
        throw new HttpError(422, `No selected query is available for: ${missing.join(", ")}`);
      }

      const sources: MaterializedRow[] = [];
      for (const attempt of attempts.rows) {
        const providerKey = protocol.ResearchProviderKeySchema.parse(attempt.provider_key);
        const compiledQuery = protocol.ResearchCompiledQuerySchema.parse(attempt.compiled_query_json) as ResearchCompiledQuery;
        const channel = await new SourceChannelService(tx, this.config).createFromSelectedResearchAttempt(identity, {
          attemptId: attempt.attempt_id,
          providerKey,
          compiledQuery,
          credentialId: input.credentials?.[providerKey],
        });
        const channelId = String(channel.id);
        const bindingKey = `research-query:${attempt.attempt_id}`;
        const existingBinding = await tx.query<{ id: string }>(
          `SELECT id FROM project_source_bindings
            WHERE space_id=$1 AND project_id=$2 AND source_channel_id=$3
              AND binding_key=$4 AND status <> 'archived'
            LIMIT 1`,
          [identity.spaceId, strategyRow.project_id, channelId, bindingKey],
        );
        const binding = existingBinding.rows[0] ?? await new ProjectSourceBindingService(tx).createBinding(identity, {
          project_id: strategyRow.project_id,
          source_channel_id: channelId,
          binding_key: bindingKey,
          delivery_scope: "project_members",
          extraction_policy: { mode: "metadata_and_text", full_text: true },
        });
        sources.push({
          provider_key: providerKey,
          research_query_attempt_id: attempt.attempt_id,
          source_channel_id: channelId,
          project_source_binding_id: String(binding.id),
          query_fingerprint: compiledQuery.fingerprint,
        });
      }
      await tx.query(
        `UPDATE research_query_strategies
            SET status='materialized',materialized_at=COALESCE(materialized_at,$3)
          WHERE id=$1 AND space_id=$2`,
        [strategyId, identity.spaceId, new Date().toISOString()],
      );
      await new ResearchStrategyActivationService(tx).activate({
        identity,
        strategyId,
        reason: input.activationReason ?? "initial",
        proposalId: input.proposalId,
      });
      return protocol.MaterializeResearchQueryStrategyResponseSchema.parse({
        query_strategy_id: strategyId,
        project_id: strategyRow.project_id,
        status: "materialized",
        sources,
      });
    });
  }
}
