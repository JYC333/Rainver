// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {captureFilingApi,setSpaceContext} from '../api/client';
beforeEach(()=>{setSpaceContext('browsed-space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it('uses the formal personal filing URL and preserves an explicit retry key',async()=>{
 const body={activity_id:'capture',target_project_id:'project'};
 const data={...body,object_id:'note',target_space_id:'destination',visibility:'space_shared',filed_at:'2026-11-13T00:00:00.000Z'};
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:200,headers:{'Content-Type':'application/json'}}));
 expect(await captureFilingApi.file(body,'filing-key')).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/me/filings');expect(init!.method).toBe('POST');
 expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('filing-key');expect(JSON.parse(String(init!.body))).toEqual(body);
});
it('leaves a lost reply uncertain without submitting again',async()=>{
 vi.mocked(fetch).mockRejectedValue(new Error('connection lost'));
 await expect(captureFilingApi.file({activity_id:'capture',target_project_id:'project'},'filing-key')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
