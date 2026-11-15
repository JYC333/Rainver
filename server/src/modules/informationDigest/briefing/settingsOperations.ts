import type { OperationActor, OperationInput, RegisteredSystemActionDefinition } from '@rainver/protocol';
import type { Queryable } from '../../routeUtils/common.js';
import { HttpError } from '../../routeUtils/common.js';
import { lockActivePerson } from '../../access/activePerson.js';
import { assertProjectWriterForMutation, assertProjectReadableLocked } from '../../projects/access.js';
import { hidden, markedRefusal, OperationError } from '../../systemActions/operations/errors.js';
import type { OperationRegistration } from '../../systemActions/operations/types.js';
import { personalBriefingScope } from './personalScope.js';
import { projectBriefingScope } from './projectScope.js';
import { setDailyBriefing } from './schedule.js';

type Input = OperationInput<'briefing.personal.settings.set'> | OperationInput<'briefing.project.settings.set'>;
// This historical surface is conditionally retired only after scope authority.
// Keep its 410 and domain reason through the formal error envelope.
export class ProjectBriefingReplaced extends OperationError {
  constructor() { super('operation_result_unavailable', 410, false, 'information_digest'); }
  override body(requestId: string) {
    const body = super.body(requestId);
    body.error.message = 'Project daily analysis is managed by Following';
    body.error.metadata = { code: 'project_daily_briefing_replaced' };
    return body;
  }
}
async function admit(db: Queryable, input: {space_id:string;project_id?:string}, actor: OperationActor) {
  if (input.space_id !== actor.space_id || !actor.on_behalf_of_user_id) throw hidden();
  if (input.project_id) {
    await assertProjectReadableLocked(db, actor.space_id, input.project_id, actor.on_behalf_of_user_id);
    await assertProjectWriterForMutation(db, actor.space_id, input.project_id, actor.on_behalf_of_user_id);
  }
  await lockActivePerson(db, actor.space_id, actor.on_behalf_of_user_id);
}
export function briefingSettingsRegistrations(definitions: ReadonlyMap<string,RegisteredSystemActionDefinition>): OperationRegistration[] {
  return (['briefing.personal.settings.set','briefing.project.settings.set'] as const).map(id => ({
    definition: definitions.get(id)!,
    async resolve(_db,raw,actor) {
      const input=raw as Input;
      return {authority:`briefing-settings:${actor.space_id}:${'project_id' in input?input.project_id:actor.on_behalf_of_user_id}`,targets:{...input,user_id:actor.on_behalf_of_user_id},resourceType:'space',resourceId:input.space_id};
    },
    async authorize(db,raw,actor) {
      await admit(db,raw as Input,actor);
      if ('project_id' in (raw as Input)) throw new ProjectBriefingReplaced();
    },
    async authorizeResult(db,raw,actor) {
      const output=raw as {space_id:string;project_id?:string;user_id:string};
      if(output.user_id!==actor.on_behalf_of_user_id)throw hidden();
      await admit(db,output,actor);
    },
    classifyError:error=>error instanceof HttpError?markedRefusal(error,'information_digest'):undefined,
    async execute(db,raw,actor) {
      const input=raw as Input, user=actor.on_behalf_of_user_id!;
      const adapter='project_id' in input?projectBriefingScope(actor.space_id,input.project_id):personalBriefingScope(actor.space_id,user);
      const result=await setDailyBriefing(db,adapter,user,input);
      return {space_id:actor.space_id,user_id:user,...('project_id' in input?{project_id:input.project_id}:{}),daily_enabled:result.enabled};
    },
  }));
}
