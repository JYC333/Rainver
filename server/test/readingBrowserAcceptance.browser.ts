import { sourcesModule } from '../src/modules/sources/index.js';
import { PgSourcesRepository } from '../src/modules/sources/repository.js';
import { startMockUpstream } from './support/mockUpstream.js';
import { fixtureServerGuard } from './support/outboundGuard.js';
import { PgInterestProfileRepository } from '../src/modules/interestProfile/repository.js';
import { PgSourceAnnotationRepository } from '../src/modules/sourceAnnotation/repository.js';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it, expect, vi } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject, seedMainlineRoomsForAllProjects } from './support/domainSeeds.js';
import { retainReaderBody } from './support/readingMaterial.js';
import { buildModuleServer } from './support/moduleServer.js';
import { loadConfig } from '../src/config.js';
import { projectsModule } from '../src/modules/projects/index.js';
import { informationDigestModule } from '../src/modules/informationDigest/index.js';
import { readerModule } from '../src/modules/reader/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { ProjectCorpusRepository } from '../src/modules/projects/corpusRepository.js';

const webRequire = createRequire(resolve('../apps/web/package.json'));
const db = useTestDatabase(import.meta.filename);
const shotDir = process.env.READING_SCREENSHOT_DIR ?? '/tmp/rainver-reading-stage-three';
it.each([['en',1440,1000],['zh-CN',390,844]] as const)('walks built Reading with real PG routes and private state (%s)', async (locale,width,height) => {
  const space = randomUUID(), owner = randomUUID(), project = randomUUID(), projectB = randomUUID(), secondSpace = randomUUID();
  const identity = { spaceId: space, userId: owner };
  await seedSpaceOwnerProject(db.pool, {space,owner,project,spaceName:'Reading acceptance',projectName:'Climate research'});
  await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Project B','active',now(),now())`,[projectB,space,owner]);
  await seedMainlineRoomsForAllProjects(db.pool);
  await db.pool.query(`INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Isolated Space','team',now(),now())`,[secondSpace]);
  await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())`,[randomUUID(),secondSpace,owner]);
  const first = randomUUID(), duplicate = randomUUID(), duplicateB = randomUUID(), relevant = randomUUID();
  const now = '2026-01-04T00:00:00Z';
  for (const [id,projectId,title,uri] of [[first,null,'Shared recommendation across days','https://reading.test/shared'],[duplicate,project,'Shared recommendation across days','https://reading.test/shared'],[duplicateB,projectB,'Shared recommendation across days','https://reading.test/shared'],[relevant,project,'Relevant material, not selected','https://reading.test/relevant']] as const) {
    await db.pool.query(`INSERT INTO source_items(id,space_id,owner_user_id,created_by_user_id,project_id,visibility,item_type,title,source_uri,canonical_uri,content_hash,excerpt,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at)
      VALUES($1,$2,$3,$3,$4,'space_shared','external_url',$5,$6,$6,'capture','Retained excerpt','content_saved','full_text',$7,$7,$7,$7)`,[id,space,owner,projectId,title,uri,now]);
    await retainReaderBody(db.pool,{space,owner,item:id,text:id===relevant?'Other retained material.':'This is the actual retained Reader body for the recommendation.'});
    const annotations=new PgSourceAnnotationRepository(db.pool);
    await annotations.enqueueItems(space,[id],null);
    await annotations.markSucceeded(space,{source_item_id:id,domain_key:'technology.computing',depth:'analysis',genre:'explainer',summary:'A retained summary with its original recommendation reasons.',topic_candidates:[],stance_target:null,stance_target_key:null,stance_polarity:'neutral',stance_confidence:0},null);
    if(projectId) await new ProjectCorpusRepository(db.pool).upsert(identity,project,{source_item_id:id});
  }
  for (const [projectId,itemId,date,reason] of [[null,first,'2026-01-01','Personal original reason'],[project,duplicate,'2026-01-02','Project original reason'],[projectB,duplicateB,'2026-01-03','Project B reason']] as const) {
    const digest=randomUUID();
    await db.pool.query(`INSERT INTO information_digests(id,space_id,digest_type,owner_user_id,project_id,digest_date,period_start_utc,period_end_utc,generated_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$8)`,[digest,space,projectId?'project':'personal',projectId?null:owner,projectId,date,`${date}T00:00:00Z`,`${date}T23:00:00Z`]);
    await db.pool.query(`INSERT INTO information_digest_items(id,space_id,digest_id,source_item_id,section,position,quota_slot,score,rationale,created_at) VALUES($1,$2,$3,$4,'interest',0,'interest',1,$5,$6)`,[randomUUID(),space,digest,itemId,reason,now]);
  }
  __setAuthIdentityForTests(identity);
  const artifacts=await mkdtemp(join(tmpdir(),'reading-onboarding-'));
  const upstream=await startMockUpstream((request,response)=>{
    response.writeHead(200,{'content-type':request.url==='/feed.xml'?'application/rss+xml':'text/html'});
    response.end(request.url==='/feed.xml'
      ? `<rss version="2.0"><channel><title>Reading feed</title><link>${upstream.baseUrl}</link><description>Fixture</description><item><title>First feed article</title><link>${upstream.baseUrl}/feed-article</link><guid>${upstream.baseUrl}/feed-article</guid><description>First material from a new source.</description></item></channel></rss>`
      : '<html><head><title>First saved article</title></head><body><article><h1>First saved article</h1><p>This is the first article saved from Reading. The extracted text is ready to read.</p></article></body></html>');
  });
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri,ARTIFACT_STORAGE_ROOT:artifacts});
  // Only the outbound boundary is substituted. Routes, policy, jobs, writes,
  // extraction and Reader still use their real services and isolated PostgreSQL.
  const originalRunJob=PgSourcesRepository.prototype.runJob;
  vi.spyOn(PgSourcesRepository.prototype,'runJob').mockImplementation(function(identity,jobId){
    return originalRunJob.call(new PgSourcesRepository(db.pool,config,fixtureServerGuard),identity,jobId);
  });
  const provider=randomUUID(),connector=randomUUID();
  await db.pool.query(`INSERT INTO source_providers(id,provider_key,display_name,provider_kind,category,status,capabilities_json,created_at,updated_at) VALUES($1,'generic_rss','RSS Feed','generic','feed','active','{}',now(),now()) ON CONFLICT(provider_key) DO NOTHING`,[provider]);
  await db.pool.query(`INSERT INTO source_connectors(id,connector_key,display_name,connector_type,ingestion_mode,status,capabilities_json,created_at,updated_at) VALUES($1,'rss','RSS','external_feed','pull','active','{}',now(),now()) ON CONFLICT(connector_key) DO NOTHING`,[connector]);
  await db.pool.query(`INSERT INTO source_provider_connectors(id,provider_id,connector_id,status,priority,capabilities_json,created_at,updated_at) SELECT $1,p.id,c.id,'active',0,'{}',now(),now() FROM source_providers p,source_connectors c WHERE p.provider_key='generic_rss' AND c.connector_key='rss' ON CONFLICT DO NOTHING`,[randomUUID()]);
  const app=buildModuleServer(config,[informationDigestModule,readerModule,projectsModule,sourcesModule]);
  const { chromium } = webRequire('playwright-core');
  const vitePath=pathToFileURL(webRequire.resolve('vite')).href;
  const { preview }=await import(vitePath);
  const server=await preview({root:resolve('../apps/web'),configFile:false,preview:{host:'127.0.0.1',port:0}});
  const base=`http://127.0.0.1:${server.httpServer.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE});
  const realRequests: string[]=[];
  const projectOut={id:project,space_id:space,name:'Climate research',status:'active',owner_user_id:owner,created_at:now,updated_at:now};
  await mkdir(shotDir,{recursive:true});
  try {
    {
      const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});
      await context.addInitScript((lang:string)=>localStorage.setItem('rainver:locale',lang),locale);
      const page=await context.newPage();page.setDefaultTimeout(5000);
      let failNextReading = false;
      const failures:string[]=[];
      page.on('pageerror',(e:Error)=>{failures.push(e.message);console.error('Browser error',e.message)});
      await page.route('**/api/v1/**',async(route:any)=>{
        const request=route.request();const url=new URL(request.url());const path=url.pathname.replace('/api/v1','');
        if(failNextReading && path.endsWith('/reading') && request.method()==='GET') { failNextReading=false; return route.fulfill({status:503,json:{detail:'Acceptance: transient failure'}}) }
        // Reading, preferences, historical membership and Reader are real application routes/PG.
        if(path.includes('/reading') || path.includes('/information-digests') || path.startsWith('/reader/') || path.startsWith('/sources/') || /^\/projects\/[^/]+\/corpus$/.test(path)) {
          realRequests.push(`${request.method()} ${path}${url.search}`);
          const requestedSpace=path.startsWith(`/spaces/${secondSpace}/`) || request.headers()['x-rainver-space-id']===secondSpace ? secondSpace : space;
          __setAuthIdentityForTests({spaceId:requestedSpace,userId:owner});
          const response=await app.inject({method:request.method(),url:url.pathname+url.search,headers:{'x-rainver-space-id':request.headers()['x-rainver-space-id']??space,'content-type':'application/json'},payload:request.postData()??undefined});
          if(response.statusCode>=400)console.error('Real reading route failed',path,response.statusCode,response.body);
          return route.fulfill({status:response.statusCode,contentType:'application/json',body:response.body});
        }
        const pageOf=(items:unknown[])=>({items,total:items.length,limit:100,offset:0});
        let data:unknown;
        if(path==='/me')data={id:owner,name:'Reader',email:'reader@example.test',default_space_id:space,instance_role:'member'};
        else if(path==='/me/spaces')data=[{id:space,name:'Reading acceptance',type:'personal',role:'owner'},{id:secondSpace,name:'Isolated Space',type:'team',role:'owner'}];
        else if(path==='/plugins/effective')data={plugins:{}};
        else if(path==='/projects')data=pageOf([projectOut,{...projectOut,id:projectB,name:'Project B'}]);
        else if(path===`/projects/${project}`)data=projectOut;
        else if(path.endsWith('/overview'))data={attention:[],counts:{},recent_activity:[]};
        else if(path.endsWith('/folders')||path==='/rooms'||path==='/proposals')data=pageOf([]);
        else if(path==='/agents')data=[];
        else if(path.endsWith('/information-monitoring'))data={active:{config:{objective:'Project candidate review'}},draft:null,latest_run:null,candidates:[{id:relevant,title:'Relevant material, not selected',summary:'A candidate, not a formal recommendation',reason:'Candidate rationale',recommended:false,relevance:'relevant',read_status:'unread'}],dependencies:[],available_sources:[],can_write:false};
        else if(path==='/sources/briefings')data=pageOf([]);
        else if(path.endsWith('/interest-profile'))data=null;
        else if(path==='/me/summary')data={accessible_spaces_count:1,pending_proposals_count:0,assigned_tasks_count:0,recent_failed_runs_count:0,recent_runs:[],recent_participation:[],spaces:[]};
        else if(path==='/me/timeline'||path==='/me/pending')data=[];
        else if(path==='/me/tasks')data=pageOf([]);
        else return route.fulfill({status:404,json:{detail:'Outside reading acceptance fixture'}});
        return route.fulfill({json:data});
      });
      const goto=(path:string)=>page.goto(`${base}/spaces/${space}${path}`);
      const text=locale==='en'?{mine:'My reading',read:'Read',all:'All material',mark:'Mark read',restore:'Restore unread',prefs:'Project reading preferences',project:'Project reading',open:'Open Reader',editions:'Daily editions'}:{mine:'我的阅读',read:'已读',all:'全部资料',mark:'标为已读',restore:'恢复未读',prefs:'项目阅读偏好',project:'项目阅读',open:'打开阅读器',editions:'每日版'};
      await goto('/library');
      await page.getByRole('heading',{name:text.mine,exact:true}).waitFor();
      await page.getByRole('heading',{name:'Shared recommendation across days'}).waitFor();
      expect(await page.getByRole('heading',{name:'Shared recommendation across days'}).count()).toBe(1);
      expect(await page.getByText('Project original reason').count()).toBe(0);
      await page.getByRole('button',{name:text.prefs,exact:true}).click();
      const checkbox=page.getByRole('checkbox').first();try{await checkbox.waitFor()}catch(e){console.error(await page.locator('body').innerText());throw e;}await checkbox.click();await expect.poll(()=>checkbox.isChecked()).toBe(true);
      await page.getByText('Project original reason').waitFor();console.info('Reading preference/group passed',locale);
      expect(await page.getByRole('heading',{name:'Shared recommendation across days'}).count()).toBe(1);
      const secondCheckbox=page.getByRole('checkbox').nth(1);
      await secondCheckbox.click();await page.getByText('Project B reason',{exact:true}).waitFor();
      expect(await page.getByRole('heading',{name:'Shared recommendation across days'}).count()).toBe(1);
      await checkbox.click();await expect.poll(()=>page.getByText('Project original reason',{exact:true}).count()).toBe(0);
      expect(await page.getByText('Project B reason',{exact:true}).count()).toBe(1);
      await checkbox.click();await page.getByText('Project original reason',{exact:true}).waitFor();
      await secondCheckbox.click();await expect.poll(()=>page.getByText('Project B reason',{exact:true}).count()).toBe(0);
      expect(await page.getByText(locale==='en'?'Off by default. This changes only your reading list, never the team’s collection direction, schedule or budget.':'默认关闭。只影响你的阅读列表，不改变团队采集方向、时间或预算。',{exact:true}).count()).toBe(1);
      await page.screenshot({path:`${shotDir}/${locale}-personal.png`,fullPage:true});
      await page.getByRole('button',{name:text.mark,exact:true}).click();
      await page.getByRole('heading',{name:locale==='en'?'You’re caught up':'待读推荐已读完',exact:true}).waitFor();
      expect((await db.pool.query('SELECT read_status FROM source_item_user_states WHERE source_item_id=ANY($1::varchar[]) AND user_id=$2',[[first,duplicate,duplicateB],owner])).rows.map(r=>r.read_status)).toEqual(['read','read','read']);
      // Fixed historical scope/date keeps the completed member.
      await page.screenshot({path:`${shotDir}/${locale}-empty.png`,fullPage:true});
      console.info('Reading completion passed',locale);
      await goto('/library/digests?date=2026-01-01');
      await page.getByRole('link',{name:'Shared recommendation across days',exact:true}).waitFor();
      await page.screenshot({path:`${shotDir}/${locale}-edition.png`,fullPage:true});
      console.info('Reading history passed',locale);
      // Daily editions retain their real scope and stored day through Reader.
      await page.getByRole('link',{name:'Shared recommendation across days',exact:true}).click();
      await page.getByText('This is the actual retained Reader body for the recommendation.',{exact:true}).first().waitFor();
      await page.getByRole('main').getByRole('link',{name:text.editions,exact:true}).click();
      expect(new URL(page.url()).pathname).toBe(`/spaces/${space}/library/digests`);
      expect(new URL(page.url()).searchParams.get('date')).toBe('2026-01-01');
      await page.getByRole('link',{name:'Shared recommendation across days',exact:true}).waitFor();
      await page.screenshot({path:`${shotDir}/${locale}-personal-edition-return.png`,fullPage:true});
      await goto(`/projects/${project}/sources?tab=digest&date=2026-01-02`);
      await page.getByRole('heading',{name:text.editions,exact:true}).waitFor();
      await page.getByRole('link',{name:'Shared recommendation across days',exact:true}).click();
      expect(new URL(page.url()).searchParams.get('from')).toBe('project');
      expect(new URL(page.url()).searchParams.get('projectId')).toBe(project);
      await page.getByText('This is the actual retained Reader body for the recommendation.',{exact:true}).first().waitFor();
      await page.screenshot({path:`${shotDir}/${locale}-project-edition-reader.png`,fullPage:true});
      await page.getByRole('main').getByRole('link',{name:text.editions,exact:true}).click();
      expect(new URL(page.url()).pathname).toBe(`/spaces/${space}/projects/${project}/sources`);
      expect(new URL(page.url()).searchParams.get('tab')).toBe('digest');
      expect(new URL(page.url()).searchParams.get('date')).toBe('2026-01-02');
      await page.getByRole('heading',{name:text.editions,exact:true}).waitFor();
      await page.getByRole('link',{name:'Shared recommendation across days',exact:true}).waitFor();
      expect(realRequests).toContain(`GET /spaces/${space}/projects/${project}/information-digests?date=2026-01-02`);
      await page.screenshot({path:`${shotDir}/${locale}-project-edition-return.png`,fullPage:true});
      await goto('/library/digests?date=2026-01-01');
      await page.getByRole('link',{name:'Shared recommendation across days',exact:true}).waitFor();

      const artifactCount=(await db.pool.query('SELECT count(*)::int AS n FROM artifacts WHERE space_id=$1',[space])).rows[0].n;
      await page.getByRole('button', {name:locale==='en'?'Project for Shared recommendation across days':'《Shared recommendation across days》要归入的项目',exact:true}).click();
      await page.getByRole('option', {name:'Climate research',exact:true}).click();
      await page.getByRole('button',{name:locale==='en'?'Add to Project Corpus':'加入项目语料库',exact:true}).click();
      await expect.poll(async()=>Number((await db.pool.query('SELECT count(*) AS n FROM project_corpus_items WHERE project_id=$1 AND source_item_id=$2',[project,first])).rows[0].n)).toBe(1);
      expect((await db.pool.query('SELECT count(*)::int AS n FROM artifacts WHERE space_id=$1',[space])).rows[0].n).toBe(artifactCount);
      await goto(`/projects/${project}/sources?view=all`);
      await page.getByRole('heading',{name:'Shared recommendation across days'}).waitFor();
      expect(await page.getByRole('heading',{name:'Shared recommendation across days'}).count()).toBe(1);
      await page.getByRole('heading',{name:'Shared recommendation across days'}).locator('..').getByRole('link',{name:text.open,exact:true}).click();
      await page.getByText('This is the actual retained Reader body for the recommendation.',{exact:true}).first().waitFor();
      await page.screenshot({path:`${shotDir}/${locale}-corpus-reader.png`,fullPage:true});
      await goto('/library/reading?view=read');
      await page.getByRole('button',{name:text.restore,exact:true}).click();
      await goto('/library/reading');
      await page.getByRole('heading',{name:'Shared recommendation across days'}).waitFor();
      await page.getByRole('link',{name:text.open,exact:true}).click();
      await page.getByText('This is the actual retained Reader body for the recommendation.',{exact:true}).first().waitFor();
      await page.getByRole('button',{name:locale==='en'?'Re-extract':'重新提取',exact:true}).waitFor();
      await page.getByRole('button',{name:locale==='en'?'Close inspector':'关闭检查面板',exact:true}).click();
      await page.getByRole('button',{name:locale==='en'?'Show inspector':'显示检查面板',exact:true}).click();
      await page.getByRole('complementary',{name:locale==='en'?'Reader inspector':'阅读检查面板',exact:true}).waitFor();
      await page.screenshot({path:`${shotDir}/${locale}-reader.png`,fullPage:true});
      await goto(`/projects/${project}/sources`);
      await page.getByRole('heading',{name:text.project,exact:true}).waitFor();
      await page.getByRole('heading',{name:'Shared recommendation across days'}).waitFor();
      expect(await page.getByText('Relevant material, not selected',{exact:true}).count()).toBe(0);
      await page.screenshot({path:`${shotDir}/${locale}-project.png`,fullPage:true});
      await page.getByRole('button',{name:text.all,exact:true}).click();
      await page.getByRole('heading',{name:'Relevant material, not selected'}).waitFor();
      expect(await page.evaluate(()=>(globalThis as any).document.documentElement.scrollWidth<=(globalThis as any).innerWidth)).toBe(true);
      await page.screenshot({path:`${shotDir}/${locale}-all.png`,fullPage:true});
      const profile=new PgInterestProfileRepository(db.pool);
      const coverageBefore=await profile.coverageByDomain(space,owner);
      await goto(`/projects/${project}/sources?tab=candidates`);
      await page.getByRole('link',{name:'Relevant material, not selected',exact:true}).click();
      await page.getByText('Other retained material.',{exact:true}).first().waitFor();
      expect((await db.pool.query('SELECT read_origin FROM source_item_user_states WHERE space_id=$1 AND source_item_id=$2 AND user_id=$3',[space,relevant,owner])).rows[0].read_origin).toBe('project');
      expect((await profile.coverageByDomain(space,owner)).map(({domain_key,item_count})=>({domain_key,item_count}))).toEqual(coverageBefore.map(({domain_key,item_count})=>({domain_key,item_count})));
      await page.getByRole('link',{name:locale==='en'?'Source management':'来源管理',exact:true}).click();
      await page.getByRole('heading',{name:locale==='en'?'All monitoring candidates':'全部监测候选',exact:true}).waitFor();
      await page.screenshot({path:`${shotDir}/${locale}-candidate-return.png`,fullPage:true});
      await page.goto(`${base}/home`);
      await page.getByRole('heading',{name:text.mine,exact:true}).waitFor();
      await page.getByRole('link',{name:'Shared recommendation across days',exact:true}).waitFor();
      await page.screenshot({path:`${shotDir}/${locale}-home.png`,fullPage:true});
      await page.getByRole('link',{name:locale==='en'?'Open reading':'打开阅读',exact:true}).click();
      await page.getByRole('heading',{name:text.mine,exact:true}).waitFor();
      await goto('/library/reading');await page.getByRole('button',{name:text.prefs,exact:true}).click();await page.getByRole('checkbox').first().click();await expect.poll(()=>page.getByRole('checkbox').first().isChecked()).toBe(false);
      await page.getByRole('heading',{name:'Shared recommendation across days'}).waitFor();
      failNextReading = true;
      await goto('/library/reading');
      await page.getByRole('alert').filter({hasText:locale==='en'?'Could not load reading':'无法加载阅读内容'}).waitFor();
      expect(await page.getByRole('heading',{name:'Shared recommendation across days'}).count()).toBe(0);
      await page.screenshot({path:`${shotDir}/${locale}-error.png`,fullPage:true});
      await page.getByRole('button',{name:locale==='en'?'Try again':'重试',exact:true}).click();
      await page.getByRole('heading',{name:'Shared recommendation across days'}).waitFor();
      if (locale === 'zh-CN') {
        // More than two real server pages, including state changes below the fold.
        const seeded=await db.pool.query(`INSERT INTO source_items(id,space_id,owner_user_id,created_by_user_id,visibility,item_type,title,source_uri,canonical_uri,content_hash,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at)
          SELECT gen_random_uuid()::text,$1,$2,$2,'private','external_url','Window item '||n,'https://window.test/'||n,'https://window.test/'||n,'capture-'||n,'metadata_only','metadata_only','2025-12-31','2025-12-31','2025-12-31','2025-12-31' FROM generate_series(1,64) n RETURNING id`,[space,owner]);
        const digestId=randomUUID();
        await db.pool.query(`INSERT INTO information_digests(id,space_id,digest_type,owner_user_id,digest_date,period_start_utc,period_end_utc,generated_at,created_at,updated_at) VALUES($1,$2,'personal',$3,'2025-12-31','2025-12-31','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,[digestId,space,owner]);
        await db.pool.query(`INSERT INTO information_digest_items(id,space_id,digest_id,source_item_id,section,position,quota_slot,score,rationale,created_at) SELECT gen_random_uuid()::text,$1,$2,id,'interest',position::int,'interest',1,'Retained backlog reason','2026-01-01' FROM unnest($3::varchar[]) WITH ORDINALITY x(id,position)`,[space,digestId,seeded.rows.map(r=>r.id)]);
        await goto('/library/reading');
        const list=page.getByRole('region',{name:'阅读列表'});
        const headings=list.locator('h2');
        await expect.poll(()=>headings.count()).toBe(30);
        await list.getByRole('button',{name:'加载更多',exact:true}).click();
        await expect.poll(()=>headings.count()).toBe(60);
        const readTitle=await headings.nth(40).innerText();
        await list.getByRole('button',{name:'标为已读',exact:true}).nth(40).click();
        await expect.poll(()=>list.getByRole('heading',{name:readTitle,exact:true}).count()).toBe(0);
        expect(await headings.count()).toBe(60);
        // Remaining old-window records were not discarded in favor of page one.
        const position=await list.evaluate((el:any)=>{for(let p=el.parentElement;p;p=p.parentElement)if(p.scrollTop>0)return p.scrollTop;return 0});
        expect(position).toBeGreaterThan(0);
        await list.getByRole('button',{name:'加载更多',exact:true}).click();
        await expect.poll(()=>headings.count()).toBe(64);
        const dismissTitle=await headings.nth(40).innerText();
        await list.getByRole('button',{name:'仅为我略过',exact:true}).nth(40).click();
        await expect.poll(()=>headings.count()).toBe(63);
        expect(await list.getByRole('heading',{name:dismissTitle,exact:true}).count()).toBe(0);
        await goto('/library/reading?view=all');
        await expect.poll(()=>headings.count()).toBe(30);
        await list.getByRole('button',{name:'加载更多',exact:true}).click();
        await expect.poll(()=>headings.count()).toBe(60);
        await list.getByRole('heading',{name:readTitle,exact:true}).locator('..').getByRole('button',{name:'恢复未读',exact:true}).click();
        await expect.poll(()=>list.getByRole('button',{name:'恢复未读',exact:true}).count()).toBe(0);
        expect(await headings.count()).toBe(60);
        await list.getByRole('heading',{name:dismissTitle,exact:true}).locator('..').getByRole('button',{name:'恢复到我的待读',exact:true}).click();
        await expect.poll(()=>list.getByRole('button',{name:'恢复到我的待读',exact:true}).count()).toBe(0);
        expect(await headings.count()).toBe(60);
        await list.getByRole('button',{name:'加载更多',exact:true}).click();
        await expect.poll(()=>headings.count()).toBe(65);
        await page.screenshot({path:`${shotDir}/zh-CN-window.png`,fullPage:true});
      }
      await page.goto(`${base}/spaces/${secondSpace}/library/reading`);
      await page.getByRole('heading',{name:locale==='en'?'What would you like to keep following?':'你想持续关注什么？',exact:true}).waitFor();
      expect(await page.getByRole('heading',{name:'Shared recommendation across days'}).count()).toBe(0);
      await page.screenshot({path:`${shotDir}/${locale}-space-isolation.png`,fullPage:true});
      // First content: start from the truly empty team Space. Context-free saves
      // and Sources belong to the reader's Personal Space returned by the writer.
      await page.evaluate(()=>(globalThis as any).document.documentElement.classList.add('theme-light'));
      await page.screenshot({path:`${shotDir}/${locale}-first-reading.png`,fullPage:true});
      const background = await page.getByRole('heading',{name:locale==='en'?'What would you like to keep following?':'你想持续关注什么？',exact:true}).elementHandle();
      const readingGets = () => realRequests.filter(r => r.startsWith('GET ') && /\/reading(?:\?|$)/.test(r)).length;
      const beforeCancel = readingGets();
      // Goal setup is now a durable full page; its Agent/preview/start path is
      // exercised by sourceGoalBrowser.browser.ts. No old technical dialog remains.
      const setup=page.getByRole('link',{name:locale==='en'?'Describe your goal':'描述关注目标',exact:true});
      expect(await setup.getAttribute('href')).toContain('/sources/goals/new');
      await page.getByRole('button',{name:locale==='en'?'Save an article':'先保存一篇文章',exact:true}).click();
      await page.getByRole('dialog').getByRole('button',{name:locale==='en'?'Cancel':'取消',exact:true}).click();
      await page.getByRole('dialog').waitFor({state:'hidden'});
      expect(await background!.evaluate((node:any) => node.isConnected)).toBe(true);
      expect(readingGets()).toBe(beforeCancel);
      await page.getByRole('button',{name:locale==='en'?'Save an article':'先保存一篇文章',exact:true}).click();
      await page.getByRole('textbox',{name:locale==='en'?'Article URL':'文章链接',exact:true}).fill(`${upstream.baseUrl}/saved-article`);
      await page.getByRole('button',{name:locale==='en'?'Save and extract text':'保存并提取正文',exact:true}).click();
      const firstOpen=page.getByRole('dialog').getByRole('link',{name:text.open,exact:true});
      await firstOpen.waitFor({timeout:15000});
      expect(await firstOpen.getAttribute('href')).toContain(`/spaces/${space}/library/items/`);
      await page.screenshot({path:`${shotDir}/${locale}-first-article-ready.png`,fullPage:true});
      await firstOpen.click();
      await page.getByText('This is the first article saved from Reading. The extracted text is ready to read.',{exact:true}).first().waitFor();
      await page.goto(`${base}/spaces/${secondSpace}/library/reading`);
      expect(upstream.requests.length).toBeGreaterThan(0);

      await goto('/library/reading');
      await page.getByRole('heading',{name:'Shared recommendation across days'}).waitFor();
      await context.close();
      expect(failures).toEqual([]);
    }
    expect(realRequests.some(r=>r.startsWith('PATCH '))).toBe(true);
    expect(realRequests.some(r=>r.startsWith('PUT '))).toBe(true);
    console.info('Reading browser acceptance', {screenshots:shotDir,realRouteRequests:realRequests.length});
  } finally {
    await browser.close();await new Promise<void>(r=>server.httpServer.close(()=>r()));await app.close();await upstream.close();await rm(artifacts,{recursive:true,force:true});vi.restoreAllMocks();__setAuthIdentityForTests(null);
  }
});
