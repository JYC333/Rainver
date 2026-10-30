import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {after,before,test} from 'node:test'
import {chromium} from 'playwright-core'
import {preview} from 'vite'
let server,browser,baseUrl
before(async()=>{
 server=await preview({configFile:false,preview:{host:'127.0.0.1',port:0}})
 baseUrl=`http://127.0.0.1:${server.httpServer.address().port}`
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE})
})
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve))})

// Synthetic fixture only: no real Source, member or model text.
const ITEM='11111111-1111-4111-8111-111111111111'
const coverage={since:null,cutoff:'2026-10-30T08:00:00.000Z',candidates:4,included:2,merged_duplicates:1,not_ready:1,truncated:0,egress_refused:0,not_shared_with_audience:0,carried_from_previous:0,unchanged_since_previous:0,background:0,context_changed:false,complete:false}
const base={id:'brief-1',version:1,kind:'manual',status:'queued',outcome:null,comparison:'baseline',period_date:null,cutoff_at:'2026-10-30T08:00:00.000Z',created_at:'2026-10-30T08:00:00.000Z',completed_at:null,checked_at:null,error_code:null,scope_type:'project',previous_briefing_id:null,run_status:'running',coverage,visibility:'visible',hidden_units:0,overview:null,highlights:[],open_questions:[],evidence:[],context:[{key:'C1',kind:'project_goal',label:'Project goal'}],context_outdated:false}
const ready={...base,status:'ready',outcome:'briefing',run_status:'succeeded',completed_at:'2026-10-30T08:02:00.000Z',
 overview:{text:'Synthetic fixture: two reports describe one gripper launch; a recall notice is unconfirmed.',refs:['S1','S2']},
 highlights:[{title:'Fixture gripper launch',what_changed:'A fixture vendor announced a soft gripper with a very-long-unbroken-identifier-fixture-gripper-model-x1000-to-check-wrapping.',novelty:'baseline',importance:'high',why_it_matters:'Fragile-item picking is the open risk in the fixture goal.',impact:{assessment:'affects',text:'Bears on the fixture picking goal.',context_refs:['C1']},suggested_action:'watch',statements:[{kind:'fact',text:'The fixture gripper was announced.',refs:['S1']},{kind:'inference',text:'It could replace the fixture prototype.',refs:['S1','C1']},{kind:'open_question',text:'Is the fixture price public?',refs:['S2']}],contradictions:'The fixture recall notice conflicts with the launch report.',refs:['S1','S2'],source_domains:2,rests_on_unverified:true}],
 open_questions:[{text:'Does the fixture recall affect the same model?',refs:['S2']}],
 evidence:[{key:'S1',source_item_id:ITEM,title:'Fixture launch report',source_domain:'news.fixture.test',occurred_at:'2026-10-29T10:00:00.000Z',delta_class:'baseline',unverified:false,lenses:[{kind:'corpus',label:'Project Corpus'}]},{key:'S2',source_item_id:'22222222-2222-4222-8222-222222222222',title:'Fixture recall notice',source_domain:'agent.fixture.test',occurred_at:null,delta_class:'unknown_time',unverified:true,lenses:[{kind:'following',label:'Fixture topic'}]}]}
// A sealed day held while a manual version runs; the server then starts and finishes it.
const heldDay={...base,id:'brief-day',version:4,kind:'daily',period_date:'2026-10-29',status:'blocked',outcome:null,error_code:'briefing_scope_busy',run_status:null,completed_at:'2026-10-30T10:00:00.000Z'}
const runningManual={...base,id:'brief-3',version:3}
const dayQueued={...heldDay,status:'queued',error_code:null,run_status:'running',completed_at:null}
let scene=null,sceneReads=0
const summary=b=>({id:b.id,version:b.version,kind:b.kind,status:b.status,outcome:b.outcome,comparison:b.comparison,period_date:b.period_date,cutoff_at:b.cutoff_at,created_at:b.created_at,completed_at:b.completed_at,checked_at:b.checked_at,error_code:b.error_code})
const check={...base,coverage:{...coverage,candidates:0,included:0,merged_duplicates:0,not_ready:0,unchanged_since_previous:1,complete:true},id:'brief-2',version:2,status:'ready',outcome:'no_new_material',comparison:'delta',previous_briefing_id:'brief-1',run_status:null,checked_at:'2026-10-30T09:30:00.000Z',completed_at:'2026-10-30T09:00:00.000Z',context:[]}

test('Project briefing: writer generates, sees progress, then reads a cited briefing on phone and desktop',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:900},serviceWorkers:'block'})
 let latest=null,polls=0
 const writes=[]
 try{
  await page.route('**/api/v1/**',async route=>{
   const path=new URL(route.request().url()).pathname.replace('/api/v1','')
   const method=route.request().method()
   if(path.endsWith('/information-briefings')&&method==='POST'){writes.push(path);latest=base;return route.fulfill({status:201,json:{created:true,briefing:base}})}
   if(path.endsWith('/information-briefings')&&method==='GET'&&scene==='held'){
    sceneReads+=1
    const day=sceneReads<=1?heldDay:sceneReads===2?dayQueued:{...ready,id:'brief-day',version:4,kind:'daily',period_date:'2026-10-29',overview:{text:'Synthetic fixture: the held day, briefed.',refs:['S1']}}
    const history=[day,day.status==='blocked'?runningManual:{...runningManual,status:'ready',outcome:'briefing'},ready]
    return route.fulfill({json:{can_generate:false,daily_enabled:true,latest:day,latest_briefing:day.outcome==='briefing'?day:ready,history:history.map(summary)}})
   }
   if(path.endsWith('/information-briefings')&&method==='GET'){
    if(latest&&latest.status==='queued'&&++polls>=2)latest=ready
    const published=latest===check?ready:latest?.outcome==='briefing'?latest:null
    return route.fulfill({json:{can_generate:true,daily_enabled:false,latest,latest_briefing:published,history:[latest,published].filter((b,i,all)=>b&&all.findIndex(o=>o?.id===b.id)===i).map(summary)}})
   }
   if(method!=='GET'){writes.push(path);return route.fulfill({status:404,json:{detail:'Not part of the browser fixture'}})}
   let data
   if(path==='/me')data={id:'user-fixture',name:'Tester',default_space_id:'space-fixture',instance_role:'member'}
   else if(path==='/me/spaces')data=[{id:'space-fixture',name:'Fixture Space',type:'personal',role:'owner'}]
   else if(path==='/plugins/effective')data={plugins:{}}
   else if(path==='/projects/project-fixture/overview')data={project:{id:'project-fixture',name:'Fixture robotics',status:'active'},brief:null,attention:[]}
   else if(path==='/projects/project-fixture')data={id:'project-fixture',space_id:'space-fixture',name:'Fixture robotics',status:'active'}
   else if(path==='/projects')data={items:[{id:'project-fixture',name:'Fixture robotics'}],total:1,limit:100,offset:0}
   else if(path.endsWith('/information-digests'))data={status:'missing',digest_date:'2026-10-29',timezone:'UTC',period_start_utc:'2026-10-29T00:00:00Z',period_end_utc:'2026-10-30T00:00:00Z',reason:'not_generated',backfill_available:false}
   else if(path.endsWith('/members')||path.endsWith('/operations'))data=[]
   else return route.fulfill({status:404,json:{detail:'Not part of the browser fixture'}})
   return route.fulfill({json:data})
  })
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(baseUrl+'/spaces/space-fixture/projects/project-fixture/sources?tab=digest')
  const panel=page.getByTestId('project-briefing')
  await panel.getByText('No briefing yet.',{exact:true}).waitFor()
  assert.equal(writes.length,0,'Opening the briefing must not generate one')
  await panel.getByRole('button',{name:'Generate briefing',exact:true}).click()
  await panel.getByText('Synthesizing… (Run running)',{exact:true}).waitFor()
  assert.equal(await panel.getByRole('button',{name:'Generate briefing',exact:true}).isDisabled(),true)
  await panel.getByText(ready.overview.text).waitFor({timeout:15000})
  assert.deepEqual(writes,['/spaces/space-fixture/projects/project-fixture/information-briefings'])
  await panel.getByText('Rests on agent-provided material that nobody verified.',{exact:true}).waitFor()
  assert.equal(await panel.getByRole('link',{name:'Fixture launch report',exact:true}).getAttribute('href'),`/library/items/${ITEM}?from=project&returnTo=%2Fprojects%2Fproject-fixture%2Fsources%3Ftab%3Ddigest`)
  await mkdir('/tmp/rainver-briefing-p1',{recursive:true})
  for(const width of [390,1280]){
   await page.setViewportSize({width,height:1000})
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
   const geometry=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}))
   assert.ok(geometry.scroll<=geometry.viewport+1,JSON.stringify(geometry))
   const box=await panel.boundingBox()
   assert.ok(box&&box.x>=0&&box.x+box.width<=width+1,`panel fits ${width}: ${JSON.stringify(box)}`)
   await panel.screenshot({path:`/tmp/rainver-briefing-p1/briefing-${width}.png`})
  }
  // A later check found nothing new: it is the latest version, and the last real briefing stays readable under it.
  latest=check
  await page.reload()
  await panel.getByText('Nothing new since the previous briefing.',{exact:true}).waitFor()
  await page.getByTestId('project-briefing-last').getByText(ready.overview.text).waitFor()
  for(const width of [390,1280]){
   await page.setViewportSize({width,height:1000})
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
   const geometry=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}))
   assert.ok(geometry.scroll<=geometry.viewport+1,JSON.stringify(geometry))
   await panel.screenshot({path:`/tmp/rainver-briefing-p1/briefing-check-${width}.png`})
  }
  // A reader opens the Project while a sealed day is held behind a running manual version: it follows by reads alone.
  scene='held';sceneReads=0
  const writesBefore=writes.length
  await page.reload()
  await panel.getByText('The briefing for 2026-10-29 is held and will start in its turn.',{exact:true}).waitFor()
  assert.equal(await panel.getByRole('button',{name:'Generate briefing',exact:true}).count(),0)
  await panel.screenshot({path:'/tmp/rainver-briefing-p1/briefing-held-1280.png'})
  await panel.getByText('Synthetic fixture: the held day, briefed.').waitFor({timeout:20000})
  assert.equal(writes.length,writesBefore,'Following a held day must not write')
  scene=null
  latest=ready
  await page.evaluate(()=>localStorage.setItem('rainver:locale','zh-CN'))
  await page.reload()
  await page.getByTestId('project-briefing').getByRole('button',{name:'生成简报',exact:true}).waitFor()
  await page.getByTestId('project-briefing').getByText('事实',{exact:true}).waitFor()
  await page.getByTestId('project-briefing').screenshot({path:'/tmp/rainver-briefing-p1/briefing-1280-zh.png'})
  assert.deepEqual(errors,[])
 }finally{await page.close()}
})
