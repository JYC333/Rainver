import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";

/**
 * Work Loop stages and the Project work event vocabulary.
 *
 * Two axes that a single `tasks.status` cannot carry, and that this module
 * keeps apart on purpose:
 *
 * - **Flow state** (`tasks.status`) — where the work sits in the queue.
 *   `inbox / ready / in_progress / waiting_for_review / blocked / done /
 *   cancelled`. This is what Board columns show.
 * - **Loop stage** (here) — which *kind* of problem the work is solving right
 *   now. A Task can be `in_progress` while framing the question, and equally
 *   `in_progress` while checking a result; those are different situations and
 *   an agent advancing the work needs to tell them apart.
 *
 * The five stages are a **system constant**, not per-Project configuration.
 * The stress test across delivery, research, operations, learning, events and
 * personal work found the same five everywhere; only the wording differed, and
 * a per-Project "mode" that swapped the wording was the last thing left of a
 * Project classification nothing else read, so it went (ADR 0019). The keys,
 * their order, and their meaning are identical in every Project.
 */

/**
 * The Task states that mean a person has to act.
 *
 * Shared because three things count them and must agree: the responsibility
 * chain hands a Task back in these states, the Board badges them, and the
 * Board's own filter lists them. A badge that disagreed with the list it opens
 * sends someone to look for a card that is not there.
 */
/**
 * Every flow status a Task can be in. The one list: the `tasks` and
 * `board_columns` check constraints, the repository's validator and the
 * Board's lanes all derive from it, and `projectWorkContracts.test.ts` pins
 * them to it — a status with no lane is a card counted and never drawn.
 */
export const TASK_STATUSES = ["inbox", "ready", "in_progress", "waiting_for_review", "blocked", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PERSON_ONLY_TASK_STATUSES = ["waiting_for_review", "blocked"] as const;

export const WORK_LOOP_STAGE_KEYS = ["frame", "plan", "act", "verify", "conclude"] as const;
export const WorkLoopStageKeySchema = z.enum(WORK_LOOP_STAGE_KEYS);
export type WorkLoopStageKey = z.infer<typeof WorkLoopStageKeySchema>;

/**
 * One wording for the five stages, whatever the Project is about. The stage
 * keys are the vocabulary the docs use, so they are the labels too.
 */
export const WORK_LOOP_STAGE_LABELS: Record<WorkLoopStageKey, string> = {
  frame: "Frame",
  plan: "Plan",
  act: "Act",
  verify: "Verify",
  conclude: "Conclude",
};

export function workLoopStageLabel(stage: WorkLoopStageKey): string {
  return WORK_LOOP_STAGE_LABELS[stage];
}

/**
 * How one stage move relates to the previous stage.
 *
 * Stages are ordered but movement is not: verification that fails because the
 * method was wrong belongs back at `plan`, and one that fails because the goal
 * was misunderstood belongs back at `frame`. A simple ordered index therefore
 * classifies the move rather than restricting it — `allowed_next` matrices
 * were considered and rejected, because every legal matrix for these five
 * ended up allowing everything.
 */
export const STAGE_TRANSITION_KINDS = ["advance", "regress", "skip", "reopen"] as const;
export const StageTransitionKindSchema = z.enum(STAGE_TRANSITION_KINDS);
export type StageTransitionKind = z.infer<typeof StageTransitionKindSchema>;

export function stageTransitionKind(
  from: WorkLoopStageKey | null,
  to: WorkLoopStageKey,
): StageTransitionKind {
  if (from === null) return "advance";
  const fromIndex = WORK_LOOP_STAGE_KEYS.indexOf(from);
  const toIndex = WORK_LOOP_STAGE_KEYS.indexOf(to);
  if (toIndex === fromIndex) return "reopen";
  if (toIndex < fromIndex) return "regress";
  return toIndex - fromIndex === 1 ? "advance" : "skip";
}

/**
 * Core Project work event kinds.
 *
 * The event stream is the authority for how a Project advanced; the loop-state
 * row and the Task's own columns are folds of it, rebuildable at any time.
 * That is why an "Updates" surface is a filter over this stream rather than a
 * second table: a separate `project_updates` table would let the readable
 * account and the machine record disagree, and there is no version of that
 * disagreement anyone can resolve afterwards.
 *
 * Governance-bearing metadata (endpoints, who may write) lives in the
 * server-side registry (`modules/projectWork/eventKinds.ts`), which modules
 * and plugins register into. This module carries the vocabulary and nothing
 * else, exactly as `linkTypes.ts` does for edges.
 */
export const PROJECT_WORK_EVENT_KINDS = [
  // Task lifecycle
  "task.created",
  "task.flow_changed",
  "task.stage_changed",
  "task.accepted",
  "task.responsibility_changed",
  // Execution outcomes folded into Project state
  "task.run_settled",
  // Readable account: what an actor did and concluded. `task.reported` closes
  // out one Task; `project.reported` is the periodic cross-Task summary.
  "task.reported",
  "project.reported",
  // Inquiry advancement. An Agent creates, archives, concludes and adopts a
  // next step directly (ADR 0017 §2), so these are how a person sees what it
  // did and how they undo it — the counterpart the direct write is
  // conditional on.
  "thread.created",
  "thread.archived",
  "thread.reopened",
  "thread.concluded",
  "thread.next_step_adopted",
  // What an Agent chose to remember. Direct, for the same reason and on the
  // same condition (ADR 0003 §2): the person reads it here and archives it in
  // one action.
  "memory.remembered",
  "memory.revised",
  // The reversal, which is itself a row rather than a deletion.
  "memory.archived",
] as const;
export const ProjectWorkEventKindSchema = z.enum(PROJECT_WORK_EVENT_KINDS);
export type ProjectWorkEventKind = z.infer<typeof ProjectWorkEventKindSchema>;

/** Why a Task settled where it did, carried on `task.run_settled`. */
export const RUN_SETTLEMENT_REASONS = [
  "accepted",
  "evaluation_not_accepted",
  "evaluation_missing",
  "required_outputs_missing",
  "run_failed",
  "run_cancelled",
  "supervisor_review",
] as const;
export const RunSettlementReasonSchema = z.enum(RUN_SETTLEMENT_REASONS);
export type RunSettlementReason = z.infer<typeof RunSettlementReasonSchema>;

export const ProjectWorkEventSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    project_id: IdSchema,
    event_kind: ProjectWorkEventKindSchema,
    subject_type: z.string(),
    subject_id: IdSchema,
    actor_id: IdSchema,
    occurred_at: ISODateTimeSchema,
    correlation_id: z.string().nullable(),
    causation_id: z.string().nullable(),
    data_json: z.record(z.string(), z.unknown()),
  })
  .passthrough();
export type ProjectWorkEvent = z.infer<typeof ProjectWorkEventSchema>;

export const TaskLoopStateSchema = z
  .object({
    task_id: IdSchema,
    project_id: IdSchema,
    loop_instance_id: IdSchema,
    current_stage_key: WorkLoopStageKeySchema,
    stage_entered_at: ISODateTimeSchema,
    revision: z.number().int(),
  })
  .passthrough();
export type TaskLoopState = z.infer<typeof TaskLoopStateSchema>;

/**
 * Why a Task cannot close yet.
 *
 * `evaluation` — no evaluation, or one that did not recommend acceptance.
 * `required_output:<artifact_type>` — a declared output with nothing attached.
 *
 * There is deliberately no `gate` token. Gates have no producer, and a token
 * nothing can emit reads to the UI as a permanently unmeetable requirement.
 */
export const TaskCompletionSchema = z
  .object({
    ok: z.boolean(),
    missing: z.array(z.string()),
  })
  .strict();
export type TaskCompletion = z.infer<typeof TaskCompletionSchema>;

export const ResponsibleActorSchema = z
  .object({
    kind: z.enum(["user", "agent"]).nullable(),
    id: IdSchema.nullable(),
    display_name: z.string().nullable(),
  })
  .strict();
export type ResponsibleActor = z.infer<typeof ResponsibleActorSchema>;

export const ProjectBoardCardSchema = z
  .object({
    id: IdSchema,
    title: z.string(),
    status: z.string(),
    priority: z.string(),
    risk_level: z.string(),
    due_at: ISODateTimeSchema.nullable(),
    updated_at: ISODateTimeSchema,
    /**
     * Which lane draws this card. Not always its status: `blocked` is an
     * overlay rather than a column, so a held-up card keeps its own status and
     * is drawn where the work actually sits.
     */
    column_key: z.string(),
    loop_stage: WorkLoopStageKeySchema.nullable(),
    loop_stage_label: z.string().nullable(),
    responsible: ResponsibleActorSchema,
    active_run_count: z.number().int(),
    latest_run_status: z.string().nullable(),
    evaluation_recommendation: z.string().nullable(),
    blocked_reason: z.string().nullable(),
    completion: TaskCompletionSchema,
  })
  .strict();
export type ProjectBoardCard = z.infer<typeof ProjectBoardCardSchema>;

export const ProjectBoardColumnSchema = z
  .object({
    status_key: z.string(),
    label: z.string(),
    wip_limit: z.number().int().nullable(),
    count: z.number().int(),
  })
  .strict();
export type ProjectBoardColumn = z.infer<typeof ProjectBoardColumnSchema>;

export const ProjectBoardResponseSchema = z
  .object({
    project: z.object({
      id: IdSchema,
      name: z.string(),
    }).strict(),
    columns: z.array(ProjectBoardColumnSchema),
    cards: z.array(ProjectBoardCardSchema),
    /** Who asked. The filters below are relative to this person. */
    viewer_user_id: IdSchema,
    /** Whether they may move, close or reassign a card. A viewer sees the
     * Board and drags nothing; without this the drag would 403 after the drop. */
    viewer_can_write: z.boolean(),
    /** Card counts per filter, so the control can show them without a second fetch. */
    filters: z.object({
      all: z.number().int(),
      mine: z.number().int(),
      agent_held: z.number().int(),
      needs_me: z.number().int(),
    }).strict(),
  })
  .strict();
export type ProjectBoardResponse = z.infer<typeof ProjectBoardResponseSchema>;

export const TaskWorkEventSchema = z
  .object({
    id: IdSchema,
    event_kind: z.string(),
    occurred_at: ISODateTimeSchema,
    actor: ResponsibleActorSchema,
    data_json: z.record(z.string(), z.unknown()),
  })
  .strict();
export type TaskWorkEvent = z.infer<typeof TaskWorkEventSchema>;

export const TaskWorkViewResponseSchema = z
  .object({
    task: z.object({
      id: IdSchema,
      project_id: IdSchema.nullable(),
      title: z.string(),
      status: z.string(),
      definition_of_done: z.string().nullable(),
      required_outputs: z.array(z.string()),
      completed_at: ISODateTimeSchema.nullable(),
    }).strict(),
    /** Null until the Task's Loop has been entered. */
    loop: z.object({
      current_stage_key: WorkLoopStageKeySchema,
      stage_entered_at: ISODateTimeSchema,
      revision: z.number().int(),
    }).strict().nullable(),
    /**
     * Stages this Task has actually been in, from the whole event stream.
     *
     * Not derivable from the current stage: a Task that settled straight to
     * `verify` never framed or planned, and a rail that ticked every earlier
     * stage would claim work that never happened. Not derivable from `events`
     * either — that list is capped.
     */
    visited_stage_keys: z.array(WorkLoopStageKeySchema),
    /** Every stage with its Mode label, so the rail needs no client vocabulary. */
    stages: z.array(z.object({
      key: WorkLoopStageKeySchema,
      label: z.string(),
    }).strict()),
    responsible: ResponsibleActorSchema,
    completion: TaskCompletionSchema,
    evaluation: z.object({
      id: IdSchema,
      recommendation: z.string().nullable(),
      summary: z.string().nullable(),
      created_at: ISODateTimeSchema,
    }).strict().nullable(),
    present_outputs: z.array(z.string()),
    /** What this Task is advancing: an Experiment, an Inquiry Thread, a Decision. */
    links: z.array(z.object({
      entity_type: z.string(),
      entity_id: IdSchema,
      role: z.string(),
    }).strict()),
    events: z.array(TaskWorkEventSchema),
    runs: z.array(z.object({
      id: IdSchema,
      status: z.string(),
      role: z.string(),
      created_at: ISODateTimeSchema,
    }).strict()),
  })
  .strict();
export type TaskWorkViewResponse = z.infer<typeof TaskWorkViewResponseSchema>;

export const TaskStageChangeRequestSchema = z
  .object({
    to_stage: WorkLoopStageKeySchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type TaskStageChangeRequest = z.infer<typeof TaskStageChangeRequestSchema>;

/**
 * Acknowledging exactly which requirements are being overridden, rather than a
 * bare force flag: the record of a Task closed early has to say what was
 * skipped, or the completion contract is decorative.
 */
export const TaskCompletionOverrideSchema = z
  .object({
    acknowledged: z.array(z.string()).min(1),
  })
  .strict();
export type TaskCompletionOverride = z.infer<typeof TaskCompletionOverrideSchema>;

/** One binding a Task declares on the way in; the role set mirrors `ck_task_entity_links_role`. */
export const TaskEntityLinkInputSchema = z
  .object({
    entity_type: z.string().trim().min(1).max(64),
    entity_id: IdSchema,
    role: z.enum(["executes", "investigates", "prepares", "references"]),
  })
  .strict();
export type TaskEntityLinkInput = z.infer<typeof TaskEntityLinkInputSchema>;

/** The structured fields of `PATCH /tasks/:id` that a free-form body cannot be trusted to shape. */
export const TaskPatchStructuredFieldsSchema = z
  .object({
    override_completion: TaskCompletionOverrideSchema.nullish(),
    links: z.array(TaskEntityLinkInputSchema).max(32).nullish(),
  })
  .passthrough();

/** A person's own account of where a Project stands. */
export const ProjectUpdateRequestSchema = z
  .object({
    summary: z.string().trim().min(1).max(8_000),
  })
  .strict();
export type ProjectUpdateRequest = z.infer<typeof ProjectUpdateRequestSchema>;

/**
 * One readable account, as the Updates surface renders it.
 *
 * A filter over `project_work_events`, not a table: the readable account and
 * the machine record have to be the same record, or there is a version of
 * events nobody can reconcile.
 */
/**
 * What undoing one update means, when it can be undone at all.
 *
 * Review-after is the counterpart of a direct write (ADR 0017 §4): an Agent
 * creating a Thread without asking is only acceptable while the person can
 * see it here and reverse it in one action. `null` for updates that record
 * something already settled — a report, an acceptance — where there is
 * nothing to put back.
 */
export const ProjectWorkUpdateUndoSchema = z
  .object({
    action: z.enum(["archive_thread", "reopen_thread", "revert_iteration", "archive_memory"]),
    target_id: IdSchema,
  })
  .strict();
export type ProjectWorkUpdateUndo = z.infer<typeof ProjectWorkUpdateUndoSchema>;

const ProjectWorkUpdateBaseSchema = z.object({
  id: IdSchema,
  /**
   * `task.accepted` is here because a Task closing *is* an update, and
   * nothing writes a `task.reported` at close-out — the readable account is
   * written by whoever chose to write one, and a machine acceptance has no
   * author to put words in the mouth of. Rendering the acceptance itself is
   * honest; fabricating prose for it would not be.
   */
  event_kind: ProjectWorkEventKindSchema,
  occurred_at: ISODateTimeSchema,
  actor: ResponsibleActorSchema,
  summary: z.string(),
  outcome: z.string().nullable(),
  /**
   * What the update is about. Null for a Project-level update. Generalised
   * from a Task-only field when Inquiry advancement started appearing here:
   * a stream that can only name Tasks cannot be the record of everything an
   * Agent did.
   */
  subject: z
    .object({ type: z.enum(["task", "inquiry_thread", "memory_entry"]), id: IdSchema, title: z.string() })
    .strict()
    .nullable(),
  undo: ProjectWorkUpdateUndoSchema.nullable(),
  /** Set once a later update reversed this one. */
  undone_by_event_id: IdSchema.nullable(),
});

export const ProjectWorkUpdateSchema = ProjectWorkUpdateBaseSchema.extend({
  /**
   * One turn's writes of one kind, collapsed. Six sub-questions created by one
   * decomposition are one thing that happened, and six rows of it is the
   * per-item ceremony ADR 0017 removed from the approval queue arriving again
   * in the feed. Null when the update stands alone; members carry their own
   * undo, the fold carries none.
   */
  members: z.array(ProjectWorkUpdateBaseSchema).nullable(),
}).strict();
export type ProjectWorkUpdate = z.infer<typeof ProjectWorkUpdateSchema>;

export const ProjectWorkUpdatesResponseSchema = z
  .object({
    items: z.array(ProjectWorkUpdateSchema),
    /** Opaque; pass back as `cursor` for the next page. */
    next_cursor: z.string().nullable(),
    /**
     * Whether this reader may post one. Reading the account and adding to it
     * are different permissions, so the surface has to be told which it has —
     * otherwise a `viewer` is offered a composer that always refuses.
     */
    viewer_can_write: z.boolean(),
  })
  .strict();
export type ProjectWorkUpdatesResponse = z.infer<typeof ProjectWorkUpdatesResponseSchema>;
