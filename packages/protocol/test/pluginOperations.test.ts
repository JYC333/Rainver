import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { pluginFrontendEntries, PluginOperationManifestSchema } from '../src/pluginOperations.js';
const op = {
  id: 'plugin.probe.record.list',
  version: 1,
  title: 'List',
  description: 'List records',
  kind: 'query',
  side_effects: 'none',
  data_class: 'non_sensitive',
  input_schema: z.object({}),
  output_schema: z.object({}),
  gate_class: null
};
const base = {
  id: 'probe',
  version: '1.0.0',
  hostApi: 1,
  name: 'Probe',
  description: 'Fixture',
  scope: 'space',
  requires: [],
  permissions: {
    agent: true
  },
  data_access: 'caller_owned',
  entities: [{
    name: 'record',
    exemption: 'Read-only catalog'
  }],
  operations: [op]
};
describe('operation manifest authority', () => {
  it('accepts a bounded namespace and explicit entity coverage', () => {
    expect(PluginOperationManifestSchema.parse(base).operations[0]!.id).toBe(op.id);
  });
  it.each(['task.create', 'plugin.other.record.list', 'plugin.probe.record.list.extra', 'plugin.probe.record.' + 'x'.repeat(129)])('refuses foreign/invalid namespace %s', id => {
    expect(PluginOperationManifestSchema.safeParse({
      ...base,
      operations: [{
        ...op,
        id
      }]
    }).success).toBe(false);
  });
  it('refuses duplicate definitions, undeclared ownership and query effects', () => {
    expect(PluginOperationManifestSchema.safeParse({
      ...base,
      operations: [op, op]
    }).success).toBe(false);
    expect(PluginOperationManifestSchema.safeParse({
      ...base,
      operations: [{
        ...op,
        id: 'plugin.probe.orphan.list'
      }]
    }).success).toBe(false);
    expect(PluginOperationManifestSchema.safeParse({
      ...base,
      entities: [{
        name: 'record'
      }]
    }).success).toBe(false);
    expect(PluginOperationManifestSchema.safeParse({
      ...base,
      operations: [{
        ...op,
        side_effects: 'durable'
      }]
    }).success).toBe(false);
    expect(PluginOperationManifestSchema.safeParse({
      ...base,
      operations: [{
        ...op,
        kind: 'command',
        side_effects: 'proposal'
      }]
    }).success).toBe(false);
  });
  it('fails closed for unsupported API, unknown permissions and cross-person content', () => {
    expect(PluginOperationManifestSchema.safeParse({
      ...base,
      hostApi: 2
    }).success).toBe(false);
    expect(PluginOperationManifestSchema.safeParse({
      ...base,
      permissions: {
        agent: true,
        core_write: true
      }
    }).success).toBe(false);
    expect(PluginOperationManifestSchema.safeParse({
      ...base,
      data_access: 'cross_person'
    }).success).toBe(false);
  });
});
describe('manifest lifecycle authority', () => {
  const job = {
    id: 'plugin.probe.jobs.write',
    payload_schema: z.object({
      value: z.string()
    })
  };
  it('requires explicit background permission and declared scheduled jobs', () => {
    expect(PluginOperationManifestSchema.safeParse({
      ...base,
      jobs: [job]
    }).success).toBe(false);
    const ready = {
      ...base,
      permissions: {
        agent: true,
        background: true
      },
      jobs: [job],
      schedules: [{
        id: 'plugin.probe.schedule.write',
        job: job.id,
        intervalSeconds: 60
      }]
    };
    expect(PluginOperationManifestSchema.safeParse(ready).success).toBe(true);
    expect(PluginOperationManifestSchema.safeParse({
      ...ready,
      jobs: []
    }).success).toBe(false);
    expect(PluginOperationManifestSchema.safeParse({
      ...ready,
      jobs: [{
        ...job,
        id: op.id
      }]
    }).success).toBe(false);
    expect(PluginOperationManifestSchema.safeParse({
      ...ready,
      requires: ['../foreign']
    }).success).toBe(false);
  });
  it('links typed proposal contributions only to their declared proposal-class action', () => {
    const proposed = {
      ...op,
      id: 'plugin.probe.record.propose',
      kind: 'command',
      side_effects: 'proposal',
      gate_class: 'direction',
      proposal_type: 'plugin.probe.record.approve'
    };
    const spec = {
      id: proposed.proposal_type,
      operation: proposed.id,
      payload_schema: z.object({})
    };
    const ready = {
      ...base,
      operations: [op, proposed],
      proposalTypes: [spec]
    };
    expect(PluginOperationManifestSchema.safeParse(ready).success).toBe(true);
    expect(PluginOperationManifestSchema.safeParse({
      ...ready,
      proposalTypes: []
    }).success).toBe(false);
    expect(PluginOperationManifestSchema.safeParse({
      ...ready,
      proposalTypes: [{
        ...spec,
        operation: op.id
      }]
    }).success).toBe(false);
    expect(PluginOperationManifestSchema.safeParse({
      ...ready,
      proposalTypes: [{
        ...spec,
        id: 'plugin.probe.record.' + 'a'.repeat(70)
      }]
    }).success).toBe(false);
  });
});


it('derives navigation and typed Project placements from one declaration and refuses executable paths',()=>{
 const entry={id:'records',title:'Records',icon:'notebook',placements:['navigation','project.area','project.overview.card']};
 const parsed=PluginOperationManifestSchema.parse({...base,web:{entries:[entry]}});
 expect(pluginFrontendEntries(parsed)).toEqual([{module_id:'plugin.probe.records',entry_id:'records',label:'Records',path:'/plugins/probe/records',icon:'notebook',section:'knowledge',group:'work',placements:entry.placements}]);
 for(const web of [{entries:[entry,entry]},{entries:[{...entry,id:'../core'}]},{entries:[{...entry,url:'https://external.test/code.js'}]},{entries:[{...entry,placements:['unknown']}]}])expect(PluginOperationManifestSchema.safeParse({...base,web}).success).toBe(false);
});
