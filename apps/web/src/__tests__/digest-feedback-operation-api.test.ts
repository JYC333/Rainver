// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {informationDigestsApi,setSpaceContext} from '../api/client';
afterEach(()=>vi.unstubAllGlobals());
it('sends an explicit feedback key and exposes only the existing owner result',async()=>{
 setSpaceContext('space');const result={digest_item_id:'item',domain_key:'sports',feedback:'never',cooldown_until:null,blocked:true,created_at:'2026-11-13T12:00:00.000Z'};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:{space_id:'space',user_id:'person',...result}}),{status:200,headers:{'Content-Type':'application/json'}})));
 expect(await informationDigestsApi.serendipityFeedback('space','item','never','feedback-key')).toEqual(result);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/actions/digest.serendipity.feedback');expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('feedback-key');expect(JSON.parse(String(init!.body))).toEqual({space_id:'space',item_id:'item',feedback:'never'});
});
