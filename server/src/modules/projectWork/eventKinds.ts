import { PROJECT_WORK_EVENT_KINDS, type ProjectWorkEventKind } from "@rainver/protocol";

/**
 * Which subjects each Project work event kind may be written about, and who
 * declared it.
 *
 * The column carries a format check only, the same trade the ontology made for
 * `link_type`: a closed-set CHECK on a shared table forces every new domain to
 * edit that table, and three mutually inconsistent CHECKs is what the ontology
 * audit actually found when nobody did. The trade is only safe while something
 * asks the registry on the write path — `assertWorkEventKind` is that
 * something, and it is called from the one writer.
 *
 * Open for modules and plugins to register into, for the same reason link
 * types are: a declaration needs an implementation behind it, so it belongs in
 * code, but that must not mean only the core can extend the vocabulary.
 */

export interface WorkEventKindDefinition {
  kind: ProjectWorkEventKind;
  /** Entity types this kind may name as its subject. */
  subjects: readonly string[];
  /** Module that registered it, for attribution in diagnostics. */
  owner: string;
}

const registry = new Map<ProjectWorkEventKind, WorkEventKindDefinition>();

export function registerWorkEventKind(definition: WorkEventKindDefinition): void {
  const existing = registry.get(definition.kind);
  if (existing && existing.owner !== definition.owner) {
    throw new Error(
      `Work event kind ${definition.kind} is already declared by ${existing.owner}`,
    );
  }
  registry.set(definition.kind, definition);
}

export function workEventKindDefinition(kind: string): WorkEventKindDefinition | null {
  return registry.get(kind as ProjectWorkEventKind) ?? null;
}

export function registeredWorkEventKinds(): readonly WorkEventKindDefinition[] {
  return [...registry.values()];
}

function registerCoreWorkEventKinds(): void {
  const taskKinds: readonly ProjectWorkEventKind[] = [
    "task.created",
    "task.flow_changed",
    "task.stage_changed",
    "task.accepted",
    "task.responsibility_changed",
    "task.run_settled",
    "task.reported",
  ];
  for (const kind of taskKinds) {
    registerWorkEventKind({ kind, subjects: ["task"], owner: "projectWork" });
  }
  registerWorkEventKind({
    kind: "project.reported",
    subjects: ["project"],
    owner: "projectWork",
  });
  // Inquiry advancement. Declared here rather than from the inquiry module so
  // the vocabulary is complete the moment the registry is imported: the
  // protocol/registry agreement test does not depend on which module happened
  // to be loaded first.
  const threadKinds: readonly ProjectWorkEventKind[] = [
    "thread.created",
    "thread.archived",
    "thread.reopened",
    "thread.concluded",
    "thread.next_step_adopted",
  ];
  for (const kind of threadKinds) {
    registerWorkEventKind({ kind, subjects: ["inquiry_thread"], owner: "inquiry" });
  }
  // Memory's direct writes, declared here for the same reason as the Inquiry
  // kinds: the vocabulary must be complete when the registry is imported.
  for (const kind of ["memory.remembered", "memory.revised", "memory.archived"] as const) {
    registerWorkEventKind({ kind, subjects: ["memory_entry"], owner: "memory" });
  }
}

registerCoreWorkEventKinds();

/**
 * Whether a protocol vocabulary value has a declaration here. The protocol
 * package carries the client-facing vocabulary and no behaviour; a test
 * asserts the two agree, so a kind cannot be renderable without being
 * writable.
 */
export function hasWorkEventKindDeclaration(kind: string): boolean {
  return registry.has(kind as ProjectWorkEventKind);
}

export function coreWorkEventKindCount(): number {
  return PROJECT_WORK_EVENT_KINDS.length;
}
