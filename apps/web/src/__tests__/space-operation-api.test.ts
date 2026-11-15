// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {contentAccessApi,setSpaceContext,spacesApi} from '../api/client';
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const body=(call:unknown[])=>JSON.parse(String((call[1] as RequestInit).body));
beforeEach(()=>{setSpaceContext('current-space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>{vi.unstubAllGlobals();});
it('generates the invitation secret locally, sends it once in the named Space and keeps it out of the receipt',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{invitation_id:'inv',space_id:'team',invited_email:'a@example.com',role:'member',status:'available',expires_at:'2026-11-19T00:00:00.000Z'}},201));
 const out=await spacesApi.invite('team',{email:'a@example.com',role:'member'});
 const [call]=vi.mocked(fetch).mock.calls;
 expect(String(call![0])).toBe('/api/v1/actions/space.invitation.create');
 const headers=new Headers((call![1] as RequestInit).headers);
 expect(headers.get('Idempotency-Key')).toBeTruthy();expect(headers.get('X-Rainver-Space-Id')).toBe('team');
 const sent=body(call!);expect(sent).toMatchObject({space_id:'team',email:'a@example.com',role:'member'});
 expect(sent.token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(out).toMatchObject({id:'inv',token:sent.token,invited_email:'a@example.com'});
});
it('rereads a created Space and a changed policy through their readers',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'new'}},201)).mockResolvedValueOnce(response({id:'new',name:'Lab',type:'team',role:'owner'}));
 expect(await spacesApi.create({name:'Lab',type:'team'})).toMatchObject({id:'new',role:'owner'});
 expect(vi.mocked(fetch).mock.calls.map(([url])=>String(url))).toEqual(['/api/v1/actions/space.create','/api/v1/spaces/new']);
 vi.mocked(fetch).mockClear();
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',resource_type:'memory',resource_id:'v2'}})).mockResolvedValueOnce(response({resource_id:'v2',visibility:'private'}));
 expect(await contentAccessApi.update('memory','v1',{visibility:'private',access_level:'full',project_id:null,grants:[]})).toMatchObject({resource_id:'v2'});
 const calls=vi.mocked(fetch).mock.calls;
 expect(String(calls[0]![0])).toBe('/api/v1/actions/content.access.update');expect(body(calls[0]!)).toMatchObject({resource_type:'memory',resource_id:'v1'});
 expect(String(calls[1]![0])).toBe('/api/v1/content-access/memory/v2');
});
it('reads the recorded disclosure by the receipt confirmation id',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',resource_type:'note',resource_id:'n',confirmation_id:'c',target_visibility:'private',expires_at:'x'}},201)).mockResolvedValueOnce(response({confirmation_id:'c',exposure:{readers:[],consuming_runs:[],shared_derived_outputs:[]}}));
 expect(await contentAccessApi.discloseDemotion('note','n','private')).toMatchObject({confirmation_id:'c'});
 expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe('/api/v1/content-access/note/n/demotion-disclosures/c');
});
