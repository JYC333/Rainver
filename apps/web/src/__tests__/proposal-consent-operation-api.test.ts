// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {proposalsApi,setSpaceContext} from '../api/client';
beforeEach(()=>{setSpaceContext('space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it('unwraps consent for existing consumers and preserves an explicit retry key',async()=>{
 const consent={id:'approval',proposal_id:'proposal',approver_user_id:'owner',status:'approved'};
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:consent}),{status:200}));
 expect(await proposalsApi.approveEgressGrantingUserProposal('proposal',{grant_id:'grant'},{idempotencyKey:'consent-key'})).toEqual(consent);
 const [url,init]=vi.mocked(fetch).mock.calls[0];
 expect(url).toBe('/api/v1/proposals/proposal/approvals/egress-granting-user');
 expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('consent-key');
 expect(JSON.parse(String(init?.body))).toEqual({grant_id:'grant'});
});

it('unwraps a canonical rejection receipt with the caller retry key',async()=>{
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:{id:'proposal',status:'rejected'}}),{status:200}));
 expect(await proposalsApi.reject('proposal',{idempotencyKey:'reject-key'})).toMatchObject({id:'proposal',status:'rejected'});
 expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe('reject-key');
});
