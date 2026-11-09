import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {before,after,test} from 'node:test'
import {chromium} from 'playwright-core'
import {preview} from 'vite'
const space='patch-space',now='2026-11-06T12:00:00Z'
const proposal={id:'patch-1',space_id:space,user_id:'owner',proposal_type:'code_patch',proposed_title:'Update the reviewed file',proposed_content:'Reviewed file change',rationale:'Requested change',status:'pending',risk_level:'high',urgency:'normal',visibility:'private',preview:false,expired:false,created_at:now}
let server,browser,url
before(async()=>{server=await preview({configFile:false,preview:{host:'127.0.0.1',port:0}});url=`http://127.0.0.1:${server.httpServer.address().port}`;browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE});await mkdir('/tmp/code-patch-shots',{recursive:true})})
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.httpServer.close(r))})
for(const [locale,theme,width] of [['en','dark',1280],['zh-CN','light',390]])test(`Proposal list -> durable detail receipt (${locale}/${theme}/${width})`,async()=>{
 const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});await context.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme)},{locale,theme});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let state=null,accepted=0;
 const receipt=()=>({id:'decision-1',proposal_id:proposal.id,phase:'apply',status:state,job_id:'job-1',error:state==='compensation_failed'?'code_patch_decision_compensation_failed':null})
 await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname.replace('/api/v1','');let data;
 if(path==='/me')data={id:'owner',name:'Patch owner',default_space_id:space,instance_role:'admin',is_instance_admin:true};
 else if(path==='/me/spaces')data=[{id:space,name:'Review Space',type:'personal',role:'owner'}];
 else if(path==='/plugins/effective')data={plugins:{}};
 else if(path==='/proposals')data={items:[proposal],total:1,limit:80,offset:0};
 else if(path===`/proposals/${proposal.id}/accept`){accepted++;state='pending';data={proposal,result_type:'code_patch_pending',result:receipt()};}
 else if(path===`/proposals/${proposal.id}`)data={...proposal,...(state?{code_patch_decision:receipt()}:{}),status:state==='succeeded'?'accepted':'pending'};
 else if(path==='/me/agent-attention/snapshot')data={type:'attention.snapshot',seq:1,version:'patch',unread_count:0,page:{items:[],total:0,limit:100,offset:0},notices:[]};
 else if(path==='/me/agent-attention/stream')return route.fulfill({status:503,body:''});
 else if(path==='/projects'||path==='/rooms/pending-approvals')data={items:[],total:0,limit:100,offset:0};
 else return route.fulfill({status:404,json:{detail:'Unavailable in visual fixture'}});
 return route.fulfill({status:path.endsWith('/accept')?202:200,json:data});
 });
 try{await page.goto(`${url}/spaces/${space}/proposals`);await page.getByRole('button',{name:'Accept',exact:true}).click();await page.getByText(locale==='en'?'Code patch decision recorded. File execution is queued; inspect Job Queue before continuing.':'代码补丁决定已记录，文件操作已入队；请在任务队列查看结果后继续。').waitFor();await page.getByRole('link',{name:proposal.proposed_title}).click();
 await page.getByText(locale==='en'?'File execution is queued. The proposal remains pending.':'文件执行已排队，提案仍待处理。').waitFor();assert.equal(await page.getByRole('button',{name:'Accept',exact:true}).count(),0);
 const destination=page.getByRole('link',{name:locale==='en'?'Open Job Queue':'打开任务队列'});assert.match(await destination.getAttribute('href'),/\/jobs$/);
 await page.screenshot({path:`/tmp/code-patch-shots/${locale}-pending.png`,fullPage:true});
 state='compensation_failed';await page.getByRole('button',{name:locale==='en'?'Refresh decision':'刷新决定'}).click();await page.getByText(locale==='en'?'File restoration needs attention. Inspect Job Queue and resolve the files before continuing.':'文件恢复需要处理。请查看任务队列并解决文件问题后再继续。').waitFor();await page.screenshot({path:`/tmp/code-patch-shots/${locale}-restoration.png`,fullPage:true});
 state='succeeded';await page.getByRole('button',{name:locale==='en'?'Refresh decision':'刷新决定'}).click();await page.getByText(locale==='en'?'File execution and the decision receipt are complete.':'文件执行和决定回执已完成。').waitFor();assert.equal(accepted,1);assert.deepEqual(errors,[]);
 }catch(e){console.error('Fixture page',page.url(),(await page.locator('body').innerText()).slice(-2500));await page.screenshot({path:`/tmp/code-patch-shots/${locale}-failure.png`,fullPage:true});throw e;}finally{await context.close()}
})
