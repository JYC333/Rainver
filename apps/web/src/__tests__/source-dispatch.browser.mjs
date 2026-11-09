import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {before,after,test} from 'node:test'
import {chromium} from 'playwright-core'
import {preview} from 'vite'
let server,browser,base
const space='source-check',user='source-user',now='2026-11-06T10:00:00.000Z'
const monitor={id:'monitor',space_id:space,source_connection_id:'origin',source_name:'Research source',name:'Evidence monitor',channel_type:'feed',endpoint_url:'https://example.test/rss',query:{},provider_query:{},query_fingerprint:'fp',status:'active',fetch_frequency:'manual',schedule_rule:null,connector_key:'rss',provider:{key:'rss',display_name:'RSS'},connection_status:'active',capture_policy:'reference_only',scan_state:{status:'active',cursor:{},watermark:{},next_run_at:null,last_run_at:null},goal_id:null}
const job={id:'dispatch-job',space_id:space,user_id:user,job_type:'source_extraction_manual',status:'failed',priority:0,payload:{extraction_job_id:'extraction'},result:{source_dispatch:'started'},error:'Connection closed after execution started',attempts:1,max_attempts:1,claimed_by:null,claimed_at:null,scheduled_at:now,started_at:now,completed_at:now,created_at:now,updated_at:now}
const pageOf=items=>({items,total:items.length,limit:100,offset:0})
before(async()=>{server=await preview({configFile:false,preview:{host:'127.0.0.1',port:0}});base=`http://127.0.0.1:${server.httpServer.address().port}`;browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE})})
after(async()=>{await browser?.close();await new Promise(r=>server.httpServer.close(r))})
test('Source parent entries explain enqueue and reach the existing unknown-outcome Job result',{timeout:90000},async()=>{
 const out=process.env.SOURCE_DISPATCH_SHOTS??'/tmp/source-dispatch-shots';await mkdir(out,{recursive:true})
 for(const [locale,theme,width] of [['en','dark',1280],['zh-CN','dark',390],['en','light',390],['zh-CN','light',1280]]){
  const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'}),errors=[]
  page.setDefaultTimeout(8000);console.log('checking',locale,theme,width)
  page.on('pageerror',e=>errors.push(e.message))
  await page.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme)},{locale,theme})
  await page.route('**/api/v1/**',async route=>{
   const path=new URL(route.request().url()).pathname.replace('/api/v1','');let data
   if(path==='/me')data={id:user,name:'Source reviewer',default_space_id:space,instance_role:'member'}
   else if(path==='/me/spaces')data=[{id:space,name:'Source check',type:'personal',role:'owner'}]
   else if(path==='/plugins/effective')data={plugins:{}}
   else if(path==='/sources/channels')data=[monitor]
   else if(path==='/sources/providers'||path==='/sources/recommendations'||path==='/sources/channels/followed')data=[]
   else if(path==='/actions/source.channel.scan')data={status:'succeeded',data:{id:'extraction'}}
   else if(path==='/actions/source.extraction.dispatch')data={status:'succeeded',data:{job_id:job.id,status:'pending',source_channel_id:null,extraction_job_id:'extraction',extraction_status:'pending'}}
   else if(path==='/jobs')data=pageOf([job])
   else if(path.startsWith('/jobs/')&&path.endsWith('/events'))data=[{id:'event',event_type:'error',message:job.error,created_at:now}]
   else if(path==='/projects')data=pageOf([])
   else data=[]
   return route.fulfill({json:data})
  })
  try{
   await page.goto(`${base}/spaces/${space}/sources`);console.log('source loaded',page.url())
   await page.getByTestId('source-dispatch-notice').waitFor()
   const notice=page.getByTestId('source-dispatch-notice');assert.match(await notice.innerText(),locale==='en'?/not completed/:/不代表处理完成/)
   await page.getByRole('button',{name:/Scan now/}).first().click()
   await page.getByText(locale==='en'?'Monitor scan queued':'监测扫描已入队',{exact:true}).waitFor()
   await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>/Scan now/.test(b.textContent??'')&&!b.disabled))
   await page.screenshot({path:`${out}/${locale}-${theme}-${width}-list.png`,fullPage:true})
   await page.goto(`${base}/spaces/${space}/sources/origin`);await page.getByTestId('source-dispatch-notice').waitFor()
   await page.getByRole('button',{name:/Scan now/}).first().click();await page.getByText(locale==='en'?'Monitor scan queued':'监测扫描已入队',{exact:true}).waitFor()
   await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>/Scan now/.test(b.textContent??'')&&!b.disabled))
   await page.screenshot({path:`${out}/${locale}-${theme}-${width}-detail.png`,fullPage:true})
   await page.getByTestId('source-dispatch-notice').getByRole('link').click()
   await page.getByRole('alert').filter({hasText:locale==='en'?'external effects may have occurred':'外部效果可能已经发生'}).waitFor()
   await page.getByText('source_extraction_manual',{exact:true}).click()
   await page.getByText(job.error,{exact:true}).last().waitFor()
   await page.screenshot({path:`${out}/${locale}-${theme}-${width}-result.png`,fullPage:true})
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
   assert.deepEqual(errors,[])
  }catch(error){console.log('failure URL',page.url(),(await page.locator('body').innerText()).slice(-2500));await page.screenshot({path:`${out}/failure.png`,fullPage:true});throw error;}finally{await page.close()}
 }
})
