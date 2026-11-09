import { z } from 'zod';
import type { PluginOperationManifest } from '@rainver/protocol';
export const input = z.object({
  key: z.string().default('one'),
  value: z.string().default('value')
}).strict();
const output = z.object({
  values: z.array(z.string())
}).strict();
export const jobId = 'plugin.operation_probe.jobs.write';
export const proposalType = 'plugin.operation_probe.record.approve';
const action = (verb: string, kind: 'command' | 'query' = 'command') => ({
  id: `plugin.operation_probe.record.${verb}`,
  version: 1,
  title: verb,
  description: `Probe ${verb}`,
  kind,
  side_effects: kind === 'query' ? 'none' as const : 'durable' as const,
  data_class: 'non_sensitive' as const,
  input_schema: input,
  output_schema: output,
  gate_class: null
});
export const probeManifest: PluginOperationManifest = {
  id: 'operation_probe',
  version: '1.0.0',
  hostApi: 1,
  scope: 'space',
  name: 'Lifecycle probe',
  description: 'Isolated caller-owned lifecycle consumer',
  requires: [],
  permissions: {
    agent: true,
    background: true
  },
  data_access: 'caller_owned',
  entities: [{
    name: 'record'
  }],
  migrations: ['0000_unusual_joseph'],
  jobs: [{
    id: jobId,
    payload_schema: z.object({
      value: z.string(),
      hold: z.boolean().optional()
    }).strict()
  }],
  schedules: [{
    id: 'plugin.operation_probe.schedule.write',
    job: jobId,
    intervalSeconds: 60
  }],
  proposalTypes: [{
    id: proposalType,
    operation: 'plugin.operation_probe.record.propose',
    payload_schema: input
  }],
  web: {
    entries: [{
      id: 'records',
      title: 'Records',
      icon: 'notebook',
      placements: ['navigation', 'project.area', 'project.overview.card']
    }]
  },
  operations: [action('write'), action('list', 'query'), {
    ...action('propose'),
    side_effects: 'proposal',
    gate_class: 'direction',
    proposal_type: proposalType
  }, {
    ...action('enqueue'),
    output_schema: z.object({
      jobId: z.string()
    }).strict()
  }]
};
