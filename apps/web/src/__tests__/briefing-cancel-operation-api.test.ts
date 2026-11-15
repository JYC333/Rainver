// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {personalBriefingsApi,setSpaceContext} from '../api/client';
afterEach(()=>vi.unstubAllGlobals());
it('sends the exact briefing and key, unwrapping a stop intent receipt',async()=>{
 setSpaceContext('space');const receipt={space_id:'space',user_id:'owner',briefing_id:'briefing',attempt:1,run_id:'run',status:'cancelling'};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:receipt}),{status:200,headers:{'Content-Type':'application/json'}})));
 expect(await personalBriefingsApi.cancel('space','briefing','cancel-key')).toEqual(receipt);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;
 expect(url).toBe('/api/v1/actions/briefing.personal.cancel');expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('cancel-key');expect(JSON.parse(String(init!.body))).toEqual({space_id:'space',briefing_id:'briefing'});
});
