import {sourceGoalError} from './dispatchError.js';
import {SourceGoalSafeTextSchema} from '@rainver/protocol';
/** Reject recognizable credential material before either goal or Session storage.
 * Access is configured through the existing encrypted credential service. */
export function assertSafeGoalMessage(content:string){
 if(!SourceGoalSafeTextSchema.safeParse(content).success)throw sourceGoalError(422,'source_goal_use_credential_channel');
}
