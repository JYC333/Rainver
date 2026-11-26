import type {OperationActor, PluginDataClass} from '@rainver/protocol';
import {operationTransaction} from '../../db/operationTransaction.js';
import {recordAgentDataRead} from '../contentAccess/agentReads.js';
import {ContentAccessAuditService} from '../contentAccess/audit.js';
import type {Queryable} from '../routeUtils/common.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {withPluginDb} from './operationDb.js';
import {assertPluginProjectAudience} from './projectBindings.js';

const projectReadTables: Readonly<Record<string, string>> = {
  'plugin.phd_application.application.list': 'applications',
  'plugin.phd_application.application.get': 'applications',
  'plugin.phd_application.application.summary': 'applications',
  'plugin.phd_application.contact.list': 'application_contacts',
  'plugin.phd_application.contact.list_events': 'application_contacts',
  'plugin.phd_application.library.list': 'application_library_items',
};

export const applicationProjectQueries: ReadonlySet<string> = new Set(Object.keys(projectReadTables));

/** Recheck every released row with the Applications role, then audit under the host role. */
export async function releaseApplicationReads(db: Queryable, actor: OperationActor, projectId: string, actionId: string, ids: string[], audience: string[] | undefined, projectOnly: boolean, consent: {dataClass: PluginDataClass; grantId: string | null} | undefined, relatedTable?: 'applications') {
  const person = actor.on_behalf_of_user_id!;
  const readers = audience ?? [person];
  await assertPluginProjectAudience(db, actor.space_id, projectId, readers);
  if (!ids.length) return;
  const table = relatedTable ?? projectReadTables[actionId];
  if (!table) throw new OperationError('operation_audit_unavailable', 503, true);

  const transaction = operationTransaction(db);
  let rows: {id: string; user_id: string}[];
  try {
    rows = await withPluginDb(transaction.db, 'phd_application', actor, async pluginDb => (await pluginDb.query<{id: string; user_id: string}>(
      `SELECT id,user_id FROM ${table} WHERE space_id=current_setting('rainver.space_id') AND project_id=$1
         AND id=ANY($2::text[]) AND (project_shared OR ($3 AND user_id=current_setting('rainver.user_id')))
       ORDER BY id,user_id FOR SHARE`,
      [projectId, ids, !projectOnly],
    )).rows);
  } finally {
    transaction.close();
  }
  if (rows.length !== ids.length) throw new OperationError('operation_audit_unavailable', 503, true);
  await new ContentAccessAuditService(db).recordApplicationReads({
    spaceId: actor.space_id, rows, readers, agentId: actor.agent_id, runId: actor.run_id,
  });
  if (actor.principal.kind === 'agent' && actor.run_id) {
    const own = rows.filter(row => row.user_id === person).map(row => row.id);
    if (own.length) await recordAgentDataRead(db, {
      spaceId: actor.space_id, ownerUserId: person, resourceType: 'plugin.phd_application', resourceIds: own,
      agentId: actor.agent_id, runId: actor.run_id, actionId, dataClass: consent?.dataClass ?? 'non_sensitive', grantId: consent?.grantId ?? null,
    });
  }
}
