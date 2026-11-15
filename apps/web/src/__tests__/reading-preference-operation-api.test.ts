// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { informationDigestsApi, setSpaceContext } from '../api/client';
beforeEach(()=>{setSpaceContext('space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it('sends one scoped keyed command and unwraps its preference receipt',async()=>{
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:{space_id:'space',project_id:'project',user_id:'person',show_in_my_reading:true}}),{status:200,headers:{'Content-Type':'application/json'}}));
  expect(await informationDigestsApi.setReadingPreference('space','project',true,'same-key')).toEqual({show_in_my_reading:true});
  const [url,init]=vi.mocked(fetch).mock.calls[0]!;
  expect(url).toBe('/api/v1/actions/reading.preference.set');expect(init!.method).toBe('POST');
  expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('same-key');
  expect(JSON.parse(String(init!.body))).toEqual({space_id:'space',project_id:'project',show_in_my_reading:true});
});
it('surfaces a revoked-authority refusal without retrying',async()=>{
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({error:{code:'operation_not_found',domain:'operations',message:'unavailable',metadata:{},retryable:false,request_id:'request'}}),{status:404,headers:{'Content-Type':'application/json'}}));
  await expect(informationDigestsApi.setReadingPreference('space','project',true,'same-key')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
