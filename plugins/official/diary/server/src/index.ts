import type {
  AgentSpacePlugin,
  PluginHostContext,
} from "@agent-space/protocol";
import type { FastifyInstance } from "fastify";
import { registerDiaryRoutes } from "./routes.js";
import { JOB_TYPE_DIARY_REFLECTION, buildDiaryReflectionHandler } from "./jobs.js";
import { buildDiaryDailyPromptTask } from "./scheduler.js";
import { diaryMigrations } from "./schema.js";
import {
  DIARY_PLUGIN_ID,
  DIARY_PLUGIN_VERSION,
} from "./manifest.js";

export const diaryPlugin: AgentSpacePlugin = {
  id: DIARY_PLUGIN_ID,
  version: DIARY_PLUGIN_VERSION,
  migrations: diaryMigrations,

  activate(ctx: PluginHostContext) {
    const fastify = ctx.fastify as FastifyInstance;
    const db = ctx.db;

    registerDiaryRoutes(fastify, db, ctx);
    ctx.jobs.register(
      JOB_TYPE_DIARY_REFLECTION,
      buildDiaryReflectionHandler(db, DIARY_PLUGIN_ID),
    );
    ctx.scheduler.register(buildDiaryDailyPromptTask(db, DIARY_PLUGIN_ID));
    return { activated: true };
  },
};
