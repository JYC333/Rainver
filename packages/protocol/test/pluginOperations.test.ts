import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { pluginFrontendEntries, PluginOperationManifestSchema, PluginOperationRefusal, pluginRefusalOf, pluginToolsetExpansion } from '../src/pluginOperations.js';
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
  it('marks a person-only operation explicitly and keeps it out of every Agent toolset', () => {
    const review = {...op, id: 'plugin.probe.record.review', kind: 'command', side_effects: 'durable', actors: ['user']};
    const m = PluginOperationManifestSchema.parse({...base, operations: [op, review]});
    expect(m.operations[1]!.actors).toEqual(['user']);
    expect(pluginToolsetExpansion(m, 'write', 'non_sensitive')).toEqual([]);
    expect(pluginToolsetExpansion(m, 'read', 'non_sensitive').map(p => p.action_id)).toEqual([op.id]);
    for (const actors of [['agent'], ['user', 'agent'], [], 'user']) {
      expect(PluginOperationManifestSchema.safeParse({...base, operations: [op, {...review, actors}]}).success, JSON.stringify(actors)).toBe(false);
    }
  });
  it('declares the read-only Notes port among the typed core ports', () => {
    expect(PluginOperationManifestSchema.parse({...base, core_ports: ['notes.read', 'notes.draft']}).core_ports).toEqual(['notes.read', 'notes.draft']);
    expect(PluginOperationManifestSchema.safeParse({...base, core_ports: ['notes.write']}).success).toBe(false);
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
describe('Project-bound operation manifest', () => {
  const bound = {...base, project_binding: 'required', operations: [{...op, input_schema: z.object({project_id: z.string()}).strict()}]};
  const issues = (manifest: unknown) => {
    const parsed = PluginOperationManifestSchema.safeParse(manifest);
    return parsed.success ? [] : parsed.error.issues.map(i => i.message);
  };
  it('accepts operations that name their Project target', () => {
    expect(PluginOperationManifestSchema.parse(bound).project_binding).toBe('required');
  });
  it('refuses an operation whose input cannot carry the Project target', () => {
    expect(issues({...bound, operations: [op]})).toContain('Project-bound operation input must declare project_id');
    // Declared but optional, nullable or defaulted still lets an input arrive without its Project.
    for (const project_id of [z.string().optional(), z.string().nullable(), z.string().nullish(), z.string().default('p')]) {
      expect(issues({...bound, operations: [{...op, input_schema: z.object({project_id}).strict()}]})).toContain('Project-bound operation input must declare project_id');
    }
  });
  it('refuses background work and global navigation until Project-scoped holds exist', () => {
    const job = 'plugin.probe.jobs.run';
    expect(issues({...bound, permissions: {agent: true, background: true}, jobs: [{id: job, payload_schema: z.object({})}]})).toContain('Project-bound packages cannot declare Jobs or schedules');
    expect(issues({...bound, web: {entries: [{id: 'records', title: 'Records', placements: ['navigation', 'project.area']}]}})).toContain('Project-bound web entries live inside a Project');
    expect(issues({...bound, web: {entries: [{id: 'records', title: 'Records', placements: ['project.area', 'project.overview.card']}]}})).toEqual([]);
  });
  it('rejects any other binding mode', () => {
    expect(issues({...bound, project_binding: 'optional'}).length).toBeGreaterThan(0);
  });
});
describe('plugin business refusals', () => {
  it('recognises a refusal by shape, including one from a separately compiled package', () => {
    expect(pluginRefusalOf(new PluginOperationRefusal('conflict', 'revision_conflict'))).toEqual({kind: 'conflict', reason: 'revision_conflict'});
    expect(pluginRefusalOf(Object.assign(new Error('x'), {name: 'PluginOperationRefusal', kind: 'invalid', reason: 'not_found'}))).toEqual({kind: 'invalid', reason: 'not_found'});
  });
  it('treats anything else as an internal error: other errors, other kinds, free text reasons', () => {
    expect(pluginRefusalOf(new Error('revision_conflict'))).toBeUndefined();
    expect(pluginRefusalOf(Object.assign(new Error('x'), {name: 'PluginOperationRefusal', kind: 'forbidden', reason: 'x'}))).toBeUndefined();
    expect(pluginRefusalOf(new PluginOperationRefusal('conflict', 'Record of Ada was changed'))).toBeUndefined();
    expect(pluginRefusalOf(null)).toBeUndefined();
  });
});
