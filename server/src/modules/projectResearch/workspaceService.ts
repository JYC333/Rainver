import { randomUUID } from "node:crypto";
import { HttpError, objectValue, optionalString, type Queryable, type SpaceUserIdentity, withQueryableTransaction } from "../routeUtils/common";
import { assertProjectReadable, assertProjectWriter, canWriteProject, lockActiveProjectForMutation } from "../projects/access";
import { ProjectCorpusRepository } from "../projects/corpusRepository";
import { sourceItemReadableClause } from "../sources/sourceItemAccess";
import type { ServerConfig } from "../../config";
import { ProjectResearchExecutionProfileService } from "./executionProfileService";
import { PgRunRepository } from "../runs/repository";
import { PgJobQueueRepository } from "../jobs/repository";
import { RunOrchestrationService } from "../runs/orchestrationService";
import { PgSessionRepository } from "../sessions/repository";
import { createManagedExecutionPolicy } from "../policy/managedExecutionPolicy";
import { markdownToPm, normalizePmText, pmBlocksText } from "../knowledge/noteDocument";
import {
  applyNoteOpsWithConflictFallback,
  insertInitialNoteRevision,
  sha256,
  writeNote,
} from "../knowledge/noteRevisionService";
import { NOTEBOOK_SECTION_KEYS, SECTION_LABELS, resolveProjectNoteByTitle, type SectionKey } from "./notebookNotes";

export { NOTEBOOK_SECTION_KEYS, SECTION_LABELS };

/**
 * D6: ad-hoc analysis has its own small budget lane, independent of the
 * project research operation budget. Enforced per project per UTC day.
 */
export const RESEARCH_ADHOC_DAILY_RUN_LIMIT = 20;

// `type: [X, "null"]` is valid JSON Schema, but not every provider's
// structured-output validator accepts a type array (MiniMax's rejects it
// outright with a 400 "mismatched type" parse error) — `anyOf` is the
// portable way to express a nullable field across providers.
const NOTEBOOK_OP_ITEM_SCHEMA = {
  type: "object",
  properties: {
    op: { enum: ["append", "insert", "replace", "delete"] },
    index: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
    count: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    markdown: { anyOf: [{ type: "string", maxLength: 20_000 }, { type: "null" }] },
  },
  required: ["op", "index", "count", "markdown"],
  additionalProperties: false,
} as const;

// Target is pinned by the run's own contract_snapshot (one note per ad-hoc
// run), so the model only needs to describe the edit, not restate the target.
const ADHOC_OUTPUT_CONTRACT = {
  type: "json_schema",
  schema_id: "research.adhoc_analyze.v3",
  strict: true,
  stage: "research_adhoc",
  schema: {
    type: "object",
    properties: {
      notebook_update: {
        type: "object",
        properties: {
          ops: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: NOTEBOOK_OP_ITEM_SCHEMA,
          },
          refs: { type: "array", items: { type: "string" } },
        },
        required: ["ops", "refs"],
        additionalProperties: false,
      },
    },
    required: ["notebook_update"],
    additionalProperties: false,
  },
} as const;

// Freeform note targeting: the model picks an existing note by id from the
// list given in the prompt, or leaves note_id null and names a new note.
const NOTEBOOK_CHAT_OUTPUT_CONTRACT = {
  type: "json_schema",
  schema_id: "research.notebook_chat.v2",
  strict: true,
  stage: "research_notebook_chat",
  schema: {
    type: "object",
    properties: {
      answer: { type: "string", maxLength: 8_000 },
      notebook_update: {
        type: "object",
        properties: {
          note_id: { anyOf: [{ type: "string", maxLength: 36 }, { type: "null" }] },
          new_note_title: { anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }] },
          ops: {
            type: "array",
            minItems: 0,
            maxItems: 20,
            items: NOTEBOOK_OP_ITEM_SCHEMA,
          },
          refs: { type: "array", items: { type: "string" } },
        },
        required: ["note_id", "new_note_title", "ops", "refs"],
        additionalProperties: false,
      },
    },
    required: ["answer", "notebook_update"],
    additionalProperties: false,
  },
} as const;

export class ProjectResearchWorkspaceService {
  constructor(private readonly db: Queryable, private readonly config?: ServerConfig) {}

  async getWorkspace(identity: SpaceUserIdentity, projectId: string) {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const folder = await this.db.query<{ id: string }>(`SELECT id FROM note_collections WHERE space_id=$1 AND project_id=$2`, [identity.spaceId, projectId]);
    if (!folder.rows[0]) throw new HttpError(404, "Research workspace not initialized");
    const [notes, checklist, reports] = await Promise.all([
      this.listProjectNotes(identity.spaceId, projectId),
      this.db.query(`SELECT * FROM research_checklist_items WHERE space_id=$1 AND project_id=$2 ORDER BY sort_order,id`, [identity.spaceId, projectId]),
      this.db.query(`SELECT id,research_question,research_question_version,status,run_kind,created_at,updated_at FROM project_research_reports WHERE space_id=$1 AND project_id=$2 ORDER BY created_at DESC`, [identity.spaceId, projectId]),
    ]);
    return { notes_collection_id: folder.rows[0].id, notes, checklist: checklist.rows, reports: reports.rows };
  }

  async initializeWorkspace(identity: SpaceUserIdentity, projectId: string) {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const existing = await this.db.query(`SELECT id FROM note_collections WHERE space_id=$1 AND project_id=$2`, [identity.spaceId, projectId]);
    if (existing.rows[0]) return this.getWorkspace(identity, projectId);
    if (!await canWriteProject(this.db, identity.spaceId, projectId, identity.userId)) {
      // Readers must not fail the page; they see the uninitialized state.
      throw new HttpError(404, "Research workspace not initialized");
    }
    await withQueryableTransaction(this.db, async (db) => {
      await assertProjectWriter(db, identity.spaceId, projectId, identity.userId);
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const service = new ProjectResearchWorkspaceService(db, this.config);
      await service.ensureWorkspace(identity.spaceId, projectId);
      // Projects with reports from before the living workspace existed get
      // their notes seeded from the latest completed report once.
      const report = await db.query<{ synthesis_run_id: string; content_json: unknown }>(
        `SELECT synthesis_run_id,content_json FROM project_research_reports
          WHERE space_id=$1 AND project_id=$2 AND status <> 'rejected'
          ORDER BY created_at DESC LIMIT 1`,
        [identity.spaceId, projectId],
      );
      if (report.rows[0]) {
        await service.seedFromReport({
          spaceId: identity.spaceId,
          projectId,
          runId: report.rows[0].synthesis_run_id,
          report: objectValue(report.rows[0].content_json),
        });
      }
    });
    return this.getWorkspace(identity, projectId);
  }

  async readingList(identity: SpaceUserIdentity, projectId: string, filters: Record<string, unknown>) {
    const corpus = await new ProjectCorpusRepository(this.db).list(identity, projectId, {
      status: "active", triageStatus: optionalString(filters.triage_status), readStatus: optionalString(filters.read_status), role: null,
      q: optionalString(filters.q), limit: Math.min(100, Math.max(1, Number(filters.limit) || 50)), offset: Math.max(0, Number(filters.offset) || 0),
    });
    const items = Array.isArray(corpus.items) ? corpus.items as Record<string, unknown>[] : [];
    const sourceIds = items.map((row) => optionalString(row.source_item_id)).filter((id): id is string => Boolean(id));
    const cards = sourceIds.length ? await this.db.query(`SELECT * FROM research_paper_cards WHERE space_id=$1 AND project_id=$2 AND source_item_id=ANY($3::text[])`, [identity.spaceId, projectId, sourceIds]) : { rows: [] as Record<string, unknown>[] };
    const bySource = new Map(cards.rows.map((card) => [String(card.source_item_id), card]));
    return { ...corpus, items: items.map((row) => ({ ...row, paper_card: bySource.get(String(row.source_item_id)) ?? null })) };
  }

  // Per-note editing, revision history, and rollback are no longer
  // workspace-specific: the frontend calls the generic
  // /api/v1/knowledge/notes/:noteId (+/revisions, +/rollback) endpoints
  // directly, since a project's notes are ordinary Notes.

  async upsertPaperCard(identity: SpaceUserIdentity, projectId: string, sourceItemId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const now = new Date().toISOString();
    const result = await this.db.query(
      `INSERT INTO research_paper_cards (id,space_id,project_id,source_item_id,object_id,why_md,how_md,what_md,provenance_json,edited_by_user,created_at,updated_at)
       SELECT $1::varchar,$2::varchar,$3::varchar,$4::varchar,pci.object_id,$5::text,$6::text,$7::text,'{}'::jsonb,true,$8::timestamptz,$8::timestamptz
         FROM project_corpus_items pci
         JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
         JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
        WHERE pci.space_id=$2::varchar AND pci.project_id=$3::varchar AND pcis.source_item_id=$4::varchar
          AND pci.status='active' AND ${sourceItemReadableClause("si", "$9", false)} LIMIT 1
       ON CONFLICT (space_id,project_id,source_item_id) DO UPDATE SET why_md=EXCLUDED.why_md,how_md=EXCLUDED.how_md,what_md=EXCLUDED.what_md,edited_by_user=true,updated_at=EXCLUDED.updated_at RETURNING *`,
      [randomUUID(), identity.spaceId, projectId, sourceItemId, text(body.why_md, 4000), text(body.how_md, 4000), text(body.what_md, 4000), now, identity.userId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Project paper not found");
    return result.rows[0];
  }

  async createChecklistItem(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const value = text(body.text, 2000); if (!value) throw new HttpError(422, "text is required");
    const now = new Date().toISOString();
    const result = await this.db.query(`INSERT INTO research_checklist_items (id,space_id,project_id,text,status,sort_order,origin,created_at,updated_at) SELECT $1,$2,$3,$4,'open',COALESCE(max(sort_order)+1,0),'user',$5,$5 FROM research_checklist_items WHERE space_id=$2 AND project_id=$3 RETURNING *`, [randomUUID(), identity.spaceId, projectId, value, now]);
    return result.rows[0];
  }

  async updateChecklistItem(identity: SpaceUserIdentity, projectId: string, itemId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const status = optionalString(body.status); if (status && !["open", "done", "dismissed"].includes(status)) throw new HttpError(422, "invalid checklist status");
    const value = body.text === undefined ? null : text(body.text, 2000);
    if (body.text !== undefined && !value) throw new HttpError(422, "text must not be empty");
    const order = Number.isInteger(body.sort_order) && Number(body.sort_order) >= 0 ? Number(body.sort_order) : null;
    if (body.sort_order !== undefined && order === null) throw new HttpError(422, "sort_order must be a non-negative integer");
    const result = await this.db.query(`UPDATE research_checklist_items SET text=COALESCE($4,text),status=COALESCE($5,status),sort_order=COALESCE($6,sort_order),updated_at=$7 WHERE id=$1 AND space_id=$2 AND project_id=$3 RETURNING *`, [itemId, identity.spaceId, projectId, value, status, order, new Date().toISOString()]);
    if (!result.rows[0]) throw new HttpError(404, "Checklist item not found"); return result.rows[0];
  }

  async deleteChecklistItem(identity: SpaceUserIdentity, projectId: string, itemId: string) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const result = await this.db.query(`DELETE FROM research_checklist_items WHERE id=$1 AND space_id=$2 AND project_id=$3 RETURNING id`, [itemId, identity.spaceId, projectId]);
    if (!result.rows[0]) throw new HttpError(404, "Checklist item not found"); return { id: itemId };
  }

  async askAi(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    if (!this.config) throw new HttpError(500, "Research execution is unavailable");
    const prompt = text(body.prompt, 4000);
    if (!prompt) throw new HttpError(422, "prompt is required");
    // `section_key` is a legacy field name (kept for the existing Reading
    // List "compare selected papers" caller): a known starter-note key maps
    // to its title; any other value is used as a literal note title,
    // created if it doesn't exist yet.
    const requested = optionalString(body.section_key) ?? "understanding";
    const title = (SECTION_LABELS as Record<string, string>)[requested] ?? requested;
    const used = await this.adhocRunsUsedToday(identity.spaceId, projectId);
    if (used >= RESEARCH_ADHOC_DAILY_RUN_LIMIT) {
      throw new HttpError(429, `The ad-hoc research budget of ${RESEARCH_ADHOC_DAILY_RUN_LIMIT} runs per day is spent for this project; try again tomorrow`);
    }
    const { folderId } = await withQueryableTransaction(this.db, (db) =>
      new ProjectResearchWorkspaceService(db, this.config).ensureWorkspace(identity.spaceId, projectId));
    let note = await resolveProjectNoteByTitle(this.db, identity.spaceId, projectId, title);
    if (!note) {
      const now = new Date().toISOString();
      const created = await withQueryableTransaction(this.db, (db) =>
        new ProjectResearchWorkspaceService(db, this.config).createProjectNote({
          spaceId: identity.spaceId, projectId, folderId, title, doc: markdownToPm(""), createdByUserId: identity.userId, at: now,
        }));
      note = { id: created.id, version: created.version, content_json: markdownToPm(""), plain_text: "" };
    }
    const baseVersion = note.version;
    const blocks = pmBlocksText(note.content_json ?? { type: "doc", content: [] });
    const paperIds = (Array.isArray(body.source_item_ids) ? body.source_item_ids : []).filter((v): v is string => typeof v === "string").slice(0, 20);
    const papers = paperIds.length ? await this.db.query<{ title: string; excerpt: string | null; why_md: string | null; how_md: string | null; what_md: string | null }>(
      `SELECT si.title,si.excerpt,pc.why_md,pc.how_md,pc.what_md
         FROM project_corpus_items pci
         JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
         JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
         LEFT JOIN research_paper_cards pc ON pc.project_id=pci.project_id AND pc.source_item_id=pcis.source_item_id
        WHERE pci.space_id=$1 AND pci.project_id=$2 AND pcis.source_item_id=ANY($3::text[])
          AND pci.status='active' AND ${sourceItemReadableClause("si", "$4", false)}`,
      [identity.spaceId, projectId, paperIds, identity.userId],
    ) : { rows: [] };
    const execution = objectValue(body.execution); const resolved = await new ProjectResearchExecutionProfileService(this.db, this.config).resolve(identity, { modelProviderId: optionalString(execution.model_provider_id), modelName: optionalString(execution.model_name) });
    const instruction = [
      "Perform the requested bounded research analysis using only the supplied note and paper context.",
      `User request: ${prompt}`, `Target note: ${title}`, `Note base version: ${baseVersion}`,
      `Current note as indexed blocks (edit by block index; the document has ${blocks.length} blocks):\n${blocks.map((value, index) => `[${index}] ${value || "(empty)"}`).join("\n") || "(empty document)"}`,
      `Selected papers:\n${papers.rows.map((p) => JSON.stringify(p)).join("\n")}`,
      "Return JSON only with a top-level notebook_update. Express the change as minimal block operations against the indexed blocks:",
      `- {"op":"append","index":null,"count":null,"markdown":"..."} adds blocks at the end`,
      `- {"op":"insert","index":N,"count":null,"markdown":"..."} inserts before block N`,
      `- {"op":"replace","index":N,"count":C,"markdown":"..."} replaces blocks N..N+C-1`,
      `- {"op":"delete","index":N,"count":C,"markdown":null} removes blocks`,
      "Never rewrite blocks you are not changing. Use refs for source_item ids you relied on.",
    ].join("\n\n");
    const run = await new PgRunRepository(this.db).createQueuedRunWithBudgetAdmission({
      agent_id: resolved.agentId, space_id: identity.spaceId, user_id: identity.userId, project_id: projectId,
      mode: "live", run_type: "agent", trigger_origin: "manual", runtime_profile_id: resolved.runtimeProfileId,
      prompt, instruction, capability_id: "research.adhoc_analyze", capabilities_json: ["research.adhoc_analyze"],
      contract_snapshot: { source: { kind: "direct", id: note.id }, project_id: projectId, policy_context_json: createManagedExecutionPolicy("project_research", true), workflow_input_json: { research_adhoc: { note_id: note.id, base_version: baseVersion, source_item_ids: paperIds } }, structured_output_json: ADHOC_OUTPUT_CONTRACT },
    });
    const job = await new PgJobQueueRepository(this.db).enqueue({ job_type: "agent_run", space_id: identity.spaceId, user_id: identity.userId, agent_id: resolved.agentId, payload: { run_id: run.id } });
    return { run_id: run.id, job_id: job.id, status: run.status, daily_limit: RESEARCH_ADHOC_DAILY_RUN_LIMIT, daily_used: used + 1 };
  }

  /**
   * Synchronous multi-turn conversation grounded in the whole notebook +
   * selected papers. Reuses the generic sessions store (project_id-scoped)
   * for history; when the model's reply includes a notebook_update it is
   * applied immediately (same ai_adhoc direct-write + revision model as
   * askAi), and the applied/attempted edit is attached to the assistant
   * message so the client can render an inline undo affordance and reload
   * it from session history later.
   */
  async notebookChat(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    if (!this.config) throw new HttpError(500, "Research execution is unavailable");
    const message = text(body.message, 4000);
    if (!message) throw new HttpError(422, "message is required");
    const used = await this.adhocRunsUsedToday(identity.spaceId, projectId);
    if (used >= RESEARCH_ADHOC_DAILY_RUN_LIMIT) {
      throw new HttpError(429, `The ad-hoc research budget of ${RESEARCH_ADHOC_DAILY_RUN_LIMIT} runs per day is spent for this project; try again tomorrow`);
    }
    const { folderId } = await withQueryableTransaction(this.db, (db) =>
      new ProjectResearchWorkspaceService(db, this.config).ensureWorkspace(identity.spaceId, projectId));
    const sessions = new PgSessionRepository(this.db);
    const requestedSessionId = optionalString(body.session_id);
    const session = requestedSessionId
      ? await sessions.getSession(identity.spaceId, identity.userId, requestedSessionId)
      : await sessions.createSession(identity.spaceId, identity.userId, { projectId, title: "Research notebook chat" });
    if (!session) throw new HttpError(404, "session not found in this space");
    if ((session.project_id ?? null) !== projectId) throw new HttpError(409, "session belongs to a different project");
    const userMessage = await sessions.addMessage(identity.spaceId, identity.userId, session.id, { role: "user", content: message });
    if (!userMessage) throw new HttpError(404, "session not found in this space");

    const history = (await sessions.listRecentMessagesForContext(identity.spaceId, identity.userId, session.id, 20)) ?? [];
    const historyBlock = history.length > 1
      ? `Conversation so far:\n${history.slice(0, -1).map((m) => `${m.role}: ${m.content}`).join("\n")}`
      : "";

    const paperIds = (Array.isArray(body.source_item_ids) ? body.source_item_ids : []).filter((v): v is string => typeof v === "string").slice(0, 20);
    const papers = paperIds.length ? await this.db.query<{ title: string; excerpt: string | null; why_md: string | null; how_md: string | null; what_md: string | null }>(
      `SELECT si.title,si.excerpt,pc.why_md,pc.how_md,pc.what_md
         FROM project_corpus_items pci
         JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
         JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
         LEFT JOIN research_paper_cards pc ON pc.project_id=pci.project_id AND pc.source_item_id=pcis.source_item_id
        WHERE pci.space_id=$1 AND pci.project_id=$2 AND pcis.source_item_id=ANY($3::text[])
          AND pci.status='active' AND ${sourceItemReadableClause("si", "$4", false)}`,
      [identity.spaceId, projectId, paperIds, identity.userId],
    ) : { rows: [] };
    const execution = objectValue(body.execution);
    const resolved = await new ProjectResearchExecutionProfileService(this.db, this.config).resolve(identity, { modelProviderId: optionalString(execution.model_provider_id), modelName: optionalString(execution.model_name) });

    const notes = await this.listProjectNotes(identity.spaceId, projectId);
    const notebookText = notes.map((note) => {
      const blocks = pmBlocksText(note.content_json ?? { type: "doc", content: [] });
      return `## [${note.id}] ${note.title} (base version ${note.version}, ${blocks.length} blocks)\n${blocks.map((value, index) => `[${index}] ${value || "(empty)"}`).join("\n") || "(empty document)"}`;
    }).join("\n\n");

    const instruction = [
      "You are discussing this project's notes with the user. Answer their latest message, grounded only in the supplied notes and paper context.",
      "notebook_update is always present in your JSON reply. Only if the user is asking you to update a note: set note_id to an existing note's id (from the list below) to edit it, referencing that note's base version; or leave note_id null and set new_note_title to create a new note instead. Otherwise leave ops as an empty array — that means no edit.",
      historyBlock,
      `Latest message: ${message}`,
      `Current notes:\n${notebookText || "(no notes yet)"}`,
      `Selected papers:\n${papers.rows.map((p) => JSON.stringify(p)).join("\n")}`,
      "If proposing notebook_update, express it as minimal block operations against the target note's indexed blocks:",
      `- {"op":"append","index":null,"count":null,"markdown":"..."} adds blocks at the end`,
      `- {"op":"insert","index":N,"count":null,"markdown":"..."} inserts before block N`,
      `- {"op":"replace","index":N,"count":C,"markdown":"..."} replaces blocks N..N+C-1`,
      `- {"op":"delete","index":N,"count":C,"markdown":null} removes blocks`,
      "Never rewrite blocks you are not changing. Use refs for source_item ids you relied on.",
    ].filter(Boolean).join("\n\n");

    const run = await new PgRunRepository(this.db).createQueuedRunWithBudgetAdmission({
      agent_id: resolved.agentId, space_id: identity.spaceId, user_id: identity.userId, project_id: projectId,
      mode: "live", run_type: "agent", trigger_origin: "manual", runtime_profile_id: resolved.runtimeProfileId,
      prompt: message, instruction, capability_id: "research.ask", capabilities_json: ["research.ask"],
      contract_snapshot: {
        source: { kind: "direct", id: folderId }, project_id: projectId,
        policy_context_json: createManagedExecutionPolicy("project_research", true),
        workflow_input_json: {},
        structured_output_json: NOTEBOOK_CHAT_OUTPUT_CONTRACT,
      },
    });
    await new RunOrchestrationService(this.config, new PgRunRepository(this.db)).executeRun({
      run_id: run.id, space_id: identity.spaceId, worker_id: `notebook-chat:${randomUUID()}`, command_source: "http",
    });
    const finished = await new PgRunRepository(this.db).getRun(identity.spaceId, run.id);
    if (!finished || !["succeeded", "degraded"].includes(finished.status)) {
      const errorText = finished?.error_message ?? "The notebook chat run did not complete successfully.";
      await sessions.addMessage(identity.spaceId, identity.userId, session.id, { role: "assistant", content: errorText, metadata: { run_id: run.id, error: true } });
      return { session_id: session.id, run_id: run.id, ok: false, error: errorText, daily_limit: RESEARCH_ADHOC_DAILY_RUN_LIMIT, daily_used: used + 1 };
    }

    const output = objectValue(finished.output_json);
    const answer = text(output.answer, 8000) || "(no answer returned)";
    const notebookUpdate = objectValue(output.notebook_update);
    let notebookEdit: { note_id: string; version: number; conflict: boolean } | null = null;
    const rawOps: unknown[] = Array.isArray(notebookUpdate.ops) ? notebookUpdate.ops : [];
    if (rawOps.length) {
      const refs = Array.isArray(notebookUpdate.refs) ? notebookUpdate.refs.filter((v): v is string => typeof v === "string").slice(0, 50) : [];
      const requestedNoteId = optionalString(notebookUpdate.note_id);
      const targetNote = requestedNoteId ? notes.find((n) => n.id === requestedNoteId) : undefined;
      if (targetNote) {
        const applied = await withQueryableTransaction(this.db, (db) => applyNoteOpsWithConflictFallback(db, {
          spaceId: identity.spaceId, noteId: targetNote.id, baseVersion: targetNote.version, rawOps, source: "ai_adhoc", runId: run.id, refs,
        }));
        if (applied) notebookEdit = { note_id: targetNote.id, version: applied.note.version, conflict: applied.conflict };
      } else {
        const newTitle = text(notebookUpdate.new_note_title, 200) || "Untitled";
        const now = new Date().toISOString();
        const created = await withQueryableTransaction(this.db, (db) =>
          new ProjectResearchWorkspaceService(db, this.config).createProjectNote({
            spaceId: identity.spaceId, projectId, folderId, title: newTitle, doc: markdownToPm(""), createdByUserId: null, at: now,
          }));
        const applied = await withQueryableTransaction(this.db, (db) => applyNoteOpsWithConflictFallback(db, {
          spaceId: identity.spaceId, noteId: created.id, baseVersion: created.version, rawOps, source: "ai_adhoc", runId: run.id, refs,
        }));
        if (applied) notebookEdit = { note_id: created.id, version: applied.note.version, conflict: applied.conflict };
      }
    }
    await sessions.addMessage(identity.spaceId, identity.userId, session.id, {
      role: "assistant", content: answer, metadata: { run_id: run.id, notebook_edit: notebookEdit },
    });
    return { session_id: session.id, run_id: run.id, ok: true, reply: answer, notebook_edit: notebookEdit, daily_limit: RESEARCH_ADHOC_DAILY_RUN_LIMIT, daily_used: used + 1 };
  }

  /**
   * Terminal callback for ad-hoc runs (invoked by the research reconciler).
   * Applies the run's block ops directly to the notebook; when the section
   * moved past the run's base version, the change degrades to a clearly
   * labeled append so the user's request is never silently dropped.
   */
  async applyAdhocRunOutput(spaceId: string, runId: string): Promise<void> {
    const run = await this.db.query<{ project_id: string | null; status: string; output_json: unknown; contract_snapshot_json: unknown }>(
      `SELECT project_id,status,output_json,contract_snapshot_json FROM runs WHERE id=$1 AND space_id=$2`,
      [runId, spaceId],
    );
    const row = run.rows[0];
    if (!row?.project_id || !["succeeded", "degraded"].includes(row.status)) return;
    const contract = objectValue(objectValue(objectValue(row.contract_snapshot_json).workflow_input_json).research_adhoc);
    const noteId = optionalString(contract.note_id); const baseVersion = Number(contract.base_version);
    if (!noteId || !Number.isInteger(baseVersion)) return;
    const applied = await this.db.query(`SELECT 1 FROM note_revisions WHERE note_id=$1 AND created_by_run_id=$2 LIMIT 1`, [noteId, runId]);
    if (applied.rows[0]) return;
    const update = objectValue(objectValue(row.output_json).notebook_update);
    const rawOps: unknown[] = Array.isArray(update.ops) ? update.ops : [];
    if (rawOps.length === 0) {
      throw new Error("Ad-hoc research run output does not contain a valid notebook_update");
    }
    const refs = Array.isArray(update.refs) ? update.refs.filter((v): v is string => typeof v === "string").slice(0, 50) : [];
    await withQueryableTransaction(this.db, (db) => applyNoteOpsWithConflictFallback(db, {
      spaceId, noteId, baseVersion, rawOps, source: "ai_adhoc", runId, refs,
    }));
  }

  async seedFromReport(input: { spaceId: string; projectId: string; runId: string; report: Record<string, unknown> }) {
    return withQueryableTransaction(this.db, async (db) => {
      const service = new ProjectResearchWorkspaceService(db, this.config);
      await service.ensureWorkspace(input.spaceId, input.projectId);
      const sections: Record<SectionKey, string> = {
        understanding: [text(input.report.summary, 20_000), ...arrayObjects(input.report.findings).map((v) => `- ${text(v.title, 1000) || text(v.claim, 1000)} ${text(v.detail, 4000)}`)].filter(Boolean).join("\n\n"),
        questions: arrayStrings(input.report.limitations).map((v) => `- ${v}`).join("\n"),
        ideas: arrayObjects(input.report.ideas).map((v) => `- ${text(v.title, 1000) || text(v.idea, 1000)} ${text(v.detail, 4000)}`).join("\n"), experiments: "",
      };
      const reportRefs = collectSourceItemRefs(input.report);
      for (const key of NOTEBOOK_SECTION_KEYS) {
        const markdown = sections[key]; if (!markdown) continue;
        const current = await db.query<{ object_id: string; version: number; plain_text: string | null }>(
          `SELECT n.object_id, n.version, n.plain_text FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
            WHERE so.space_id=$1 AND so.primary_project_id=$2 AND so.status='active' AND so.title=$3 LIMIT 1`,
          [input.spaceId, input.projectId, SECTION_LABELS[key]],
        );
        const row = current.rows[0];
        // Only seed a starter note that's never been touched (still v1, still empty).
        if (!row || row.version !== 1 || (row.plain_text ?? "") !== "") continue;
        await writeNote(db, {
          spaceId: input.spaceId, noteId: row.object_id,
          expectVersion: 1,
          content: { kind: "doc", doc: markdownToPm(markdown) },
          source: "seed", runId: input.runId, refs: reportRefs,
        });
      }
      const actions = [
        ...arrayObjects(input.report.ideas).map((idea) => text(idea.title, 1000) || text(idea.idea, 1000) || text(idea.detail, 2000)),
        ...arrayStrings(input.report.limitations).map((limitation) => `Resolve limitation: ${limitation}`),
      ].filter(Boolean);
      if (actions.length) {
        const existing = await db.query(`SELECT 1 FROM research_checklist_items WHERE space_id=$1 AND project_id=$2 AND origin_run_id=$3 LIMIT 1`, [input.spaceId, input.projectId, input.runId]);
        if (!existing.rows[0]) {
          const now = new Date().toISOString();
          for (const item of actions) {
            await db.query(
              `INSERT INTO research_checklist_items (id,space_id,project_id,text,status,sort_order,origin,origin_run_id,created_at,updated_at)
               SELECT $1::varchar,$2::varchar,$3::varchar,$4::text,'open',COALESCE(max(sort_order)+1,0),'agent',$5::varchar,$6::timestamptz,$6::timestamptz FROM research_checklist_items WHERE space_id=$2::varchar AND project_id=$3::varchar`,
              [randomUUID(), input.spaceId, input.projectId, item.slice(0, 2000), input.runId, now],
            );
          }
        }
      }
    });
  }

  async materializePaperCardsFromDeepAnalysis(input: { spaceId: string; projectId: string; runId: string; promptHash?: string | null; summaries: Array<{ source_item_id: string; summary_markdown: string }> }): Promise<number> {
    const now = new Date().toISOString();
    let written = 0;
    const creator = await this.db.query<{ model_provider_id: string | null; model_override_json: unknown }>(`SELECT model_provider_id,model_override_json FROM runs WHERE id=$1 AND space_id=$2`, [input.runId, input.spaceId]);
    const runProvenance = creator.rows[0];
    for (const summary of input.summaries) {
      const parts = paperCardParts(summary.summary_markdown);
      // User-edited cards are never overwritten by generation; the user's
      // interpretation wins until they clear it themselves.
      const result = await this.db.query(
        `INSERT INTO research_paper_cards (id,space_id,project_id,source_item_id,object_id,why_md,how_md,what_md,provenance_json,edited_by_user,created_at,updated_at)
         SELECT $1::varchar,$2::varchar,$3::varchar,$4::varchar,pci.object_id,$5::text,$6::text,$7::text,$8::jsonb,false,$9::timestamptz,$9::timestamptz FROM project_corpus_items pci
          JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
          JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
          WHERE pci.space_id=$2::varchar AND pci.project_id=$3::varchar AND pcis.source_item_id=$4::varchar AND pci.status='active'
            AND pci.triage_status IN ('relevant','maybe','included') LIMIT 1
         ON CONFLICT (space_id,project_id,source_item_id) DO UPDATE SET why_md=EXCLUDED.why_md,how_md=EXCLUDED.how_md,what_md=EXCLUDED.what_md,provenance_json=EXCLUDED.provenance_json,updated_at=EXCLUDED.updated_at
         WHERE research_paper_cards.edited_by_user=false
         RETURNING id`,
        [randomUUID(), input.spaceId, input.projectId, summary.source_item_id, parts.why, parts.how, parts.what,
          JSON.stringify({ run_id: input.runId, model_provider_id: runProvenance?.model_provider_id ?? null, model: optionalString(objectValue(runProvenance?.model_override_json).model), prompt_hash: input.promptHash ?? null, generated_from: "deep_analysis" }), now],
      );
      if (result.rows[0]) written += 1;
    }
    return written;
  }

  private async adhocRunsUsedToday(spaceId: string, projectId: string): Promise<number> {
    const result = await this.db.query<{ used: number }>(
      `SELECT count(*)::int AS used FROM runs
        WHERE space_id=$1 AND project_id=$2 AND capability_id IN ('research.adhoc_analyze','research.ask')
          AND created_at >= date_trunc('day', now())`,
      [spaceId, projectId],
    );
    return result.rows[0]?.used ?? 0;
  }

  /**
   * Ensures a project's auto-created Knowledge Notes folder exists (system
   * folder, one per project) and is seeded with the starter notes. A
   * project's notes are ordinary Notes, just filed under this folder and
   * tagged with `primary_project_id`, so they're free-form and fully
   * interlinked with the rest of Knowledge — not locked to a fixed
   * 4-section structure.
   */
  private async ensureWorkspace(spaceId: string, projectId: string): Promise<{ folderId: string }> {
    const folderId = await this.ensureProjectNotesFolder(spaceId, projectId);
    await this.ensureStarterNotes(spaceId, projectId, folderId);
    return { folderId };
  }

  private async ensureProjectNotesFolder(spaceId: string, projectId: string): Promise<string> {
    const existing = await this.db.query<{ id: string }>(`SELECT id FROM note_collections WHERE space_id=$1 AND project_id=$2`, [spaceId, projectId]);
    if (existing.rows[0]) return existing.rows[0].id;
    const project = await this.db.query<{ name: string }>(`SELECT name FROM projects WHERE id=$1 AND space_id=$2`, [projectId, spaceId]);
    const parentId = await this.resolveProjectsParentFolderId(spaceId);
    const id = randomUUID(); const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,project_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'project',0,true,false,$5,$6,$6)
       ON CONFLICT (space_id,project_id) WHERE project_id IS NOT NULL DO NOTHING`,
      [id, spaceId, parentId, project.rows[0]?.name ?? "Project", projectId, now],
    );
    const found = await this.db.query<{ id: string }>(`SELECT id FROM note_collections WHERE space_id=$1 AND project_id=$2`, [spaceId, projectId]);
    return found.rows[0]!.id;
  }

  /** Every space is seeded with a protected, singleton "Projects" PARA
   * folder (system_role='projects_root', see spaceSeeds.ts) — nest each
   * project's auto-created notes folder under it so it shows up where a
   * user following that structure would look for it. Looked up by role
   * (like Inbox/Archive), not by name, since the folder is protected but a
   * pre-existing space seeded before this role existed may not have one —
   * that degrades gracefully to a root-level folder, matching prior
   * behavior. */
  private async resolveProjectsParentFolderId(spaceId: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM note_collections WHERE space_id=$1 AND system_role='projects_root' LIMIT 1`,
      [spaceId],
    );
    return result.rows[0]?.id ?? null;
  }

  private async ensureStarterNotes(spaceId: string, projectId: string, folderId: string): Promise<void> {
    const base = Date.now();
    for (const [index, key] of NOTEBOOK_SECTION_KEYS.entries()) {
      const title = SECTION_LABELS[key];
      const existing = await resolveProjectNoteByTitle(this.db, spaceId, projectId, title);
      // Strictly increasing timestamps keep starter-note ordering
      // (understanding/questions/ideas/experiments) deterministic — they'd
      // otherwise tie on created_at if stamped with one shared `now`.
      if (!existing) await this.createProjectNote({ spaceId, projectId, folderId, title, doc: markdownToPm(""), createdByUserId: null, at: new Date(base + index).toISOString() });
    }
  }

  private async listProjectNotes(spaceId: string, projectId: string): Promise<Array<{ id: string; title: string; version: number; content_json: Record<string, unknown> }>> {
    const rows = await this.db.query<{ id: string; title: string; version: number; content_json: Record<string, unknown> }>(
      `SELECT n.object_id AS id, so.title, n.version, n.content_json
         FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
        WHERE so.space_id=$1 AND so.primary_project_id=$2 AND so.status='active' ORDER BY so.created_at ASC`,
      [spaceId, projectId],
    );
    return rows.rows;
  }

  private async createProjectNote(input: {
    spaceId: string; projectId: string; folderId: string; title: string; doc: Record<string, unknown>;
    createdByUserId: string | null; at: string;
  }): Promise<{ id: string; version: number }> {
    const objectId = randomUUID();
    const normalized = normalizePmText(input.doc);
    await this.db.query(
      `INSERT INTO space_objects (id,space_id,object_type,title,status,visibility,owner_user_id,primary_project_id,created_by_user_id,created_at,updated_at)
       VALUES ($1,$2,'note',$3,'active','space_shared',$4,$5,$4,$6,$6)`,
      [objectId, input.spaceId, input.title, input.createdByUserId, input.projectId, input.at],
    );
    await this.db.query(
      `INSERT INTO notes (object_id,space_id,content_json,content_format,content_schema_version,plain_text,version,content_hash)
       VALUES ($1,$2,$3::jsonb,'prosemirror_json',1,$4,1,$5)`,
      [objectId, input.spaceId, JSON.stringify(input.doc), normalized, sha256(normalized)],
    );
    await insertInitialNoteRevision(this.db, { spaceId: input.spaceId, noteId: objectId, doc: input.doc, at: input.at, userId: input.createdByUserId });
    await this.db.query(
      `INSERT INTO note_collection_items (id,space_id,collection_id,note_id,sort_order,created_at) VALUES ($1,$2,$3,$4,0,$5)`,
      [randomUUID(), input.spaceId, input.folderId, objectId, input.at],
    );
    return { id: objectId, version: 1 };
  }
}

function text(value: unknown, max: number): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function arrayStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; }
function arrayObjects(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(objectValue) : []; }
function collectSourceItemRefs(value: unknown, refs = new Set<string>()): string[] {
  if (Array.isArray(value)) for (const item of value) collectSourceItemRefs(item, refs);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>; const id = optionalString(record.source_item_id); if (id) refs.add(id);
    for (const child of Object.values(record)) collectSourceItemRefs(child, refs);
  }
  return [...refs];
}
function paperCardParts(markdown: string): { why: string; how: string; what: string } {
  const take = (label: string) => markdown.match(new RegExp(`(?:^|\\n)#{0,3}\\s*${label}\\s*:?\\s*([^\\n]+(?:\\n(?!#{0,3}\\s*(?:WHY|HOW|WHAT)\\b)[^\\n]+)*)`, "i"))?.[1]?.trim().slice(0, 4000) ?? "";
  const why = clipWords(take("WHY"), 80); const how = clipWords(take("HOW"), 80); const what = clipWords(take("WHAT"), 80);
  return { why, how, what: what || (!why && !how ? clipWords(markdown.trim(), 80) : "") };
}
function clipWords(value: string, limit: number): string { return value.split(/\s+/).filter(Boolean).slice(0, limit).join(" "); }
