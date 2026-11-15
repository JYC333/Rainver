import { lockReadingMutation } from '../sources/readingMutationAccess.js';
import { assertFavoriteMaterial, favoriteMaterial } from '../sources/deepReading/service.js';
import { ReadingService } from './readingService.js';
import type { OperationActor, OperationInput, RegisteredSystemActionDefinition } from '@rainver/protocol';
import type { Queryable, SpaceUserIdentity } from '../routeUtils/common.js';
import { HttpError } from '../routeUtils/common.js';
import { assertProjectReadableLocked, lockProjectAudience } from '../projects/access.js';
import { lockSpaceRole } from '../spaces/writers.js';
import { hidden, markedRefusal } from '../systemActions/operations/errors.js';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { ReadingPreferences } from './readingPreferences.js';

type Input = OperationInput<'reading.preference.set'>;
const person = (actor: OperationActor): SpaceUserIdentity => ({ spaceId: actor.space_id, userId: actor.on_behalf_of_user_id! });
async function authorize(db: Queryable, actor: OperationActor, spaceId: string, projectId: string): Promise<void> {
  if (spaceId !== actor.space_id) throw hidden();
  await lockProjectAudience(db, actor.space_id, projectId);
  await lockSpaceRole(db, actor.space_id, actor.on_behalf_of_user_id!);
  await assertProjectReadableLocked(db, actor.space_id, projectId, actor.on_behalf_of_user_id!);
}

export function readingPreferenceRegistration(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration {
  return {
    definition: definitions.get('reading.preference.set')!,domainAuthorizationFirst:true,
    async resolve(_db, raw, actor) {
      const input = raw as Input;
      return { authority: `space:${actor.space_id}`, targets: { space_id: input.space_id, project_id: input.project_id, user_id: actor.on_behalf_of_user_id }, resourceType: 'project', resourceId: input.project_id };
    },
    async authorize(db, raw, actor) {
      const input = raw as Input;
      await authorize(db, actor, input.space_id, input.project_id);
    },
    async authorizeResult(db, raw, actor) {
      const output = raw as { space_id: string; project_id: string; user_id: string };
      if (output.user_id !== actor.on_behalf_of_user_id) throw hidden();
      await authorize(db, actor, output.space_id, output.project_id);
    },
    classifyError(error) { return error instanceof HttpError ? markedRefusal(error, 'reading') : undefined; },
    async execute(db, raw, actor) {
      const input = raw as Input;
      const result = await new ReadingPreferences(db).set(person(actor), input.project_id, input.show_in_my_reading);
      return { space_id: actor.space_id, project_id: input.project_id, user_id: actor.on_behalf_of_user_id!, ...result };
    },
  };
}

export function readingItemRegistrations(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration[] {
  return (['reading.favorite.set', 'reading.project_state.set', 'reading.personal_state.set'] as const).map(id => {
    type Input = OperationInput<typeof id>;
    const check = async (db: Queryable, input: Input, actor: OperationActor) => {
      if (input.space_id !== actor.space_id) throw hidden();
      const project = 'project_id' in input ? input.project_id : undefined;
      const current = async () => {
        if ('favorite' in input) await assertFavoriteMaterial(db, person(actor), project!, input.item_id);
        else await new ReadingService(db).requireState(person(actor), input.item_id, input, project);
      };
      await current();
      await lockReadingMutation(db, person(actor), input.item_id, project);
      await current();
    };
    return {
      definition: definitions.get(id)!,
      async resolve(_db, raw, actor) {
        const input = raw as Input;
        return { authority: `space:${actor.space_id}`, targets: { space_id: input.space_id, item_id: input.item_id, project_id: 'project_id' in input ? input.project_id : null, user_id: actor.on_behalf_of_user_id }, resourceType: 'source_item', resourceId: input.item_id };
      },
      async authorize(db, raw, actor) { await check(db, raw as Input, actor); },
      async authorizeResult(db, raw, actor) {
        const output = raw as Input & { user_id: string };
        if (output.user_id !== actor.on_behalf_of_user_id) throw hidden();
        await check(db, output, actor);
      },
      classifyError(error) { return error instanceof HttpError ? markedRefusal(error, 'reading') : undefined; },
      async execute(db, raw, actor) {
        const input = raw as Input;
        const project = 'project_id' in input ? input.project_id : undefined;
        const result = 'favorite' in input
          ? await favoriteMaterial(db, person(actor), project!, input.item_id, input.favorite)
          : await new ReadingService(db).state(person(actor), input.item_id, input, project);
        return { space_id: actor.space_id, item_id: input.item_id, ...(project ? { project_id: project } : {}), user_id: actor.on_behalf_of_user_id!, ...('topic_change_id' in input && input.topic_change_id ? { topic_change_id: input.topic_change_id } : {}), ...result };
      },
    };
  });
}
