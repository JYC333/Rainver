import type { FastifyInstance } from "fastify";
import type { Queryable, PluginHostContext } from "@agent-space/protocol";
import { diaryRepository } from "./domain/repository.js";
import { JOB_TYPE_DIARY_REFLECTION } from "./jobs.js";

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s || null;
}

export function registerDiaryRoutes(
  app: FastifyInstance,
  db: Queryable,
  ctx: PluginHostContext,
): void {
  app.get("/api/v1/diary/today", async (request, reply) => {
    try {
      const identity = await ctx.http.pluginGuard(request, reply);
      if (!identity) return;
      const today = new Date().toISOString().slice(0, 10);
      const entry = await diaryRepository.findEntry(db, identity.userId, today);
      reply.send({ date: today, entry: entry ?? null });
    } catch (err) {
      ctx.http.sendError(reply, err);
    }
  });

  app.put("/api/v1/diary/entries/:date", async (request, reply) => {
    try {
      const identity = await ctx.http.pluginGuard(request, reply);
      if (!identity) return;

      const date = (request.params as Record<string, string>)["date"];
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        reply.code(400).send({ detail: "date must be YYYY-MM-DD" });
        return;
      }

      const body = ctx.http.parseJsonBody(request);
      const content = optionalString(body["content"]) ?? "";

      const entry = await diaryRepository.upsertEntry(db, {
        userId: identity.userId,
        entryDate: date,
        content,
      });

      if (await diaryRepository.isAiReflectionEnabled(db, ctx.pluginId, identity.userId)) {
        try {
          await ctx.jobs.enqueue(
            JOB_TYPE_DIARY_REFLECTION,
            { user_id: identity.userId, entry_id: entry.id, entry_date: date },
            { spaceId: identity.spaceId, userId: identity.userId },
          );
        } catch {
          // reflection job failure must not fail the save
        }
      }

      reply.code(200).send({ entry });
    } catch (err) {
      ctx.http.sendError(reply, err);
    }
  });

  app.delete("/api/v1/diary/entries/:date", async (request, reply) => {
    try {
      const identity = await ctx.http.pluginGuard(request, reply);
      if (!identity) return;

      const date = (request.params as Record<string, string>)["date"];
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        reply.code(400).send({ detail: "date must be YYYY-MM-DD" });
        return;
      }

      const deleted = await diaryRepository.deleteEntry(db, identity.userId, date);
      reply.code(200).send({ deleted });
    } catch (err) {
      ctx.http.sendError(reply, err);
    }
  });

  app.get("/api/v1/diary/entries", async (request, reply) => {
    try {
      const identity = await ctx.http.pluginGuard(request, reply);
      if (!identity) return;

      const query = request.query as Record<string, string>;
      const limit = Math.min(100, parseInt(query["limit"] ?? "30", 10) || 30);
      const before = optionalString(query["before"] ?? null) ?? undefined;

      const entries = await diaryRepository.listEntries(db, identity.userId, limit, before);
      reply.send({ entries });
    } catch (err) {
      ctx.http.sendError(reply, err);
    }
  });

  app.get("/api/v1/diary/on-this-day", async (request, reply) => {
    try {
      const identity = await ctx.http.pluginGuard(request, reply);
      if (!identity) return;

      const query = request.query as Record<string, string>;
      const date = optionalString(query["date"] ?? null) ?? new Date().toISOString().slice(0, 10);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        reply.code(400).send({ detail: "date must be YYYY-MM-DD" });
        return;
      }

      const entries = await diaryRepository.findOnThisDay(db, identity.userId, date);
      reply.send({ date, entries });
    } catch (err) {
      ctx.http.sendError(reply, err);
    }
  });

  app.get("/api/v1/diary/entries/:date/reflections", async (request, reply) => {
    try {
      const identity = await ctx.http.pluginGuard(request, reply);
      if (!identity) return;

      const date = (request.params as Record<string, string>)["date"];
      const entry = await diaryRepository.findEntry(db, identity.userId, date ?? "");
      if (!entry) {
        reply.code(404).send({ detail: "entry not found" });
        return;
      }

      const reflections = await diaryRepository.findReflectionsForEntry(db, entry.id);
      reply.send({ entry_date: date, reflections });
    } catch (err) {
      ctx.http.sendError(reply, err);
    }
  });
}
