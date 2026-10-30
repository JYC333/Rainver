import {seedNativeSearchCatalog} from '../src/modules/sources/catalog/nativeSearchCatalog.js';
import {streamingModule} from '../src/modules/streaming/index.js';
import {runsModule} from '../src/modules/runs/index.js';
import {roomsModule} from '../src/modules/rooms/index.js';
import {agentsModule,__setAgentChatIdentityForTests} from '../src/modules/agents/index.js';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {it,expect,vi} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedCustomSourceWorld,upsertCustomSourceSpacePolicy} from './support/customSourceWorld.js';
import {seedRun,seedServerHost} from './support/domainSeeds.js';
import {startMockUpstream} from './support/mockUpstream.js';
import {fixtureServerGuard} from './support/outboundGuard.js';
import {loadConfig} from '../src/config.js';
import {buildModuleServer} from './support/moduleServer.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {informationDigestModule} from '../src/modules/informationDigest/index.js';
import {readerModule} from '../src/modules/reader/index.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {SourceRecipeCreateService} from '../src/modules/sources/sourceRecipes/recipeCreateService.js';
import {SourceRecipeDryRunService} from '../src/modules/sources/sourceRecipes/recipeDryRunService.js';
import {SourceGoalExecutor} from '../src/modules/sources/goals/execution.js';
import {SourceGoalService} from '../src/modules/sources/goals/service.js';
import {runSourceGoalTick} from '../src/modules/sources/goals/worker.js';
import {SourceGoalDetailSchema,type SourceGoalBindingSpec} from '@rainver/protocol';
/** Topic following acceptance: real backend, HTTP, PostgreSQL, Sources,
 * scheduler tick, materializer, Reading and Reader through Chromium. Only the
 * external planning Agent is a deterministic fixture that writes the plan its
 * real queued Run would write; no model is launched and no fixture output is
 * presented as a real search result. */
const webRequire=createRequire(resolve('../apps/web/package.json'));const db=useTestDatabase(import.meta.filename);const shotDir=process.env.SOURCE_GOAL_SCREENSHOTS??'/tmp/rainver-topic-phase3';
type FeedItem={guid:string;title:string;date:string};const rss=(items:FeedItem[],base:string,name:string)=>`<rss><channel>${items.map(i=>`<item><guid>${i.guid}</guid><title>${i.title}</title><link>${base}/${name}/${i.guid}</link><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>Fixture feed summary for ${i.title}.</description></item>`).join('')}</channel></rss>`;
it.each([['en',1440,1000,false],['zh-CN',390,844,false],['en',1440,1000,true]] as const)('topic: one confirmation → background preparation and first collection → incremental, no-update, partial, permission → Reading filter/return → pause/delete (%s %s×%s project=%s)',async(locale,width,height,projectContext)=>{
 await resetTables(db.pool,['spaces','users','source_provider_connectors','source_providers','source_connectors'],{cascade:true});const identity={spaceId:randomUUID(),userId:randomUUID()};await seedCustomSourceWorld(db.pool,identity);await seedNativeSearchCatalog(db.pool);await db.pool.query(`UPDATE spaces SET type='personal' WHERE id=$1`,[identity.spaceId]);await upsertCustomSourceSpacePolicy(db.pool,identity.spaceId,{default_capture_policy:'extract_text',default_retention_policy:'full_text'});await seedRun(db.pool,{id:randomUUID(),space:identity.spaceId,owner:identity.userId,agent:randomUUID(),version:randomUUID()});
 const runtimeHost=randomUUID();await seedServerHost(db.pool,{id:runtimeHost});
 const advertised=[{id:'model',name:'Model',description:null,category:'model',type:'select',current_value:'fixture/default',options:[{value:'fixture/default',name:'Fixture default',description:null,group:null},{value:'fixture/chosen',name:'Fixture chosen model',description:null,group:null}]},{id:'mode',name:'Session Mode',description:null,category:'mode',type:'select',current_value:'default',options:[{value:'default',name:'Default',description:null,group:null},{value:'plan',name:'Fixture plan mode',description:null,group:null}]}];
 await db.pool.query('UPDATE hosts SET capabilities_json=$2::jsonb WHERE id=$1',[runtimeHost,JSON.stringify({installations:{claude_code:[{id:'managed:1.0.0',version:'1.0.0',logged_in:true,options:{session_available:true,config_options:advertised}}]}})]);
 await db.pool.query("UPDATE agent_runtime_profiles SET runtime_key='claude_code',execution_host_id=$1,workspace_mode='managed',runtime_installation='managed:1.0.0' WHERE space_id=$2",[runtimeHost,identity.spaceId]);
 const projectId=projectContext?randomUUID():null;if(projectId){await db.pool.query(`UPDATE spaces SET type='team' WHERE id=$1`,[identity.spaceId]);await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Goal acceptance project','active',now(),now())`,[projectId,identity.spaceId,identity.userId]);const {seedProjectMainlineRoom}=await import('./support/domainSeeds.js');await seedProjectMainlineRoom(db.pool,{project:projectId,space:identity.spaceId,owner:identity.userId});}
 const root=await mkdtemp(join(tmpdir(),'topic-browser-'));const config={...loadConfig({}),databaseUrl:db.connectionUri,rainverHome:root,artifactStorageRoot:join(root,'artifacts')};let hits=0;
 const feeds:Record<string,FeedItem[]|'fail'>={research:[{guid:'r1',title:'Robotics research baseline',date:'2026-10-20T00:00:00Z'}],industry:[{guid:'i1',title:'Robotics industry baseline',date:'2026-10-21T00:00:00Z'}]};
 const upstream=await startMockUpstream((req,res)=>{hits++;const name=req.url?.includes('industry')?'industry':'research';const feed=feeds[name];if(feed==='fail'){res.writeHead(503);res.end('unavailable');return}res.writeHead(200,{'content-type':'application/rss+xml'});res.end(rss(feed,upstream.baseUrl,name))});
 const specs:SourceGoalBindingSpec[]=[];const create=new SourceRecipeCreateService(db.pool,config),dry=new SourceRecipeDryRunService(db.pool,config);
 for(const name of ['research','industry']){const made=await create.createSource(identity,{name,project_id:projectId,source_type:'rss',endpoint_url:upstream.baseUrl+'/'+name,fetch_frequency:'manual',capture_policy:'extract_text',retention_policy:'full_text'});await dry.dryRunRecipeVersion(identity,made.connection.id,{recipe_version_id:made.recipe_version.id,fixture_content:rss([{guid:name,title:'Robotics '+name,date:'2026-10-01T00:00:00Z'}],upstream.baseUrl,name)});await create.activateRecipe(identity,made.connection.id,{recipe_version_id:made.recipe_version.id});specs.push({source_connection_id:made.connection.id,source_channel_id:made.connection.source_channel_id,reason:name==='research'?'Research evidence':'Industry developments',implementation:{kind:'connector' as const},supports_history:false});}
 hits=0;const executor=()=>new SourceGoalExecutor(db.pool,config,fixtureServerGuard);const service=new SourceGoalService(db.pool,config,executor());
 let changeEvidence:string|null=null;
 // Explicit collecting-Agent signal fixture: real HTTP/quota/materialization,
 // deterministic cited change only, no model or actual search quality claim.
 const tick=async(goalId:string)=>runSourceGoalTick(db.pool,config,goalId,identity.spaceId,{async execute(...args){const result=await executor().execute(...args);return changeEvidence?{...result,topicSignals:{items:{[upstream.baseUrl+'/research/r2']:{change:{kind:'update' as const,evidence_url:changeEvidence},judgment:{importance:'important' as const,reason:'Fixture cited release'}}}}}:result;}});
 const app=buildModuleServer(config,[sourcesModule,informationDigestModule,readerModule,projectsModule,agentsModule,roomsModule,runsModule,streamingModule]);__setAuthIdentityForTests(identity);__setAgentChatIdentityForTests(identity);
 app.addHook('onError',async(_request,_reply,error)=>{console.error('Fixture backend error',error.message)});
 const backendAddress=await app.listen({host:'127.0.0.1',port:0});
 const {preview}=await import(pathToFileURL(webRequire.resolve('vite')).href);const server=await preview({root:resolve('../apps/web'),configFile:false,preview:{host:'127.0.0.1',port:0,proxy:{'/api/v1':{target:backendAddress}}}});const base=`http://127.0.0.1:${server.httpServer.address().port}`;const {chromium}=webRequire('playwright-core');const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE});await mkdir(shotDir,{recursive:true});
 const shot=async(page:any,name:string)=>page.screenshot({path:join(shotDir,`${projectId?'project-':''}${locale}-${name}.png`),fullPage:true});
 try{const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});await context.addInitScript((lang:string)=>localStorage.setItem('rainver:locale',lang),locale);const page=await context.newPage();page.setDefaultTimeout(10000);const errors:string[]=[];page.on('pageerror',(e:Error)=>{errors.push(e.message);console.error('Topic page error',e.message)});
 await page.route('**/api/v1/**',async(route:any)=>{const r=route.request(),u=new URL(r.url()),path=u.pathname.replace('/api/v1','');if(path.startsWith('/runs/'))return route.continue({headers:{...r.headers(),'x-rainver-space-id':identity.spaceId}});if(path.startsWith('/rooms')||path.startsWith('/agents')||path.startsWith('/sources/')||path.includes('/reading')||path.includes('/information-digests')||path.startsWith('/reader/')||projectId&&path.startsWith('/projects/'+projectId)){console.info('Goal real request',r.method(),path);const result=await app.inject({method:r.method(),url:u.pathname+u.search,headers:{'x-rainver-space-id':identity.spaceId,'content-type':'application/json'},payload:r.postData()??undefined});if(result.statusCode===200&&r.method()==='GET'&&/^\/sources\/goals\/[^/]+$/.test(path))SourceGoalDetailSchema.parse(JSON.parse(result.body));if(result.statusCode>=400)console.error('Goal browser route',path,result.statusCode,result.body);return route.fulfill({status:result.statusCode,contentType:'application/json',body:result.body})}let data:unknown;if(path==='/me')data={id:identity.userId,name:'Acceptance reader',email:'reader@test.invalid',default_space_id:identity.spaceId,instance_role:'member'};else if(path==='/me/spaces')data=[{id:identity.spaceId,name:'Goal acceptance',type:'personal',role:'owner'}];else if(path==='/plugins/effective')data={plugins:{}};else if(path==='/projects'||path==='/rooms'||path==='/proposals'||path==='/agents')data={items:[],total:0,offset:0,limit:50};else if(path.endsWith('/interest-profile'))data=null;else if(path==='/me/summary')data={spaces:[],recent_runs:[],recent_participation:[],pending_proposals_count:0,assigned_tasks_count:0};else return route.fulfill({status:404,json:{detail:'Outside test scope'}});return route.fulfill({json:data})});
 const en=locale==='en';const L=(e:string,z:string)=>en?e:z;
 const prefix=`${base}/spaces/${identity.spaceId}`;const readingPath=projectId?`/projects/${projectId}/sources`:'/library/reading';const goalsPath=`${readingPath}/goals`;
 // 1. Empty Reading offers following; opening the create page writes nothing.
 await page.goto(prefix+readingPath);await page.getByRole('heading',{name:L('What would you like to keep following?','你想持续关注什么？')}).waitFor();
 await page.getByRole('link',{name:L('Follow a topic','关注一个主题'),exact:true}).click();await page.getByRole('heading',{name:L('Follow a topic','关注一个主题'),level:1}).waitFor();
 const topic=page.getByRole('textbox',{name:L('Topic','主题')});await topic.fill('api_key=FIXTURE_BROWSER_SECRET_123456789');await page.getByRole('button',{name:L('Start following','开始关注'),exact:true}).click();
 await page.getByText(L('This looks like a password or key. Remove it from the message and use secure credentials.','消息中疑似含有密码或密钥。请移除，并使用安全凭证入口。'),{exact:true}).waitFor();expect((await db.pool.query('SELECT count(*)::int n FROM source_goals')).rows[0].n).toBe(0);
 await topic.fill('Follow robotics research and industry updates');await page.getByRole('button',{name:L('How often to check','检查频率')}).click();await page.getByRole('option',{name:L('Every 12 hours','每 12 小时')}).click();
 await page.getByText(L('Advanced: search path and Agent','高级：搜索方式与 Agent')).click();const apiPath=page.getByRole('button',{name:L('Existing API source','既有 API 来源'),exact:true});await apiPath.click();await expect.poll(()=>apiPath.getAttribute('aria-pressed')).toBe('true');await page.waitForTimeout(300);await shot(page,'create');
 expect(hits).toBe(0);expect((await db.pool.query('SELECT count(*)::int n FROM source_goals')).rows[0].n).toBe(0);
 await page.getByRole('button',{name:L('Start following','开始关注'),exact:true}).click();await page.waitForURL(new RegExp(`${goalsPath}/(?!new)[\\w-]+$`));const topicUrl=page.url();
 const goal=(await db.pool.query('SELECT * FROM source_goals')).rows[0];expect(goal.follow_json).toMatchObject({interval_seconds:43200,requests_per_run:8,items_per_source:20,activated_version_id:null});expect(goal.project_id).toBe(projectId);expect(goal.compatibility_json.search_path).toBe('api');
 // 2. Background preparation is the real queued planning Run; nothing else ran.
 const planning=(await db.pool.query("SELECT id,status FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$1",[goal.id])).rows;expect(planning).toHaveLength(1);expect(planning[0].status).toBe('queued');expect(hits).toBe(0);
 await page.getByText(L('Preparing sources','正在准备来源'),{exact:true}).waitFor();await page.getByText(L('Preparing sources in the background. You can leave this page; following continues.','正在后台准备来源。你可以离开本页，关注会继续进行。')).waitFor();await shot(page,'preparing');
 // Leaving and returning does not stop following.
 await page.goto(prefix+readingPath);await page.getByRole('link',{name:L('Following (1)','关注（1）'),exact:true}).waitFor();await page.goto(topicUrl);
 // A confirmed topic can be paused while still preparing: its planning Run is cancelled; resume continues the same confirmation with one Run.
 await page.getByRole('button',{name:L('Pause','暂停'),exact:true}).click();await expect.poll(async()=>(await db.pool.query('SELECT status FROM source_goals WHERE id=$1',[goal.id])).rows[0].status).toBe('paused');
 await expect.poll(async()=>(await db.pool.query("SELECT status FROM runs WHERE id=$1",[planning[0].id])).rows[0].status).toMatch(/^cancel/);
 await page.getByText(L('Paused','已暂停'),{exact:true}).first().waitFor();await shot(page,'preparing-paused');
 await page.getByRole('button',{name:L('Resume','恢复'),exact:true}).click();await page.getByText(L('Preparing sources','正在准备来源'),{exact:true}).waitFor();
 const resumed=(await db.pool.query("SELECT id FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$1 AND status='queued'",[goal.id])).rows;expect(resumed).toHaveLength(1);planning[0]=resumed[0];expect(hits).toBe(0);
 // Fixture planning Agent: the bound Run writes its plan; the confirmed follow activates it in the same transaction.
 await db.pool.query(`UPDATE runs r SET status='running',runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[planning[0].id]);
 await service.writeVersion(identity,{goal_id:goal.id,expected_revision:goal.revision,plan:{summary:'Robotics research and industry feeds',sources:specs,limitations:['Deterministic planning fixture; no model invocation.'],filters:{includes:['robotics'],excludes:[],excluded_origins:[]}}},planning[0].id);
 await db.pool.query(`UPDATE runs SET status='succeeded',output_json=$2 WHERE id=$1`,[planning[0].id,{schema_version:'run_output.v1',summary:'Fixture planning boundary: plan written.',result:{}}]);
 const active=(await db.pool.query('SELECT status,active_version_id,current_version_id FROM source_goals WHERE id=$1',[goal.id])).rows[0];expect(active.status).toBe('running');expect(active.active_version_id).toBe(active.current_version_id);
 await page.getByText(L('First collection','首次采集'),{exact:true}).waitFor({timeout:15000});
 // 3. First collection: background material, judged by deterministic topic rules.
 await tick(goal.id);expect(hits).toBe(2);await page.getByRole('button',{name:L('Refresh progress','刷新进度')}).click();
 await page.getByRole('link',{name:'Robotics research baseline',exact:true}).waitFor();await page.getByText(L('Following','关注中'),{exact:true}).first().waitFor();expect(await page.getByText(L('Background','背景资料'),{exact:true}).count()).toBe(2);await shot(page,'first-collection');
 // 4. Incremental update: a newer publication is New; the repeated baseline is not redelivered.
 (feeds.research as FeedItem[]).unshift({guid:'r2',title:'Robotics research new result',date:'2026-10-27T00:00:00Z'});await tick(goal.id);await page.reload();
 const fresh=page.getByRole('listitem').filter({has:page.getByRole('link',{name:'Robotics research new result',exact:true})});await fresh.getByText(L('Why this is here','推荐与跟踪依据'),{exact:true}).click();await fresh.getByText(L('New','新发布'),{exact:true}).waitFor();await page.getByText(L('1 new in the last check','上次检查新增 1 条')).waitFor();expect(page.url()).toBe(topicUrl);await shot(page,'incremental');
 const members=(await db.pool.query('SELECT delivery_kind,count(*)::int n FROM source_goal_items WHERE goal_id=$1 GROUP BY 1 ORDER BY 1',[goal.id])).rows;expect(members).toEqual([{delivery_kind:'baseline',n:2},{delivery_kind:'new_publication',n:1}]);
 // 5. No update.
 await tick(goal.id);await page.getByRole('button',{name:L('Refresh progress','刷新进度')}).click();await page.getByText(L('Last check found nothing new','上次检查没有新内容')).waitFor();
 // 6. Partial failure: one source fails, the healthy one continues and is not hidden.
 feeds.industry='fail';await db.pool.query("UPDATE source_goal_bindings SET retry_at=NULL WHERE goal_id=$1",[goal.id]);await tick(goal.id);await page.getByRole('button',{name:L('Refresh progress','刷新进度')}).click();
 const partialState=SourceGoalDetailSchema.parse(JSON.parse((await app.inject({method:'GET',url:`/api/v1/sources/goals/${goal.id}`,headers:{'x-rainver-space-id':identity.spaceId}})).body)).goal.follow_state!;console.info('Topic partial state',JSON.stringify(partialState.sources.map(s=>[s.health,s.error])));
 await page.getByText(L('Some sources have problems','部分来源异常'),{exact:true}).waitFor();const status=page.getByRole('heading',{name:L('Status','状态'),exact:true}).locator('xpath=ancestor::section[1]');expect(await status.getByText('Research evidence',{exact:true}).count()).toBe(1);expect(await status.getByText('Industry developments',{exact:true}).count()).toBe(1);await shot(page,'partial');
 // 7. Missing permission is never "no updates". The industry Source changes after confirmation (its address):
 // the topic names it as a Source change the owner confirms there — not a Source-page dead end.
 feeds.industry=[{guid:'i1',title:'Robotics industry baseline',date:'2026-10-21T00:00:00Z'}];await db.pool.query("UPDATE source_channels SET endpoint_url=endpoint_url||'?scope=changed' WHERE id=$1",[specs[1].source_channel_id]);await db.pool.query("UPDATE source_goal_bindings SET retry_at=NULL,status='active' WHERE goal_id=$1",[goal.id]);await tick(goal.id);await page.reload();
 const state=SourceGoalDetailSchema.parse(JSON.parse((await app.inject({method:'GET',url:`/api/v1/sources/goals/${goal.id}`,headers:{'x-rainver-space-id':identity.spaceId}})).body)).goal.follow_state!;console.info('Topic permission state',JSON.stringify({phase:state.phase,health:state.health,sources:state.sources.map(s=>[s.health,s.error,s.attention,s.resolvable_by])}));
 expect(state.health).toBe('needs_permission');expect(state.sources.find(s=>s.source_connection_id===specs[1].source_connection_id)).toMatchObject({attention:'source_changed',resolvable_by:'you'});
 await page.getByText(L('A source this topic uses changed after you confirmed the topic','你确认主题之后，它使用的一个来源发生了变化')).waitFor();await page.getByText(L('Waiting for your confirmation','等待你确认'),{exact:true}).waitFor();
 expect(await page.getByRole('link',{name:L('Review source','查看来源'),exact:true}).count()).toBe(0);await shot(page,'source-changed');
 const changedBinding=(await db.pool.query('SELECT id,revision FROM source_goal_bindings WHERE goal_id=$1 AND source_connection_id=$2',[goal.id,specs[1].source_connection_id])).rows[0];
 await page.getByRole('button',{name:L('Review change and continue','查看变化并继续')}).click();const dialog=page.getByRole('dialog');
 await dialog.getByText(L('Changed since the topic was confirmed: Address.','主题确认之后发生变化的项：地址。')).waitFor();await page.waitForTimeout(300);await shot(page,'source-change-review');
 // It changes back while the dialog is open: the state shown is no longer current, so the confirmation is refused and the current state shown.
 await db.pool.query("UPDATE source_channels SET endpoint_url=replace(endpoint_url,'?scope=changed','') WHERE id=$1",[specs[1].source_channel_id]);
 await dialog.getByRole('button',{name:L('Confirm and continue','确认并继续')}).click();
 await dialog.getByText(L('The source changed again since this was shown.','显示之后来源又有了变化。')).waitFor();await dialog.getByText(L('Nothing differs from what was confirmed','与确认时的状态没有差别')).waitFor();
 expect((await db.pool.query('SELECT status,revision FROM source_goal_bindings WHERE id=$1',[changedBinding.id])).rows[0]).toMatchObject({status:'paused',revision:changedBinding.revision});await shot(page,'source-change-refused');
 await dialog.getByRole('button',{name:L('Confirm and continue','确认并继续')}).click();await dialog.waitFor({state:'detached'});
 expect((await db.pool.query('SELECT status,revision,fixture_json FROM source_goal_bindings WHERE id=$1',[changedBinding.id])).rows[0]).toMatchObject({status:'active',revision:changedBinding.revision+1,fixture_json:{reconfirmed_by:identity.userId}});
 await page.getByText(L('A source this topic uses changed','你确认主题之后')).waitFor({state:'detached'});
 // Collecting resumes for the confirmed Source.
 await tick(goal.id);expect((await db.pool.query('SELECT status,fixture_json FROM source_goal_bindings WHERE id=$1',[changedBinding.id])).rows[0].fixture_json).not.toHaveProperty('collection_error');
 await page.getByRole('button',{name:L('Refresh progress','刷新进度')}).click();await shot(page,'source-change-confirmed');
 // A bound Source is deleted (FIXTURE: Source deletion APIs are retired with 410, so its row is marked deleted as in the PG regression).
 // The topic stays manageable; the deleted Source shows only redacted state, and the healthy one remains.
 await db.pool.query("UPDATE source_connections SET deleted_at=now(),status='archived' WHERE id=$1",[specs[1].source_connection_id]);await page.reload();
 const sourcesPanel=page.getByRole('heading',{name:L('Status','状态'),exact:true}).locator('xpath=ancestor::section[1]');
 await sourcesPanel.getByText(L('Source no longer available','来源已不可用'),{exact:true}).waitFor();await sourcesPanel.getByText('Research evidence',{exact:true}).waitFor();expect(await sourcesPanel.getByText('Industry developments',{exact:true}).count()).toBe(0);
 await page.getByRole('button',{name:L('Pause','暂停'),exact:true}).waitFor();await shot(page,'deleted-source');
 await page.goto(prefix+goalsPath);await page.getByRole('link',{name:'Follow robotics research and industry updates',exact:true}).waitFor();await page.getByText(L('Source access needed','需要来源访问'),{exact:true}).waitFor();await page.goto(topicUrl);
 // 8. Important / All and refresh recovery of the chosen view.
 await page.getByRole('button',{name:L('All collected','全部已采集'),exact:true}).click();await page.waitForURL(/selection=all/);await page.reload();expect(await page.getByRole('button',{name:L('All collected','全部已采集'),exact:true}).getAttribute('aria-pressed')).toBe('true');
 // 9. Reading: topic filter, reason, Reader and return to the same filtered scope; read state persists.
 await page.goto(prefix+readingPath);await page.getByRole('button',{name:L('Topic','主题'),exact:true}).click();await page.getByRole('option',{name:'Follow robotics research and industry updates'}).click();await page.waitForURL(/topic=/);
 await page.getByRole('link',{name:'Robotics research new result',exact:true}).first().waitFor();await shot(page,'reading-topic');const filtered=page.url();
 await page.getByRole('link',{name:'Robotics research new result',exact:true}).first().click();await page.waitForURL(/\/library\/items\//);
 const back=page.locator(`a[href*="${readingPath}?topic="]`).first();await back.waitFor();await back.click();await page.waitForURL(filtered);
 await page.getByRole('button',{name:L('Mark read','标为已读'),exact:true}).first().click();
 await expect.poll(async()=>(await db.pool.query("SELECT count(*)::int n FROM source_item_user_states WHERE read_status='read'")).rows[0].n).toBeGreaterThan(0);
 // 9b. The same URL's cited change is its own delivery, not a body revision.
 const unchanged=(await db.pool.query("SELECT id,reading_body_revision FROM source_items WHERE source_uri=$1",[upstream.baseUrl+'/research/r2'])).rows[0];
 // Due again with a fresh request window: the source-change step ran one more collection against the same fixture host,
 // which scheduled the next check and used that host's request quota (both enforced as in production).
 await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL WHERE goal_id=$1',[goal.id]);await db.pool.query('DELETE FROM source_request_quota_state');changeEvidence=upstream.baseUrl+'/release/v2';const changeTick=await tick(goal.id);console.info('Change fixture tick',JSON.stringify(changeTick),JSON.stringify((await db.pool.query('SELECT source_uri FROM source_items')).rows),JSON.stringify((await db.pool.query('SELECT evidence_url,delivered_at FROM source_goal_item_changes')).rows));await page.reload();
 // The Reading row (its list item) carrying the topic-update delivery, independent of card density and styling.
 const changeCard=page.locator('[data-reading-row]').filter({has:page.getByText(L('Topic update','主题变化'),{exact:true})});await changeCard.waitFor();expect(await changeCard.count()).toBe(1);
 await changeCard.getByRole('link',{name:'Robotics research new result',exact:true}).click();await page.waitForURL(/change=/);
 await page.getByRole('button',{name:L('Mark this update read','标记本次变化已读'),exact:true}).click();await page.getByRole('button',{name:L('This update is read','本次变化已读'),exact:true}).waitFor();await shot(page,'change-confirmed');
 await page.locator(`a[href*="${readingPath}?topic="]`).first().click();await page.waitForURL(filtered);expect(await page.getByText(L('Topic update','主题变化'),{exact:true}).count()).toBe(0);
 // Replay and v3 transitions are exercised in real-PG native settlement tests;
 // do not spend three additional physical checks inside this browser's shared
 // account/endpoint minute window merely to repeat those assertions.
 expect((await db.pool.query('SELECT id,reading_body_revision FROM source_items WHERE id=$1',[unchanged.id])).rows[0]).toEqual(unchanged);
 // 10. Pause from the topic page: background following stops; history stays readable; badge excludes paused topics.
 await page.goto(topicUrl);await page.getByRole('button',{name:L('Pause','暂停'),exact:true}).click();await expect.poll(async()=>(await db.pool.query('SELECT status FROM source_goals WHERE id=$1',[goal.id])).rows[0].status).toBe('paused');await page.getByText(L('Paused','已暂停'),{exact:true}).first().waitFor();
 const beforePausedTick=hits;await tick(goal.id);expect(hits).toBe(beforePausedTick);await shot(page,'paused');
 await page.goto(prefix+readingPath+'?view=all');await page.getByRole('link',{name:L('Following (0)','关注（0）'),exact:true}).waitFor();
 // 11. Delete keeps collected material.
 await page.getByRole('link',{name:L('Following (0)','关注（0）'),exact:true}).click();await page.getByRole('button',{name:L('Delete goal','删除目标'),exact:true}).click();await page.getByRole('dialog').waitFor();await shot(page,'delete');await page.getByRole('dialog').getByRole('button',{name:L('Delete goal','删除目标'),exact:true}).click();
 await expect.poll(async()=>(await db.pool.query('SELECT status FROM source_goals WHERE id=$1',[goal.id])).rows[0].status).toBe('deleted');await page.goto(prefix+readingPath+'?view=all');await page.getByRole('heading',{name:'Robotics research new result',exact:true}).waitFor();
 expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(3);
 // Exactly the cancelled planning Run from the paused preparation and the one resumed Run; no other paid work.
 const goalRuns=(await db.pool.query("SELECT status FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$1 ORDER BY created_at",[goal.id])).rows.map(r=>r.status);expect(goalRuns).toHaveLength(2);expect(goalRuns[0]).toMatch(/^cancel/);
 expect(errors).toEqual([]);console.info('Topic browser acceptance',{locale,project:!!projectId,hits,items:3,planning_fixture:true,model_calls:0,screenshots:shotDir});await context.close();
 }finally{await browser.close();await new Promise<void>(r=>server.httpServer.close(()=>r()));await app.close();await upstream.close();await rm(root,{recursive:true,force:true});vi.restoreAllMocks();__setAgentChatIdentityForTests(null);__setAuthIdentityForTests(null)}
},180000);
