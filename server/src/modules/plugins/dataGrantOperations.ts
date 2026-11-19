import {PLUGIN_DATA_ACCESS_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {listAgentDataReads} from '../contentAccess/agentReads.js';
import {PluginDataGrantRepository,type GrantCreate} from './dataGrantRepository.js';

type Id = keyof typeof PLUGIN_DATA_ACCESS_OPERATION_SCHEMAS;
const person = (a: OperationActor) => ({spaceId: a.space_id, userId: a.on_behalf_of_user_id!});

/**
 * Person-only consent and attribution operations (ADR 0030). Every replay
 * re-reads the grant under the current actor: a person who lost the role or
 * ownership does not receive a stored receipt.
 */
export function pluginDataAccessRegistrations(defs: ReadonlyMap<string, RegisteredSystemActionDefinition>, config: ServerConfig): OperationRegistration[] {
  return (Object.keys(PLUGIN_DATA_ACCESS_OPERATION_SCHEMAS) as Id[]).map(id => {
    const repo = (db: Parameters<OperationRegistration['execute']>[0]) => new PluginDataGrantRepository(db, config);
    const query = id.endsWith('.list');
    return {
      definition: defs.get(id)!,
      ...(query ? {readKind: 'metadata' as const} : {}),
      successStatus: id === 'plugin_data_grant.create' ? 201 : 200,
      async resolve(_db, raw, a) {
        const i = raw as {grant_id?: string; run_id?: string; target_run_id?: string};
        return {authority: `plugin-data-grant:${a.space_id}:${a.on_behalf_of_user_id}`, targets: raw, resourceType: id === 'agent_data_read.list' ? 'agent_data_read' : 'plugin_data_grant', resourceId: i.grant_id ?? i.run_id ?? i.target_run_id ?? null};
      },
      async authorize(db, raw, a) {
        if (id === 'plugin_data_grant.revoke' && !await repo(db).get(person(a), (raw as {grant_id: string}).grant_id)) throw hidden();
      },
      async authorizeResult(db, raw, a) {
        const out = raw as {id?: string; run_id?: string};
        if ((id === 'plugin_data_grant.create' || id === 'plugin_data_grant.revoke') && (!out.id || !await repo(db).get(person(a), out.id))) throw hidden();
      },
      async execute(db, raw, a) {
        const r = repo(db), who = person(a);
        switch (id) {
          case 'plugin_data_grant.create': return r.create(who, raw as GrantCreate);
          case 'plugin_data_grant.revoke': return r.revoke(who, (raw as {grant_id: string}).grant_id);
          case 'plugin_data_grant.revoke_run': return r.revokeRun(who, (raw as {run_id: string}).run_id);
          case 'plugin_data_grant.list': return r.list(who, raw as {plugin_id?: string; status?: string; run_id?: string});
          case 'agent_data_read.list': {
            const i = raw as {run_id?: string; limit: number};
            return listAgentDataReads(db, {spaceId: a.space_id, ownerUserId: who.userId, runId: i.run_id, limit: i.limit});
          }
        }
      },
      // 403/404 become the executor's uniform hidden refusal.
      classifyError: error => error instanceof HttpError ? markedRefusal(error, 'plugins') : undefined,
    } satisfies OperationRegistration;
  });
}
