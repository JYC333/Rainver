import { createHash } from 'node:crypto';
import { systemActionInputJsonSchema, PluginOperationManifestSchema, type RainverPlugin } from '@rainver/protocol';
import { canonical } from '../systemActions/operations/repository.js';
/** Admission contract identity, not a code signature or a hostile-code sandbox. */
export function operationPackageIdentity(plugin: RainverPlugin): string {
  const m = PluginOperationManifestSchema.parse(plugin.operationManifest);
  const spec = {
    id: m.id,
    version: m.version,
    hostApi: m.hostApi,
    web:m.web,
    scope: m.scope,
    permissions: m.permissions,
    data_access: m.data_access,
    requires: m.requires,
    // Present only when declared, so earlier packages keep their admitted contract hash.
    ...(m.project_binding ? {project_binding: m.project_binding} : {}),
    ...(m.core_ports?.length ? {core_ports: [...m.core_ports].sort()} : {}),
    ...(m.entities.some(e => e.data_class) ? {entity_classes: m.entities.map(e => [e.name, e.data_class ?? null])} : {}),
    migrations: plugin.migrations?.map(x => ({
      id: x.id,
      sql: x.sql
    })) ?? [],
    operations: m.operations.map(o => ({
      id: o.id,
      version: o.version,
      kind: o.kind,
      side_effects: o.side_effects,
      data_class: o.data_class,
      gate_class: o.gate_class,
      proposal_type: o.proposal_type,
      ...(o.actors ? {actors: o.actors} : {}),
      input: systemActionInputJsonSchema({
        input_schema: o.input_schema
      }),
      output: systemActionInputJsonSchema({
        input_schema: o.output_schema
      })
    })),
    jobs: m.jobs?.map(j => ({
      id: j.id,
      input: systemActionInputJsonSchema({
        input_schema: j.payload_schema
      })
    })) ?? [],
    schedules: m.schedules ?? [],
    proposalTypes: m.proposalTypes?.map(t => ({
      id: t.id,
      operation: t.operation,
      input: systemActionInputJsonSchema({
        input_schema: t.payload_schema
      })
    })) ?? []
  };
  return createHash('sha256').update(canonical(JSON.parse(JSON.stringify(spec)))).digest('hex');
}
