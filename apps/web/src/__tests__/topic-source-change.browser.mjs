import assert from 'node:assert/strict'
import {after,before,test} from 'node:test'
import {chromium} from 'playwright-core'
import {preview} from 'vite'

/*
 * A topic source stopped because its Source changed after the topic was
 * confirmed (the reported case: saving full text was allowed later). The topic
 * explains it in place, the owner reviews the Source as it is now and confirms
 * it; a change meanwhile is refused and shown again. A Source the topic cannot
 * use any more says who must act and offers neither confirmation nor a Source
 * page link. The API is a stateful fixture of the server contract (the server's
 * own gates are covered against PostgreSQL in sourceGoalsDb.test.ts).
 */
let server,browser,baseUrl
const shots=process.env.TOPIC_SHOTS
const results={items_total:10,important_total:0,unjudged_total:0,not_selected_total:10,judgment_failed_total:0,baseline_total:10,new_publication_total:0,evidenced_change_total:0,unknown_freshness_total:0,changes_total:0,last_outcome:'failed',last_new_items:0,last_checked_at:'2026-10-29T01:10:29Z',last_success_at:'2026-10-28T01:11:45Z',next_check_at:'2026-10-30T01:10:00Z'}
const spec={source_connection_id:'c',source_channel_id:'ch',reason:'Agent memory search',supports_history:false,implementation:{kind:'agent_search',query:'agent memory'}}
const src=over=>({binding_id:'b',source_connection_id:'c',status:'paused',health:'needs_permission',error:'source_authority_revoked',failures:0,last_success_at:'2026-10-28T01:11:45Z',retry_at:null,attention:'source_changed',resolvable_by:'you',...over})
const followState=(over={})=>({intent:'following',collections:{queued:0,running:0},pending_adjustment:false,phase:'waiting_for_permission',blocked_reason:null,health:'needs_permission',sources:[src()],results,...over})
const goal=state=>({id:'g',space_id:'s',owner_user_id:'u',project_id:null,agent_id:'a',runtime_profile_id:'rp',intent_json:{intent:'Agent long-term memory',title:'Agent memory'},budget_json:{requests_per_run:8,items_per_source:20,agent_attempts:2,repair_attempts:2,interval_seconds:86400},status:'running',revision:3,current_version_id:'v',active_version_id:'v',follow_state:state,follow_json:{confirmed_at:'2026-10-27T09:00:00Z',confirmed_by_user_id:'u',idempotency_key:'k',version_id:null,interval_seconds:86400,requests_per_run:8,items_per_source:20,activated_version_id:'v',reused_preview_id:null,last_error:null}})
const detail=(state,binding)=>({goal:goal(state),versions:[{id:'v',revision:1,plan_json:{summary:'Agent memory plan',sources:[spec],limitations:[]}}],previews:[],bindings:[{id:'b',status:'paused',spec_json:spec,gaps_json:[],cursor_json:{},...binding}],agent_runs:[],messages:[],repairs:[],runs:[],changes:[]})
const view=(over={})=>({binding_id:'b',binding_revision:0,resolvable_by:'you',source_name:'Agent memory search',current:{capture_policy:'extract_text',retention_policy:'full_text',source_status:'active',channel_status:'active',uses_credential:false},changed:null,related_changes:[{kind:'source_material_retention',at:'2026-10-28T14:45:51Z'}],authority:'a'.repeat(64),...over})

before(async()=>{
 server=await preview({configFile:false,preview:{host:'127.0.0.1',port:0}})
 baseUrl=`http://127.0.0.1:${server.httpServer.address().port}`
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE})
})
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve))})

async function open(width,fixture){
 const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'})
 const unknown=[],errors=[],writes=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.addInitScript(locale=>localStorage.setItem('rainver:locale',locale),fixture.locale??'en')
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1','')
  if(req.method()!=='GET'){writes.push({path,body:req.postDataJSON()});const r=fixture.write(path,req.postDataJSON());return route.fulfill(r)}
  let data
  if(path==='/me')data={id:'u',name:'Owner',email:'o@example.test',default_space_id:'s',instance_role:'member'}
  else if(path==='/me/spaces')data=[{id:'s',name:'Space',type:'personal',role:'owner'}]
  else if(path==='/plugins/effective')data={plugins:{}}
  else if(path==='/proposals')data={items:[],total:0,next_cursor:null}
  else if(path==='/me/agent-attention/snapshot')data={type:'attention.snapshot',seq:1,version:'fixture',unread_count:0,page:{items:[],total:0,next_cursor:null},notices:[]}
  else if(path==='/me/agent-attention/stream')return route.fulfill({status:503,body:''})
  else if(path==='/sources/goal-setup/agent-search/rp')data={supported:false}
  else if(path==='/sources/goals/g')data=fixture.detail()
  else if(path==='/sources/goals')data={goals:[fixture.detail().goal]}
  else if(path==='/sources/goals/g/bindings/b/source-confirmation')data=fixture.view()
  else if(path.endsWith('/information-digests/reading')||path.endsWith('/reading'))data={items:fixture.items?.()??[],total:fixture.items?.().length??0,next_cursor:null}
  else if(path==='/agents')data=[{id:'a',name:'Search Agent',created_by_user_id:'u',agent_kind:'standard'}]
  else if(path==='/agents/runtime-profiles'||path.endsWith('/runtime-profiles'))data=[]
  else if(path.endsWith('/conversation-backends'))data={options:[],binding:null}
  else if(path.endsWith('/native-availability'))data={supported:false}
  else{unknown.push(path);return route.fulfill({status:404,json:{detail:'Not part of the browser fixture'}})}
  return route.fulfill({json:data})
 })
 return {page,unknown,errors,writes}
}

test('REPORTED: a changed Source is explained in the topic, confirmed there, refused when it changes again, and collecting resumes',async()=>{
 for(const width of [390,1280]){
  let state='blocked',current=view()
  const fixture={
   detail:()=>state==='blocked'?detail(followState()):detail(followState({phase:'scheduled',health:'ok',sources:[src({status:'active',health:'ok',error:null,attention:null,resolvable_by:null})]}),{status:'active'}),
   view:()=>current,
   write:(path,body)=>{
    if(body.authority!==current.authority||body.binding_revision!==current.binding_revision)return {status:409,json:{error:'source_scope_changed',message:'source_scope_changed'}}
    state='active';return {json:{binding_id:'b',binding_revision:1,status:'active'}}
   },
  }
  const {page,unknown,errors,writes}=await open(width,fixture)
  try{
   await page.goto(`${baseUrl}/spaces/s/library/reading/goals`)
   await page.getByText('Source changed — confirm').first().waitFor()
   if(shots)await page.screenshot({path:`${shots}/list-${width}.png`,fullPage:true})
   await page.goto(`${baseUrl}/spaces/s/library/reading/goals/g`)
   await page.getByText(/A source this topic uses changed after you confirmed the topic/).waitFor()
   assert.equal(await page.getByRole('link',{name:'Review source'}).count(),0,'no dead-end link to the Source page')
   assert.ok(await page.getByText('Waiting for your confirmation').isVisible())
   assert.equal(await page.getByText(/needs permission/i).count(),0,'not labelled as a generic permission problem')
   if(shots)await page.screenshot({path:`${shots}/problem-${width}.png`,fullPage:true})
   await page.getByRole('button',{name:'Review change and continue'}).click()
   const dialog=page.getByRole('dialog')
   await dialog.getByText('Saving full text was allowed for this source',{exact:false}).waitFor();await page.waitForTimeout(400)
   assert.ok(await dialog.getByText('Full text',{exact:true}).isVisible())
   if(shots)await page.screenshot({path:`${shots}/explain-${width}.png`})
   // The Source changes again before the owner confirms: refused, shown again.
   current=view({authority:'b'.repeat(64),changed:['retention_policy'],current:{...view().current,retention_policy:'excerpt'}})
   await dialog.getByRole('button',{name:'Confirm and continue'}).click()
   await dialog.getByRole('alert').filter({hasText:'The source changed again since this was shown.'}).waitFor()
   await dialog.getByText('Changed since the topic was confirmed: What is kept.').waitFor();await page.waitForTimeout(300)
   assert.equal(state,'blocked')
   if(shots)await page.screenshot({path:`${shots}/refused-${width}.png`})
   await dialog.getByRole('button',{name:'Confirm and continue'}).click()
   await page.getByText(/A source this topic uses changed/).waitFor({state:'detached'})
   assert.equal(await page.getByRole('dialog').count(),0)
   assert.deepEqual(writes.map(w=>w.body),[{binding_revision:0,authority:'a'.repeat(64)},{binding_revision:0,authority:'b'.repeat(64)}])
   if(shots)await page.screenshot({path:`${shots}/recovered-${width}.png`,fullPage:true})
   assert.deepEqual(errors,[]);assert.deepEqual(unknown.filter(p=>!p.startsWith('/proposals')&&p!=='/me/agent-attention/stream'&&!p.startsWith('/sources/goal-setup/')),[])
  }finally{await page.close()}
 }
})

test('a Source the topic can no longer use says who must act and offers no confirmation or Source page dead end',async()=>{
 const fixture={detail:()=>detail(followState({sources:[src({attention:'access',resolvable_by:'source_owner'})]}),{unavailable:true}),view:()=>view({resolvable_by:'source_access',current:null,authority:null}),write:()=>({status:500,json:{}})}
 const {page,errors,writes}=await open(390,fixture)
 try{
  await page.goto(`${baseUrl}/spaces/s/library/reading/goals/g`)
  await page.getByText(/Its owner or a Space admin must restore it; this topic cannot\./).waitFor()
  assert.ok(await page.getByText('Waiting for the source’s owner').isVisible())
  assert.equal(await page.getByRole('button',{name:'Review change and continue'}).count(),0)
  assert.equal(await page.getByRole('link',{name:'Review source'}).count(),0)
  if(shots)await page.screenshot({path:`${shots}/source-owner-390.png`,fullPage:true})
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[])
 }finally{await page.close()}
})


test('latest collection replaces the unread chip without adding badges, metadata rows or card height',async()=>{
 for(const width of [390,1280]){
  const measures=[];
  for(const fresh of [false,true]){
   const topic={goal_id:'g',project_id:null,title:'Agent memory',selection_status:'important',selection_reason:'与主题相关',judged_by:'topic_rules',delivery_kind:'unknown_freshness',change_evidence_url:null,...(fresh?{new_in_latest_collection:true}:{})};
   const row={key:'article',source_item_id:'article',source_item_ids:['article'],title:'机器人控制台：本次收集的文章',summary:'说明内容保持不变。标记只替换原来未读的位置，不增加卡片信息行。',source_uri:'https://example.test/article',occurred_at:'2026-10-26T09:00:00Z',access_level:'full',reader_origin:'library',read_status:'unread',dismissed:false,available_at:'2026-10-29T09:00:00Z',contributions:[],material_links:[],topics:[topic]};
   const fixture={locale:'zh-CN',items:()=>[row],detail:()=>detail(followState({phase:'scheduled',health:'ok',sources:[src({status:'active',health:'ok',error:null,attention:null,resolvable_by:null})]}),{status:'active'}),view:()=>view(),write:()=>({status:500,json:{}})};
   const {page,unknown,errors,writes}=await open(width,fixture);
   try{
    await page.goto(`${baseUrl}/spaces/s/library/reading/goals/g`);
    const heading=page.getByRole('heading',{name:row.title});await heading.waitFor();
    const card=page.locator('li').filter({has:heading});await card.getByText(fresh?'本次新增':'未读',{exact:true}).waitFor();
    await page.evaluate(()=>document.fonts.ready);
    measures.push(await card.evaluate(el=>{const h=el.querySelector('h2');return {height:el.getBoundingClientRect().height,metadataHeight:h.previousElementSibling.getBoundingClientRect().height,badges:el.querySelectorAll('[class*="rounded-full"]').length,overflow:el.scrollWidth>el.clientWidth}}));
    assert.equal(await card.locator('details[open]').count(),0,'supporting details remain collapsed');
    if(shots)await card.screenshot({path:`${shots}/arrival-${fresh?'after':'before'}-${width}.png`});
    assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);assert.deepEqual(unknown,[]);
   }finally{await page.close()}
  }
  assert.equal(measures[1].badges,measures[0].badges,'badge count unchanged');
  assert.equal(measures[1].metadataHeight,measures[0].metadataHeight,'no new metadata row');
  assert.equal(measures[1].height,measures[0].height,'card height unchanged');
  assert.equal(measures[1].overflow,false,'no horizontal overflow');
 }
});
