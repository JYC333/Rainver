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
 const state={item_id:item,item_title:'Shallow homepage result',project_id:project,project_name:'Warehouse project',can_manage:true,initialized:true,effective_version_id:'v1',effective_version:1,effective_scope:'system',method:baseline,result_provenance:null,versions:[],cases:[],trials:[],runtimes:[{agent_id:'a',runtime_profile_id:'r',name:'Synthetic Analyst · Local',usable:true,reason:null}]}
 const writes=[]
 await page.route('**/api/v1/**',async route=>{const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method(),json=data=>route.fulfill({json:data});if(method!=='GET')writes.push(path)
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
  if(path==='/prompts/reading-method/drafts'){const b=request.postDataJSON();state.versions=[{id:'v2',version:2,status:'draft',content_hash:'a'.repeat(64),method:b.method,reason:b.reason}];return json({id:'v2'})}
  if(path==='/prompts/reading-method/samples'){state.cases=[{id:'sample',name:'Homepage + docs'}];return json({id:'sample'})}
  if(path==='/prompts/reading-method/trials'){state.trials=[{id:'pair',candidate_version_id:'v2',baseline_version_id:'v1',status:'passed',stale:false,visibility:'visible',judgment:null,reason:null,case_name:'Homepage + docs',baseline:{run_id:'old',status:'succeeded',text:'# Homepage\nOnly a generic product overview.',seconds:2,cost_usd:null},candidate:{run_id:'new',status:'succeeded',text:exampleResult,seconds:3,cost_usd:null}}];return json(state.trials[0])}
  if(path.endsWith('/judgment')){Object.assign(state.trials[0],request.postDataJSON());return json(state.trials[0])}
  if(path==='/prompts/reading-method/promote'){state.promotion={id:'proposal-fixture',status:'pending',candidate_version_id:'v2'};return json({proposal_id:'proposal-fixture'})}
  if(path==='/prompts/reading-method/rollback'){Object.assign(state,{effective_version_id:'v1',effective_version:1,method:baseline});return json({version_id:'v1'})}
  if(path===`/reader/documents/source_item/${item}`)return json({document_type:'source_item',document_id:item,space_id:space,project_id:project,title:'Shallow homepage result',plain_text:'Only a homepage overview.',normalized_text:'Only a homepage overview.',content_hash:'fixture',structure_hash:'fixture-tree',content_format:'tiptap_json',content_schema_version:1,content_json:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Only a homepage overview.'}]}]},source_item_id:item,artifact_id:null,source_snapshot_id:null,raw_artifact_id:null,extracted_artifact_id:null,source_uri:'https://example.org/flow',content_state:'content_saved',can_annotate:true,image_policy:'none'})
  if(path.endsWith('/annotations'))return json({items:[]})
  if(path.includes('/reader/preferences'))return json({font_size:null,line_height:'normal',width:'medium',font:'sans',theme:'app'})
  if(path.includes('/position'))return json({position:null})
  return route.fulfill({status:404,json:{detail:'Outside synthetic browser fixture'}})
 })
 return {state,writes}
}
for(const theme of ['dark','light'])for(const locale of ['en','zh-CN'])for(const width of [390,1280])test(`method journey ${theme} ${locale} ${width}`,async()=>{
 const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'});await page.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme);localStorage.setItem('project.sidecar.method-project.open','false')},{locale,theme});const {state,writes}=await fixture(page);const cn=locale==='zh-CN',text=(a,b)=>cn?a:b
 try{
 await page.goto(`${base}/spaces/${space}/library/items/${item}`)
 await page.getByRole('link',{name:text('改进结果：调整此条目的阅读方法','Improve result: adjust the reading method for this item')}).waitFor();await mkdir('/tmp/reading-method-browser',{recursive:true});await page.screenshot({path:`/tmp/reading-method-browser/reader-entry-${theme}-${locale}-${width}.png`,fullPage:true});
 await page.getByRole('link',{name:text('改进结果：调整此条目的阅读方法','Improve result: adjust the reading method for this item')}).click()
 await page.getByRole('button',{name:text('修改方法','Edit method'),exact:true}).click()
 await page.getByLabel(text('本次问题／改进说明','Problem / reason for change')).fill(text('主页没有机制证据','Missing mechanism evidence'))
 await page.getByLabel(text('阅读方法','Reading method'),{exact:true}).fill(baseline+' Read the actual retry example and identify a counterexample.')
 await page.getByRole('button',{name:text('保存草稿（不影响正式运行）','Save draft (production unchanged)')}).click()
 await page.getByRole('button',{name:text('添加合成主页＋文档样例','Add synthetic homepage + docs sample')}).click()
 const execution=page.getByRole('button',{name:text('执行配置（明确选择）','Execution configuration (choose explicitly)')});
 if(theme==='dark'&&locale==='en'&&width===1280){await page.waitForFunction(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Execution configuration (choose explicitly)');return b&&!b.disabled});await execution.focus();await execution.press('Enter');await page.getByRole('option',{name:'Synthetic Analyst · Local',exact:true}).waitFor();let reached=false;for(let n=0;n<12;n++){await page.keyboard.press('Tab');const focused=await page.evaluate(()=>({role:document.activeElement?.getAttribute('role'),text:document.activeElement?.textContent}));if(focused.role==='option'&&focused.text==='Synthetic Analyst · Local'){reached=true;await page.screenshot({path:'/tmp/reading-method-browser/keyboard-runtime-dark-en-1280.png',fullPage:true});await page.keyboard.press('Enter');break}}assert.equal(reached,true);await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Execution configuration (choose explicitly)'&&b.textContent==='Synthetic Analyst · Local'))}else{await execution.click();await page.getByRole('option',{name:'Synthetic Analyst · Local',exact:true}).click()}
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
 await page.getByText(/(?:当前生效|Effective) v2/).waitFor()
 await page.getByRole('heading',{name:text('项目相关功能调查','Project-related functional investigation'),exact:true}).scrollIntoViewIfNeeded()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false)
 await mkdir('/tmp/reading-method-browser',{recursive:true});await page.screenshot({path:`/tmp/reading-method-browser/${theme}-${locale}-${width}.png`,fullPage:true})
 await page.getByRole('tab',{name:text('历史','History'),exact:true}).click()
 await page.getByRole('button',{name:text('回滚当前范围上一生效版','Roll back this scope to previous effective version')}).click()
 await page.getByText(/(?:当前生效|Effective) v1/).waitFor()
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
 const original=new URL(await open.getAttribute('href'),base);await improve.press('Enter');await page.getByRole('button',{name:cn?'修改方法':'Edit method',exact:true}).waitFor();assert.equal(await page.locator('select').count(),0);
 await page.getByRole('link',{name:cn?'← 返回正文':'← Back to reading'}).click();await page.waitForURL(u=>u.pathname.includes('/library/items/'));const arrived=new URL(page.url());assert.equal(arrived.searchParams.get('from'),original.searchParams.get('from'));assert.equal(arrived.searchParams.get('returnTo'),original.searchParams.get('returnTo'));
 }finally{await page.close()}
})
