import type { RegisteredSystemActionDefinition, OperationInput } from '@rainver/protocol';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { hidden, markedRefusal } from '../systemActions/operations/errors.js';
import { HttpError } from '../routeUtils/common.js';
import { SpaceCommandError } from '../spaces/writers.js';
import { lockActivePeople } from '../access/activePerson.js';
import { SerendipityFeedbackService } from './feedbackService.js';

export function serendipityFeedbackRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration {
  return {
    definition:definitions.get('digest.serendipity.feedback')!,
    async resolve(_db,raw,actor) {
      const i=raw as OperationInput<'digest.serendipity.feedback'>;
      return {authority:`digest-feedback:${actor.space_id}:${actor.on_behalf_of_user_id}`,targets:{...i,user_id:actor.on_behalf_of_user_id},resourceType:'space',resourceId:i.space_id};
    },
    async authorize(_db,raw,actor) {
      const i=raw as OperationInput<'digest.serendipity.feedback'>;
      if(i.space_id!==actor.space_id || !actor.on_behalf_of_user_id)throw hidden();

    },
    async authorizeResult(db,raw,actor) {
      const r=raw as {space_id:string;user_id:string;digest_item_id:string};
      if(r.space_id!==actor.space_id || r.user_id!==actor.on_behalf_of_user_id)throw hidden();
      // A receipt contains only the owner's feedback, never Source content.
      // Replay has no recommendation effect and needs only current ownership.
      await lockActivePeople(db,r.space_id,[r.user_id]);
      const row=await db.query(`SELECT i.id FROM information_digest_items i
        JOIN information_digests d ON d.id=i.digest_id AND d.space_id=i.space_id
        WHERE i.space_id=$1 AND i.id=$2 AND i.section='serendipity'
          AND d.digest_type='personal' AND d.owner_user_id=$3 FOR SHARE OF i,d`,[r.space_id,r.digest_item_id,r.user_id]);
      if(!row.rows.length)throw hidden();
    },
    classifyError(error) {return error instanceof HttpError || error instanceof SpaceCommandError ? markedRefusal(error,'information_digest') : undefined;},
    async execute(db,raw,actor) {
      const i=raw as OperationInput<'digest.serendipity.feedback'>;
      return {space_id:actor.space_id,user_id:actor.on_behalf_of_user_id!,...await new SerendipityFeedbackService(db).record(actor.space_id,actor.on_behalf_of_user_id!,i.item_id,i.feedback)};
    },
  };
}
