// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {personalBriefingsApi,setSpaceContext} from '../api/client';
afterEach(()=>vi.unstubAllGlobals());
it('passes an explicit daily setting key and unwraps the canonical receipt',async()=>{
 setSpaceContext('space');vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:{space_id:'space',user_id:'owner',daily_enabled:true}}),{status:200,headers:{'Content-Type':'application/json'}})));
 expect(await personalBriefingsApi.setDaily('space',true,'setting-key')).toEqual({daily_enabled:true});
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;
 expect(url).toBe('/api/v1/actions/briefing.personal.settings.set');expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('setting-key');expect(JSON.parse(String(init!.body))).toEqual({space_id:'space',daily_enabled:true});
});
