import { estimateModelTokens, trimTextToModelTokens, trimTextToModelTokensFromEnd } from "../../usage/modelCatalog.js";

/**
 * The one CLI replay budget, independent of the vendor's model capacity: an
 * incremental delta above it rotates to a reconstruction, and a
 * reconstruction (checkpoint, coverage notice and history together) fits it.
 */
export const CLI_REPLAY_TOKENS = 6_000;

/** The most of that budget a semantic checkpoint takes; a larger one is excerpted. */
export const CLI_CHECKPOINT_TOKENS = 3_000;

const RECONSTRUCTION_HEADER = "Rainver canonical continuity reconstruction:";
const COVERAGE_NOTICE_RESERVE = 300;

export interface CliDeltaEvent {
  id: string;
  scope_sequence: number;
  event_type: string;
  canonical_type: string;
  canonical_id: string;
  content: string | null;
  /** The producing Run's status, when the event has one. */
  run_status?: string | null;
}

const FAILED_RUN_STATUSES = new Set(["failed", "cancelled", "orphaned"]);

// Keep these in the audit ledger; generic progress is not useful model context.
const PROGRESS_EVENTS = new Set([
  "model.text_delta", "model.tool_call_delta", "tool_call_started",
  "invocation_finalized",
]);

function historyEvents(events: CliDeltaEvent[]): CliDeltaEvent[] {
  return events.filter((event) => !PROGRESS_EVENTS.has(event.event_type)
    && !(event.event_type === "tool_call_completed"
      && (!event.content?.trim() || event.content.trim() === "Tool call completed.")));
}

function eventText(event: CliDeltaEvent): string {
  // What a failed attempt left behind is one fact, not a transcript: the
  // ledger keeps every event, the model gets the outcome once.
  if (event.event_type === "assistant_message_completed" && event.run_status && FAILED_RUN_STATUSES.has(event.run_status)) {
    return `- earlier attempt ${event.run_status}: ${event.content?.trim() || event.canonical_type}`;
  }
  return event.content?.trim()
    ? `- ${event.event_type}: ${event.content.trim()}`
    : `- ${event.event_type} (${event.canonical_type})`;
}

const FAILED_ATTEMPT_LINE = "- earlier attempt ";

export function renderCliEventDelta(events: CliDeltaEvent[]): string | null {
  // Repeated attempts leave the same notice; it is said once. Any other
  // repeated line is a real repetition in the conversation and stays.
  const seenFailures = new Set<string>();
  const lines = historyEvents(events).map(eventText).filter((line) => {
    if (!line.startsWith(FAILED_ATTEMPT_LINE)) return true;
    if (seenFailures.has(line)) return false;
    seenFailures.add(line);
    return true;
  });
  return lines.length ? [
    "Rainver context changes since the last acknowledged CLI delivery:",
    ...lines,
  ].join("\n") : null;
}

/**
 * Select recent reference history before it becomes a pinned ContextItem.
 * Current input and standing instructions are separate items. The validated
 * semantic checkpoint rendered here shares the replay budget: up to
 * `CLI_CHECKPOINT_TOKENS` verbatim, beyond that a labelled excerpt, and history
 * gets what the checkpoint leaves. The ledger, the checkpoint row and event
 * refs retain the complete record.
 */
export function renderCliReconstruction(checkpoint: unknown, events: CliDeltaEvent[]): string | null {
  const meaningful = historyEvents(events);
  if (!checkpoint && meaningful.length === 0) return null;
  const checkpointBlock = checkpoint ? renderCheckpoint(checkpoint) : [];
  const lines: string[] = [];
  // Every block is joined by a blank line; charge each separator too.
  let remaining = CLI_REPLAY_TOKENS - COVERAGE_NOTICE_RESERVE
    - estimateModelTokens(RECONSTRUCTION_HEADER)
    - checkpointBlock.reduce((sum, block) => sum + estimateModelTokens(`${block}\n\n`), 0);
  let omitted = 0;
  for (let index = meaningful.length - 1; index >= 0; index -= 1) {
    const event = meaningful[index]!;
    const line = eventText(event);
    const tokens = estimateModelTokens(`${line}\n\n`);
    if (tokens > remaining) {
      // Do not drop the latest large reply completely. Its excerpt is explicitly
      // labelled as incomplete and linked to its canonical source.
      const notice = `- Excerpt of ${event.event_type} (${event.canonical_type}:${event.canonical_id}); beginning omitted:\n`;
      const excerptBudget = remaining - estimateModelTokens(notice) - 2;
      if (excerptBudget > 0) {
        lines.unshift(notice + trimTextToModelTokensFromEnd(event.content ?? line, excerptBudget));
      }
      omitted = index + 1;
      break;
    }
    lines.unshift(line);
    remaining -= tokens;
  }
  return [
    RECONSTRUCTION_HEADER,
    ...checkpointBlock,
    ...(omitted ? [
      `History coverage: ${omitted} older event(s), through sequence ${meaningful[omitted - 1]!.scope_sequence},`
      + " are omitted or excerpted to fit the history budget. Full canonical records remain in Rainver;"
      + " this is not a complete summary. Do not infer decisions or completed work from omitted history.",
    ] : []),
    ...lines,
  ].join("\n\n");
}

function renderCheckpoint(checkpoint: unknown): string[] {
  const text = JSON.stringify(checkpoint);
  if (estimateModelTokens(text) <= CLI_CHECKPOINT_TOKENS) return ["Validated semantic checkpoint:", text];
  return [
    "Validated semantic checkpoint (excerpt: its end is omitted to fit the replay budget, so it is not"
    + " valid JSON; the complete checkpoint remains in Rainver. Do not infer anything from the omitted part):",
    trimTextToModelTokens(text, CLI_CHECKPOINT_TOKENS),
  ];
}
