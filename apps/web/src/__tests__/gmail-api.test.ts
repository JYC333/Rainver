// @vitest-environment node
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {ApiRequestError} from '../api/client'
import {gmailApi,gmailFailure} from '../api/gmail'

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})
const now='2026-11-16T09:00:00.000Z'
const call=(n=0)=>{const [url,init]=vi.mocked(fetch).mock.calls[n]!;return {url:String(url),init:init!,headers:new Headers(init!.headers)}}
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn())})
afterEach(()=>vi.unstubAllGlobals())

describe('Gmail API consumer',()=>{
  it('reads monitors in the named Space and refuses a reply carrying mail content',async()=>{
    const sync={connection_id:'c1',state:'ok',push:'active',last_success_at:now,next_check_at:now,recovery_partial:false,last_error_code:null}
    const monitor={id:'m1',connection_id:'c1',project_id:null,purpose:'Admissions replies',criteria:{from_any:['@uni.example'],subject_any:[],label_any:[]},status:'active',active_since:now,match_count:2,last_matched_at:now,created_at:now,updated_at:now}
    const match={monitor_id:'m1',google_message_id:'18c0ffee',gmail_url:'https://mail.google.com/mail/u/?authuser=me%40example.test#all/18c0ffee',matched_at:now}
    vi.mocked(fetch).mockResolvedValue(json({push_configured:true,monitors:[monitor],sync:[sync],recent_matches:[match]}))
    const controller=new AbortController()
    const list=await gmailApi.monitors({spaceId:'space-a',signal:controller.signal})
    expect(list.monitors[0]!.criteria.from_any).toEqual(['@uni.example'])
    const {url,init,headers}=call()
    expect(url).toBe('/api/v1/sources/gmail/monitors')
    expect(init.signal).toBe(controller.signal)
    expect(headers.get('X-Rainver-Space-Id')).toBe('space-a')
    // A match carries ids and a link only: a subject or sender in the reply is outside the contract.
    vi.mocked(fetch).mockResolvedValue(json({push_configured:true,monitors:[],sync:[],recent_matches:[{...match,subject:'Interview'}]}))
    await expect(gmailApi.monitors({spaceId:'space-a'})).rejects.toThrow()
  })
  it('lists only well-formed monitor drafts and decides them through the ordinary proposal decision with the caller key',async()=>{
    const payload={proposal_type:'gmail_monitor_create',action_id:'source.gmail.monitor.propose',connection_id:'c1',purpose:'Admissions replies',criteria:{from_any:['@uni.example'],subject_any:[],label_any:[]},target_project_id:null}
    vi.mocked(fetch).mockResolvedValue(json({items:[{id:'p1',created_at:now,payload_json:payload},{id:'p2',created_at:now,payload_json:{proposal_type:'memory_create'}}],total:2,limit:50,offset:0}))
    const drafts=await gmailApi.monitorDrafts({spaceId:'space-a'})
    expect(drafts).toEqual([{id:'p1',created_at:now,connection_id:'c1',purpose:'Admissions replies',criteria:payload.criteria}])
    expect(call().url).toBe('/api/v1/proposals?status=pending&type=gmail_monitor_create&limit=50')
    vi.mocked(fetch).mockResolvedValue(json({status:'succeeded',data:{}}))
    await gmailApi.decideMonitorDraft('p1','accept','accept-key',{spaceId:'space-a'})
    expect(call(1).url).toBe('/api/v1/proposals/p1/accept')
    expect(call(1).headers.get('Idempotency-Key')).toBe('accept-key')
    vi.mocked(fetch).mockResolvedValue(json({status:'succeeded',data:{monitor_id:'m1',space_id:'space-a',status:'paused'}}))
    await gmailApi.setMonitorStatus('m1','paused','pause-key',{spaceId:'space-a'})
    expect(call(2).url).toBe('/api/v1/sources/gmail/monitors/m1/status')
    expect(JSON.parse(String(call(2).init.body))).toEqual({status:'paused'})
    expect(call(2).headers.get('Idempotency-Key')).toBe('pause-key')
    vi.mocked(fetch).mockResolvedValue(json({status:'succeeded',data:{selection_id:'s1',space_id:'space-a',removed:true}}))
    await gmailApi.removeSelection('s1','remove-key',{spaceId:'space-a'})
    expect(call(3).url).toBe('/api/v1/sources/gmail/selections/s1')
    expect(call(3).init.method).toBe('DELETE')
    // The retired manual search and add are gone from the client.
    expect('search' in gmailApi).toBe(false)
    expect('addSelection' in gmailApi).toBe(false)
  })
  it('refuses a reply that carries fields outside the secret-free contract',async()=>{
    vi.mocked(fetch).mockResolvedValue(json({configured:true,connections:[{id:'c1',mailbox_email:'me@example.test',status:'active',granted_scopes:[],last_error_class:null,
      connected_at:now,disconnected_at:null,agent_read_enabled:false,updated_at:now,refresh_token:'leaked'}]}))
    await expect(gmailApi.connections({spaceId:'space-a'})).rejects.toThrow()
  })
  it('reads the first page with an empty body and later pages with the server cursor only',async()=>{
    const page={selection_id:'s1',project_id:'p1',connection_id:'c1',google_thread_id:'18c0ffee',gmail_url:'https://mail.google.com/mail/u/?authuser=me@example.test#all/18c0ffee',
      subject:'Budget',messages_in_window:0,messages:[],next_cursor:null,truncated:false,truncation:[]}
    vi.mocked(fetch).mockImplementation(async()=>json(page))
    await gmailApi.read('s1',null,{spaceId:'space-a'})
    await gmailApi.read('s1','next.cursor',{spaceId:'space-a'})
    expect(JSON.parse(String(call(0).init.body))).toEqual({})
    expect(JSON.parse(String(call(1).init.body))).toEqual({cursor:'next.cursor'})
  })
})

describe('Gmail failure classes',()=>{
  const err=(status:number,code?:string,payload?:Record<string,unknown>)=>new ApiRequestError('x',status,code,payload)
  it.each([
    [err(404,'operation_not_found'),'gone'],[err(403),'gone'],[err(401,'authentication_required'),'signed_out'],
    [err(409,'gmail_reauth_required'),'reauth'],[err(409,'gmail_selection_changed'),'changed'],[err(409,'gmail_cursor_expired'),'cursor'],
    [err(429,'gmail_rate_limited'),'rate_limited'],[err(504,'gmail_upstream_timeout'),'deadline'],[err(503,'gmail_audit_unavailable'),'busy'],
    [err(409,'operation_conflict',{error:{code:'operation_conflict',metadata:{code:'gmail_connection_inactive'}}}),'inactive'],
    [err(409,'operation_conflict'),'unavailable'],
    [new TypeError('Failed to fetch'),'unavailable'],
  ])('%#: classifies without echoing server text',(error,kind)=>{expect(gmailFailure(error)).toBe(kind)})
})
