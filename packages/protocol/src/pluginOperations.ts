import { z } from 'zod';
import { SystemActionGateClassSchema } from './systemActions.js';
import type { Queryable } from './plugins.js';
import type { OperationActor, OperationOutcome } from './operations.js';
export type PluginOperationId = `plugin.${string}.${string}.${string}`;
const schemaValue = z.custom<z.ZodType>(v => typeof (v as z.ZodType)?.safeParse === 'function');
export const PluginWebEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  title: z.string().min(1).max(100),
  icon: z.string().regex(/^[a-z][a-z-]*$/).default('puzzle'),
  placements: z.array(z.enum(['navigation', 'project.area', 'project.overview.card'])).min(1)
}).strict();
export type PluginWebEntry = z.infer<typeof PluginWebEntrySchema>;
/** Deterministic routes: manifests cannot replace core paths or carry executable URLs. */
export function pluginFrontendEntries(manifest: {
  id: string;
  web?: {
    entries: PluginWebEntry[];
  };
}) {
  return (manifest.web?.entries ?? []).map(e => ({
    module_id: `plugin.${manifest.id}.${e.id}`,
    entry_id: e.id,
    label: e.title,
    path: `/plugins/${manifest.id}/${e.id}`,
    icon: e.icon,
    section: 'knowledge',
    group: 'work',
    placements: e.placements
  }));
}
export const PLUGIN_CORE_PORTS = ['tasks.create', 'relations.person.create', 'memory.propose', 'artifacts.create', 'references.resolve', 'notes.read', 'notes.draft'] as const;
export type PluginCorePortId = typeof PLUGIN_CORE_PORTS[number];
export const PluginOperationManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  hostApi: z.literal(1),
  scope: z.enum(['space', 'user']),
  name: z.string().min(1),
  description: z.string().min(1),
  requires: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,23}$/)).default([]),
  permissions: z.object({
    agent: z.boolean(),
    background: z.boolean().optional()
  }).strict(),
  /** Caller-owned data eligibility; domain SQL review is mandatory, not enforced by this label. Cross-person content needs a canonical B11 resource adapter. */
  data_access: z.literal('caller_owned'),
  /**
   * `required`: a Project-level package. Enablement at `scope` is only admission;
   * each operation also targets one Project (`project_id` in its input) that an
   * owner-level person bound the package to. The host resolves and authorizes
   * that target for every entry; see OFFICIAL_OPTIONAL_MODULES "Project binding".
   */
  project_binding: z.literal('required').optional(),
  entities: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    exemption: z.string().min(1).optional(),
    /** Floor for every operation on this entity; an operation may only raise it. */
    data_class: z.enum(['non_sensitive', 'personal', 'sensitive']).optional()
  }).strict()),
  web: z.object({
    entries: z.array(PluginWebEntrySchema).min(1)
  }).strict().optional(),
  migrations: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).optional(),
  /** Typed core-object host ports the operations use (ADR 0030); undeclared ports are absent. */
  core_ports: z.array(z.enum(PLUGIN_CORE_PORTS)).optional(),
  jobs: z.array(z.object({
    id: z.string().max(128),
    payload_schema: schemaValue
  }).strict()).optional(),
  schedules: z.array(z.object({
    id: z.string().max(128),
    job: z.string(),
    intervalSeconds: z.number().int().positive(),
    runOnStart: z.boolean().optional()
  }).strict()).optional(),
  proposalTypes: z.array(z.object({
    id: z.string().max(64),
    operation: z.string(),
    payload_schema: schemaValue
  }).strict()).optional(),
  operations: z.array(z.object({
    id: z.string().max(128).regex(/^plugin\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
    version: z.number().int().positive(),
    title: z.string().min(1),
    description: z.string().min(1),
    kind: z.enum(['command', 'query']),
    side_effects: z.enum(['none', 'durable', 'proposal']),
    /** non_sensitive is the normal class; personal/sensitive need data-side consent (ADR 0030). */
    data_class: z.enum(['non_sensitive', 'personal', 'sensitive']),
    input_schema: schemaValue,
    output_schema: schemaValue,
    proposal_type: z.string().optional(),
    gate_class: SystemActionGateClassSchema.nullable(),
    /**
     * `['user']`: a person-only operation (for example, recording that the person
     * reviewed a text), modeled as its own operation rather than an actor check
     * inside an executor. It is never an Agent tool and never joins a toolset.
     * Absent: the package's `permissions.agent` decides.
     */
    actors: z.tuple([z.literal('user')]).optional()
  }).strict()).min(1)
}).strict().superRefine((m, ctx) => {
  if (new Set(m.web?.entries.map(e => e.id)).size !== (m.web?.entries.length ?? 0)) ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Duplicate web entry'
  });
  const ids = new Set<string>();
  for (const op of m.operations) {
    if (ids.has(op.id) || !op.id.startsWith(`plugin.${m.id}.`) || !m.entities.some(e => e.name === op.id.split('.')[2]) || op.kind === 'query' !== (op.side_effects === 'none') || op.side_effects === 'proposal' && !op.gate_class || op.kind === 'query' && op.gate_class !== null) ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid operation namespace/effect/duplicate'
    });
    ids.add(op.id);
  }
  const names = new Set(ids);
  for (const contribution of [...(m.jobs ?? []), ...(m.schedules ?? []), ...(m.proposalTypes ?? [])]) {
    if (!new RegExp(`^plugin\\.${m.id}\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$`).test(contribution.id) || names.has(contribution.id)) ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid contribution namespace/duplicate'
    });
    names.add(contribution.id);
  }
  if ((m.jobs?.length ?? 0) + (m.schedules?.length ?? 0) > 0 && !m.permissions.background) ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Background permission required'
  });
  for (const s of m.schedules ?? []) if (!m.jobs?.some(j => j.id === s.job)) ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Schedule job undeclared'
  });
  for (const t of m.proposalTypes ?? []) if (!m.operations.some(o => o.id === t.operation && o.side_effects === 'proposal' && o.proposal_type === t.id)) ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Proposal operation mismatch'
  });
  for (const o of m.operations) if (o.proposal_type && !m.proposalTypes?.some(t => t.id === o.proposal_type && t.operation === o.id)) ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Proposal type undeclared'
  });
  if (m.project_binding) {
    // Every entry names its Project, so the host can authorize it before plugin code runs.
    for (const op of m.operations) if (!pluginInputDeclaresProject(op.input_schema)) ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Project-bound operation input must declare project_id'
    });
    // Project-scoped holds/cleanup do not exist yet; Space/user Jobs would outlive an unbind.
    if ((m.jobs?.length ?? 0) + (m.schedules?.length ?? 0) > 0) ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Project-bound packages cannot declare Jobs or schedules'
    });
    if (m.web?.entries.some(e => e.placements.includes('navigation'))) ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Project-bound web entries live inside a Project'
    });
  }
  for (const op of m.operations) {
    const floor = m.entities.find(e => e.name === op.id.split('.')[2])?.data_class;
    if (floor && PLUGIN_DATA_CLASS_RANK[op.data_class] < PLUGIN_DATA_CLASS_RANK[floor]) ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Operation data class below its entity floor'
    });
  }
  for (const entity of m.entities) {
    if (!entity.exemption && (!m.operations.some(o => o.id === `plugin.${m.id}.${entity.name}.list` && o.kind === 'query') || !m.operations.some(o => o.id.startsWith(`plugin.${m.id}.${entity.name}.`) && o.kind === 'command'))) ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Entity requires list and command coverage or exemption'
    });
  }
});
export type PluginOperationManifest = z.infer<typeof PluginOperationManifestSchema>;
/**
 * A Project-bound operation's input is an object schema whose `project_id` is
 * required and never null: an input without its Project target must fail the
 * declared schema, not reach the host gate as "no Project".
 */
export function pluginInputDeclaresProject(schema: z.ZodType): boolean {
  const shape = (schema as {shape?: Record<string, unknown>}).shape;
  const field = shape && typeof shape === 'object' ? shape.project_id : undefined;
  return field instanceof z.ZodType && !field.isOptional() && !field.isNullable();
}
export type PluginDataClass = 'non_sensitive' | 'personal' | 'sensitive';
export const PLUGIN_DATA_CLASS_RANK: Readonly<Record<PluginDataClass, number>> = Object.freeze({ non_sensitive: 0, personal: 1, sensitive: 2 });
export type PluginToolset = 'read' | 'write';
/** One pinned tool of a toolset expansion; any field change is a re-consent trigger. */
export interface PluginToolPin {
  action_id: string;
  action_version: number;
  data_class: PluginDataClass;
  side_effects: 'none' | 'durable' | 'proposal';
  gate_class: string | null;
}
/**
 * Toolset expansion, computed when a grant is written and pinned there. Read
 * is the query set, write the command set; write never implies read and there
 * is no wildcard toolset. Only tools of exactly `dataClass` are expanded.
 */
export function pluginToolsetExpansion(manifest: PluginOperationManifest, toolset: PluginToolset, dataClass: PluginDataClass): PluginToolPin[] {
  return manifest.operations
    .filter(o => (toolset === 'read' ? o.kind === 'query' : o.kind === 'command') && o.data_class === dataClass && !o.actors)
    .map(o => ({ action_id: o.id, action_version: o.version, data_class: o.data_class, side_effects: o.side_effects, gate_class: o.gate_class ?? null }))
    .sort((a, b) => a.action_id.localeCompare(b.action_id));
}
export interface PluginToolsetDiff {
  /** Added tools stay inactive until re-consent; normal-read auto-extension is not enabled. */
  added: string[];
  /** Removed tools shrink the grant. */
  removed: string[];
  /** Version, side-effect, data-class or gate change: inactive until re-consent. */
  changed: string[];
}
export function diffPluginToolset(pinned: readonly PluginToolPin[], current: readonly PluginToolPin[]): PluginToolsetDiff {
  const before = new Map(pinned.map(p => [p.action_id, p])), after = new Map(current.map(p => [p.action_id, p]));
  const same = (a: PluginToolPin, b: PluginToolPin) => a.action_version === b.action_version && a.data_class === b.data_class && a.side_effects === b.side_effects && a.gate_class === b.gate_class;
  return {
    added: [...after.keys()].filter(k => !before.has(k)).sort(),
    removed: [...before.keys()].filter(k => !after.has(k)).sort(),
    changed: [...after.entries()].filter(([k, v]) => before.has(k) && !same(before.get(k)!, v)).map(([k]) => k).sort()
  };
}
/** Host-created per invocation, scoped to one transaction. No raw pool or lifecycle methods. */
export interface PluginDb extends Queryable {
  transaction<T>(scope: {
    spaceId: string;
    userId: string;
  }, fn: (db: Queryable) => Promise<T>): Promise<T>;
}
export interface PluginOperationContext {
  readonly db: PluginDb;
  readonly actor: Readonly<OperationActor>;
  readonly jobs?: PluginJobIntents;
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Declared typed core-object ports, executed by the canonical owners in this transaction. */
  readonly core?: PluginCorePorts;
  /** Host-supplied scope and read attribution for the bundled Applications queries. */
  readonly applicationRead?: {
    readonly projectOnly: boolean;
    record(ids: readonly string[]): void;
    recordRelatedApplications?(ids: readonly string[]): void;
  };
}
/**
 * Typed core-object host ports. Each runs the owning module's canonical writer
 * or read gate for the invoking actor inside the operation transaction, under
 * that core action's own actor eligibility and policy; there is no general
 * core SQL or entity API. Memory is proposal-only (B10).
 */
export interface PluginCorePorts {
  tasks?: { create(input: { project_id: string; title: string; description?: string; due_at?: string }): Promise<{ task_id: string }> };
  relations?: { createPerson(input: { project_id: string; title: string }): Promise<{ object_id: string }> };
  memory?: { propose(input: { title: string; content: string }): Promise<{ proposal_id: string }> };
  /** Commands only: a private inline Artifact (at most 64 KiB) in a Project the person writes. */
  artifacts?: { create(input: { project_id: string; title: string; content: string; format?: 'markdown' | 'text' }): Promise<{ artifact_id: string }> };
  /** Queries only: resolved for every current reader of the output, then rechecked and audited at release. */
  /**
   * `resolve` (queries only) returns a title the release gate rechecks for every reader.
   * `verify` (commands too) answers only whether the object may be referenced now: it
   * exists, every current reader reads it, and for a Project-bound operation it belongs
   * to the bound Project. Both refuse another Project's object for a Project-bound operation.
   */
  references?: {
    resolve(ref: { type: 'task' | 'artifact' | 'space_object'; id: string }): Promise<{ type: string; id: string; title: string | null } | null>;
    verify(ref: { type: 'task' | 'artifact' | 'space_object'; id: string }): Promise<boolean>;
  };
  /**
   * Notes (`notes.read`), read through Knowledge's own revision reader under
   * the live content ACL. A Note qualifies when it is active, every current
   * reader reads it fully, and its Project closure stays inside the bound
   * Project: a Note of this Project, or a Project-free personal Note (a
   * reusable CV or experience note); another Project's Note, or one shared
   * to or from another Project, is refused. `verify` (commands too) answers
   * only that, the current version number and whether the Note is shared in
   * the bound Project. A command output carries no Note content.
   * `read` (queries only) returns one revision — the current one
   * unless `version` is given — and its text only with `body: true`; the release
   * gate rechecks and audits the Note before the result leaves.
   */
  notes?: {
    verify(ref: { note_id: string; version?: number }): Promise<{ current_version: number; project_shared?: boolean } | null>;
    read(ref: { note_id: string; version?: number; body?: boolean }): Promise<PluginNoteRevision | null>;
  };
  /**
   * Generated Note drafts (`notes.draft`) for the person who asks. The bundled
   * Applications plugin can start and save via a manual Agent turn. Preview
   * still requires the requester to be the only reader.
   * `start` (commands) queues one private provider-task Run of the person over pinned
   * Note revisions that qualify as for `notes.read` and that the Source egress rules let go
   * to the resolved provider (`egress_denied` otherwise); the revisions are read and
   * rechecked when the Run is dispatched, before each send and again when its result is
   * saved, never copied into the request. Only the person reads the Run (no Space
   * oversight). `read` (queries) returns one generation this package started for the
   * person in the bound Project; the release gate rechecks its input Notes. `apply`
   * (commands) writes a succeeded draft once through Knowledge's own Note operations, as a
   * new version of a Note no one else reads, oversight included (`expect_version` must
   * still match), or as a new Project-free private Note where the ordinary creation rule
   * keeps it in this Space (`placement_unavailable` otherwise); a concurrent edit is
   * returned as `conflict`, a Note someone else can read as `not_private`. Whether a draft
   * was already applied is the plugin's record.
   */
  drafts?: {
    start(input: { project_id: string; inputs: Array<{ note_id: string; version: number }>; instruction: string; provider_id?: string | null; model?: string | null }): Promise<
      | { outcome: 'queued'; run_id: string }
      | { outcome: 'unavailable' | 'busy' | 'provider_unavailable' | 'egress_denied' }>;
    read(input: { run_id: string }): Promise<PluginNoteDraft | null>;
    apply(input: { run_id: string; note_id: string | null; expect_version: number | null; title: string }): Promise<
      | { outcome: 'written'; note_id: string; version: number }
      | { outcome: 'conflict'; current_version: number }
      | { outcome: 'not_private' | 'unavailable' | 'not_ready' | 'placement_unavailable' }>;
  };
}
/** One generated draft as `notes.draft` returns it. */
export interface PluginNoteDraft {
  run_id: string;
  /** The Run's status; `succeeded` carries a draft. */
  status: string;
  created_at: string;
  inputs: Array<{ note_id: string; version: number }>;
  /** Plain text, at most `PLUGIN_NOTE_DRAFT_TEXT_MAX` characters. */
  draft: string | null;
  /** Statements the person must check before using the text (facts the model could not ground). */
  verify: string[];
  /** The pinned inputs the model reports it drew on (others it named are dropped). */
  sources_used: Array<{ note_id: string; version: number }>;
  /** A short failure code when the Run did not produce a draft. */
  error_code: string | null;
  /** Whether `apply` can create a new Note here (the creation rule keeps it in this Space). */
  save_new: boolean;
}
/** Bounds of one generated draft (the text is kept on its Run, whose output strings stay under 32 000 characters). */
export const PLUGIN_NOTE_DRAFT_TEXT_MAX = 30_000;
export const PLUGIN_NOTE_DRAFT_INPUTS_MAX = 20;
export const PLUGIN_NOTE_DRAFT_INSTRUCTION_MAX = 8_000;
export const PLUGIN_NOTE_DRAFT_VERIFY_MAX = 20;
/** One Note revision as the `notes.read` port returns it. Text is plain text, bounded by `PLUGIN_NOTE_TEXT_MAX`. */
export interface PluginNoteRevision {
  note_id: string;
  title: string | null;
  current_version: number;
  version: number;
  content_hash: string;
  created_at: string;
  text: string | null;
  truncated: boolean;
}
/** Characters of Note text one `notes.read` call returns; longer text is cut and marked `truncated`. */
export const PLUGIN_NOTE_TEXT_MAX = 200_000;
export type PluginOperationExecutor = (input: unknown, ctx: PluginOperationContext) => Promise<unknown>;
/**
 * A deterministic business refusal a plugin executor or proposal applier may
 * throw: `conflict` becomes `operation_conflict` (409), `invalid`
 * `operation_invalid_input` (422), both with `{reason}` as metadata. The
 * transaction still rolls back. `reason` is a short code the plugin's own UI
 * translates; it never carries record content. Any other thrown error stays an
 * internal error.
 */
export class PluginOperationRefusal extends Error {
  override readonly name = 'PluginOperationRefusal';
  constructor(readonly kind: 'conflict' | 'invalid', readonly reason: string) {
    super(reason);
  }
}
const PLUGIN_REFUSAL_REASON = /^[a-z][a-z0-9_]{0,63}$/;
/** Recognised by shape, so a separately compiled package's class instance still matches. */
export function pluginRefusalOf(error: unknown): {kind: 'conflict' | 'invalid'; reason: string} | undefined {
  if (!error || typeof error !== 'object' || (error as {name?: unknown}).name !== 'PluginOperationRefusal') return undefined;
  const {kind, reason} = error as {kind?: unknown; reason?: unknown};
  return (kind === 'conflict' || kind === 'invalid') && typeof reason === 'string' && PLUGIN_REFUSAL_REASON.test(reason) ? {kind, reason} : undefined;
}
export interface PluginActionPort {
  register(id: PluginOperationId, execute: PluginOperationExecutor): void;
}
export interface PluginJobIntents {
  enqueue(type: string, payload: Record<string, unknown>): Promise<{
    jobId: string;
  }>;
}
export interface PluginScope {
  spaceId: string;
  userId: string;
}
/** A handle on a Job's scope hold that outlives the handler; the hold stays a durable cleanup obligation until `release`. */
export interface PluginRetainedEffects {
  readonly signal: AbortSignal;
  /** Same contract as `PluginBackgroundContext.onDispose`; after `release` it throws `PluginRegistrationClosed`. */
  onDispose(dispose: () => Promise<void> | void): () => Promise<void>;
  release(): void;
}
export interface PluginBackgroundContext extends PluginOperationContext {
  readonly signal: AbortSignal;
  readonly jobId: string;
  /**
   * Registers a dispose callback for a resource of this Job; it runs outside
   * every transaction, only in an attempt the host claimed against the hold's
   * durable counter (at most three per cleanup round). Registration is open
   * while the handler runs. With `disposeRegistration: 'handler'` it closes
   * when the handler settles, and a later call throws an error named
   * `PluginRegistrationClosed` (use `retain()` before creating a resource that
   * outlives the handler). Without it (the original contract) it stays open
   * until the process ends, so the Job's scope hold remains a cleanup
   * obligation: after a disable it is never recorded released and the scope
   * cannot be re-enabled until this process has ended.
   *
   * The returned function disposes that resource early, through the same
   * claimed attempts: it resolves at once once the callback succeeded (never
   * run again) and shares an invocation in flight. It rejects with an error
   * named `PluginDisposeRefused`, without running the callback, inside the
   * Job's open transaction and when no attempt can be claimed (not due after a
   * failure, the round's three attempts spent, no owner lease); the host's
   * cleanup round, or a new disable round, retries it. A rejected invocation
   * may be retried.
   */
  onDispose(dispose: () => Promise<void> | void): () => Promise<void>;
  /**
   * For a resource created after the handler returns: resolves once the host
   * durably confirmed this Job's hold as a cleanup obligation of its
   * generation (so no enable can see the scope clean); rejects, with nothing
   * registered, when it cannot (the generation already ended, no lease, a DB
   * fault).
   */
  retain(): Promise<PluginRetainedEffects>;
}
export interface PluginJobOptions {
  /**
   * `'handler'`: the bounded registration contract (see
   * `PluginBackgroundContext.onDispose`). Omitted: the original contract.
   */
  readonly disposeRegistration?: 'handler';
}
export interface PluginProposalOptions {
  readonly preconditions?: (input: unknown, ctx: PluginOperationContext, phase: 'propose' | 'approve') => Promise<unknown>;
}
export interface PluginLifecyclePort {
  jobs: {
    register(id: string, handler: (payload: unknown, ctx: PluginBackgroundContext) => Promise<Record<string, unknown>>, options?: PluginJobOptions): () => void;
  };
  schedules: {
    register(id: string, payload: (scope: PluginScope) => Promise<Record<string, unknown>>): () => void;
  };
  proposals: {
    /**
     * `preconditions` (optional) reads, as the requester, the state the decision is about.
     * The host freezes its output with the request and re-reads it on approval; a
     * different value supersedes the Proposal instead of applying a stale decision.
     * Validate new proposals in the `propose` phase. In `approve`, return the
     * current state even if it would now prevent a new proposal.
     */
    register(id: string, apply: PluginOperationExecutor, options?: PluginProposalOptions): () => void;
  };
}

/** Browser-neutral host contract. UI packages define the structural controls they consume; no app/server import is needed. */
export interface PluginViewOps {
  query<T = unknown>(id: PluginOperationId, input: unknown): Promise<OperationOutcome<T>>;
  command<T = unknown>(id: PluginOperationId, input: unknown, key: string): Promise<OperationOutcome<T>>;
}
export interface PluginViewContext<UI> {
  readonly spaceId: string;
  readonly projectId: string | null;
  readonly projectCanWrite?: boolean;
  /** Host live invalidation. Reread through ops without remounting the view. */
  readonly projectRevision?: number;
  readonly ops: PluginViewOps;
  readonly ui: UI;
}
