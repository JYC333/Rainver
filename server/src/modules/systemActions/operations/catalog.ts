import type { SystemActionDefinition } from '@rainver/protocol';
import type { OperationRegistration } from './types.js';
/** Discovery describes only enabled user operations, never legacy metadata or Agent grants. */
export function catalogRegistration(definitions: ReadonlyMap<string, SystemActionDefinition>): OperationRegistration {
  const definition = definitions.get('system.actions.list');
  if (!definition) throw new Error('Operation catalog definition missing');
  return {
    definition,
    readKind: 'metadata',
    async resolve(_db, _input, actor) {
      return {
        authority: `space:${actor.space_id}`,
        targets: {
          space_id: actor.space_id
        },
        resourceType: 'space',
        resourceId: actor.space_id
      };
    },
    async authorize() {/* Live membership is enforced by core; these are public metadata only. */},
    async execute() {
      return {
        actions: [...definitions.values()].filter(d => d.execution && d.visibility.has("public_api") && d.allowed_actor_types.includes("user")).map(d => ({
          id: d.id,
          version: d.version,
          title: d.title,
          kind: d.execution!.kind
        }))
      };
    }
  };
}
