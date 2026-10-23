import type {
  RuntimeSessionConfigDroppedSelection,
  RuntimeSessionConfigOption,
  RuntimeSessionConfigSelection,
} from "@rainver/protocol";

export class ConversationSessionConfigError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

/**
 * Validates a selection the person asked for in this request. Strict: an
 * option or value the backend no longer advertises is refused with 422, so
 * the person sees at once that the choice they just made cannot be honoured.
 */
export function validateSessionConfig(
  requested: RuntimeSessionConfigSelection[],
  advertised: RuntimeSessionConfigOption[],
): RuntimeSessionConfigSelection[] {
  const seen = new Set<string>();
  return requested.map((selection) => {
    if (seen.has(selection.id)) throw new ConversationSessionConfigError(`Session option '${selection.id}' was selected more than once`, 422);
    seen.add(selection.id);
    const problem = selectionProblem(selection, advertised);
    if (problem) throw new ConversationSessionConfigError(problem.message, 422);
    return selection;
  });
}

/**
 * Applies a selection nobody chose in this request: one saved on the
 * conversation binding, or inherited from the last Run's snapshot. A CLI or
 * adapter update can withdraw an option or one of its values after it was
 * saved; failing every later turn and delegation on that would hold the
 * conversation hostage to a setting the person did not touch. The stale entry
 * is dropped instead — the runtime keeps its own default for it — and named in
 * `dropped`, which the Run records so the conversation can say so.
 */
export function reconcileSavedSessionConfig(
  saved: unknown,
  advertised: RuntimeSessionConfigOption[],
): { selections: RuntimeSessionConfigSelection[]; dropped: RuntimeSessionConfigDroppedSelection[] } {
  const selections: RuntimeSessionConfigSelection[] = [];
  const dropped: RuntimeSessionConfigDroppedSelection[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(saved) ? saved : []) {
    const selection = savedSelection(entry);
    if (!selection || seen.has(selection.id)) continue;
    seen.add(selection.id);
    const problem = selectionProblem(selection, advertised);
    if (problem) {
      dropped.push({ id: selection.id, category: selection.category, value: selection.value, reason: problem.reason });
    } else {
      selections.push(selection);
    }
  }
  return { selections, dropped };
}

/** The selections a Run applies, and whether the person asked for them in this request. */
export interface ResolvedSessionConfig {
  selections: RuntimeSessionConfigSelection[];
  dropped: RuntimeSessionConfigDroppedSelection[];
  source: "request" | "saved";
}

export const NO_SESSION_CONFIG: ResolvedSessionConfig = { selections: [], dropped: [], source: "saved" };

/**
 * An explicit selection in the request is strict; without one the saved or
 * inherited selection is reconciled against what the backend offers now.
 */
export async function resolveSessionConfig(
  requested: RuntimeSessionConfigSelection[] | null | undefined,
  saved: () => Promise<unknown>,
  advertised: RuntimeSessionConfigOption[],
): Promise<ResolvedSessionConfig> {
  if (requested) return { selections: validateSessionConfig(requested, advertised), dropped: [], source: "request" };
  return { ...reconcileSavedSessionConfig(await saved(), advertised), source: "saved" };
}

/**
 * The Run's `model_override_json` fields for its session options. A saved
 * selection is marked so the ACP controller falls back to the runtime default
 * when the live session withdrew it since the snapshot was taken, rather than
 * failing the turn (`runs/cliConversationProtocol.ts`).
 */
export function sessionConfigRunOverride(config: ResolvedSessionConfig): Record<string, unknown> {
  return {
    ...(config.selections.length ? { acp_session_config: config.selections } : {}),
    ...(config.selections.length && config.source === "saved" ? { acp_session_config_source: "saved" } : {}),
    ...(config.dropped.length ? { acp_session_config_dropped: config.dropped } : {}),
  };
}

function selectionProblem(
  selection: RuntimeSessionConfigSelection,
  advertised: RuntimeSessionConfigOption[],
): { reason: RuntimeSessionConfigDroppedSelection["reason"]; message: string } | null {
  const option = advertised.find((candidate) => candidate.id === selection.id);
  if (!option || option.type !== selection.type || option.category !== selection.category) {
    return { reason: "option_unavailable", message: `Session option '${selection.id}' is not available for this backend` };
  }
  if (option.type === "select") {
    if (typeof selection.value !== "string" || !option.options.some((choice) => choice.value === selection.value)) {
      return { reason: "value_unavailable", message: `Value for session option '${selection.id}' is not available` };
    }
  } else if (typeof selection.value !== "boolean") {
    return { reason: "value_unavailable", message: `Value for session option '${selection.id}' must be boolean` };
  }
  return null;
}

/** A stored selection in the shape the protocol defines, or null for a malformed row. */
function savedSelection(entry: unknown): RuntimeSessionConfigSelection | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const item = entry as Record<string, unknown>;
  const type = item.type === "select" || item.type === "boolean" ? item.type : null;
  const category = typeof item.category === "string" || item.category === null ? item.category : undefined;
  if (typeof item.id !== "string" || !item.id.trim() || !type || category === undefined) return null;
  if (typeof item.value !== "string" && typeof item.value !== "boolean") return null;
  return { id: item.id, type, value: item.value, category };
}
