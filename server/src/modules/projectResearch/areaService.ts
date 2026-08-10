import { randomUUID } from "node:crypto";
import { HttpError, objectValue, optionalString, type Queryable, type SpaceUserIdentity } from "../routeUtils/common";
import { assertProjectReadable, assertProjectWriter, canWriteProject, lockActiveProjectForMutation } from "../projects/access";
import { ProjectCorpusRepository } from "../projects/corpusRepository";
import { sourceItemReadableClause } from "../sources/sourceItemAccess";
import type { ServerConfig } from "../../config";
import { ProjectResearchExecutionProfileService } from "./executionProfileService";
import { PgRunRepository } from "../runs/repository";
import { PgJobQueueRepository } from "../jobs/repository";
import { RunOrchestrationService } from "../runs/orchestrationService";
import { runOutputResult } from "../runs/orchestrationResults";
import { PgSessionRepository } from "../sessions/repository";
import { createManagedExecutionPolicy } from "../policy/managedExecutionPolicy";
import { markdownToPm, pmBlocksText } from "../knowledge/noteDocument";
import { withNoteWrites, type NoteWriteScope } from "../knowledge/noteWriter";
import { ensureProjectNotesFolder } from "../knowledge/noteProjectFolders";
import { NOTEBOOK_SECTION_KEYS, SECTION_LABELS, resolveNotebookNote, resolveNotebookNotes, type NotebookNoteRow, type SectionKey } from "./notebookNotes";
import { isNoteProjectRole, type NoteProjectRole } from "../knowledge/noteProjectRoles";

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

export class ProjectResearchAreaService {
  constructor(private readonly db: Queryable, private readonly config?: ServerConfig) {}

  async getArea(identity: SpaceUserIdentity, projectId: string) {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const folder = await this.db.query<{ id: string }>(`SELECT id FROM note_collections WHERE space_id=$1 AND project_id=$2`, [identity.spaceId, projectId]);
    if (!folder.rows[0]) throw new HttpError(404, "Research Area not initialized");
    const [notes, checklist, reports] = await Promise.all([
      this.listProjectNotes(identity.spaceId, projectId),
      this.db.query(`SELECT * FROM research_checklist_items WHERE space_id=$1 AND project_id=$2 ORDER BY sort_order,id`, [identity.spaceId, projectId]),
      this.db.query(`SELECT id,research_question,research_question_version,status,run_kind,created_at,updated_at FROM project_research_reports WHERE space_id=$1 AND project_id=$2 ORDER BY created_at DESC`, [identity.spaceId, projectId]),
    ]);
    return { notes_collection_id: folder.rows[0].id, notes, checklist: checklist.rows, reports: reports.rows };
  }

  async initializeArea(identity: SpaceUserIdentity, projectId: string) {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const existing = await this.db.query(`SELECT id FROM note_collections WHERE space_id=$1 AND project_id=$2`, [identity.spaceId, projectId]);
    if (!await canWriteProject(this.db, identity.spaceId, projectId, identity.userId)) {
      // Readers may inspect an initialized area, but cannot repair a partial
      // baseline or create one as a side effect of a read.
      if (existing.rows[0]) return this.getArea(identity, projectId);
      throw new HttpError(404, "Research Area not initialized");
    }
    await withNoteWrites(this.db, async (scope) => {
      const db = scope.db;
      await assertProjectWriter(db, identity.spaceId, projectId, identity.userId);
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const service = new ProjectResearchAreaService(db, this.config);
      await service.ensureArea(scope, identity.spaceId, projectId);
      // Projects with reports from before the living area existed get
      // their notes seeded from the latest completed report once.
      const report = existing.rows[0] ? { rows: [] } : await db.query<{ synthesis_run_id: string; content_json: unknown }>(
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
    return this.getArea(identity, projectId);
  }

  async readingList(identity: SpaceUserIdentity, projectId: string, filters: Record<string, unknown>) {
    const corpus = await new ProjectCorpusRepository(this.db).list(identity, projectId, {
      status: "active", triageStatus: optionalString(filters.triage_status), readStatus: optionalString(filters.read_status), role: null,
      q: optionalString(filters.q), limit: Math.min(100, Math.max(1, Number(filters.limit) || 50)), offset: Math.max(0, Number(filters.offset) || 0),
    });
    const items = Array.isArray(corpus.items) ? corpus.items as Record<string, unknown>[] : [];
    const sourceIds = items.map((row) => optionalString(row.source_item_id)).filter((id): id is string => Boolean(id));
    const cards = sourceIds.length ? await this.db.query(`SELECT * FROM research_evidence_cards WHERE space_id=$1 AND project_id=$2 AND source_item_id=ANY($3::text[])`, [identity.spaceId, projectId, sourceIds]) : { rows: [] as Record<string, unknown>[] };
    const bySource = new Map(cards.rows.map((card) => [String(card.source_item_id), card]));
    return { ...corpus, items: items.map((row) => ({ ...row, evidence_card: bySource.get(String(row.source_item_id)) ?? null })) };
  }

  // Per-note editing, revision history, and rollback are no longer
  // area-specific: the frontend calls the generic
  // /api/v1/knowledge/notes/:noteId (+/revisions, +/rollback) endpoints
  // directly, since a project's notes are ordinary Notes.

  async upsertEvidenceCard(identity: SpaceUserIdentity, projectId: string, sourceItemId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const now = new Date().toISOString();
    const result = await this.db.query(
      `INSERT INTO research_evidence_cards (id,space_id,project_id,source_item_id,object_id,why_md,how_md,what_md,provenance_json,edited_by_user,created_at,updated_at)
       SELECT $1::varchar,$2::varchar,$3::varchar,$4::varchar,pci.object_id,$5::text,$6::text,$7::text,'{}'::jsonb,true,$8::timestamptz,$8::timestamptz
         FROM project_corpus_items pci
         JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
         JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
        WHERE pci.space_id=$2::varchar AND pci.project_id=$3::varchar AND pcis.source_item_id=$4::varchar
          AND pci.status='active' AND ${sourceItemReadableClause("si", "$9", false)} LIMIT 1
       ON CONFLICT (space_id,project_id,source_item_id) DO UPDATE SET why_md=EXCLUDED.why_md,how_md=EXCLUDED.how_md,what_md=EXCLUDED.what_md,edited_by_user=true,updated_at=EXCLUDED.updated_at RETURNING *`,
      [randomUUID(), identity.spaceId, projectId, sourceItemId, text(body.why_md, 4000), text(body.how_md, 4000), text(body.what_md, 4000), now, identity.userId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Project material not found");
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
    // List "compare selected material" caller): a registered role resolves to
    // whichever note holds that role, whatever its title now is; any other
    // value is a literal note title, created if it doesn't exist yet.
    const requested = optionalString(body.section_key) ?? "understanding";
    const role = isNoteProjectRole(requested) ? requested : null;
    const title = role ? SECTION_LABELS[role] : requested;
    const used = await this.adhocRunsUsedToday(identity.spaceId, projectId);
    if (used >= RESEARCH_ADHOC_DAILY_RUN_LIMIT) {
      throw new HttpError(429, `The ad-hoc research budget of ${RESEARCH_ADHOC_DAILY_RUN_LIMIT} runs per day is spent for this project; try again tomorrow`);
    }
    const { folderId } = await withNoteWrites(this.db, (scope) =>
      new ProjectResearchAreaService(scope.db, this.config).ensureArea(scope, identity.spaceId, projectId));
    let note: NotebookNoteRow | null = null;
    if (role) {
      const resolution = await resolveNotebookNote(this.db, identity.spaceId, projectId, role);
      if (resolution.present) note = resolution.note;
    } else {
      note = await this.resolveProjectNoteByExactTitle(identity.spaceId, projectId, title);
    }
    if (!note) {
      const now = new Date().toISOString();
      const created = await withNoteWrites(this.db, (scope) =>
        new ProjectResearchAreaService(scope.db, this.config).createProjectNote(scope, {
          spaceId: identity.spaceId, projectId, folderId, title, doc: markdownToPm(""), createdByUserId: identity.userId, at: now,
          projectRole: role,
        }));
      note = { id: created.id, version: created.version, content_json: markdownToPm(""), plain_text: "" };
    }
    const baseVersion = note.version;
    const blocks = pmBlocksText(note.content_json ?? { type: "doc", content: [] });
    const materialIds = (Array.isArray(body.source_item_ids) ? body.source_item_ids : []).filter((v): v is string => typeof v === "string").slice(0, 20);
    const material = materialIds.length ? await this.db.query<{ title: string; excerpt: string | null; why_md: string | null; how_md: string | null; what_md: string | null }>(
      `SELECT si.title,si.excerpt,pc.why_md,pc.how_md,pc.what_md
         FROM project_corpus_items pci
         JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
         JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
         LEFT JOIN research_evidence_cards pc ON pc.project_id=pci.project_id AND pc.source_item_id=pcis.source_item_id
        WHERE pci.space_id=$1 AND pci.project_id=$2 AND pcis.source_item_id=ANY($3::text[])
          AND pci.status='active' AND ${sourceItemReadableClause("si", "$4", false)}`,
      [identity.spaceId, projectId, materialIds, identity.userId],
    ) : { rows: [] };
    const execution = objectValue(body.execution); const resolved = await new ProjectResearchExecutionProfileService(this.db, this.config).resolve(identity, { modelProviderId: optionalString(execution.model_provider_id), modelName: optionalString(execution.model_name) });
    const instruction = [
      "Perform the requested bounded research analysis using only the supplied note and evidence context.",
      `User request: ${prompt}`, `Target note: ${title}`, `Note base version: ${baseVersion}`,
      `Current note as indexed blocks (edit by block index; the document has ${blocks.length} blocks):\n${blocks.map((value, index) => `[${index}] ${value || "(empty)"}`).join("\n") || "(empty document)"}`,
      `Selected material:\n${material.rows.map((item) => JSON.stringify(item)).join("\n")}`,
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
      contract_snapshot: { source: { kind: "direct", id: note.id }, project_id: projectId, policy_context_json: createManagedExecutionPolicy("project_research", true), workflow_input_json: { research_adhoc: { note_id: note.id, base_version: baseVersion, source_item_ids: materialIds } }, structured_output_json: ADHOC_OUTPUT_CONTRACT },
    });
    const job = await new PgJobQueueRepository(this.db).enqueue({ job_type: "agent_run", space_id: identity.spaceId, user_id: identity.userId, agent_id: resolved.agentId, payload: { run_id: run.id } });
    return { run_id: run.id, job_id: job.id, status: run.status, daily_limit: RESEARCH_ADHOC_DAILY_RUN_LIMIT, daily_used: used + 1 };
  }

  /**
   * Synchronous multi-turn conversation grounded in the whole notebook +
   * selected material. Reuses the generic sessions store (project_id-scoped)
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
    const { folderId } = await withNoteWrites(this.db, (scope) =>
      new ProjectResearchAreaService(scope.db, this.config).ensureArea(scope, identity.spaceId, projectId));
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

    const materialIds = (Array.isArray(body.source_item_ids) ? body.source_item_ids : []).filter((v): v is string => typeof v === "string").slice(0, 20);
    const material = materialIds.length ? await this.db.query<{ title: string; excerpt: string | null; why_md: string | null; how_md: string | null; what_md: string | null }>(
      `SELECT si.title,si.excerpt,pc.why_md,pc.how_md,pc.what_md
         FROM project_corpus_items pci
         JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
         JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
         LEFT JOIN research_evidence_cards pc ON pc.project_id=pci.project_id AND pc.source_item_id=pcis.source_item_id
        WHERE pci.space_id=$1 AND pci.project_id=$2 AND pcis.source_item_id=ANY($3::text[])
          AND pci.status='active' AND ${sourceItemReadableClause("si", "$4", false)}`,
      [identity.spaceId, projectId, materialIds, identity.userId],
    ) : { rows: [] };
    const execution = objectValue(body.execution);
    const resolved = await new ProjectResearchExecutionProfileService(this.db, this.config).resolve(identity, { modelProviderId: optionalString(execution.model_provider_id), modelName: optionalString(execution.model_name) });

    const notes = await this.listProjectNotes(identity.spaceId, projectId);
    const notebookText = notes.map((note) => {
      const blocks = pmBlocksText(note.content_json ?? { type: "doc", content: [] });
      return `## [${note.id}] ${note.title} (base version ${note.version}, ${blocks.length} blocks)\n${blocks.map((value, index) => `[${index}] ${value || "(empty)"}`).join("\n") || "(empty document)"}`;
    }).join("\n\n");

    const instruction = [
      "You are discussing this project's notes with the user. Answer their latest message, grounded only in the supplied notes and evidence context.",
      "notebook_update is always present in your JSON reply. Only if the user is asking you to update a note: set note_id to an existing note's id (from the list below) to edit it, referencing that note's base version; or leave note_id null and set new_note_title to create a new note instead. Otherwise leave ops as an empty array — that means no edit.",
      historyBlock,
      `Latest message: ${message}`,
      `Current notes:\n${notebookText || "(no notes yet)"}`,
      `Selected material:\n${material.rows.map((item) => JSON.stringify(item)).join("\n")}`,
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

    const output = runOutputResult(finished.output_json);
    const answer = text(output.answer, 8000) || "(no answer returned)";
    const notebookUpdate = objectValue(output.notebook_update);
    let notebookEdit: { note_id: string; version: number; conflict: boolean } | null = null;
    const rawOps: unknown[] = Array.isArray(notebookUpdate.ops) ? notebookUpdate.ops : [];
    if (rawOps.length) {
      const refs = Array.isArray(notebookUpdate.refs) ? notebookUpdate.refs.filter((v): v is string => typeof v === "string").slice(0, 50) : [];
      const requestedNoteId = optionalString(notebookUpdate.note_id);
      const targetNote = requestedNoteId ? notes.find((n) => n.id === requestedNoteId) : undefined;
      if (targetNote) {
        const applied = await withNoteWrites(this.db, (scope) => scope.applyOps({
          spaceId: identity.spaceId, noteId: targetNote.id, baseVersion: targetNote.version, rawOps, source: "ai_adhoc", runId: run.id, refs,
        }));
        if (applied) notebookEdit = { note_id: targetNote.id, version: applied.note.version, conflict: applied.conflict };
      } else {
        const newTitle = text(notebookUpdate.new_note_title, 200) || "Untitled";
        const now = new Date().toISOString();
        // One scope: a note created for an edit that then fails to apply is a
        // note nobody asked for.
        const applied = await withNoteWrites(this.db, async (scope) => {
          const created = await new ProjectResearchAreaService(scope.db, this.config).createProjectNote(scope, {
            spaceId: identity.spaceId, projectId, folderId, title: newTitle, doc: markdownToPm(""),
            createdByUserId: null, createdByRunId: run.id, at: now,
          });
          const result = await scope.applyOps({
            spaceId: identity.spaceId, noteId: created.id, baseVersion: created.version, rawOps, source: "ai_adhoc", runId: run.id, refs,
          });
          return result ? { noteId: created.id, ...result } : null;
        });
        if (applied) notebookEdit = { note_id: applied.noteId, version: applied.note.version, conflict: applied.conflict };
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
    const update = objectValue(runOutputResult(row.output_json).notebook_update);
    const rawOps: unknown[] = Array.isArray(update.ops) ? update.ops : [];
    if (rawOps.length === 0) {
      throw new Error("Ad-hoc research run output does not contain a valid notebook_update");
    }
    const refs = Array.isArray(update.refs) ? update.refs.filter((v): v is string => typeof v === "string").slice(0, 50) : [];
    await withNoteWrites(this.db, (scope) => scope.applyOps({
      spaceId, noteId, baseVersion, rawOps, source: "ai_adhoc", runId, refs,
    }));
  }

  async seedFromReport(input: { spaceId: string; projectId: string; runId: string; report: Record<string, unknown> }) {
    return withNoteWrites(this.db, async (scope) => {
      const db = scope.db;
      const service = new ProjectResearchAreaService(db, this.config);
      await service.ensureArea(scope, input.spaceId, input.projectId);
      const sections: Record<SectionKey, string> = {
        understanding: [text(input.report.summary, 20_000), ...arrayObjects(input.report.findings).map((v) => `- ${text(v.title, 1000) || text(v.claim, 1000)} ${text(v.detail, 4000)}`)].filter(Boolean).join("\n\n"),
        questions: arrayStrings(input.report.limitations).map((v) => `- ${v}`).join("\n"),
        ideas: arrayObjects(input.report.ideas).map((v) => `- ${text(v.title, 1000) || text(v.idea, 1000)} ${text(v.detail, 4000)}`).join("\n"), experiments: "",
      };
      const reportRefs = collectSourceItemRefs(input.report);
      const byRole = await resolveNotebookNotes(db, input.spaceId, input.projectId);
      for (const key of NOTEBOOK_SECTION_KEYS) {
        const markdown = sections[key]; if (!markdown) continue;
        const row = byRole[key];
        // Only seed a starter note that's never been touched (still v1, still empty).
        if (!row || row.version !== 1 || (row.plain_text ?? "") !== "") continue;
        await scope.write({
          spaceId: input.spaceId, noteId: row.id,
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

  async materializeEvidenceCardsFromDeepAnalysis(input: { spaceId: string; projectId: string; runId: string; promptHash?: string | null; summaries: Array<{ source_item_id: string; summary_markdown: string }> }): Promise<number> {
    const now = new Date().toISOString();
    let written = 0;
    const creator = await this.db.query<{ model_provider_id: string | null; model_override_json: unknown }>(`SELECT model_provider_id,model_override_json FROM runs WHERE id=$1 AND space_id=$2`, [input.runId, input.spaceId]);
    const runProvenance = creator.rows[0];
    for (const summary of input.summaries) {
      const parts = evidenceCardParts(summary.summary_markdown);
      // User-edited cards are never overwritten by generation; the user's
      // interpretation wins until they clear it themselves.
      const result = await this.db.query(
        `INSERT INTO research_evidence_cards (id,space_id,project_id,source_item_id,object_id,why_md,how_md,what_md,provenance_json,edited_by_user,created_at,updated_at)
         SELECT $1::varchar,$2::varchar,$3::varchar,$4::varchar,pci.object_id,$5::text,$6::text,$7::text,$8::jsonb,false,$9::timestamptz,$9::timestamptz FROM project_corpus_items pci
          JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
          JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
          WHERE pci.space_id=$2::varchar AND pci.project_id=$3::varchar AND pcis.source_item_id=$4::varchar AND pci.status='active'
            AND pci.triage_status IN ('relevant','maybe','included') LIMIT 1
         ON CONFLICT (space_id,project_id,source_item_id) DO UPDATE SET why_md=EXCLUDED.why_md,how_md=EXCLUDED.how_md,what_md=EXCLUDED.what_md,provenance_json=EXCLUDED.provenance_json,updated_at=EXCLUDED.updated_at
         WHERE research_evidence_cards.edited_by_user=false
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
  private async ensureArea(scope: NoteWriteScope, spaceId: string, projectId: string): Promise<{ folderId: string }> {
    const folderId = await this.ensureProjectNotesFolder(spaceId, projectId);
    await this.adoptStarterNotesByTitle(scope, spaceId, projectId);
    await this.ensureStarterNotes(scope, spaceId, projectId, folderId);
    return { folderId };
  }

  /**
   * One-shot reconciliation for projects whose starter notes predate the role
   * marker (N2). Title matching here is legitimate and is the only place it
   * remains: it reconstructs the binding the old title-based resolver created,
   * rather than being a binding of its own.
   *
   * The schema is regenerated from one baseline rather than migrated
   * incrementally, so this lives on the read path — the same place that
   * already creates a missing starter note — and stops doing anything the
   * moment every role is filled. A note whose title the user already changed
   * is not adopted: there is nothing to reconstruct, and guessing would put a
   * role on a note the user never designated.
   */
  private async adoptStarterNotesByTitle(scope: NoteWriteScope, spaceId: string, projectId: string): Promise<void> {
    const byRole = await resolveNotebookNotes(this.db, spaceId, projectId);
    for (const role of NOTEBOOK_SECTION_KEYS) {
      if (byRole[role]) continue;
      // Finding the candidate is this method's own business — the title match
      // is the whole point here. Writing the role is not: that goes through
      // the note writer like every other role write, so the registry check and
      // the displacement rule apply here too.
      const candidate = await this.db.query<{ object_id: string }>(
        `SELECT n.object_id FROM notes n
           JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
          WHERE n.space_id=$1 AND so.primary_project_id=$2 AND n.status='active'
            AND so.deleted_at IS NULL AND so.title=$3 AND n.project_role IS NULL
          ORDER BY so.created_at ASC LIMIT 1`,
        [spaceId, projectId, SECTION_LABELS[role]],
      );
      const noteId = candidate.rows[0]?.object_id;
      if (!noteId) continue;
      await scope.setProjectRole({ spaceId, noteId, actor: { system: true }, role, projectId });
    }
  }

  /** The folder itself belongs to Knowledge, which owns `note_collections`;
   * the research area is one of two callers that need it to exist (the other
   * is the Project's notes surface), so the rule lives there rather than here. */
  private async ensureProjectNotesFolder(spaceId: string, projectId: string): Promise<string> {
    return ensureProjectNotesFolder(this.db, spaceId, projectId);
  }

  private async projectOwnerUserId(spaceId: string, projectId: string): Promise<string | null> {
    const row = await this.db.query<{ owner_user_id: string | null }>(
      `SELECT owner_user_id FROM projects WHERE id = $1 AND space_id = $2`,
      [projectId, spaceId],
    );
    return row.rows[0]?.owner_user_id ?? null;
  }

  private async ensureStarterNotes(scope: NoteWriteScope, spaceId: string, projectId: string, folderId: string): Promise<void> {
    const base = Date.now();
    const byRole = await resolveNotebookNotes(this.db, spaceId, projectId);
    for (const [index, key] of NOTEBOOK_SECTION_KEYS.entries()) {
      // Presence is decided by the role, so a user who renamed "Idea pool" does
      // not get a second one seeded next to it.
      if (byRole[key]) continue;
      // Strictly increasing timestamps keep starter-note ordering
      // (understanding/questions/ideas/experiments) deterministic — they'd
      // otherwise tie on created_at if stamped with one shared `now`.
      await this.createProjectNote(scope, {
        spaceId, projectId, folderId, title: SECTION_LABELS[key], doc: markdownToPm(""),
        createdByUserId: null, at: new Date(base + index).toISOString(), projectRole: key,
      });
    }
  }

  /**
   * Free-form title lookup, for the ad-hoc caller that names a note instead of
   * a role. Not a system binding: the title is the user's own input in that
   * path, so matching it is what they asked for.
   */
  private async resolveProjectNoteByExactTitle(spaceId: string, projectId: string, title: string): Promise<NotebookNoteRow | null> {
    const result = await this.db.query<NotebookNoteRow>(
      `SELECT n.object_id AS id, n.version, n.content_json, n.plain_text
         FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
        WHERE so.space_id=$1 AND so.primary_project_id=$2 AND n.status='active'
          AND so.deleted_at IS NULL AND so.title=$3
        ORDER BY so.created_at ASC LIMIT 1`,
      [spaceId, projectId, title],
    );
    return result.rows[0] ?? null;
  }

  private async listProjectNotes(spaceId: string, projectId: string): Promise<Array<{ id: string; title: string; version: number; content_json: Record<string, unknown>; project_role: string | null }>> {
    const rows = await this.db.query<{ id: string; title: string; version: number; content_json: Record<string, unknown>; project_role: string | null }>(
      `SELECT n.object_id AS id, so.title, n.version, n.content_json, n.project_role
         FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
        WHERE so.space_id=$1 AND so.primary_project_id=$2 AND n.status='active' AND so.deleted_at IS NULL
        ORDER BY so.created_at ASC`,
      [spaceId, projectId],
    );
    return rows.rows;
  }

  /**
   * Creates a note in this Project's notebook folder.
   *
   * The work is the shared note writer's: this method only supplies what is
   * specific to a Project note — the folder, the role, and the attribution for
   * scaffolding nobody asked for by hand. It used to assemble the root row,
   * the extension row, the revision and the folder membership itself, and had
   * drifted from the general path in two visible ways (no `summary`, and every
   * note filed at `sort_order` 0).
   */
  private async createProjectNote(scope: NoteWriteScope, input: {
    spaceId: string; projectId: string; folderId: string; title: string; doc: Record<string, unknown>;
    createdByUserId: string | null; createdByRunId?: string | null; at: string;
    /** The notebook role this note is created to hold, when it has one. */
    projectRole?: NoteProjectRole | null;
  }): Promise<{ id: string; version: number }> {
    // Auto-created scaffolding (starter notes) has no acting user. Attributing
    // it to the Project owner is accurate — the notes exist because that
    // Project does — and leaves the object traceable, which B12H requires.
    const createdByUserId = input.createdByUserId
      ?? (input.createdByRunId ? null : await this.projectOwnerUserId(input.spaceId, input.projectId));
    return scope.create({
      spaceId: input.spaceId,
      // Seeding is not a user action even when a user triggered the run that
      // caused it, so the Project write check does not apply: the Project is
      // this service's own, not one the caller named.
      actor: { system: true },
      title: input.title,
      doc: input.doc,
      contentFormat: "prosemirror_json",
      ownerUserId: createdByUserId,
      createdByUserId,
      createdByRunId: input.createdByRunId ?? null,
      primaryProjectId: input.projectId,
      collectionId: input.folderId,
      projectRole: input.projectRole ?? null,
      at: input.at,
    });
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
function evidenceCardParts(markdown: string): { why: string; how: string; what: string } {
  const take = (label: string) => markdown.match(new RegExp(`(?:^|\\n)#{0,3}\\s*${label}\\s*:?\\s*([^\\n]+(?:\\n(?!#{0,3}\\s*(?:WHY|HOW|WHAT)\\b)[^\\n]+)*)`, "i"))?.[1]?.trim().slice(0, 4000) ?? "";
  const why = clipWords(take("WHY"), 80); const how = clipWords(take("HOW"), 80); const what = clipWords(take("WHAT"), 80);
  return { why, how, what: what || (!why && !how ? clipWords(markdown.trim(), 80) : "") };
}
function clipWords(value: string, limit: number): string { return value.split(/\s+/).filter(Boolean).slice(0, limit).join(" "); }
