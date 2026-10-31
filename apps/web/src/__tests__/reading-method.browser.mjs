import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {before,after,test} from 'node:test'
import {preview} from 'vite'
import {chromium} from 'playwright-core'
let server,browser,base
before(async()=>{server=await preview({configFile:false,preview:{host:'127.0.0.1',port:0}});base=`http://127.0.0.1:${server.httpServer.address().port}`;browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE})})
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.httpServer.close(r))})
const space='method-space',project='method-project',item='method-item'
const baseline='Investigate capabilities with actual primary documentation and explain integration costs.'
const exampleResult='# Mechanism\nBounded retries need a stable idempotency key.\n\nEvidence: [documentation](https://example.org/flow/docs/retries).\n\nUnknown: retention duration. This is synthetic output for UI wiring, not a model-quality pass.'
async function fixture(page){
 const state={target_key:'reading.project_investigation',api_execution:{usable:true,name:'Synthetic default API · synthetic-chat',reason:null},item_id:item,item_title:'Shallow homepage result',project_id:project,project_name:'Warehouse project',can_manage:true,initialized:true,effective_content_hash:'b'.repeat(64),generations:[],effective_version_id:'v1',effective_version:1,effective_scope:'system',method:baseline,result_provenance:null,versions:[],cases:[],trials:[],runtimes:[{agent_id:'a',runtime_profile_id:'r',name:'Synthetic Analyst · Local',usable:true,reason:null}]}
 const meta={...state,target_key:'prompt.revision.method',method:'Revise the target prompt from supplied feedback. Preserve correct constraints and evidence boundaries; return a complete prompt and explanation, never a quality claim.',versions:[],cases:[],trials:[],generations:[]};meta.effective_version_id='revision-v1';state.revision_method={version_id:'revision-v1',version:1,method:meta.method};meta.revision_method=state.revision_method;const contexts={'reading.project_investigation':state,'prompt.revision.method':meta};let activeTarget='reading.project_investigation';
 const writes=[]
 await page.route('**/api/v1/**',async route=>{const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method(),json=data=>route.fulfill({json:data});if(method!=='GET')writes.push(path);const body=method==='POST'?request.postDataJSON():{};if(path==='/prompts/reading-method'&&method==='GET')activeTarget=url.searchParams.get('target_key')??'reading.project_investigation';const state=contexts[body?.target_key??activeTarget];
  if(path==='/prompts/reading-method/cli-options')return json([{agent_id:'a',runtime_profile_id:'r',name:'codex_cli · Synthetic Host · Native',usable:true,reason:null}]);
  if(path==='/providers')return json([{id:'api-fixture',name:'Synthetic default API',enabled:true,grant_enabled:true,provider_type:'ollama',default_model:'synthetic-chat',available_models:['synthetic-chat'],is_default:true}]);
  if(path===`/sources/items/${item}/processing`)return json({status:'idle',can_prepare:true})
  if(path.endsWith('/reading'))return json({items:[{key:item,source_item_id:item,source_item_ids:[item],material_project_id:null,title:'Investigation result',summary:'Only the homepage was read. Primary documentation remains unverified.',source_uri:null,occurred_at:null,access_level:'full',reader_origin:'serendipity',read_status:'unread',dismissed:false,available_at:'2026-10-28T00:00:00Z',contributions:[],topics:[],material_links:[]}],total:1,next_cursor:null})
  if(path.includes('/information-digests')&&!path.endsWith('/profile'))return json({status:'available',digest:{id:'edition',digest_type:path.includes('/projects/')?'project':'personal',project_id:path.includes('/projects/')?project:null,digest_date:'2026-10-28',timezone:'UTC',status:'ready',settings:{},team_aggregates_available:false,team_blind_spot_domains:[],items:[{id:'di',source_item_id:item,section:'serendipity',position:0,title:'Investigation result',summary:'Only homepage evidence. Further documentation required.',source_uri:null,genre:'article',domain_key:'technology',depth:'analysis',read_status:'unread',anonymous_read_count:null,score:1,component_scores:{},serendipity_feedback:null}],generated_at:'2026-10-29T00:00:00Z',period_start_utc:'2026-10-28T00:00:00Z',period_end_utc:'2026-10-29T00:00:00Z'}})
  if(path==='/projects')return json({items:[],total:0})
  if(path===`/projects/${project}`)return json({id:project,space_id:space,name:'Warehouse project',status:'active',settings:{},owner_user_id:'method-user'})
  if(path.includes('/briefings'))return json({items:[],total:0})
  if(path.includes('/source-goals')||path.includes('/sources/goals'))return json({goals:[]})
  if(path.includes('/reading-preference'))return json({show_in_my_reading:false})
  if(path==='/me')return json({id:'method-user',name:'Tester',default_space_id:space,instance_role:'member'})
  if(path==='/me/spaces')return json([{id:space,name:'Synthetic Space',type:'personal',role:'owner'}])
  if(path==='/plugins/effective')return json({plugins:{}})
  if(path==='/prompts/reading-method/entry')return json({can_manage:true,project_id:project})
  if(path==='/prompts/reading-method'&&method==='GET')return state.error?route.fulfill({status:503,json:{detail:'Synthetic retryable failure'}}):json(state)
  if(path==='/prompts/reading-method/generations'){
   const b=request.postDataJSON();if(b.agent_id){assert.equal(b.agent_id,'a');assert.equal(b.runtime_profile_id,'r');assert.equal(b.provider_id,undefined);assert.equal(b.model,undefined);}else{assert.equal(b.runtime_profile_id,undefined);}assert.equal(b.source_kind,'description');assert.equal(b.parent_version_id,state.effective_version_id);assert.equal(b.parent_content_hash,'b'.repeat(64));assert.ok(!('raw_log' in b));
   if(state.generationFailure)return route.fulfill({status:503,json:{detail:'Synthetic generation failure; description retained'}});
   const g={id:'generation-fixture',status:'queued',visibility:'visible',stale:false,description:b.description,parent_version_id:state.effective_version_id,candidate_version_id:null,candidate_version:null,method:null,baseline_method:state.method,summary:null,changes:[],execution_name:b.agent_id?'codex_cli · Synthetic Host · Native':'Synthetic default API · synthetic-chat',seconds:null,cost_usd:null};state.generations=[g];return json(g)
  }
  if(path==='/prompts/reading-method/generations/generation-fixture/cancel'){state.generations[0].status='cancelled';return json(state.generations[0])}
  if(path===`/prompts/reading-method/generations/${state.generations?.[0]?.id}`){
   const g=state.generations[0];
   if(state.generationReady&&g.status==='queued'){Object.assign(g,{status:'ready',candidate_version_id:'v2',candidate_version:2,method:(state.target_key==='prompt.revision.method'?state.method+' Preserve every legitimate input and output constraint.':baseline+' Inspect primary examples and report limitations.'),summary:state.target_key==='prompt.revision.method'?'Clarified revision constraints.':'Added documentation evidence and explicit unknowns.',changes:state.target_key==='prompt.revision.method'?['Preserve input/output and evidence constraints.','Turn feedback into an executable revision strategy.']:['Inspect primary API examples.','State adaptation costs and unknowns.'],seconds:3});state.versions=[{id:'v2',version:2,status:'draft',content_hash:'a'.repeat(64),method:g.method,reason:g.description}];}
   return json(g)
  }
  if(path==='/prompts/reading-method/drafts'){const b=request.postDataJSON();state.versions=[{id:'v2',version:2,status:'draft',content_hash:'a'.repeat(64),method:b.method,reason:b.reason}];return json({id:'v2'})}
  if(path==='/prompts/reading-method/samples'){state.cases=[{id:'sample',name:state.target_key==='prompt.revision.method'?'Controlled prompt revision (offline)':'Homepage + docs'}];return json({id:'sample'})}
  if(path==='/prompts/reading-method/trials'){state.trials=[{id:'pair',candidate_version_id:'v2',baseline_version_id:state.effective_version_id,status:'passed',stale:false,visibility:'visible',judgment:null,reason:null,case_name:state.target_key==='prompt.revision.method'?'Controlled prompt revision (offline)':'Homepage + docs',baseline:{run_id:'old',status:'succeeded',text:state.target_key==='prompt.revision.method'?'# Revised prompt\nSummarize supplied release notes in the user language. Cite supplied evidence, do not browse, and report unknowns.':'# Homepage\nOnly a generic product overview.',seconds:2,cost_usd:null},candidate:{run_id:'new',status:'succeeded',text:state.target_key==='prompt.revision.method'?'# Revised prompt\nSeparate verified changes and practical impact from unverified claims. Preserve the user language and supplied-evidence-only boundary. Do not browse or invent missing facts. Report summary and unknowns.':exampleResult,seconds:3,cost_usd:null}}];return json(state.trials[0])}
  if(path.endsWith('/judgment')){Object.assign(state.trials[0],request.postDataJSON());return json(state.trials[0])}
  if(path==='/prompts/reading-method/promote'){state.promotion={id:'proposal-fixture',status:'pending',candidate_version_id:'v2'};return json({proposal_id:'proposal-fixture'})}
  if(path==='/prompts/reading-method/rollback'){Object.assign(state,{effective_version_id:'v1',effective_version:1,method:baseline});return json({version_id:'v1'})}
  if(path===`/reader/documents/source_item/${item}`)return json({document_type:'source_item',document_id:item,space_id:space,project_id:project,title:'Shallow homepage result',plain_text:'Only a homepage overview.',normalized_text:'Only a homepage overview.',content_hash:'fixture',structure_hash:'fixture-tree',content_format:'tiptap_json',content_schema_version:1,content_json:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Only a homepage overview.'}]}]},source_item_id:item,artifact_id:null,source_snapshot_id:null,raw_artifact_id:null,extracted_artifact_id:null,source_uri:'https://example.org/flow',content_state:'content_saved',can_annotate:true,image_policy:'none'})
  if(path.endsWith('/annotations'))return json({items:[]})
  if(path.includes('/reader/preferences'))return json({font_size:null,line_height:'normal',width:'medium',font:'sans',theme:'app'})
  if(path.includes('/position'))return json({position:null})
  return route.fulfill({status:404,json:{detail:'Outside synthetic browser fixture'}})
 })
 return {state,writes,meta}
}
for(const theme of ['dark','light'])for(const locale of ['en','zh-CN'])for(const width of [390,1280])test(`method journey ${theme} ${locale} ${width}`,async()=>{
 const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'});await page.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme);localStorage.setItem('project.sidecar.method-project.open','false')},{locale,theme});const {state,writes}=await fixture(page);const cn=locale==='zh-CN',text=(a,b)=>cn?a:b
 try{
 await page.goto(`${base}/spaces/${space}/library/items/${item}`)
 await page.getByRole('link',{name:text('改进结果：调整此条目的阅读方法','Improve result: adjust the reading method for this item')}).waitFor();await mkdir('/tmp/reading-method-browser',{recursive:true});await page.screenshot({path:`/tmp/reading-method-browser/reader-entry-${theme}-${locale}-${width}.png`,fullPage:true});
 await page.getByRole('link',{name:text('改进结果：调整此条目的阅读方法','Improve result: adjust the reading method for this item')}).click()
 await page.getByText(text('高级','Advanced'),{exact:true}).click();await page.getByRole('button',{name:text('手动编辑','Edit manually'),exact:true}).click()
 await page.getByLabel(text('本次问题／改进说明','Problem / reason for change')).fill(text('主页没有机制证据','Missing mechanism evidence'))
 await page.getByLabel(text('阅读方法','Reading method'),{exact:true}).fill(baseline+' Read the actual retry example and identify a counterexample.')
 await page.getByRole('button',{name:text('保存草稿（不影响正式运行）','Save draft (production unchanged)')}).click()
 await page.getByRole('button',{name:text('添加合成主页＋文档样例','Add synthetic homepage + docs sample')}).click()
 assert.equal(await page.getByRole('button',{name:text('执行配置（明确选择）','Execution configuration (choose explicitly)')}).count(),0);
 await page.getByRole('button',{name:text('开始两个 Run 的比较','Start two-run comparison')}).click()
 await page.getByRole('heading',{name:'Mechanism',exact:true}).waitFor()
 await page.getByRole('heading',{name:'Mechanism',exact:true}).scrollIntoViewIfNeeded()
 assert.equal(writes.filter(p=>p==='/prompts/reading-method/trials').length,1)
 await mkdir('/tmp/reading-method-browser',{recursive:true});await page.screenshot({path:`/tmp/reading-method-browser/${theme}-${locale}-${width}-comparison.png`,fullPage:true})
 await page.getByRole('button',{name:text('人工判断','Human judgment'),exact:true}).click();await page.getByRole('option',{name:text('更好','Better'),exact:true}).click()
 await page.getByRole('textbox',{name:text('判断理由','Judgment reason')}).fill(text('仅合成接线测试，不代表语义通过','Synthetic wiring only, not semantic quality'))
 await page.getByRole('button',{name:text('记录人工判断','Record judgment')}).click()
 await page.getByRole('button',{name:text('申请启用','Request activation')}).click()
 await page.getByText(text('提案等待你的决定，尚未启用。','Proposal awaits your decision; it is not active.'),{exact:false}).waitFor()
 assert.equal(state.effective_version_id,'v1');await page.screenshot({path:`/tmp/reading-method-browser/pending-${theme}-${locale}-${width}.png`,fullPage:true})
 // External fixture decision, not an Agent approving a product proposal.
 state.promotion.status='accepted';state.versions[0].status='approved';
 Object.assign(state,{effective_version_id:'v2',effective_version:2,effective_scope:'project',method:state.versions[0].method})
 await page.getByRole('button',{name:text('决定后刷新生效版本','Refresh effective version after decision')}).click()
 await page.locator('main header').getByText(/(?:当前生效|Effective) v2/).waitFor()
 await page.getByRole('heading',{name:text('阅读方法','Reading method'),exact:true}).scrollIntoViewIfNeeded()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false)
 await mkdir('/tmp/reading-method-browser',{recursive:true});await page.screenshot({path:`/tmp/reading-method-browser/${theme}-${locale}-${width}.png`,fullPage:true})
 await page.getByRole('tab',{name:text('历史','History'),exact:true}).click()
 await page.getByRole('button',{name:text('回滚当前范围上一生效版','Roll back this scope to previous effective version')}).click()
 await page.locator('main header').getByText(/(?:当前生效|Effective) v1/).waitFor()
 if(width===390){state.error=true;await page.getByRole('button',{name:text('回滚当前范围上一生效版','Roll back this scope to previous effective version')}).click();await page.getByRole('alert').waitFor();await page.getByRole('alert').scrollIntoViewIfNeeded();await page.screenshot({path:`/tmp/reading-method-browser/error-${theme}-${locale}-${width}.png`,fullPage:true});state.error=false;await page.getByRole('button',{name:text('重试／刷新','Retry / refresh')}).click();await page.getByRole('alert').waitFor({state:'hidden'})}
 }catch(error){await mkdir('/tmp/reading-method-browser',{recursive:true});await page.screenshot({path:`/tmp/reading-method-browser/failed-${theme}-${locale}-${width}.png`,fullPage:true});console.error((await page.locator('body').innerText()).slice(0,2500));throw error}finally{await page.close()}
})

for(const theme of ['dark','light'])for(const locale of ['en','zh-CN'])for(const width of [390,1280])test(`card entry ${theme} ${locale} ${width}`,async()=>{
 const cn=locale==='zh-CN',name=cn?'改进结果：调整此条目的阅读方法':'Improve result: adjust the reading method for this item';
 const page=await browser.newPage({viewport:{width,height:950},serviceWorkers:'block'});await page.addInitScript(({theme,locale})=>{localStorage.setItem('rainver:theme',theme);localStorage.setItem('project.sidecar.method-project.open','false');localStorage.setItem('rainver:locale',locale)},{theme,locale});await fixture(page)
 const isProject=width===1280,isDigest=theme==='light';const parent=isProject?`/projects/${project}/sources${isDigest?'?tab=digest&date=2026-10-28':''}`:isDigest?'/library/digests?date=2026-10-28':'/library/reading';
 try{
 await page.goto(`${base}/spaces/${space}${parent}`);const improve=page.getByRole('link',{name,exact:true});await improve.waitFor();const open=page.getByRole('link',{name:cn?'打开阅读器':'Open Reader',exact:true}).first();await open.waitFor();await improve.scrollIntoViewIfNeeded();
 const geometry=await improve.evaluate((element)=>{const primary=[...element.parentElement.querySelectorAll('a')].find(e=>e.textContent==='Open Reader'||e.textContent==='打开阅读器');const style=getComputedStyle(element),ps=getComputedStyle(primary),r=element.getBoundingClientRect(),p=primary.getBoundingClientRect();return {font:style.fontSize,primaryFont:ps.fontSize,height:r.height,primaryHeight:p.height,underline:style.textDecorationLine,order:!!(primary.compareDocumentPosition(element)&Node.DOCUMENT_POSITION_FOLLOWING),rem:parseFloat(getComputedStyle(document.documentElement).fontSize),width:r.width,textHeight:style.lineHeight,primary:p.toJSON(),entry:r.toJSON()}})
 assert.equal(geometry.font,geometry.primaryFont);assert.equal(geometry.order,true);assert.equal(geometry.underline,'none');assert.ok(Math.abs(geometry.height-geometry.primaryHeight)<2);assert.ok(geometry.height>= (width===390?44:geometry.rem*1.75));
 await improve.focus();await page.screenshot({path:`/tmp/reading-method-browser/card-${theme}-${locale}-${width}.png`,fullPage:true});console.log(JSON.stringify({theme,locale,width,parent,geometry}));
 const original=new URL(await open.getAttribute('href'),base);await improve.press('Enter');await page.getByRole('heading',{name:cn?'阅读方法':'Reading method',exact:true}).waitFor();assert.equal(await page.locator('select').count(),0);
 await page.getByRole('link',{name:cn?'← 返回正文':'← Back to reading'}).click();await page.waitForURL(u=>u.pathname.includes('/library/items/'));const arrived=new URL(page.url());assert.equal(arrived.searchParams.get('from'),original.searchParams.get('from'));assert.equal(arrived.searchParams.get('returnTo'),original.searchParams.get('returnTo'));
 }finally{await page.close()}
})

for(const [theme,locale,width] of [['dark','zh-CN',390],['dark','en',1280],['light','en',390],['light','zh-CN',1280]])test(`description revision ${theme} ${locale} ${width}`,async()=>{
 const page=await browser.newPage({viewport:{width,height:950},serviceWorkers:'block'}),cn=locale==='zh-CN',text=(zh,en)=>cn?zh:en;
 await page.addInitScript(({theme,locale})=>{localStorage.setItem('rainver:theme',theme);localStorage.setItem('rainver:locale',locale);localStorage.setItem('project.sidecar.method-project.open','false')},{theme,locale});
 const {state,writes}=await fixture(page);state.project_name=cn?'多仓库跨团队机器人调查与运行方式改进项目（合成范围名称）':'Warehouse coordination, robotics investigation and operations improvement (synthetic scope)';state.method=baseline+'\n\nRead relevant primary documentation and a concrete API example before explaining mechanisms, costs and unknowns.\n\nA synthetic code example: submit({ idempotency_key: stable_event_id, retry: { max: 3 } });\n'+ 'Evidence should distinguish observed behavior from inference. '.repeat(5);state.result_provenance={version_id:'recorded-version',version:1,run_id:'origin-run',content_hash:null};await mkdir('/tmp/reading-workbench-layout',{recursive:true});
 try{
  const parent=theme==='light'?'/library/digests?date=2026-10-28':'/library/reading';
  await page.goto(`${base}/spaces/${space}${parent}`);
  const open=page.getByRole('link',{name:text('打开阅读器','Open Reader'),exact:true}).first();await open.waitFor();const original=new URL(await open.getAttribute('href'),base);
  const improve=page.getByRole('link',{name:text('改进结果：调整此条目的阅读方法','Improve result: adjust the reading method for this item')});await improve.waitFor();await page.screenshot({path:`/tmp/reading-workbench-layout/entry-${theme}-${locale}-${width}.png`,fullPage:true});await improve.click();
  const title=page.getByRole('heading',{name:text('阅读方法','Reading method'),exact:true});await title.waitFor();
  const header=await title.evaluate(el=>{const r=el.getBoundingClientRect();let p=el.parentElement;const clips=[];while(p){const a=p.getBoundingClientRect(),s=getComputedStyle(p);if(s.overflowX!=='visible'&&r.right>a.right+1)clips.push(p.tagName);p=p.parentElement;}return {width:r.width,left:r.left,right:r.right,viewport:innerWidth,clips}});assert.ok(header.left>=0&&header.right<=width);assert.deepEqual(header.clips,[]);const scopeGeometry=await title.locator('..').locator('p').evaluate(p=>({scroll:p.scrollWidth,width:p.clientWidth,height:p.clientHeight,line:parseFloat(getComputedStyle(p).lineHeight)}));assert.ok(scopeGeometry.scroll<=scopeGeometry.width+1);if(width===390)assert.ok(scopeGeometry.height>=scopeGeometry.line*2-1);
  assert.equal(await page.locator('select').count(),0);assert.equal(await page.getByLabel(text('本次问题／改进说明','Problem / reason for change')).count(),0);
  const current=page.getByRole('region',{name:text('当前方法','Current method'),exact:true});await current.waitFor();assert.equal(await current.locator('p').last().innerText(),state.method);assert.equal(await current.isVisible(),true);
  const advanced=page.locator('summary').filter({hasText:new RegExp('^'+text('高级','Advanced')+'$')});assert.equal(await advanced.count(),1);assert.equal(await advanced.evaluate(el=>el.parentElement.open),false);
  const currentOrder=await current.evaluate(el=>{const input=document.querySelector('textarea');return {before:!!(el.compareDocumentPosition(input)&Node.DOCUMENT_POSITION_FOLLOWING),gap:input.closest('[class*=bg-card]').getBoundingClientRect().top-el.getBoundingClientRect().bottom}});assert.equal(currentOrder.before,true);assert.ok(currentOrder.gap>=12);
  await page.screenshot({path:`/tmp/reading-workbench-layout/current-${theme}-${locale}-${width}.png`,fullPage:true});
  await advanced.focus();await page.keyboard.press('Enter');await page.getByRole('link',{name:text('打开高级工作台','Open advanced workspace'),exact:true}).waitFor();assert.equal(await page.getByText('v1 · recorded-version',{exact:true}).isVisible(),true);assert.equal(await page.getByLabel(text('本次问题／改进说明','Problem / reason for change')).count(),0);assert.equal(await page.getByLabel(text('哪里不好，希望怎样改？','What went wrong, and what should change?')).isEnabled(),true);assert.equal(writes.length,0);
  await advanced.evaluate(el=>el.parentElement.scrollIntoView({block:'center'}));await page.screenshot({path:`/tmp/reading-workbench-layout/info-${theme}-${locale}-${width}.png`,fullPage:true});await advanced.focus();await page.keyboard.press('Enter');
  const input=page.getByLabel(text('哪里不好，希望怎样改？','What went wrong, and what should change?'));await input.fill(text('现在只改写主页，希望调查相关文档与API示例，解释证据、机制与未知。','It only rewrites the homepage. Investigate relevant documentation and API examples, explaining evidence and unknowns.'));
  const choose=async()=>{assert.equal(await page.getByRole('button',{name:text('生成执行配置','Generation execution configuration')}).count(),0);};await choose();
  await page.screenshot({path:`/tmp/reading-workbench-layout/form-${theme}-${locale}-${width}.png`,fullPage:true});
  if(width===390){
   state.generationFailure=true;await page.getByRole('button',{name:text('生成候选版本','Generate candidate version'),exact:true}).click();await page.getByRole('alert').waitFor();assert.ok((await input.inputValue()).length>5);await page.screenshot({path:`/tmp/reading-workbench-layout/failure-${theme}-${locale}-${width}.png`,fullPage:true});state.generationFailure=false;
  }
  await page.getByRole('button',{name:text('生成候选版本','Generate candidate version'),exact:true}).click();await page.getByRole('button',{name:text('取消生成','Cancel generation'),exact:true}).waitFor();
  // Refresh restores the canonical in-flight record, without POSTing a second Run.
  const count=writes.filter(p=>p==='/prompts/reading-method/generations').length;await page.reload();await page.getByRole('button',{name:text('取消生成','Cancel generation'),exact:true}).waitFor();assert.equal(writes.filter(p=>p==='/prompts/reading-method/generations').length,count);
  await page.getByRole('button',{name:text('取消生成','Cancel generation'),exact:true}).click();await page.getByText(text('生成状态: 已取消','Generation: Cancelled'),{exact:true}).waitFor();
  await choose();await page.getByRole('button',{name:text('生成候选版本','Generate candidate version'),exact:true}).click();await page.getByRole('button',{name:text('取消生成','Cancel generation'),exact:true}).waitFor();state.generationReady=true;await page.getByRole('button',{name:text('刷新生成状态','Refresh generation'),exact:true}).click();await page.getByText('Added documentation evidence and explicit unknowns.',{exact:true}).waitFor();
  assert.equal(writes.filter(p=>p==='/prompts/reading-method/trials').length,0);assert.equal(writes.filter(p=>p==='/prompts/reading-method/promote').length,0);assert.equal(state.effective_version_id,'v1');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);await page.getByText('Added documentation evidence and explicit unknowns.',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:`/tmp/reading-workbench-layout/ready-${theme}-${locale}-${width}.png`,fullPage:true});
  assert.equal(await current.locator('p').last().innerText(),state.method);await page.getByRole('button',{name:text('下一步：试跑比较','Next: compare this candidate'),exact:true}).click();await page.getByRole('button',{name:text('继续修改（保存为新草稿）','Revise method (save a new draft)'),exact:true}).click();const manual=page.getByLabel(text('阅读方法','Reading method'),{exact:true});await manual.waitFor();assert.match(await manual.inputValue(),/Inspect primary examples/);assert.equal(await manual.evaluate(el=>el===document.activeElement),true);assert.equal(await advanced.evaluate(el=>el.parentElement.open),true);await manual.scrollIntoViewIfNeeded();await page.screenshot({path:`/tmp/reading-workbench-layout/manual-${theme}-${locale}-${width}.png`,fullPage:true});
  await page.getByLabel(text('本次问题／改进说明','Problem / reason for change')).fill(text('明确证据与限制','Clarify evidence and limitations'));await page.getByRole('button',{name:text('保存草稿（不影响正式运行）','Save draft (production unchanged)'),exact:true}).click();await manual.waitFor({state:'hidden'});await page.getByRole('tab',{name:text('试跑对比','Comparison'),exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:text('试跑对比','Comparison'),exact:true}).getAttribute('aria-selected'),'true');assert.equal(await manual.count(),0);
  await page.getByRole('link',{name:text('← 返回正文','← Back to reading'),exact:true}).click();await page.waitForURL(u=>u.pathname.includes('/library/items/'));const returned=new URL(page.url());assert.equal(returned.searchParams.get('from'),original.searchParams.get('from'));assert.equal(returned.searchParams.get('returnTo'),original.searchParams.get('returnTo'));
 }catch(error){await page.screenshot({path:`/tmp/reading-workbench-layout/FAILED-${theme}-${locale}-${width}.png`,fullPage:true});console.error((await page.locator('body').innerText()).slice(0,1800));throw error;}finally{await page.close();}
});
test('degraded generation retry localized state sample',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:950},serviceWorkers:'block'});await page.addInitScript(()=>{localStorage.setItem('rainver:locale','zh-CN');localStorage.setItem('rainver:theme','dark')});const {state}=await fixture(page);
 state.generations=[{id:'old-degraded',status:'degraded',visibility:'visible',stale:false,description:'希望查找实际文档和机制证据。',parent_version_id:state.effective_version_id,candidate_version_id:null,candidate_version:null,method:null,baseline_method:baseline,summary:null,changes:[],execution_name:'Synthetic Analyst · Local',seconds:2,cost_usd:null}];
 try{
  await page.goto(`${base}/spaces/${space}/library/items/${item}`);await page.getByRole('link',{name:'改进结果：调整此条目的阅读方法'}).click();await page.getByText('生成状态: 生成未完成，需明确重试',{exact:true}).waitFor();await page.getByRole('button',{name:'刷新生成状态'}).click();assert.equal(await page.getByRole('button',{name:'生成执行配置'}).count(),0);
  await page.getByText('生成状态: 生成未完成，需明确重试',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/reading-description-browser/degraded-zh-CN-390.png',fullPage:true});
  const sent=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/reading-method/generations'));await page.getByRole('button',{name:'生成候选版本',exact:true}).click();assert.equal((await sent).postDataJSON().retry_of,'old-degraded');await page.getByRole('button',{name:'取消生成',exact:true}).waitFor();state.generationReady=true;await page.getByRole('button',{name:'刷新生成状态'}).click();await page.getByText('Added documentation evidence and explicit unknowns.',{exact:true}).waitFor();assert.equal(state.generations[0].id,'generation-fixture');
 }finally{await page.close()}
});
for(const [theme,locale,width] of [['dark','zh-CN',390],['light','en',1280]])test(`default API meta method ${theme} ${locale} ${width}`,async()=>{
 const cn=locale==='zh-CN',text=(a,b)=>cn?a:b;const page=await browser.newPage({viewport:{width,height:950},serviceWorkers:'block'});await page.addInitScript(({theme,locale})=>{localStorage.setItem('rainver:theme',theme);localStorage.setItem('rainver:locale',locale)},{theme,locale});const {state,meta,writes}=await fixture(page);await mkdir('/tmp/prompt-revision-browser',{recursive:true});
 try{
 await page.goto(`${base}/spaces/${space}/library/reading`);await page.getByRole('link',{name:text('改进结果：调整此条目的阅读方法','Improve result: adjust the reading method for this item')}).click();await page.getByRole('region',{name:text('当前方法','Current method')}).waitFor();
 const feedback=page.getByLabel(text('哪里不好，希望怎样改？','What went wrong, and what should change?'));
 assert.match(await feedback.getAttribute('placeholder'),cn?/主页简介/:/homepage/);
 await page.getByText(text('完整调查正文沿 Source 材料进入 Reader。简报仍消费有限摘要，不代表综合质量已升级。','Investigation text is delivered through Source materials to Reader. Briefings still consume bounded excerpts; this is not a briefing-quality upgrade.'),{exact:true}).waitFor();
 await page.screenshot({path:`/tmp/prompt-revision-browser/reading-copy-${locale}-${width}.png`,fullPage:true});
 await page.getByText(text('高级','Advanced'),{exact:true}).click();await page.getByRole('button',{name:text('执行方式','Execution method'),exact:true}).click();await page.getByRole('option',{name:text('其他 API','Other API'),exact:true}).click();await page.getByRole('button',{name:text('API Provider','API Provider'),exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('option',{name:'Synthetic default API',exact:true}).click();await page.getByRole('button',{name:text('API 模型','API model'),exact:true}).click();await page.getByRole('option',{name:'synthetic-chat',exact:true}).click();assert.equal(writes.length,0);await page.screenshot({path:`/tmp/prompt-revision-browser/advanced-${locale}-${width}.png`,fullPage:true});
 await page.getByRole('link',{name:text('查看／改进系统改写方法','View / improve the system revision method')}).click();await page.getByRole('heading',{name:text('系统 Prompt 改写方法','System prompt revision method'),exact:true}).waitFor();assert.equal(await page.getByRole('region',{name:text('当前方法','Current method')}).locator('p').last().innerText(),meta.method);assert.equal(await page.getByRole('button',{name:text('生成执行配置','Generation execution configuration')}).count(),0);assert.equal(await feedback.getAttribute('placeholder'),text('例如：保留已有输入、输出与语言约束，将反馈转化为可执行的 Prompt 改写策略。','For example: preserve existing input, output and language constraints, and turn feedback into an executable prompt revision strategy.'));assert.equal(await page.getByText(/Investigation text is delivered through Source materials|完整调查正文沿 Source 材料/).count(),0);await page.screenshot({path:`/tmp/prompt-revision-browser/current-${locale}-${width}.png`,fullPage:true});
 await page.getByLabel(text('哪里不好，希望怎样改？','What went wrong, and what should change?')).fill(text('更明确地保留已有输入输出约束。','Preserve the existing input and output constraints more explicitly.'));await page.getByRole('button',{name:text('生成候选版本','Generate candidate version'),exact:true}).click();await page.getByRole('button',{name:text('取消生成','Cancel generation')}).waitFor();meta.generationReady=true;await page.getByRole('button',{name:text('刷新生成状态','Refresh generation')}).click();await page.getByText('Clarified revision constraints.',{exact:true}).waitFor();await page.getByText('Clarified revision constraints.',{exact:true}).scrollIntoViewIfNeeded();assert.equal(state.effective_version_id,'v1');assert.equal(meta.effective_version_id,'revision-v1');await page.screenshot({path:`/tmp/prompt-revision-browser/ready-${locale}-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:text('下一步：试跑比较','Next: compare this candidate'),exact:true}).click();await page.getByRole('button',{name:text('添加受控 Prompt 改写样例','Add controlled prompt-revision example'),exact:true}).click();await page.getByRole('button',{name:text('开始两个 Run 的比较','Start two-run comparison'),exact:true}).click();await page.getByRole('button',{name:text('人工判断','Human judgment'),exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Revised prompt',exact:true}).count(),2);await page.screenshot({path:`/tmp/prompt-revision-browser/compare-${locale}-${width}.png`,fullPage:true});assert.equal(writes.filter(p=>p.endsWith('/promote')).length,0);
 }finally{await page.close()}
});
test('default API setup failure keeps the method and advanced manual editor usable',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:950},serviceWorkers:'block'});await page.addInitScript(()=>{localStorage.setItem('rainver:locale','zh-CN');localStorage.setItem('rainver:theme','light')});const {state,writes}=await fixture(page);state.api_execution={usable:false,name:null,reason:'No default chat API'};state.runtimes=[];
 try{await page.goto(`${base}/spaces/${space}/library/reading`);await page.getByRole('link',{name:'改进结果：调整此条目的阅读方法'}).click();await page.getByRole('region',{name:'当前方法'}).waitFor();await page.getByLabel('哪里不好，希望怎样改？').fill('希望保留原证据约束。');assert.equal(await page.getByRole('button',{name:'生成候选版本',exact:true}).isDisabled(),true);await page.getByText('尚无可用默认文本 API。',{exact:false}).scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/prompt-revision-browser/missing-api-zh-CN-390.png',fullPage:true});await page.getByText('高级',{exact:true}).click();await page.getByRole('button',{name:'手动编辑',exact:true}).click();assert.equal(await page.getByLabel('阅读方法',{exact:true}).isEnabled(),true);assert.equal(writes.filter(p=>p.endsWith('/generations')).length,0);await page.screenshot({path:'/tmp/prompt-revision-browser/manual-no-api-zh-CN-390.png',fullPage:true});}finally{await page.close()}
});

for(const [theme,locale,width] of [['dark','zh-CN',390],['light','en',1280]])test(`optional CLI method ${theme} ${locale} ${width}`,async()=>{
 const cn=locale==='zh-CN',text=(a,b)=>cn?a:b;const page=await browser.newPage({viewport:{width,height:950},serviceWorkers:'block'});
 await page.addInitScript(({theme,locale})=>{localStorage.setItem('rainver:theme',theme);localStorage.setItem('rainver:locale',locale)},{theme,locale});
 const {state,meta}=await fixture(page);state.api_execution={usable:false,name:null,reason:'Synthetic API missing'};meta.api_execution=state.api_execution;
 await mkdir('/tmp/prompt-revision-cli-browser',{recursive:true});
 try{
  await page.goto(`${base}/spaces/${space}/library/reading`);await page.getByRole('link',{name:text('改进结果：调整此条目的阅读方法','Improve result: adjust the reading method for this item')}).click();
  for(const target of ['reading','meta']){
   if(target==='meta')await page.getByRole('link',{name:text('查看／改进系统改写方法','View / improve the system revision method')}).click();
   await page.getByText(text('高级','Advanced'),{exact:true}).click();
   await page.getByRole('button',{name:text('执行方式','Execution method'),exact:true}).click();await page.getByRole('option',{name:text('CLI 执行器','CLI runtime'),exact:true}).click();
   await page.getByRole('button',{name:text('CLI 执行器','CLI runtime'),exact:true}).click();await page.getByRole('option',{name:'codex_cli · Synthetic Host · Native',exact:true}).click();
   await page.screenshot({path:`/tmp/prompt-revision-cli-browser/${target}-${locale}-${width}.png`,fullPage:true});
   await page.getByLabel(text('哪里不好，希望怎样改？','What went wrong, and what should change?')).fill('Keep constraints and primary evidence explicit.');
   await page.getByRole('button',{name:text('生成候选版本','Generate candidate version'),exact:true}).click();await page.getByRole('button',{name:text('取消生成','Cancel generation'),exact:true}).waitFor();
   const model=target==='meta'?meta:state;model.generationReady=true;
   await page.getByRole('button',{name:text('刷新生成状态','Refresh generation'),exact:true}).click();await page.getByRole('button',{name:text('下一步：试跑比较','Next: compare this candidate'),exact:true}).click();
   await page.getByRole('button',{name:target==='meta'?text('添加受控 Prompt 改写样例','Add controlled prompt-revision example'):text('添加合成主页＋文档样例','Add synthetic homepage + docs sample'),exact:true}).click();
   await page.getByRole('button',{name:text('开始两个 Run 的比较','Start two-run comparison'),exact:true}).click();await page.getByRole('button',{name:text('人工判断','Human judgment'),exact:true}).waitFor();
   await page.screenshot({path:`/tmp/prompt-revision-cli-browser/${target}-compare-${locale}-${width}.png`,fullPage:true});
   if(target==='reading'){await page.getByRole('tab',{name:text('当前方法','Current method'),exact:true}).click();}
  }
 const back=page.getByRole('link',{name:/返回正文|Back to reading/});const href=await back.getAttribute('href');await back.click();assert.equal(new URL(page.url()).pathname+new URL(page.url()).search,new URL(href,base).pathname+new URL(href,base).search);
 }finally{await page.close();}
});
