import {PgTaskRepository} from "../src/modules/tasks/repository.js";
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
  const page=await browser.newPage({viewport:{width:1280,height:900},serviceWorkers:'block'});page.setDefaultTimeout(15000);const errors:string[]=[];let columnWrites=0;page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('rainver:locale','en'));
  await page.route('**/api/v1/**',async(route:any)=>{
   const r=route.request(),u=new URL(r.url()),path=u.pathname.replace('/api/v1','');
   if(path==='/tasks'||path.startsWith('/rooms/')||path.startsWith('/tasks/')||path.startsWith(`/projects/${project}`)){
    if(path.endsWith('/board/columns')&&r.method()==='PUT')columnWrites++;
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
  for(const width of [1280,390]){
   const candidate=await new PgTaskRepository(db.pool).createTask(identity,{project_id:project,title:`Remove duplicate ${width}`});
   await page.setViewportSize({width,height:900});
   await page.goto(`${base}/spaces/${space}/projects/${project}/tasks/${candidate.id}`);
   await page.getByRole('button',{name:'Delete task',exact:true}).waitFor();
   if(width<600){
    const closeChat=page.getByRole('button',{name:'Close Project chat',exact:true});
    await closeChat.click();
   }
   await page.getByRole('button',{name:'Delete task',exact:true}).click();
   const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'Delete task?'}).waitFor();
   await dialog.evaluate(async (element:{getAnimations():Array<{finished:Promise<unknown>}>})=>{await Promise.all(element.getAnimations().map(animation=>animation.finished));});
   await mkdir('/tmp/task-delete-browser',{recursive:true});
   await page.screenshot({path:`/tmp/task-delete-browser/confirm-${width}.png`,fullPage:true});
   await dialog.getByRole('button',{name:'Delete task',exact:true}).click();
   await page.waitForURL(`**/projects/${project}/board`);
   expect((await db.pool.query('SELECT deleted_at FROM tasks WHERE id=$1',[candidate.id])).rows[0].deleted_at).toBeTruthy();
   await page.getByText(`Remove duplicate ${width}`,{exact:true}).waitFor({state:'detached'});
   expect(await page.getByText(`Remove duplicate ${width}`,{exact:true}).count()).toBe(0);
  }
  await page.setViewportSize({width:1280,height:900});
  const menuTask=await new PgTaskRepository(db.pool).createTask(identity,{project_id:project,title:'Board menu sample',status:'ready'});
  await page.goto(`${base}/spaces/${space}/projects/${project}/board`);
  const grip=page.getByTestId(`board-card-handle-${menuTask.id}`);
  await grip.click();
  await page.getByRole('menuitem',{name:'Edit task',exact:true}).click();
  let dialog=page.getByRole('dialog');
  await dialog.getByLabel('Title',{exact:true}).fill('Edited on Board');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await dialog.waitFor({state:'detached'});
  await page.getByText('Edited on Board',{exact:true}).waitFor();
  const contextCard=await page.getByTestId(`board-card-${menuTask.id}`).boundingBox();
  if(!contextCard)throw new Error('Missing context card');
  const pointer={x:contextCard.x+contextCard.width-14,y:contextCard.y+contextCard.height-12};
  await page.mouse.click(pointer.x,pointer.y,{button:'right'});
  await page.getByRole('menuitem',{name:'Delete task',exact:true}).waitFor();
  await page.getByRole('menu').evaluate(async(element:{getAnimations():Array<{finished:Promise<unknown>}>})=>{await Promise.all(element.getAnimations().map(a=>a.finished));});
  const contextMenu=await page.getByRole('menu').boundingBox();
  if(!contextMenu)throw new Error('Missing context menu');
  expect(Math.abs(contextMenu.x-pointer.x)).toBeLessThanOrEqual(8);
  expect(Math.abs(contextMenu.y-pointer.y)).toBeLessThanOrEqual(8);
  await page.screenshot({path:'/tmp/task-delete-browser/board-menu.png',fullPage:true});
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({state:'detached'});
  console.info('Board menu dismissed',page.url());
  // A no-op drop and cancellation leave this same card mounted. Radix must
  // not open its menu on the sensor's drop keys or steal focus on ArrowDown.
  for(const finish of ['Space','Enter','Escape']){
    console.info('Same-column drag finish',finish);
    await grip.focus();await page.keyboard.press('Space');
    await expect.poll(()=>grip.getAttribute('aria-pressed')).toBe('true');
    // KeyboardSensor installs its document listener in a zero-delay timer.
    await page.evaluate('new Promise(resolve=>setTimeout(resolve,0))');
    await page.keyboard.press('ArrowDown');
    expect(await page.getByRole('menu').count()).toBe(0);
    await page.keyboard.press(finish);
    await expect.poll(()=>grip.getAttribute('aria-pressed')).not.toBe('true');
    expect(await page.getByRole('menu').count()).toBe(0);
    expect(new URL(page.url()).pathname).toBe(`/spaces/${space}/projects/${project}/board`);
    expect((await db.pool.query('SELECT status FROM tasks WHERE id=$1',[menuTask.id])).rows[0].status).toBe('ready');
  }
  // Space/arrow/drop must move rather than open the grip menu.
  await grip.focus();const keyboardStart=await grip.boundingBox();await page.keyboard.press('Space');
  await expect.poll(()=>grip.getAttribute('aria-pressed')).toBe('true');
  await page.evaluate('new Promise(resolve=>setTimeout(resolve,0))');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async()=>(await grip.boundingBox())?.x).not.toBe(keyboardStart?.x);
  await expect.poll(()=>page.getByTestId('board-column-in_progress').getAttribute('class')).toContain('ring-primary/40');
  await page.keyboard.press('Space');
  await page.getByTestId(`board-card-${menuTask.id}`).waitFor();
  await expect.poll(async()=>(await db.pool.query('SELECT status FROM tasks WHERE id=$1',[menuTask.id])).rows[0].status).toBe('in_progress');
  expect(await page.getByRole('menu').count()).toBe(0);
  expect(await page.getByRole('button',{name:'Manage columns',exact:true}).count()).toBe(0);
  const originalName=await page.getByRole('button',{name:'Rename column Inbox',exact:true}).boundingBox();
  const originalMenu=await page.getByRole('button',{name:'Column actions for Inbox',exact:true}).boundingBox();
  const originalFont=await page.getByRole('button',{name:'Rename column Inbox',exact:true}).evaluate('(node)=>getComputedStyle(node).fontSize');
  await page.getByRole('button',{name:'Rename column Inbox',exact:true}).click();
  const editingName=await page.getByLabel('Column name',{exact:true}).boundingBox();
  const editingMenu=await page.getByRole('button',{name:'Column actions for Inbox',exact:true}).boundingBox();
  if(!originalName||!editingName||!originalMenu||!editingMenu)throw new Error('Missing rename geometry');
  for(const key of ['x','y','width','height'] as const){
    expect(Math.abs(originalName[key]-editingName[key])).toBeLessThanOrEqual(1);
    expect(Math.abs(originalMenu[key]-editingMenu[key])).toBeLessThanOrEqual(1);
  }
  expect(await page.getByLabel('Column name',{exact:true}).evaluate('(node)=>getComputedStyle(node).fontSize')).toBe(originalFont);

  await page.getByLabel('Column name',{exact:true}).fill('Backlog');
  expect(await page.getByRole('button',{name:'Save',exact:true}).count()).toBe(0);
  expect(await page.getByRole('button',{name:'Cancel',exact:true}).count()).toBe(0);
  await page.getByRole('heading',{name:'Board',exact:true}).click();
  await page.getByRole('button',{name:'Rename column Backlog',exact:true}).waitFor();
  const writesBefore=columnWrites;
  await page.getByRole('button',{name:'Rename column Backlog',exact:true}).click();
  await page.getByRole('heading',{name:'Board',exact:true}).click();
  await page.getByRole('button',{name:'Rename column Backlog',exact:true}).waitFor();
  expect(columnWrites).toBe(writesBefore);
  await page.getByRole('button',{name:'Column actions for Waiting',exact:true}).click();
  await page.getByRole('menuitem',{name:'Add column to the right',exact:true}).click();
  const draft=page.getByRole('form',{name:'Add column',exact:true});
  await draft.getByLabel('Column name',{exact:true}).fill('Design');
  await draft.getByRole('button',{name:'Add column',exact:true}).click();
  await draft.waitFor({state:'detached'});
  const design=(await db.pool.query("SELECT id FROM board_columns WHERE name='Design' AND deleted_at IS NULL")).rows[0].id;
  const waiting=(await db.pool.query("SELECT id FROM board_columns WHERE name='Waiting' AND deleted_at IS NULL")).rows[0].id;
  const columnGrip=page.getByRole('button',{name:'Move column Design',exact:true});
  await columnGrip.focus();await page.keyboard.press('Space');
  await expect.poll(()=>columnGrip.getAttribute('aria-pressed')).toBe('true');
  await page.evaluate('new Promise(resolve=>setTimeout(resolve,0))');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(()=>page.getByTestId(`board-column-${waiting}`).getAttribute('class')).toContain('ring-primary/40');
  await page.keyboard.press('Space');
  await expect.poll(async()=>(await db.pool.query('SELECT position FROM board_columns WHERE id=$1',[design])).rows[0].position).toBe(3);
  await expect.poll(()=>columnGrip.isEnabled()).toBe(true);
  // Drag the whole column back to the right, using its header grip.
  const columnTarget=page.getByRole('button',{name:'Move column Waiting',exact:true});
  await columnTarget.scrollIntoViewIfNeeded();
  const colFrom=await columnGrip.boundingBox(),colTo=await columnTarget.boundingBox();
  if(!colFrom||!colTo)throw new Error('Missing column drag geometry');
  await page.mouse.move(colFrom.x+colFrom.width/2,colFrom.y+colFrom.height/2);await page.mouse.down();
  await page.mouse.move(colTo.x+colTo.width/2,colTo.y+colTo.height/2,{steps:12});
  await expect.poll(()=>page.getByTestId(`board-column-${waiting}`).getAttribute('class')).toContain('ring-primary/40');
  await page.mouse.up();
  await expect.poll(async()=>(await db.pool.query('SELECT position FROM board_columns WHERE id=$1',[design])).rows[0].position).toBe(4);
  await expect.poll(()=>columnGrip.isEnabled()).toBe(true);
  expect((await db.pool.query('SELECT status FROM tasks WHERE id=$1',[menuTask.id])).rows[0].status).toBe('in_progress');
  await page.screenshot({path:'/tmp/task-delete-browser/board-columns-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'New Task in Design',exact:true}).click();
  dialog=page.getByRole('dialog');
  await dialog.getByLabel('What needs to be done?').fill('Created inside Design');
  await dialog.getByRole('button',{name:'Create Task',exact:true}).click();
  await dialog.waitFor({state:'detached'});
  const created=(await db.pool.query("SELECT id,column_id FROM tasks WHERE project_id=$1 AND title='Created inside Design'",[project])).rows[0];
  expect(created.column_id).toBeTruthy();
  // The card body is a drag surface, not just its small grip.
  const target=page.getByTestId('board-column-'+(await db.pool.query("SELECT id FROM board_columns WHERE board_id=(SELECT board_id FROM tasks WHERE id=$1) AND status_key='in_progress' AND deleted_at IS NULL",[created.id])).rows[0].id);
  await target.scrollIntoViewIfNeeded();
  const to=await target.boundingBox();
  const from=await page.getByTestId(`board-card-${created.id}`).boundingBox();
  if(!from||!to)throw new Error('Missing Board drag geometry');
  await page.mouse.move(from.x+from.width-18,from.y+from.height-12);await page.mouse.down();await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:12});await page.mouse.up();
  await expect.poll(async()=>(await db.pool.query('SELECT status FROM tasks WHERE id=$1',[created.id])).rows[0].status).toBe('in_progress');
  expect(await page.getByRole('menu').count()).toBe(0);
  // Dragging the title itself must not start a native link drag or navigate.
  const ready=(await db.pool.query("SELECT id FROM board_columns WHERE board_id=(SELECT board_id FROM tasks WHERE id=$1) AND status_key='ready' AND name='Ready' AND deleted_at IS NULL",[created.id])).rows[0].id;
  await page.getByTestId(`board-column-${ready}`).scrollIntoViewIfNeeded();
  const title=await page.getByRole('link',{name:'Created inside Design',exact:true}).boundingBox();
  const readyBox=await page.getByTestId(`board-column-${ready}`).boundingBox();
  if(!title||!readyBox)throw new Error('Missing title drag geometry');
  await page.mouse.move(title.x+title.width/2,title.y+title.height/2);await page.mouse.down();
  await page.mouse.move(readyBox.x+readyBox.width/2,readyBox.y+readyBox.height/2,{steps:12});
  await expect.poll(()=>page.getByTestId(`board-column-${ready}`).getAttribute('class')).toContain('ring-primary/40');
  await page.mouse.up();
  await expect.poll(async()=>(await db.pool.query('SELECT status FROM tasks WHERE id=$1',[created.id])).rows[0].status).toBe('ready');
  expect(new URL(page.url()).pathname).toBe(`/spaces/${space}/projects/${project}/board`);
  // A normal title click remains navigation rather than starting a drag.
  await page.getByRole('link',{name:'Created inside Design',exact:true}).click();
  await page.waitForURL(`**/projects/${project}/tasks/${created.id}`);
  await page.goto(`${base}/spaces/${space}/projects/${project}/board`);
  // A populated column is removed from its own header, not a central editor.
  await page.getByRole('button',{name:'New Task in Design',exact:true}).click();
  dialog=page.getByRole('dialog');
  await dialog.getByLabel('What needs to be done?').fill('Relocate on Delete');
  await dialog.getByRole('button',{name:'Create Task',exact:true}).click();
  await dialog.waitFor({state:'detached'});
  await page.getByRole('button',{name:'Column actions for Design',exact:true}).click();
  await page.getByRole('menuitem',{name:'Delete column',exact:true}).click();
  dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Move tasks to',exact:true}).click();
  await page.getByRole('option',{name:'Ready',exact:true}).click();
  await dialog.getByRole('button',{name:'Delete column',exact:true}).click();
  await dialog.waitFor({state:'detached'});
  expect((await db.pool.query("SELECT count(*)::int AS n FROM board_columns WHERE name='Design' AND deleted_at IS NULL")).rows[0].n).toBe(0);
  expect((await db.pool.query("SELECT c.name,t.status FROM tasks t JOIN board_columns c ON c.id=t.column_id WHERE t.title='Relocate on Delete' AND t.project_id=$1",[project])).rows[0]).toMatchObject({name:'Ready',status:'ready'});
  await page.getByRole('button',{name:'Status meaning for Ready',exact:true}).click();
  await page.getByRole('option',{name:'Waiting for review',exact:true}).click();
  dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await dialog.waitFor({state:'detached'});
  expect((await db.pool.query("SELECT status FROM tasks WHERE title='Relocate on Delete' AND project_id=$1",[project])).rows[0].status).toBe('waiting_for_review');
  expect(await page.getByRole('button',{name:'Status meaning for Ready',exact:true}).innerText()).toContain('Waiting for review');
  // Match the reported light-theme In Progress header, not just an isolated input.
  await page.evaluate("document.documentElement.classList.add('theme-light')");
  const progressTitle=page.getByRole('button',{name:'Rename column In Progress',exact:true});
  await progressTitle.scrollIntoViewIfNeeded();
  const lightBefore=await progressTitle.boundingBox();
  const lightMenuBefore=await page.getByRole('button',{name:'Column actions for In Progress',exact:true}).boundingBox();
  const progressLane=page.getByTestId('board-column-'+(await db.pool.query("SELECT id FROM board_columns WHERE name='In Progress' AND deleted_at IS NULL")).rows[0].id);
  await progressLane.locator(':scope > div').first().screenshot({path:'/tmp/task-delete-browser/column-name-light-before.png'});
  await progressTitle.click();
  const lightAfter=await page.getByLabel('Column name',{exact:true}).boundingBox();
  const lightMenuAfter=await page.getByRole('button',{name:'Column actions for In Progress',exact:true}).boundingBox();
  if(!lightBefore||!lightAfter||!lightMenuBefore||!lightMenuAfter)throw new Error('Missing light rename geometry');
  for(const key of ['x','y','width','height'] as const){
    expect(Math.abs(lightBefore[key]-lightAfter[key])).toBeLessThanOrEqual(1);
    expect(Math.abs(lightMenuBefore[key]-lightMenuAfter[key])).toBeLessThanOrEqual(1);
  }
  await progressLane.locator(':scope > div').first().screenshot({path:'/tmp/task-delete-browser/column-name-light-after.png'});
  await page.getByRole('heading',{name:'Board',exact:true}).click();
  await page.evaluate("document.documentElement.classList.remove('theme-light')");
  await page.setViewportSize({width:390,height:900});
  const closeChat=page.getByRole('button',{name:'Close Project chat',exact:true});if(await closeChat.isVisible())await closeChat.click();
  await page.getByRole('button',{name:'Rename column Ready',exact:true}).click();
  await page.getByLabel('Column name',{exact:true}).fill('Next up');
  await page.screenshot({path:'/tmp/task-delete-browser/board-columns-narrow.png',fullPage:true});
  await page.getByRole('heading',{name:'Board',exact:true}).click();
  await page.getByRole('button',{name:'Rename column Next up',exact:true}).waitFor();
  const touch=await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  await grip.scrollIntoViewIfNeeded();const tap=await grip.boundingBox();if(!tap)throw new Error('Missing touch grip');
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tap.x+tap.width/2,y:tap.y+tap.height/2}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.getByRole('menuitem',{name:'Delete task',exact:true}).click();
  dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Delete task',exact:true}).click();
  await page.getByTestId(`board-card-${menuTask.id}`).waitFor({state:'detached'});
  expect(errors).toEqual([]);
 }finally{await browser.close();await new Promise<void>(r=>hosted.httpServer.close(()=>r()));await app.close();__setAuthIdentityForTests(null);}
});
