// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {spaceEgressApi,setSpaceContext} from '../api/client';
beforeEach(()=>{setSpaceContext('space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it('keeps the named Space REST URL, stable caller key and typed receipt',async()=>{
 const data={space_id:'space',egress_notifications_enabled:false,updated_at:'2026-11-13T00:00:00.000Z'};
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:200,headers:{'Content-Type':'application/json'}}));
 expect(await spaceEgressApi.updateNotifications('space',false,'same-key')).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/spaces/space/egress-notifications');expect(init!.method).toBe('PATCH');
 expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('same-key');expect(JSON.parse(String(init!.body))).toEqual({egress_notifications_enabled:false});
});
it('leaves a lost reply uncertain without repeating the write',async()=>{
 vi.mocked(fetch).mockRejectedValue(new Error('connection lost'));
 await expect(spaceEgressApi.updateNotifications('space',false,'same-key')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
