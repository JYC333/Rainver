import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {after,before,test} from 'node:test'
import {chromium} from 'playwright-core'
import {preview} from 'vite'
let server,browser,baseUrl
const config={objective:'Agent 的可靠性与长期记忆',include:['reliability'],exclude:['advertising'],source_channel_id:'source-monitor',from:'2026-09-24T00:00:00Z',to:'2026-10-24T00:00:00Z',total_candidates:30,batch:{candidates:30,pages:3,source_requests:6,model_runs:6},daily:{candidates:20,pages:2,source_requests:4,model_runs:4},recommendation_count:5,language:'English',timezone:'UTC',evidence_depth:'abstract',agent_id:'agent-monitor'}
const version={id:'version-monitor',version:1,config,config_hash:'a'.repeat(64),proposal_id:null,backfill_plan_id:'plan-monitor',rule_id:'rule-monitor'}
const candidate={id:'item-monitor',title:'让 Agent 的长期记忆变得可验证',source_uri:'https://example.test/paper',occurred_at:'2026-10-23T12:00:00Z',summary:'这项研究把记忆更新与可追溯证据结合，减少长期运行中的信息漂移，并给出了可复现的评估方法。',relevance:'relevant',reason:'直接回应你关注的 Agent 可靠性，尤其适合比较长期任务中的记忆方案。',recommended:true,evidence_depth:'abstract',feedback:'relevant',read_status:'read'}
const state={active:version,draft:null,available_sources:[],can_write:true,paused:false,dependencies:[],latest_run:{id:'operation-monitor',status:'completed',progress:{phase:'completed',reason:null,as_of:'2026-10-24T12:00:00Z'}},candidates:[candidate,{...candidate,id:'other-monitor',title:'An excluded candidate remains inspectable',relevance:'not_relevant',recommended:false}]}
const pageOf=items=>({items,total:items.length,limit:100,offset:0})
before(async()=>{
 server=await preview({configFile:false,preview:{host:'127.0.0.1',port:0}})
 baseUrl=`http://127.0.0.1:${server.httpServer.address().port}`
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE})
})
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve))})
test('Project monitoring on phone and desktop keeps configuration, initial results, candidates and private feedback reachable',async()=>{
 const page=await browser.newPage({viewport:{width:380,height:900},serviceWorkers:'block'})
 const writes=[]
 let fixture=state
 try{
  await page.route('**/api/v1/**',async route=>{
   const path=new URL(route.request().url()).pathname.replace('/api/v1','')
   let data
   if(route.request().method()!=='GET'){
    writes.push({path,body:route.request().postDataJSON()})
    if(path.endsWith('/research/area'))return route.fulfill({json:{checklist:[],reports:[]}})
    if(path.endsWith('/reconcile'))fixture={...fixture,can_reconcile:false,latest_run:{...fixture.latest_run,status:'completed',progress:{phase:'partial',reason:'processing_failed'}}}
    return route.fulfill({json:{feedback:'read'}})
   }
   if(path==='/me')data={id:'user-monitor',name:'Tester',default_space_id:'space-monitor',instance_role:'member'}
   else if(path==='/me/spaces')data=[{id:'space-monitor',name:'Monitor Space',type:'personal',role:'owner'}]
   else if(path==='/plugins/effective')data={plugins:{}}
   else if(path==='/projects/project-monitor/overview')data={project:{id:'project-monitor',name:'Agent 信息观察',status:'active'},brief:null,attention:[]}
   else if(path==='/projects/project-monitor')data={id:'project-monitor',space_id:'space-monitor',name:'Agent 信息观察',status:'active'}
   else if(path.endsWith('/research/standing'))data={enabled:false,enabled_binding_count:0,budget:{daily_limit:20,daily_used:0},batches:[],advice:[],recent_inflow:[]}
   else if(path.endsWith('/research/reading-list'))data=pageOf([])
   else if(path.endsWith('/research/workflow')||path.endsWith('/research/evidence-matrix')||path.endsWith('/research/reports')||path.endsWith('/research/scan-summaries')||path.endsWith('/operations')||path==='/providers'||path==='/providers/vendors')data=[]
   else if(path.endsWith('/inquiry/threads'))data=[{id:'thread-setup',statement:'Boundary fixture setup question',kind:'question',lifecycle_status:'active',attention_state:'focused'}]
   else if(path==='/sources/project-items')data=pageOf([])
   else if(path==='/sources/briefings')data=pageOf([])
   else if(path==='/sources/providers'||path==='/sources/recommendations'||path==='/sources/channels/followed')data=[]
   else if(path==='/projects')data=pageOf([{id:'project-monitor',name:'Agent 信息观察'}])
   else if(path.endsWith('/interest-profile'))data=null
   else if(path.endsWith('/source-annotation/episodes'))data={episodes:[]}
   else if(path.endsWith('/information-digests/personal'))data={status:'available',digest:{id:'daily-monitor',digest_type:'personal',digest_date:'2026-10-24',timezone:'UTC',period_start_utc:'2026-10-24T00:00:00Z',period_end_utc:'2026-10-25T00:00:00Z',generated_at:'2026-10-25T07:00:00Z',generation_kind:'scheduled',settings:{},team_blind_spot_domains:[],items:[{...candidate,id:'daily-item',source_item_id:candidate.id,section:'interest',position:0,quota_slot:'interest:1',score:0.9,component_scores:{},rationale:candidate.reason,domain_key:'artificial_intelligence',depth:'overview',genre:'paper',anonymous_read_count:null}]}}
   else if(path.endsWith('/information-monitoring'))data=fixture
   else if(path==='/sources/channels')data=[{id:'source-monitor',name:'Manual arXiv',status:'active',source_connection_id:'connection-monitor',source_name:'arXiv',channel_type:'search',provider:{key:'arxiv',display_name:'arXiv'},scan_state:{status:'idle',cursor:{},watermark:{}}}]
   else if(path==='/agents')data=[{id:'agent-monitor',name:'Chosen processor',status:'active'}]
   else if(path.endsWith('/information-digests'))data={status:'missing',digest_date:'2026-10-23',timezone:'UTC',period_start_utc:'2026-10-23T00:00:00Z',period_end_utc:'2026-10-24T00:00:00Z',reason:'not_generated',backfill_available:false}
   else if(path.endsWith('/sources/extraction-profiles'))data=[]
   else if(path.endsWith('/sources/bindings')||path.endsWith('/sources/health')||path.endsWith('/members'))data=[]
   else if(path.endsWith('/proposals'))data=pageOf([])
   else return route.fulfill({status:404,json:{detail:'Not part of the browser fixture'}})
   return route.fulfill({json:data})
  })
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  const researchRequests=[]
  page.on('request',request=>{if(new URL(request.url()).pathname.includes('/research/'))researchRequests.push(request.url())})
  await page.goto(baseUrl+'/spaces/space-monitor/projects/project-monitor/research')
  await page.getByRole('link',{name:'Choose a project question',exact:true}).waitFor()
  assert.equal(researchRequests.length,0,'Research landing must not initialize the old workflow')
  assert.equal(writes.length,0)
  await page.goto(baseUrl+'/spaces/space-monitor/projects/project-monitor/research?research=new&thread=thread-setup&keep=fixture')
  await page.waitForURL(url=>url.searchParams.get('tab')==='focus'&&!url.searchParams.has('research')&&!url.searchParams.has('thread'))
  const setup=page.getByRole('dialog')
  await setup.getByText('Researching: Boundary fixture setup question',{exact:false}).waitFor()
  await page.setViewportSize({width:800,height:900})
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  assert.equal(await setup.isVisible(),true)
  assert.equal(new URL(page.url()).searchParams.get('keep'),'fixture')
  writes.length=0
  await page.goto(baseUrl+'/spaces/space-monitor/projects/project-monitor/sources')
  await page.getByRole('heading',{name:'Worth reading',exact:true}).waitFor()
  await page.setViewportSize({width:390,height:900})
  assert.equal(await page.getByRole('link',{name:'Board',exact:true}).isVisible(),false,'Mobile navigation starts collapsed')
  await page.getByRole('button',{name:'Project navigation',exact:false}).click()
  assert.equal(await page.getByRole('link',{name:'Board',exact:true}).isVisible(),true)
  await page.getByRole('button',{name:'Project navigation',exact:false}).click()
  await page.getByRole('link',{name:candidate.title,exact:true}).waitFor()
  assert.equal(await page.getByLabel('Direction / objective',{exact:true}).count(),0,'Reading must not mount the configuration form')
  assert.equal(await page.getByText('An excluded candidate remains inspectable',{exact:true}).count(),0,'Recommendations must not mix in excluded candidates')
  for(const width of [380,800,1280]){
    await page.setViewportSize({width,height:1000})
    const geometry=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}))
    assert.ok(geometry.scroll<=geometry.viewport+1,JSON.stringify(geometry))
  }
  await Promise.all([page.waitForResponse(r=>r.url().includes('/feedback')),page.getByRole('button',{name:'Read',exact:true}).click()])
  assert.equal(writes.at(-1).body.feedback,'read')
  await page.getByRole('button',{name:'Following settings',exact:true}).first().click()
  await page.getByRole('heading',{name:'Information monitoring',exact:true}).waitFor()
  await page.getByText('Collection schedule and limits',{exact:true}).click()
  await page.getByRole('checkbox',{name:'Propose daily acquisition (takes effect only after confirmation)',exact:true}).check()
  await page.getByLabel('Collection time',{exact:true}).fill('21:30')
  assert.equal(await page.getByLabel('Collection time',{exact:true}).inputValue(),'21:30')
  await page.getByRole('button',{name:'Back to updates',exact:true}).click()
  await page.getByRole('tab',{name:'All material',exact:true}).click()
  await page.getByRole('heading',{name:'Collected items',exact:true}).waitFor()
  assert.equal(await page.getByRole('heading',{name:'Source bindings',exact:true}).count(),0)
  await page.getByRole('button',{name:'All monitoring candidates',exact:true}).click()
  await page.getByText('An excluded candidate remains inspectable',{exact:true}).waitFor()
  assert.equal(writes.length,1,'Navigation and opening settings must not activate collection')
  await page.evaluate(()=>localStorage.setItem('rainver:locale','zh-CN'))
  await mkdir('/tmp/rainver-reading-v1',{recursive:true})
  await page.goto(baseUrl+'/spaces/space-monitor/projects/project-monitor/sources')
  await page.getByRole('heading',{name:'值得一读',exact:true}).waitFor()
  await page.setViewportSize({width:1440,height:1000})
  await page.screenshot({path:'/tmp/rainver-reading-v1/project-updates-desktop.png',fullPage:true})
  await page.setViewportSize({width:390,height:900})
  await page.screenshot({path:'/tmp/rainver-reading-v1/project-updates-phone.png',fullPage:true})
  await page.setViewportSize({width:1440,height:1000})
  await page.goto(baseUrl+'/spaces/space-monitor/projects/project-monitor/research')
  await page.getByRole('link',{name:'选择项目问题',exact:true}).waitFor()
  await page.screenshot({path:'/tmp/rainver-reading-v1/research-desktop.png',fullPage:true})
  await page.goto(baseUrl+'/spaces/space-monitor/library')
  await page.waitForURL(url=>url.pathname.endsWith('/library/digests'))
  await page.getByRole('link',{name:candidate.title,exact:true}).waitFor()
  await page.screenshot({path:'/tmp/rainver-reading-v1/reading-desktop.png',fullPage:true})
  for(const width of [390,1440]){
    await page.setViewportSize({width,height:1000})
    const geometry=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}))
    assert.ok(geometry.scroll<=geometry.viewport+1,JSON.stringify(geometry))
  }
  assert.deepEqual(errors,[])
 }finally{await page.close()}
})
