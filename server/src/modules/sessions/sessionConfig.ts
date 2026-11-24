import type {
  RuntimeSessionConfigDroppedSelection,
  RuntimeSessionConfigOption,
  RuntimeSessionConfigSelection,
} from "@rainver/protocol";

export class ConversationSessionConfigError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

// Rainver's native Claude conversation default. The Host's reported current
// value may come from another application using the same Claude installation.
export const CLAUDE_CONVERSATION_DEFAULT_MODEL = "opus";

export function conversationConfigOptions(
  runtimeKey: string,
  options: RuntimeSessionConfigOption[],
): RuntimeSessionConfigOption[] {
  if (runtimeKey !== "claude_code") return options;
  return options.map(option => {
    if (option.category !== "model" || option.type !== "select") return option;
    const preferred = option.options.find(choice => choice.value === CLAUDE_CONVERSATION_DEFAULT_MODEL);
    if (!preferred) return option;
    return {
      ...option,
      current_value: preferred.value,
      options: option.options.map(choice => choice.value === "default"
        ? { ...choice, description: preferred.name } : choice),
    };
  });
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
 * `dropped`, which the Run records so the conversation can say so. Native
 * Claude conversation model choices are instead preserved for live validation.
 */
export function reconcileSavedSessionConfig(
  saved: unknown,
  advertised: RuntimeSessionConfigOption[],
  runtimeKey?: string,
): { selections: RuntimeSessionConfigSelection[]; dropped: RuntimeSessionConfigDroppedSelection[] } {
  const selections: RuntimeSessionConfigSelection[] = [];
  const dropped: RuntimeSessionConfigDroppedSelection[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(saved) ? saved : []) {
    const selection = savedSelection(entry);
    if (!selection || seen.has(selection.id)) continue;
    seen.add(selection.id);
    const problem = selectionProblem(selection, advertised);
    // Let the live Claude session confirm a saved model, including an
    // already-current model missing from the Host's cached picker.
    if (problem && !(runtimeKey === "claude_code" && selection.category === "model")) {
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
  runtimeKey?: string,
): Promise<ResolvedSessionConfig> {
  if (requested) return { selections: validateSessionConfig(requested, advertised), dropped: [], source: "request" };
  return { ...reconcileSavedSessionConfig(await saved(), advertised, runtimeKey), source: "saved" };
}

/**
 * A server-started turn pinned to the session options its owner confirmed (ADR 0034: the Agent's model
 * for automatic application updates). The saved selection is applied only when it is still exactly the
 * confirmed one and nothing of it would be dropped; it is then strict (`source: "request"`), so the ACP
 * controller fails the turn instead of keeping the runtime's default when the live session does not
 * offer or apply it. Otherwise the turn is refused before it exists.
 */
export function pinnedSessionConfig(
  resolved: ResolvedSessionConfig,
  pinned: readonly RuntimeSessionConfigSelection[],
): ResolvedSessionConfig {
  const key = (items: readonly RuntimeSessionConfigSelection[]) => JSON.stringify([...items]
    .map((item) => [item.id, item.type, item.value, item.category ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  if (resolved.dropped.length || key(resolved.selections) !== key(pinned)) {
    throw new ConversationSessionConfigError("The confirmed model or session options are not available on this runtime now", 409);
  }
  return { selections: resolved.selections, dropped: [], source: "request" };
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
