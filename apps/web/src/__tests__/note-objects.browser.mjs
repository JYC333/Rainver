import assert from 'node:assert/strict'
import {before,after,test} from 'node:test'
import {chromium} from 'playwright-core'
import {preview} from 'vite'
let server,browser,url
before(async()=>{server=await preview({configFile:false,preview:{host:'127.0.0.1',port:0}});url=`http://127.0.0.1:${server.httpServer.address().port}`;browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE})})
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.httpServer.close(r))})
for(const [locale,theme,width]of [['en','dark',1280],['zh-CN','light',390]])test(`Note parent editor explicit retry and collection metadata (${locale})`,async()=>{
 const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});await context.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme)},{locale,theme});const page=await context.newPage();const space='personal-note',now='2026-11-06T12:00:00Z',errors=[];page.on('pageerror',e=>errors.push(e.message));
 let current={id:'note-1',space_id:space,title:'Original note',status:'active',version:1,primary_project_id:null,project_role:null,role_project_id:null,content_format:'prosemirror_json',content_schema_version:1,content_json:{type:'doc',content:[{type:'paragraph',attrs:{block_id:'one'},content:[{type:'text',text:'Reviewed working text'}]}]},plain_text:'Reviewed working text',excerpt:null,placements:[{collection_id:'inbox',sort_order:0}],created_at:now,updated_at:now},writes=0,drop=true;
 const collections=[{id:'inbox',space_id:space,name:'Inbox',parent_id:null,sort_order:0,is_system:true,is_hidden:false,system_role:'inbox',created_at:now,updated_at:now}];const keys=[];const receipts=new Map();
 await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname.replace('/api/v1','');let data;
 if(path==='/me')data={id:'owner',name:'Owner',default_space_id:space,instance_role:'admin',is_instance_admin:true};
 else if(path==='/me/spaces')data=[{id:space,name:'My Personal',type:'personal',role:'owner'}];
 else if(path==='/plugins/effective')data={plugins:{}};
 else if(path==='/notes/collections')data=collections;
 else if(path==='/knowledge/notes')data={items:[current],total:1,limit:100,offset:0};
 else if(path==='/knowledge/notes/note-1')data=current;
 else if(path==='/actions/knowledge.note.update'){
  const key=route.request().headers()['idempotency-key'],input=route.request().postDataJSON();keys.push(key);assert.ok(key);
  if(!receipts.has(key)){writes++;current={...current,...input.changes,version:current.version+1};receipts.set(key,{status:'succeeded',data:{id:current.id,space_id:space,version:current.version,project_ids:[]}})}
  data=receipts.get(key);if(drop){drop=false;return route.abort('failed')}
 }
 else if(path==='/actions/knowledge.collection.create'){const input=route.request().postDataJSON();const row={...input,space_id:space,system_role:'normal',is_system:false,is_hidden:false,created_at:now,updated_at:now};collections.push(row);data={status:'succeeded',data:{id:row.id,space_id:space,deleted:false,project_ids:[]}}}
 else if(path==='/knowledge/notes/note-1/links'||path==='/knowledge/notes/note-1/backlinks'||path==='/knowledge/notes/note-1/shares'||path==='/focus-areas')data=[];
 else if(path==='/projects'||path==='/rooms/pending-approvals')data={items:[],total:0,limit:100,offset:0};
 else if(path==='/me/agent-attention/snapshot')data={type:'attention.snapshot',seq:1,version:'note',unread_count:0,page:{items:[],total:0,limit:100,offset:0},notices:[]};
 else if(path==='/me/agent-attention/stream')return route.fulfill({status:503,body:''});
 else return route.fulfill({status:404,json:{detail:'Unavailable in fixture'}});
 return route.fulfill({status:path==='/actions/knowledge.collection.create'?201:200,json:data});
 });
 try{
 await page.goto(`${url}/spaces/${space}/knowledge/notes/note-1`);const title=page.getByLabel('Note title',{exact:true});await title.fill('Retried note');await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByText('Saved',{exact:true}).waitFor();assert.equal(writes,1);assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
 const edited=page.waitForResponse(r=>r.url().endsWith('/actions/knowledge.note.update')&&r.status()===200);await title.fill('Changed note');await edited;
 assert.equal(writes,2);assert.notEqual(keys[2],keys[1]);
 if(width>1000){await page.getByRole('button',{name:/new folder/i}).first().click();await page.getByPlaceholder('Folder name').fill('Ideas');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Ideas',{exact:true}).first().waitFor();assert.equal(collections.length,2)}
 assert.deepEqual(errors,[]);
 }catch(e){console.error(page.url(),(await page.locator('body').innerText()).slice(-1800));throw e}finally{await context.close()}
})
