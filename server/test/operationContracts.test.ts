import {formatOperationForAgent} from '../src/modules/systemActions/operations/agentResult.js';
import { describe, expect, it } from 'vitest';
import { immediateOperationOrigin } from '../src/modules/systemActions/operations/actor.js';
import { fingerprint } from '../src/modules/systemActions/operations/repository.js';
describe('operation identity contracts', () => {
  it.each([['manual', 'manual'], ['automation', 'scheduled'], ['autonomous', 'system_event'], ['job', 'system_event'], ['system', 'system_event'], ['delegation', 'delegated'], ['continuation', 'continuation']])('translates %s immediate provenance to %s without interpreting effective root', (stored, origin) => {
    expect(immediateOperationOrigin(stored)).toBe(origin);
  });
  it.each(['user', 'api', 'workflow', 'unknown', '__proto__', 'toString'])('refuses legacy/unknown execution origin %s', value => {
    expect(() => immediateOperationOrigin(value)).toThrow();
  });
  it('canonicalizes object key order but preserves array/input/version/target differences', () => {
    expect(fingerprint(1, {
      b: 2,
      a: 1
    }, {
      id: 'x'
    })).toBe(fingerprint(1, {
      a: 1,
      b: 2
    }, {
      id: 'x'
    }));
    expect(fingerprint(1, {
      a: [1, 2]
    }, {
      id: 'x'
    })).not.toBe(fingerprint(1, {
      a: [2, 1]
    }, {
      id: 'x'
    }));
    expect(fingerprint(1, {
      a: 1
    }, {
      id: 'x'
    })).not.toBe(fingerprint(2, {
      a: 1
    }, {
      id: 'x'
    }));
    expect(fingerprint(1, {
      a: 1
    }, {
      id: 'x'
    })).not.toBe(fingerprint(1, {
      a: 1
    }, {
      id: 'y'
    }));
  });
});

describe('operation Agent adapter',()=>{
 it('keeps pending approval a normal tool result and preserves retryable 409 without flattening it into refusal',()=>{
  const metadata={request_id:'r',policy_decision_record_id:null,replayed:false};
  const pending=formatOperationForAgent({...metadata,http_status:202,body:{status:'pending_approval',proposal_id:'p'}},'fixture');
  expect(pending.modelResult).toMatchObject({ok:true,status:'pending_approval',http_status:202});
  const error=formatOperationForAgent({...metadata,http_status:409,body:{error:{code:'idempotency_in_progress',domain:'operations',message:'busy',metadata:{},retryable:true,request_id:'r'}}},'fixture');
  expect(error.modelResult).toMatchObject({ok:false,http_status:409,error:{code:'idempotency_in_progress',retryable:true}});
  expect(error.summary).toMatchObject({error_code:'idempotency_in_progress',http_status:409});
 });
});
