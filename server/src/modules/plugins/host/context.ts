/**
 * PluginHostContextImpl — concrete PluginHostContext passed to each plugin's activate() call.
 *
 * Wraps job handlers and proposal appliers with enablement gating. Scheduler
 * tasks are passed through because user-scoped tasks fan out to enabled users
 * internally.
 *
 * The http port delegates to server-internal helpers so plugins never need to
 * import server/src/modules directly.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerConfig } from "../../../config.js";
import type {
  AgentSpacePlugin,
  PluginHostContext,
  PluginHttpPort,
  PluginJobHandler,
  PluginJobPort,
  PluginProposalApplier,
  PluginProposalPort,
  PluginScheduledTask,
  PluginSchedulerPort,
  Queryable,
  ResolvedIdentity,
} from "@agent-space/protocol";
import type { JobEnvelopeForHandler, JobHandler } from "../../jobs/handlerRegistry.js";
import type { ScheduledTask } from "../../scheduler/registry.js";
import type { ProposalApplier, ProposalApplyContext, ProposalApplyResult } from "../../proposals/applierRegistry.js";
import { getDbPool } from "../../../db/pool.js";
import { resolveIdentity, sendRouteError, jsonBody } from "../../routeUtils/common.js";
import { requireOfficialPluginEnabled } from "../guards.js";
import { PgJobQueueRepository } from "../../jobs/repository.js";
import { pluginService } from "../service.js";

export type PluginRouteFn = (app: FastifyInstance) => void;

export interface PluginContributions {
  pluginId: string;
  routeFns: PluginRouteFn[];
  jobHandlers: Array<{ jobType: string; handler: JobHandler }>;
  schedulerTasks: ScheduledTask[];
  proposalAppliers: Array<{ proposalType: string; applier: ProposalApplier }>;
}

export class PluginHostContextImpl implements PluginHostContext {
  readonly pluginId: string;
  readonly fastify: FastifyInstance;
  readonly db: Queryable;
  readonly config: ServerConfig;

  private readonly _dbUrl: string;
  private readonly _contributions: PluginContributions;

  constructor(plugin: AgentSpacePlugin, fastify: FastifyInstance, config: ServerConfig) {
    this.pluginId = plugin.id;
    this.fastify = fastify;
    this.db = config.databaseUrl
      ? getDbPool(config.databaseUrl)
      : { query: async () => ({ rows: [], rowCount: 0 }) };
    this.config = config;
    this._dbUrl = config.databaseUrl ?? "";
    this._contributions = {
      pluginId: plugin.id,
      routeFns: [],
      jobHandlers: [],
      schedulerTasks: [],
      proposalAppliers: [],
    };
  }

  getContributions(): PluginContributions {
    return this._contributions;
  }

  async isEnabled(spaceId: string | null, userId: string | null): Promise<boolean> {
    if (!this._dbUrl) return false;
    const db = getDbPool(this._dbUrl);
    const result = await pluginService.isEnabled(db, this.pluginId, spaceId ?? "", userId);
    return result.enabled;
  }

  readonly http: PluginHttpPort = {
    resolveIdentity: async (request, reply): Promise<ResolvedIdentity | null> => {
      return resolveIdentity(
        this.config,
        request as FastifyRequest,
        reply as FastifyReply,
      );
    },

    pluginGuard: async (request, reply): Promise<ResolvedIdentity | null> => {
      const identity = await resolveIdentity(
        this.config,
        request as FastifyRequest,
        reply as FastifyReply,
      );
      if (!identity) return null;
      const allowed = await requireOfficialPluginEnabled(
        this.config,
        request as FastifyRequest,
        reply as FastifyReply,
        { pluginId: this.pluginId, spaceId: identity.spaceId, userId: identity.userId },
      );
      if (!allowed) return null;
      return identity;
    },

    sendError: (reply, err): void => {
      sendRouteError(reply as FastifyReply, err);
    },

    parseJsonBody: (request): Record<string, unknown> => {
      return jsonBody(request as FastifyRequest);
    },
  };

  readonly jobs: PluginJobPort = {
    register: (jobType: string, handler: PluginJobHandler): void => {
      const pluginId = this.pluginId;
      const dbUrl = this._dbUrl;

      const wrapped: JobHandler = async (envelope: JobEnvelopeForHandler) => {
        if (dbUrl) {
          const db = getDbPool(dbUrl);
          const { enabled } = await pluginService.isEnabled(
            db,
            pluginId,
            envelope.space_id ?? "",
            envelope.user_id,
          );
          if (!enabled) {
            return { skipped: true, reason: "plugin_disabled" };
          }
        }
        return handler({
          job_id: envelope.job_id,
          job_type: envelope.job_type,
          payload: envelope.payload,
          attempt_number: envelope.attempts,
        });
      };

      this._contributions.jobHandlers.push({ jobType, handler: wrapped });
    },

    enqueue: async (jobType, payload, opts): Promise<{ jobId: string }> => {
      if (!this._dbUrl) throw new Error("Database not configured — cannot enqueue job");
      const db = getDbPool(this._dbUrl);
      const queue = new PgJobQueueRepository(db);
      const job = await queue.enqueue({
        job_type: jobType,
        payload,
        space_id: opts?.spaceId ?? "",
        user_id: opts?.userId ?? "",
      });
      return { jobId: job.id };
    },
  };

  readonly scheduler: PluginSchedulerPort = {
    register: (task: PluginScheduledTask): void => {
      this._contributions.schedulerTasks.push({
        name: task.name,
        intervalSeconds: task.intervalSeconds,
        runOnStart: task.runOnStart,
        run: task.run,
      });
    },
  };

  readonly proposals: PluginProposalPort = {
    register: (proposalType: string, applier: PluginProposalApplier): void => {
      const pluginId = this.pluginId;
      const dbUrl = this._dbUrl;

      const wrapped: ProposalApplier = async (ctx: ProposalApplyContext): Promise<ProposalApplyResult> => {
        if (dbUrl) {
          const db = getDbPool(dbUrl);
          const { enabled } = await pluginService.isEnabled(
            db,
            pluginId,
            ctx.proposal.space_id,
            ctx.userId,
          );
          if (!enabled) {
            throw new Error(
              `plugin ${pluginId} is disabled — cannot apply proposal type ${proposalType}`,
            );
          }
        }
        await applier({
          proposal: {
            id: ctx.proposal.id,
            proposal_type: ctx.proposal.proposal_type,
            space_id: ctx.proposal.space_id,
            user_id: ctx.userId,
            payload: ctx.proposal.payload_json ?? {},
          },
          db: ctx.db,
          config: ctx.config,
        });
        return { result_type: "knowledge_item" as const, result: { plugin_id: pluginId, proposal_type: proposalType } };
      };

      this._contributions.proposalAppliers.push({ proposalType, applier: wrapped });
    },
  };
}
