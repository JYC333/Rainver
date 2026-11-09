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
  entities: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    exemption: z.string().min(1).optional()
  }).strict()),
  web: z.object({
    entries: z.array(PluginWebEntrySchema).min(1)
  }).strict().optional(),
  migrations: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).optional(),
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
    data_class: z.enum(['non_sensitive', 'sensitive']),
    input_schema: schemaValue,
    output_schema: schemaValue,
    proposal_type: z.string().optional(),
    gate_class: SystemActionGateClassSchema.nullable()
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
  for (const entity of m.entities) {
    if (!entity.exemption && (!m.operations.some(o => o.id === `plugin.${m.id}.${entity.name}.list` && o.kind === 'query') || !m.operations.some(o => o.id.startsWith(`plugin.${m.id}.${entity.name}.`) && o.kind === 'command'))) ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Entity requires list and command coverage or exemption'
    });
  }
});
export type PluginOperationManifest = z.infer<typeof PluginOperationManifestSchema>;
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
}
export type PluginOperationExecutor = (input: unknown, ctx: PluginOperationContext) => Promise<unknown>;
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
export interface PluginBackgroundContext extends PluginOperationContext {
  readonly signal: AbortSignal;
  readonly jobId: string;
  onDispose(dispose: () => Promise<void> | void): () => Promise<void>;
}
export interface PluginLifecyclePort {
  jobs: {
    register(id: string, handler: (payload: unknown, ctx: PluginBackgroundContext) => Promise<Record<string, unknown>>): () => void;
  };
  schedules: {
    register(id: string, payload: (scope: PluginScope) => Promise<Record<string, unknown>>): () => void;
  };
  proposals: {
    register(id: string, apply: PluginOperationExecutor): () => void;
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
  readonly ops: PluginViewOps;
  readonly ui: UI;
}
