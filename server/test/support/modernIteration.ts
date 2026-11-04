import {InquiryIterationService} from '../../src/modules/inquiry/iterationService.js';
import type {Queryable,SpaceUserIdentity} from '../../src/modules/routeUtils/common.js';
import type {ThreadEventProvenance} from '../../src/modules/inquiry/threadWorkEvents.js';
import {randomUUID} from 'node:crypto';
/** Fixture convenience: tests of cognition still send the complete current command. */
export class ModernIterationService extends InquiryIterationService {
 constructor(private readonly testDb:Queryable){super(testDb)}
 override async recordIteration(identity:SpaceUserIdentity,projectId:string,threadId:string,body:Record<string,unknown>,provenance?:ThreadEventProvenance){
  const t=(await this.testDb.query<{version:number;problem_revision:number}>('SELECT version,problem_revision FROM inquiry_threads WHERE object_id=$1 AND space_id=$2',[threadId,identity.spaceId])).rows[0];
  return super.recordIteration(identity,projectId,threadId,{method_version:'problem_solving.v1',round_intent:'close_round',idempotency_key:randomUUID(),expected_version:t?.version??1,expected_revision:t?.problem_revision??0,...body},provenance);
 }
}
