import type {
  ActionPreviewTurnPart,
  PlanTurnPart,
  ToolCallStatus,
  TurnPart,
  TurnPartSource,
  TurnState,
} from "@rainver/protocol";

/**
 * One Agent turn, folded from whichever event log recorded it.
 *
 * A turn on a paired host writes `host_thread_events`; a managed turn writes
 * `run_events`. Both fold into the same ordered `TurnPart[]`, so no surface
 * that renders a conversation needs to know which happened.
 *
 * Pure: the functions here take rows and return parts. Loading the rows,
 * deciding who may see them, and streaming the result all live elsewhere.
 *
 * The two logs carry different amounts, and the projection reports that
 * difference rather than smoothing it over — see `TurnPart` in the protocol
 * for what each backend can and cannot say.
 */

/** A `host_thread_events` row, in the shape the projection needs. */
export interface HostThreadEventRow {
  event_index: number;
  event_type: string;
  text: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input_summary: string | null;
  tool_kind: string | null;
  tool_result_summary: string | null;
  status: string | null;
}

/** A `run_events` row, in the shape the projection needs. */
export interface RunEventRow {
  event_index: number;
  event_type: string;
  status: string;
  summary: string | null;
  error_code: string | null;
  error_message: string | null;
  metadata_json: unknown;
}

/**
 * A part without its index, distributed over the union rather than collapsed
 * to the keys every member shares — `Omit` over a union keeps only the common
 * fields, which for `TurnPart` is just `type`.
 */
type UnindexedTurnPart = TurnPart extends infer Part
  ? Part extends { index: number } ? Omit<Part, "index"> : never
  : never;

export interface TurnProjection {
  parts: TurnPart[];
  /**
   * How far the turn got *according to this log*.
   *
   * `loadRunTurn` does not use it: the Run's own status and `chat_completed`
   * decide the turn's state, because neither log can see the whole picture —
   * a reaped Run writes no event at all, and a host log never holds the
   * `chat_completed` that says the reply exists. It is kept because the
   * projection is a pure function that should be answerable on its own terms.
   */
  state: TurnState;
  source: TurnPartSource;
  cursor: number;
}

/**
 * The turn as recorded on a paired host.
 *
 * This follows Zed's ACP thread model: session updates are consumed in order,
 * while every tool call is an entry keyed by `tool_call_id`. A `tool_call`
 * upserts that entry and every `tool_call_update` patches it in place, so
 * pending, in-progress and terminal states never become separate rows.
 */
export function projectHostThreadTurn(rows: readonly HostThreadEventRow[]): TurnProjection {
  const parts: TurnPart[] = [];
  const toolIndexByCallId = new Map<string, number>();
  let openText: { kind: "text" | "reasoning"; index: number } | null = null;
  let state: TurnState = "working";
  let cursor = 0;

  const append = (part: UnindexedTurnPart): number => {
    const index = parts.length;
    parts.push({ ...part, index } as TurnPart);
    return index;
  };

  for (const row of rows) {
    cursor = Math.max(cursor, row.event_index);
    switch (row.event_type) {
      case "assistant_text":
      case "assistant_thought": {
        if (!row.text) break;
        const kind: "text" | "reasoning" =
          row.event_type === "assistant_text" ? "text" : "reasoning";
        if (openText !== null && openText.kind === kind) {
          const existing = parts[openText.index] as { text: string };
          existing.text += row.text;
        } else {
          const index: number = kind === "text"
            ? append({ type: "text", text: row.text })
            : append({ type: "reasoning", text: row.text });
          openText = { kind, index };
        }
        break;
      }
      case "tool_activity_started": {
        const existingIndex = row.tool_call_id
          ? toolIndexByCallId.get(row.tool_call_id)
          : undefined;
        if (existingIndex !== undefined) {
          const existing = parts[existingIndex] as Extract<TurnPart, { type: "tool_call" }>;
          if (row.tool_name) existing.name = row.tool_name;
          if (row.tool_kind) existing.kind = row.tool_kind;
          if (row.tool_input_summary) existing.input = row.tool_input_summary;
          existing.status = toolStatus(row.status, existing.status);
          existing.output = row.tool_result_summary ?? existing.output;
          break;
        }
        openText = null;
        const index = append({
          type: "tool_call",
          call_id: row.tool_call_id,
          name: toolLabel(row.tool_name, row.tool_kind),
          kind: row.tool_kind,
          status: toolStatus(row.status, "running"),
          input: row.tool_input_summary,
          output: row.tool_result_summary,
        });
        if (row.tool_call_id) toolIndexByCallId.set(row.tool_call_id, index);
        break;
      }
      case "tool_activity_finished": {
        const index = row.tool_call_id ? toolIndexByCallId.get(row.tool_call_id) : undefined;
        if (index === undefined) {
          // Zed treats an update without its ToolCall as a protocol error. Do
          // the same instead of inventing a generic successful `tool` row.
          openText = null;
          const missingIndex = append({
            type: "tool_call",
            call_id: row.tool_call_id,
            name: "Tool call not found",
            kind: "fetch",
            status: "failed",
            input: null,
            output: "Tool call not found",
          });
          if (row.tool_call_id) toolIndexByCallId.set(row.tool_call_id, missingIndex);
          break;
        }
        const existing = parts[index] as Extract<TurnPart, { type: "tool_call" }>;
        if (row.tool_name) existing.name = row.tool_name;
        if (row.tool_kind) existing.kind = row.tool_kind;
        if (row.tool_input_summary) existing.input = row.tool_input_summary;
        existing.status = toolStatus(row.status, existing.status);
        existing.output = row.tool_result_summary ?? existing.output;
        break;
      }
      case "diagnostic": {
        if (!row.text) break;
        openText = null;
        append({ type: "diagnostic", level: "info", text: row.text, error_code: null });
        break;
      }
      case "plan_updated": {
        openText = null;
        const entries = parsePlanEntries(row.text);
        if (!entries) break;
        // Snapshots, not deltas: the newest replaces the last rather than
        // adding a second checklist to the turn.
        const existingPlan = parts.findIndex((part) => part.type === "plan");
        if (existingPlan >= 0) (parts[existingPlan] as PlanTurnPart).entries = entries;
        else {
          openText = null;
          append({ type: "plan", entries });
        }
        break;
      }
      case "status": {
        // Only ever downgrades to failed, for the same reason
        // `state_transition` does on the managed side: the host writes this
        // from inside the adapter, before it returns, which is several steps
        // before the reply is written. The turn is finished by
        // `chat_completed`, or by the Run's own status for work that is not
        // a conversation.
        if (runStatusToTurnState(row.status) === "failed") state = "failed";
        break;
      }
      default:
        break;
    }
  }

  return { parts, state, source: "host_thread_events", cursor };
}

/**
 * The turn as recorded by a managed Run.
 *
 * `run_events` is a semantic log, not a transcript: it records that a tool
 * ran, not what it was given or what it returned, and it does not record the
 * assistant's prose at all — the reply is a message, and text only exists
 * live, on the delta stream. So the caller passes the final reply in, and the
 * parts carry what this backend genuinely reported.
 */
export function projectRunEventTurn(
  rows: readonly RunEventRow[],
  input: { replyText?: string | null } = {},
): TurnProjection {
  const parts: TurnPart[] = [];
  const toolIndexByCallId = new Map<string, number>();
  let state: TurnState = "working";
  let cursor = 0;

  const append = (part: UnindexedTurnPart): number => {
    const index = parts.length;
    parts.push({ ...part, index } as TurnPart);
    return index;
  };

  /**
   * Records why a turn failed, once.
   *
   * Several events can carry the same failure — the runtime's own `error`,
   * then `adapter_completed`, then `chat_completed` restating it — and a
   * reader wants the reason, not three copies of it.
   */
  const appendFailure = (row: RunEventRow): void => {
    const text = row.error_message ?? row.summary;
    if (!text) return;
    const already = parts.some((part) =>
      part.type === "diagnostic" && part.level === "error" && part.text === text);
    if (already) return;
    append({ type: "diagnostic", level: "error", text, error_code: row.error_code });
  };

  for (const row of rows) {
    cursor = Math.max(cursor, row.event_index);
    const metadata = recordValue(row.metadata_json);
    const callId = stringValue(metadata.call_id);
    switch (row.event_type) {
      case "tool_call_started": {
        const existingIndex = callId ? toolIndexByCallId.get(callId) : undefined;
        if (existingIndex !== undefined) {
          const existing = parts[existingIndex] as Extract<TurnPart, { type: "tool_call" }>;
          existing.name = stringValue(metadata.tool_name) ?? existing.name;
          existing.status = "running";
          break;
        }
        const index = append({
          type: "tool_call",
          call_id: callId,
          name: toolLabel(stringValue(metadata.tool_name), null),
          kind: null,
          status: "running",
          input: null,
          output: null,
        });
        if (callId) toolIndexByCallId.set(callId, index);
        break;
      }
      case "tool_call_completed":
      case "tool_call_failed": {
        const status: ToolCallStatus = row.event_type === "tool_call_failed" ? "failed" : "succeeded";
        const index = callId ? toolIndexByCallId.get(callId) : undefined;
        if (index === undefined) {
          const missingIndex = append({
            type: "tool_call",
            call_id: callId,
            name: "Tool call not found",
            kind: "fetch",
            status: "failed",
            input: null,
            output: "Tool call not found",
          });
          if (callId) toolIndexByCallId.set(callId, missingIndex);
          break;
        }
        (parts[index] as { status: ToolCallStatus }).status = status;
        break;
      }
      case "warning": {
        if (!row.summary) break;
        append({ type: "diagnostic", level: "warning", text: row.summary, error_code: row.error_code });
        break;
      }
      case "error": {
        appendFailure(row);
        if (!row.error_message && !row.summary) {
          append({
            type: "diagnostic", level: "error",
            text: "The runtime reported an error.", error_code: row.error_code,
          });
        }
        state = "failed";
        break;
      }
      case "state_transition": {
        // Only ever downgrades to failed. `succeeded` here means the adapter
        // returned, which is several steps before the turn is finished — see
        // `chat_completed`.
        if (runStatusToTurnState(stringValue(recordValue(row.metadata_json).state)) === "failed") {
          state = "failed";
        }
        break;
      }
      case "chat_completed": {
        // Appended after the assistant message, so this is the one event that
        // says the reply exists. `loadRunTurn` treats it as the terminal for
        // a chat turn on either backend — it is folded in here too so the
        // pure projection is right on its own.
        state = row.status === "failed" ? "failed" : "done";
        // It also carries why the turn failed, which for most failures is the
        // only place that says. A preparation error — no credential, denied
        // by policy, workspace unavailable — never reaches the runtime, so
        // there is no runtime `error` event to describe it.
        if (row.status === "failed") appendFailure(row);
        break;
      }
      case "adapter_completed": {
        // The terminal for a Run that failed before or during preparation;
        // there is no `chat_completed` on that path when the Run is not a
        // conversation, and no runtime event either.
        if (row.status === "failed") {
          appendFailure(row);
          state = "failed";
        }
        break;
      }
      case "run_finalized": {
        // The turn is over for work that is not a conversation; a chat turn's
        // reply is still being written at this point, and `chat_completed`
        // above is what reports it.
        if (row.status === "failed") {
          appendFailure(row);
          state = "failed";
        }
        break;
      }
      default:
        break;
    }
  }

  // The reply comes last, after the steps that produced it — which is the
  // order D3 renders: the work folds up above, the answer is the bubble.
  if (input.replyText) {
    parts.push({ type: "text", index: parts.length, text: input.replyText });
  }

  return { parts, state, source: "run_events", cursor };
}

/**
 * The Proposals a turn raised, as parts.
 *
 * These do not come from either event log — they are rows the Run created —
 * so they are appended after the projection rather than folded into it.
 */
export function appendActionPreviewParts(
  projection: TurnProjection,
  previews: readonly Omit<ActionPreviewTurnPart, "type" | "index">[],
): TurnProjection {
  const parts = [...projection.parts];
  for (const preview of previews) {
    parts.push({ ...preview, type: "action_preview", index: parts.length });
  }
  return { ...projection, parts };
}

function toolStatus(status: string | null, fallback: ToolCallStatus): ToolCallStatus {
  if (status === "pending") return "pending";
  if (status === "failed") return "failed";
  if (status === "in_progress") return "running";
  if (status === "completed" || status === "succeeded") return "succeeded";
  return fallback;
}

function toolLabel(name: string | null, kind: string | null): string {
  return name ?? kind ?? "Tool call";
}

function runStatusToTurnState(status: string | null | undefined): TurnState | null {
  switch (status) {
    case "run_started":
      return "working";
    case "run_succeeded":
    case "succeeded":
      return "done";
    case "run_failed":
    case "run_timeout":
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function parsePlanEntries(text: string | null): PlanTurnPart["entries"] | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((raw) => (raw && typeof raw === "object" ? raw as Record<string, unknown> : null))
      .filter((raw): raw is Record<string, unknown> => raw !== null && typeof raw.content === "string")
      .map((raw) => ({
        content: raw.content as string,
        status: typeof raw.status === "string" ? raw.status : "pending",
        ...(typeof raw.priority === "string" ? { priority: raw.priority } : {}),
      }));
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
