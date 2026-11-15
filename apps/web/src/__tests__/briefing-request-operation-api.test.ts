// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {personalBriefingsApi,setSpaceContext} from '../api/client';
afterEach(()=>vi.unstubAllGlobals());
it('sends a keyed personal generation command and unwraps its receipt',async()=>{
 setSpaceContext('space');const data={created:true,briefing:{id:'briefing'}};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:201,headers:{'Content-Type':'application/json'}})));
 expect(await personalBriefingsApi.generate('space','request-key')).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;
 expect(url).toBe('/api/v1/actions/briefing.personal.request');expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('request-key');
 expect(JSON.parse(String(init!.body))).toEqual({space_id:'space'});
});
