import {seedArxivSourceChain,seedRelevantCorpusItem} from './support/researchSeeds.js';
import { ResearchAcquisitionService } from '../src/modules/projectResearch/pipeline/researchAcquisitionService.js';
import { ProjectOperationService } from '../src/modules/projects/projectOperationService.js';
import {readerModule} from '../src/modules/reader/index.js';
import { projectResearchModule } from '../src/modules/projectResearch/index.js';
import { roomsModule } from "../src/modules/rooms/index.js";
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve,join } from 'node:path';
import { mkdir,mkdtemp } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject,seedRun } from './support/domainSeeds.js';
import { InquiryThreadService } from '../src/modules/inquiry/threadService.js';
import { InquiryTaskAssociationService } from '../src/modules/inquiry/taskAssociations.js';
import { inquiryModule } from '../src/modules/inquiry/index.js';
import { tasksModule } from '../src/modules/tasks/index.js';
import { projectWorkModule } from '../src/modules/projectWork/index.js';
import { projectsModule } from '../src/modules/projects/index.js';
import { buildModuleServer } from './support/moduleServer.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { loadConfig } from '../src/config.js';
const db = useTestDatabase(import.meta.filename);
const webRequire = createRequire(resolve('../apps/web/package.json'));
it('navigates Project problem workspace, canonical Task backlink and old research paths on desktop and narrow screens', async () => {
    await resetTables(db.pool, ['spaces', 'users'], { cascade: true });
    const space = randomUUID(), owner = randomUUID(), project = randomUUID();
    await seedSpaceOwnerProject(db.pool, { space, owner, project, spaceType: 'household', ownerDisplayName: 'Task owner' });
    const identity = { spaceId: space, userId: owner };
    const thread = String((await new InquiryThreadService(db.pool).createThread(identity, project, { kind: 'question', statement: 'Why does the import fail?' })).id);
    await new InquiryTaskAssociationService(db.pool).link(identity, project, thread, { task: { title: 'Reproduce import failure' }, role: 'investigates', reason: 'Find a minimal reproduction', idempotency_key: 'browser' });
    const research = await new ResearchAcquisitionService(db.pool).startAcquisition(identity, project, { threadId: thread, requestKey: 'browser', intentNote: 'Reproduce import problem', originRoomId: null, originSessionId: null });
    const legacy = await new ProjectOperationService(db.pool).create(identity, project, { kind: 'research', title: 'Unbound historical research', status: 'completed', steps: [], progress: {} });
    const report=randomUUID(),reportRun=randomUUID(),archive=randomUUID();await seedRun(db.pool,{id:reportRun,space,owner,agent:randomUUID(),version:randomUUID()});
    const workflow=(await db.pool.query(`SELECT research_call_json->>'workflow_id' AS id FROM project_operations WHERE id=$1`,[research.operation_id])).rows[0].id;
    const content={schema_version:'research_report.v1',research_question:'Historical question',summary:'Historical report summary',findings:[],sources:[],limitations:[],ideas:[]};
    const document={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Historical report summary'}]}]};
    await db.pool.query(`INSERT INTO artifacts(id,space_id,project_id,artifact_type,title,export_formats_json,owner_user_id,visibility,created_at,updated_at) VALUES($1,$2,$3,'research_report.archive.v1','Historical report','[]'::jsonb,$4,'space_shared',now(),now())`,[archive,space,project,owner]);
    await db.pool.query(`INSERT INTO project_research_reports(id,space_id,project_id,workflow_id,operation_id,synthesis_run_id,run_kind,research_question,research_question_version,content_json,reader_document_json,normalized_text,content_hash,archive_artifact_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'baseline','Historical question',1,$7::jsonb,$8::jsonb,'Historical report summary',$9,$10,now(),now())`,[report,space,project,workflow,legacy.id,reportRun,JSON.stringify(content),JSON.stringify(document),'0'.repeat(64),archive]);
    const standingItem=await seedRelevantCorpusItem(db.pool,{space,project,owner});
    const standingBatch=randomUUID(),standingAdvice=randomUUID();
    await db.pool.query(`INSERT INTO project_research_standing_batches(id,space_id,project_id,status,source_item_ids_json,window_started_at,ready_at,created_at,updated_at) VALUES($1,$2,$3,'failed',$4::jsonb,now(),now(),now(),now())`,[standingBatch,space,project,JSON.stringify([standingItem.sourceItemId])]);
    await db.pool.query(`INSERT INTO project_research_standing_advice(id,space_id,project_id,source_item_id,batch_id,detail,action_id,action_input_json,idempotency_key,created_by_run_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Check monitored import evidence','source.raise_as_question',$6::jsonb,$1,$7,now(),now())`,[standingAdvice,space,project,standingItem.sourceItemId,standingBatch,JSON.stringify({kind:'question',statement:'What does monitored evidence show?'}),reportRun]);
    const secondStandingItem=await seedRelevantCorpusItem(db.pool,{space,project,owner}),dismissAdvice=randomUUID();
    await db.pool.query(`UPDATE source_items SET title='Second monitored paper' WHERE id=$1`,[secondStandingItem.sourceItemId]);
    await db.pool.query(`INSERT INTO project_research_standing_advice SELECT (jsonb_populate_record(null::project_research_standing_advice,to_jsonb(a)||jsonb_build_object('id',$2::text,'source_item_id',$3::text,'idempotency_key',$2::text,'detail','Review second monitored source'))).* FROM project_research_standing_advice a WHERE id=$1`,[standingAdvice,dismissAdvice,secondStandingItem.sourceItemId]);
    await db.pool.query(`UPDATE project_operations SET title='Bound screening progress',progress_json=progress_json||jsonb_build_object('workflow_id',$2::text,'run_kind','baseline','current_stage','screening','partial',false,'screening_progress',jsonb_build_object('phase','screening_batches','total_items',12,'classified_items',7)) WHERE id=$1`,[research.operation_id,workflow]);
    __setAuthIdentityForTests(identity);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: '/tmp/rainver-task-browser' }), [tasksModule, inquiryModule, projectWorkModule, projectsModule, roomsModule, projectResearchModule,readerModule]);
    const { preview } = await import(pathToFileURL(webRequire.resolve('vite')).href);
    const hosted = await preview({ root: resolve('../apps/web'), configFile: false, preview: { host: '127.0.0.1', port: 0 } });
    const { chromium } = webRequire('playwright-core');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
    const evidenceParent=process.env.PROBLEM_BROWSER_EVIDENCE_DIR??'/tmp';await mkdir(evidenceParent,{recursive:true});const shots=await mkdtemp(join(evidenceParent,'problem-browser-'));
    console.info('Browser evidence directory',shots);
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
        page.setDefaultTimeout(15000);
        const writes: string[] = [];
        const errors: string[] = [];
        page.on('pageerror', (e: Error) => { errors.push(e.message); console.error('Browser page error', e.message); });
        await page.addInitScript(() => localStorage.setItem('rainver:locale', 'en'));
        await page.route('**/api/v1/**', async (route: any) => {
            const r = route.request(), u = new URL(r.url()), path = u.pathname.replace('/api/v1', '');
            if (r.method() !== 'GET'&&!path.startsWith('/reader/'))
                writes.push(path);
            if (path.startsWith('/reader/')||path.startsWith('/rooms/') || path.startsWith('/tasks/') || path.startsWith(`/projects/${project}`)) {
                console.info('Task browser request', r.method(), path);
                const response = await app.inject({ method: r.method(), url: u.pathname + u.search, headers: { 'x-rainver-space-id': space, 'content-type': 'application/json' }, payload: r.postData() ?? undefined });
                return route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
            }
            console.info('P5 shell fixture', path);
            let data: unknown;
            if (path === '/focus-areas')
                data = [];
            else if (path === '/me/agent-attention/snapshot')
                data = { type: 'attention.snapshot', seq: 1, version: 'fixture', page: null, unread_count: 0, notices: [] };
            else if (path === '/me')
                data = { id: owner, name: 'Task owner', email: 'owner@test.invalid', default_space_id: space, instance_role: 'member' };
            else if (path === '/me/spaces')
                data = [{ id: space, name: 'Task acceptance', type: 'household', role: 'owner' }];
            else if (/^\/spaces\/[^/]+\/members$/.test(path))
                data = [{ user_id: owner, display_name: 'Task owner', role: 'owner' }];
            else if (path === '/plugins/effective')
                data = { plugins: {} };
            else if (path === '/agents' || path.startsWith('/model-providers') || path.startsWith('/provider-vendors') || path.startsWith('/providers'))
                data = [];
            else if (path === '/projects')
                data = { items: [{ id: project, name: 'Research', status: 'active', space_id: space }], total: 1, limit: 50, offset: 0 };
            else if (path.endsWith('/interest-profile'))
                data = null;
            else
                data = { items: [], total: 0, offset: 0, limit: 50 };
            return route.fulfill({ json: data });
        });
        const base = `http://127.0.0.1:${hosted.httpServer.address().port}`;

        const root = `${base}/spaces/${space}/projects/${project}`;
        await page.goto(root);
        await page.getByRole('link', { name: 'Problems', exact: true }).click();
        await page.getByRole('button', { name: 'Why does the import fail?', exact: true }).click();
        await page.getByRole('heading', { name: 'Why does the import fail?', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Plan', exact: true }).click();
        await page.waitForURL((u:URL)=>u.searchParams.get('stage')==='plan');
        await page.getByLabel('Work and reason').waitFor();
        expect(writes).toEqual([]);
        await page.getByRole('button',{name:'Plan',exact:true,pressed:true}).waitFor();
        expect(await page.getByRole('button',{name:'Plan',exact:true}).getAttribute('aria-pressed')).toBe('true');
        expect(await page.getByRole('button',{name:'Frame',exact:true}).getAttribute('aria-pressed')).toBe('false');
        await page.screenshot({ path: `${shots}/problem-desktop.png`, fullPage: true,animations:'disabled' });
        await page.getByLabel('Work and reason').fill('Compare import strategies');
        const [recorded]=await Promise.all([page.waitForResponse((r:any)=>r.request().method()==='POST'&&r.url().endsWith('/problem/work')),page.getByRole('button',{name:'Record selected work',exact:true}).click()]);
        expect(recorded.status()).toBe(201);
        await page.locator('p').filter({hasText:/^Compare import strategies$/}).first().waitFor();
        expect((await db.pool.query(`SELECT count(*)::int AS n FROM inquiry_thread_steps WHERE thread_id=$1 AND note='Compare import strategies'`,[thread])).rows[0].n).toBe(1);
        await page.getByRole('button', { name: 'Linked tasks', exact: true }).click();
        await page.getByLabel('New Task title').fill('Verify desktop evidence');
        await page.getByRole('button',{name:'Create and link Task',exact:true}).click();
        await page.getByRole('link',{name:'Verify desktop evidence',exact:true}).waitFor();
        expect((await db.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE space_id=$1 AND title='Verify desktop evidence'`,[space])).rows[0].n).toBe(1);
        let explicitWrites=writes.length;
        await page.getByRole('link', { name: 'Reproduce import failure', exact: true }).click();
        await page.getByRole('tab', { name: 'Work', exact: true }).click();
        await page.getByRole('link', { name: 'Open question', exact: true }).waitFor();
        await page.screenshot({ path: `${shots}/task-parent.png`, fullPage: true,animations:'disabled' });
        await page.getByRole('link', { name: 'Open question', exact: true }).click();
        await page.getByRole('heading', { name: 'Why does the import fail?', exact: true }).waitFor();
        await page.goBack();
        expect(new URL(page.url()).pathname).toContain('/tasks/');
        await page.goto(`${root}/research?research=new&thread=${thread}&keep=fixture`);
        await page.getByRole('heading', { name: 'Research calls', exact: true }).waitFor();
        expect(new URL(page.url()).searchParams.get('keep')).toBe('fixture');
        expect(new URL(page.url()).pathname.endsWith('/inquiry')).toBe(true);
        await page.getByText('Bound screening progress',{exact:true}).waitFor();
        await page.getByText(/7\/12 materials classified/).waitFor();
        await page.getByLabel('New item limit',{exact:true}).waitFor();
        await page.getByLabel('New item limit',{exact:true}).fill('60');
        await page.getByRole('button',{name:'Update limit',exact:true}).waitFor({state:'visible'});
        await page.getByText('Bound screening progress',{exact:true}).click();
        await page.getByText('Bound screening progress',{exact:true}).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${shots}/problem-research.png`, fullPage: true,animations:'disabled' });
        await page.getByText('Bound screening progress',{exact:true}).locator('xpath=ancestor::div[contains(@class,"space-y-3")][1]').screenshot({path:`${shots}/research-controls.png`,animations:'disabled'});
        await page.getByRole('link',{name:'Monitoring overview',exact:true}).click();
        await page.getByRole('heading',{name:'Standing research',exact:true}).waitFor();
        await page.getByText('Daily comparison budget',{exact:true}).waitFor();
        await page.getByText('Check monitored import evidence',{exact:true}).waitFor();
        await page.screenshot({path:`${shots}/standing-desktop.png`,fullPage:true,animations:'disabled'});
        await page.getByText('Check monitored import evidence',{exact:true}).locator('..').getByRole('button',{name:'Create question',exact:true}).click();
        await page.getByText('Check monitored import evidence',{exact:true}).waitFor({state:'hidden'});
        expect((await db.pool.query(`SELECT status FROM project_research_standing_advice WHERE id=$1`,[standingAdvice])).rows[0].status).toBe('actioned');
        const [retryResponse]=await Promise.all([page.waitForResponse((r:any)=>r.request().method()==='POST'&&r.url().includes(standingBatch)),page.getByRole('button',{name:'Retry comparison',exact:true}).click()]);
        expect(retryResponse.status()).toBe(200);
        await page.getByRole('button',{name:'Retry comparison',exact:true}).waitFor({state:'hidden'});
        expect((await db.pool.query(`SELECT status FROM project_research_standing_batches WHERE id=$1`,[standingBatch])).rows[0].status).toBe('pending');
        await page.goto(`${root}/research?research=new&thread=${thread}`);
        await page.getByRole('heading',{name:'Research calls',exact:true}).waitFor();
        const connection=randomUUID(),channel=randomUUID();await seedArxivSourceChain(db.pool,{space,owner,connection,connector:randomUUID(),channel,now:new Date().toISOString()});
        const material=await seedRelevantCorpusItem(db.pool,{space,project,owner});await db.pool.query(`UPDATE source_items SET connection_id=$2 WHERE id=$1`,[material.sourceItemId,connection]);
        await db.pool.query(`UPDATE project_operations SET title='WITHDRAWN_SECRET',progress_json=progress_json||jsonb_build_object('channel_ids',jsonb_build_array($2::text),'source_item_ids',jsonb_build_array($3::text),'summary','WITHDRAWN_SECRET') WHERE id=$1`,[research.operation_id,channel,material.sourceItemId]);
        await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=$1`,[connection]);
        await page.getByText('Research invocation',{exact:true}).waitFor();
        expect(await page.getByText('WITHDRAWN_SECRET',{exact:false}).count()).toBe(0);
        await page.getByText('Research invocation',{exact:true}).click();
        await page.getByRole('button',{name:'Stop',exact:true}).click();
        await page.getByText('cancelled',{exact:true}).waitFor();
        expect((await db.pool.query(`SELECT status FROM project_operations WHERE id=$1`,[research.operation_id])).rows[0].status).toBe('cancelled');
        await page.getByText('Research invocation',{exact:true}).scrollIntoViewIfNeeded();
        await page.screenshot({path:`${shots}/withdrawn-stopped.png`,fullPage:true,animations:'disabled'});
        explicitWrites=writes.length;

        await page.goto(`${root}/operations?open=${legacy.id}&keep=fixture`);
        await page.getByText('Unbound historical research', { exact: true }).waitFor();
        expect(new URL(page.url()).searchParams.get('open')).toBe(legacy.id);
        expect(new URL(page.url()).pathname.endsWith('/inquiry/records')).toBe(true);
        await page.screenshot({ path: `${shots}/unbound-history.png`, fullPage: true,animations:'disabled' });
        await page.goto(`${root}/research?tab=runs&open=${research.operation_id}&thread=${thread}`);
        await page.getByText('Unbound historical research', { exact: true }).waitFor();
        expect(new URL(page.url()).searchParams.get('open')).toBe(research.operation_id);
        await page.goto(`${root}/research/reports/${report}?thread=${thread}&keep=fixture`);
        await page.getByText('Historical report summary',{exact:true}).first().waitFor();
        await page.screenshot({path:`${shots}/historical-report.png`,fullPage:true,animations:'disabled'});
        await page.getByRole('link',{name:'Reports',exact:true}).click();
        expect(new URL(page.url()).searchParams.get('thread')).toBe(thread);
        await page.goto(`${root}/research/reports/missing-report?thread=${thread}&keep=fixture`);
        await page.getByRole('link', { name: 'Reports', exact: true }).waitFor();
        await page.getByRole('link', { name: 'Reports', exact: true }).click();
        expect(new URL(page.url()).searchParams.get('keep')).toBe('fixture');
        expect(new URL(page.url()).searchParams.get('thread')).toBe(thread);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button',{name:'Close Project chat',exact:true}).click();
        await page.goto(`${root}/inquiry?thread=${thread}`);
        await page.getByRole('heading', { name: 'Why does the import fail?', exact: true }).waitFor();
        expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
        await page.screenshot({ path: `${shots}/problem-narrow.png`, fullPage: true,animations:'disabled' });
        await page.getByRole('button', { name: 'Linked tasks', exact: true }).click();
        await page.getByRole('link', { name: 'Reproduce import failure', exact: true }).click();
        await page.getByRole('tab', { name: 'Work', exact: true }).click();
        await page.getByRole('link', { name: 'Open question', exact: true }).click();
        await page.getByRole('heading', { name: 'Why does the import fail?', exact: true }).waitFor();
        await page.screenshot({ path: `${shots}/task-return-narrow.png`, fullPage: true,animations:'disabled' });
        await page.goto(`${root}/research?tab=standing`);
        await page.getByRole('heading',{name:'Standing research',exact:true}).waitFor();
        expect(new URL(page.url()).searchParams.get('section')).toBe('standing');
        expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
        await page.screenshot({path:`${shots}/standing-narrow.png`,fullPage:true,animations:'disabled'});
        expect(writes.length).toBe(explicitWrites);
        await page.getByRole('button',{name:'Dismiss advice from Second monitored paper',exact:true}).click();
        await page.getByText('Review second monitored source',{exact:true}).waitFor({state:'hidden'});
        expect((await db.pool.query(`SELECT status FROM project_research_standing_advice WHERE id=$1`,[dismissAdvice])).rows[0].status).toBe('dismissed');

        const beforeAuxWrites=writes.length;
        await page.setViewportSize({width:1280,height:900});
        await page.goto(`${root}/inquiry?view=map`);
        await page.getByRole('tab',{name:'Structure',exact:true}).waitFor();
        await page.getByRole('button',{name:/Why does the import fail/}).waitFor();
        await page.screenshot({path:`${shots}/aux-map-desktop.png`,fullPage:true,animations:'disabled'});
        await page.getByRole('button',{name:/Why does the import fail/}).click();
        await page.getByRole('heading',{name:'Why does the import fail?',exact:true}).waitFor();
        await page.screenshot({path:`${shots}/aux-target-desktop.png`,fullPage:true,animations:'disabled'});
        await page.setViewportSize({width:390,height:844});
        await page.goto(`${root}/inquiry?view=map`);
        await page.getByRole('button',{name:/Why does the import fail/}).waitFor();
        await page.screenshot({path:`${shots}/aux-map-narrow.png`,fullPage:true,animations:'disabled'});
        await page.getByRole('button',{name:/Why does the import fail/}).click();
        await page.getByRole('heading',{name:'Why does the import fail?',exact:true}).waitFor();
        await page.screenshot({path:`${shots}/aux-target-narrow.png`,fullPage:true,animations:'disabled'});
        await page.goto(`${root}/inquiry?view=review`);
        await page.getByRole('tab',{name:'Knowledge candidates',exact:true}).waitFor();
        await page.screenshot({path:`${shots}/aux-review-narrow.png`,fullPage:true,animations:'disabled'});
        expect(writes.length).toBe(beforeAuxWrites);
        expect(errors).toEqual([]);
    }
    catch (error) {
        const pages = browser.contexts().flatMap((c: any) => c.pages());
        for (const p of pages) {
            console.error('P5 browser failure', p.url(), await p.locator('body').innerText());
            await p.screenshot({ path: `${shots}/failure.png`, fullPage: true,animations:'disabled' });
        }
        throw error;
    }
    finally {
        await browser.close();
        await new Promise<void>(r => hosted.httpServer.close(() => r()));
        await app.close();
        __setAuthIdentityForTests(null);
    }
});
