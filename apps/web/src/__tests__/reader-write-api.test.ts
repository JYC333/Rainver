// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readerApi,setSpaceContext} from '../api/client';
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const receipt=(data:Record<string,unknown>,status=200)=>response({status:'succeeded',data:{space_id:'original-space',document_type:'source_item',document_id:'doc',annotation_id:null,...data}},status);
const urls=()=>vi.mocked(fetch).mock.calls.map(([url,init])=>`${init?.method??'GET'} ${String(url)}`);
beforeEach(()=>{setSpaceContext('current-space');vi.stubGlobal('fetch',vi.fn());vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('sends one keyed annotation command and returns only what the authorized list shows',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(receipt({id:'ann',annotation_id:'ann',kind:'annotation'},201)).mockResolvedValueOnce(response({items:[{id:'other'},{id:'ann',quote_text:'beta'}]}));
 expect(await readerApi.createAnnotation({document_type:'source_item',document_id:'doc',annotation_type:'highlight',quote_text:'beta',anchor_json:{}})).toEqual({id:'ann',quote_text:'beta'});
 expect(urls()).toEqual(['POST /api/v1/reader/annotations','GET /api/v1/reader/documents/source_item/doc/annotations']);
 const calls=vi.mocked(fetch).mock.calls;
 expect(new Headers(calls[0][1]?.headers).get('Idempotency-Key')).toBeTruthy();
 expect(new Headers(calls[1][1]?.headers).get('X-Rainver-Space-Id')).toBe('original-space');
});
it('treats an annotation missing from the current list as unavailable rather than echoing the request',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(receipt({id:'ann',annotation_id:'ann',kind:'annotation'})).mockResolvedValueOnce(response({items:[]}));
 await expect(readerApi.updateAnnotation('ann',{label:'x'})).rejects.toMatchObject({status:404,code:'operation_not_found'});
});
it('polls a queued position once through its reader, then rereads the stored position',async()=>{
 const position={revision:3};
 vi.mocked(fetch).mockResolvedValueOnce(receipt({id:'job',job_id:'job',kind:'job'},202)).mockResolvedValueOnce(response({job_id:'job',status:'running',result:null})).mockResolvedValueOnce(response({job_id:'job',status:'completed',result:{outcome:'not_accepted',annotation_id:null}})).mockResolvedValueOnce(response({position,accepted:true}));
 const done=readerApi.putPosition('original-space','source_item','doc',{content_hash:'c',structure_hash:'s',current:{anchor:{block_index:0,pm_pos:0,text_offset:0,quote:'',before_context:''},progress:0},client_at:new Date().toISOString()});
 await vi.runAllTimersAsync();
 expect(await done).toEqual({position,accepted:false});
 expect(urls()).toEqual(['PUT /api/v1/reader/documents/source_item/doc/position','GET /api/v1/reader/write-requests/job','GET /api/v1/reader/write-requests/job','GET /api/v1/reader/documents/source_item/doc/position']);
});
it('sends a page-exit position once without waiting',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(receipt({id:'job',job_id:'job',kind:'job'},202));
 expect(await readerApi.putPosition('original-space','source_item','doc',{content_hash:'c',structure_hash:'s',current:{anchor:{block_index:0,pm_pos:0,text_offset:0,quote:'',before_context:''},progress:0},client_at:new Date().toISOString()},{keepalive:true})).toEqual({position:null,accepted:true});
 expect(fetch).toHaveBeenCalledTimes(1);
 expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({keepalive:true});
});
it('reports a range conflict from the Job without resubmitting',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(receipt({id:'job',job_id:'job',annotation_id:'ann',kind:'job'},202)).mockResolvedValueOnce(response({job_id:'job',status:'completed',result:{outcome:'conflict',annotation_id:null}}));
 const done=readerApi.updateAnnotationRange('ann',{} as never).catch((error:unknown)=>error);
 await vi.runAllTimersAsync();
 expect(await done).toMatchObject({status:409,code:'operation_conflict'});
 expect(fetch).toHaveBeenCalledTimes(2);
});
it('returns the proposal receipt without a body',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(receipt({id:'proposal',annotation_id:'ann',kind:'proposal'},201));
 expect(await readerApi.createProposal('ann',{proposal_type:'knowledge_create'})).toMatchObject({id:'proposal',kind:'proposal'});
 expect(urls()).toEqual(['POST /api/v1/reader/annotations/ann/proposals']);
});
