import {roomsModule} from "../src/modules/rooms/index.js";
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject} from './support/domainSeeds.js';
import {InquiryThreadService} from '../src/modules/inquiry/threadService.js';
import {InquiryTaskAssociationService} from '../src/modules/inquiry/taskAssociations.js';
import {inquiryModule} from '../src/modules/inquiry/index.js';
import {tasksModule} from '../src/modules/tasks/index.js';
import {projectWorkModule} from '../src/modules/projectWork/index.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {buildModuleServer} from './support/moduleServer.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename);
const webRequire=createRequire(resolve('../apps/web/package.json'));
it('opens the authorized problem backlink in the actual Task parent and Inquiry destination',async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 const space=randomUUID(),owner=randomUUID(),project=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household',ownerDisplayName:'Task owner'});
 const identity={spaceId:space,userId:owner};const thread=String((await new InquiryThreadService(db.pool).createThread(identity,project,{kind:'question',statement:'Why does the import fail?'})).id);
 const linked=await new InquiryTaskAssociationService(db.pool).link(identity,project,thread,{task:{title:'Reproduce import failure'},role:'investigates',reason:'Find a minimal reproduction',idempotency_key:'browser'});
 __setAuthIdentityForTests(identity);
 const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:'/tmp/rainver-task-browser'}),[tasksModule,inquiryModule,projectWorkModule,projectsModule,roomsModule]);
 const {preview}=await import(pathToFileURL(webRequire.resolve('vite')).href);const hosted=await preview({root:resolve('../apps/web'),configFile:false,preview:{host:'127.0.0.1',port:0}});
 const {chromium}=webRequire('playwright-core');const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900},serviceWorkers:'block'});page.setDefaultTimeout(15000);const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('rainver:locale','en'));
  await page.route('**/api/v1/**',async(route:any)=>{
   const r=route.request(),u=new URL(r.url()),path=u.pathname.replace('/api/v1','');
   if(path.startsWith('/rooms/')||path.startsWith('/tasks/')||path.startsWith(`/projects/${project}`)){
    console.info('Task browser request',r.method(),path);const response=await app.inject({method:r.method(),url:u.pathname+u.search,headers:{'x-rainver-space-id':space,'content-type':'application/json'},payload:r.postData()??undefined});
    return route.fulfill({status:response.statusCode,contentType:'application/json',body:response.body});
   }
   let data:unknown;
   if(path==='/me')data={id:owner,name:'Task owner',email:'owner@test.invalid',default_space_id:space,instance_role:'member'};
   else if(path==='/me/spaces')data=[{id:space,name:'Task acceptance',type:'household',role:'owner'}];
   else if(/^\/spaces\/[^/]+\/members$/.test(path))data=[{user_id:owner,display_name:'Task owner',role:'owner'}];
   else if(path==='/plugins/effective')data={plugins:{}};
   else if(path==='/agents'||path.startsWith('/model-providers')||path.startsWith('/provider-vendors')||path.startsWith('/providers'))data=[];
   else if(path==='/projects')data={items:[{id:project,name:'Research',status:'active',space_id:space}],total:1,limit:50,offset:0};
   else if(path.endsWith('/interest-profile'))data=null;
   else data={items:[],total:0,offset:0,limit:50};
   return route.fulfill({json:data});
  });
  const base=`http://127.0.0.1:${hosted.httpServer.address().port}`;
  await page.goto(`${base}/spaces/${space}/projects/${project}/tasks/${linked.task_id}`);
  try{await page.getByRole('tab',{name:'Work',exact:true}).click();}catch(error){await mkdir('/tmp/p4-browser',{recursive:true});await page.screenshot({path:'/tmp/p4-browser/failure.png',fullPage:true});console.info('Task browser failure',page.url(),await page.locator('body').innerText(),errors);throw error;}
  await page.getByRole('link',{name:'Open question',exact:true}).waitFor();
  expect(await page.getByRole('button',{name:'Move stage'}).count()).toBe(0);
  expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
  await mkdir('/tmp/p4-browser',{recursive:true});await page.screenshot({path:'/tmp/p4-browser/task-parent.png',fullPage:true});
  await page.getByRole('link',{name:'Open question',exact:true}).click();
  try{await page.getByText('Why does the import fail?',{exact:true}).first().waitFor();}catch(error){await page.screenshot({path:'/tmp/p4-browser/destination-failure.png',fullPage:true});console.info('Inquiry browser failure',page.url(),await page.locator('body').innerText(),errors);throw error;}
  expect(new URL(page.url()).pathname).toBe(`/spaces/${space}/projects/${project}/inquiry`);
  await page.getByRole('navigation',{name:'Problem stages',exact:true}).waitFor();
  await page.screenshot({path:'/tmp/p4-browser/inquiry-destination.png',fullPage:true});
  expect(errors).toEqual([]);
 }finally{await browser.close();await new Promise<void>(r=>hosted.httpServer.close(()=>r()));await app.close();__setAuthIdentityForTests(null);}
});
