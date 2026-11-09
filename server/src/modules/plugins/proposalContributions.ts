import { z } from 'zod';
import { OperationActorSchema, type RainverPlugin, type PluginOperationManifest } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import type { ProposalApplier, ProposalApplierContributor } from '../proposals/applierRegistry.js';
import { insertProposalRow } from '../proposals/reviewPackets.js';
import { withPluginDb } from './operationDb.js';
import { pluginServiceFor } from './service.js';
import type { PluginBackground } from './background.js';
const contributors = new WeakMap<ServerConfig, ProposalApplierContributor>();
/** Canonical host contributions must also be present on Agent decision calls without a route context. */
export function registerPluginProposalContributor(config: ServerConfig, contributor: ProposalApplierContributor) {
  contributors.set(config, contributor);
  return () => contributors.delete(config);
}
export function pluginProposalContributor(config: ServerConfig) {
  return contributors.get(config);
}
export function proposalApproval(manifest: PluginOperationManifest, operation: string): OperationRegistration['approval'] {
  const spec = manifest.proposalTypes?.find(t => t.operation === operation);
  if (!spec) return undefined;
  const op = manifest.operations.find(o => o.id === operation)!;
  return {
    proposalType: spec.id,
    gate: {
      kind: 'hard_gate',
      gate_class: op.gate_class!
    },
    mode: 'proposal_submission',
    atomicStatusWritersVerified: true,
    async preconditions() {
      return {
        manifest_version: manifest.version
      };
    },
    async create(db, input, actor) {
      spec.payload_schema.parse(input);
      const row = await insertProposalRow(db, {
        spaceId: actor.space_id,
        proposalType: spec.id,
        title: op.title,
        rationale: op.description,
        payload: {
          proposal_type: spec.id,
          input,
          requester: actor
        },
        createdByUserId: actor.on_behalf_of_user_id,
        ownerUserId: actor.on_behalf_of_user_id,
        createdByAgentId: actor.agent_id,
        createdByRunId: actor.run_id,
        visibility: 'private',
        riskLevel: 'low'
      });
      return row.id;
    }
  };
}
export function pluginProposalContributions(config: ServerConfig, plugin: RainverPlugin, background: PluginBackground) {
  return (plugin.operationManifest!.proposalTypes ?? []).map(spec => {
    const payloadSchema = z.object({
      proposal_type: z.literal(spec.id),
      input: spec.payload_schema,
      requester: OperationActorSchema
    }).strict();
    const applier: ProposalApplier = async context => {
      const payload = payloadSchema.parse(context.proposal.payload_json);
      const apply = background.proposalExecutors.get(spec.id);
      if (!apply) throw new Error('Plugin applier unavailable');
      const actor = payload.requester;
      const settings = (await pluginServiceFor(config).getPlugin(context.db, plugin.id, actor.space_id, actor.on_behalf_of_user_id!)).effective.settings;
      const result = await withPluginDb(context.db, plugin.id, actor, db => apply(payload.input, {
        db,
        actor,
        settings,
        jobs: background.intents(db, {
          spaceId: actor.space_id,
          userId: actor.on_behalf_of_user_id!
        })
      }));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid plugin proposal output');
      return {
        result_type: 'plugin_proposal',
        result: result as Record<string, unknown>
      };
    };
    return {
      proposalType: spec.id,
      applier,
      payloadSchema
    };
  });
}
