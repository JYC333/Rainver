import { agentsModule } from '../src/modules/agents/index.js';
import { projectFoldersModule } from '../src/modules/projectFolders/index.js';
import { projectWorkModule } from '../src/modules/projectWork/index.js';
import { agentAttentionModule } from '../src/modules/agentAttention/index.js';
import { focusAreasModule } from '../src/modules/focusAreas/index.js';
import { roomsModule } from '../src/modules/rooms/index.js';
import { knowledgeModule } from '../src/modules/knowledge/index.js';
import { it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { RainverPlugin } from '@rainver/protocol';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject, seedMainlineRoomsForAllProjects } from './support/domainSeeds.js';
import { buildModuleServer } from './support/moduleServer.js';
import { loadConfig } from '../src/config.js';
import { projectsModule } from '../src/modules/projects/index.js';
import { pluginsModule } from '../src/modules/plugins/index.js';
import { systemActionsModule } from '../src/modules/systemActions/index.js';
import { proposalsModule, __setProposalIdentityForTests } from '../src/modules/proposals/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { PluginHost } from '../src/modules/plugins/host/index.js';
import { BUILT_IN_PLUGINS } from '../src/modules/plugins/builtInPlugins.js';
import { migrateOperationPlugin } from '../src/modules/plugins/operationMigrations.js';
import { markdownToPm } from '../src/modules/knowledge/noteDocument.js';
import { __setProviderHttpClientForTests } from '../src/modules/providers/invocation/invocation.js';
import { performQueuedProviderTaskJob, seedTestModelProvider } from './support/providerTaskFixture.js';
import { openAiChatResponse } from './support/piAiHttp.js';

/**
 * Visual and behavioural acceptance of a material's Notes and drafts in the
 * Applications Area (P3 stage 3): the entry on a material row beside its status
 * and link actions, pinned sources with a stale-version prompt, starting a private
 * draft from this application's requirements, its preview with sources and checks,
 * saving it as a private Note, recording the review and opening the Note in the
 * shared Notes editor. Real server, PostgreSQL and normal web bundle in Chromium;
 * the queued draft Run is performed by the real provider_task worker with only the
 * provider's HTTP reply faked. Screenshots go to APPLICATIONS_VISUAL_OUT.
 */
const db = useTestDatabase(import.meta.filename);
afterEach(() => {
  __setProviderHttpClientForTests(null);
  __setAuthIdentityForTests(null);
  __setProposalIdentityForTests(null);
});

it('drafts a material from pinned sources, previews it and saves it to Notes from the Area', async () => {
  const plugin = BUILT_IN_PLUGINS.find(p => p.id === 'applications') as RainverPlugin;
  expect(plugin?.operationManifest).toBeTruthy();
  const space = randomUUID(), user = randomUUID(), project = randomUUID();
  // A Personal Space first: there the ordinary creation rule keeps a new private Note in this Space.
  await seedSpaceOwnerProject(db.pool, { space, owner: user, project, projectName: 'PhD applications 2027', spaceType: 'personal' });
  await seedMainlineRoomsForAllProjects(db.pool);
  const port = await new Promise<number>(resolve => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const address = s.address() as { port: number }; s.close(() => resolve(address.port)); });
  });
  const config = loadConfig({ ...process.env, SERVER_DEBUG: 'false', SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: await mkdtemp(join(tmpdir(), 'rainver-materials-')), FRONTEND_URL: `http://127.0.0.1:${port}` });
  await seedTestModelProvider(db.pool, { space, owner: user, config });
  const app = buildModuleServer(config, [projectsModule, pluginsModule, systemActionsModule, proposalsModule, roomsModule, agentsModule, projectFoldersModule, projectWorkModule, agentAttentionModule, focusAreasModule, knowledgeModule]);
  new PluginHost([plugin]).activate(app, config);
  __setAuthIdentityForTests(request => ({ spaceId: String(request.headers['x-rainver-space-id'] ?? request.headers['x-space-id'] ?? space), userId: user }));
  __setProposalIdentityForTests(() => ({ spaceId: space, userId: user }));
  __setProviderHttpClientForTests({ fetch: async () => openAiChatResponse({ choices: [{ message: { content: JSON.stringify({
    schema: 'rainver.note_draft.v1',
    draft: '# Statement of purpose\n\nI build verified systems software. At ETH I would join the Systems Group to work on verified compilers.\n\n- MSc thesis on proof-carrying code',
    verify: ['Confirm the MSc graduation year', 'The Systems Group lead is named only from the call text'],
    sources_used: [],
  }) } }], model: 'test-model', usage: {} }) });
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${api}/api/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-space-id': space, 'idempotency-key': randomUUID() }, body: JSON.stringify(body) });
    expect(r.status, await r.clone().text()).toBeLessThan(300);
    return (await r.json()) as { data: Record<string, any> };
  };
  await migrateOperationPlugin(db.pool, plugin);
  await post(`plugins/${plugin.id}/enable`, {});
  await post('actions/official_plugin.project_binding.bind', { plugin_id: plugin.id, project_id: project });
  const created = await post('actions/plugin.applications.application.create', { project_id: project, institution: 'ETH Zurich', program: 'PhD in Computer Science' });
  const applicationId = created.data.application_id as string;
  const statement = (await db.pool.query(`SELECT id FROM plugin_applications.application_materials WHERE application_id=$1 AND kind='statement'`, [applicationId])).rows[0].id as string;
  // A reusable master CV in the person's own Notes, pinned to this material and edited afterwards.
  const masterText = 'Alice Example. MSc ETH 2024, thesis on proof-carrying code.';
  const master = await post('actions/knowledge.note.create', { title: 'Master CV', primary_project_id: project, content_json: markdownToPm(masterText), plain_text: masterText, content_format: 'prosemirror_json' });
  await post('actions/plugin.applications.material.add_source', { project_id: project, material_id: statement, note_id: master.data.id });
  const edited = 'Alice Example. MSc ETH 2024, thesis on proof-carrying code. Now at a startup.';
  await post('actions/knowledge.note.update', { note_id: master.data.id, changes: { content_json: markdownToPm(edited), plain_text: edited, expect_version: 1 } });

  const web = join(import.meta.dirname, '../../apps/web'), shots = process.env.APPLICATIONS_VISUAL_OUT ?? '/tmp/rainver-applications-visual';
  await mkdir(shots, { recursive: true });
  const vite = spawn(process.execPath, [join(web, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: web, env: { PATH: process.env.PATH, API_URL: api }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let viteLog = '';
  vite.stdout.on('data', d => { viteLog += d; });
  vite.stderr.on('data', d => { viteLog += d; });
  const base = `http://127.0.0.1:${port}`;
  const { chromium } = await import(pathToFileURL(join(web, 'node_modules/playwright-core/index.mjs')).href);
  let browser: any;
  try {
    await expect.poll(async () => { try { return (await fetch(base)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // Full verification runs this browser beside the database suites.
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => { pageErrors.push(e.message); });
    page.on('response', async (r: any) => { if (r.url().includes('/actions/plugin.applications') && r.status() >= 400) console.error('Operation response', r.status(), await r.text()); });
    await page.route('**/api/v1/me', (route: any) => route.fulfill({ json: { id: user, email: 'fixture@test.invalid', display_name: 'Fixture person', default_space_id: space, created_at: new Date().toISOString(), avatar_url: null, last_login_at: null } }));
    let spaceType = 'personal';
    await page.route('**/api/v1/me/spaces', (route: any) => route.fulfill({ json: [{ id: space, name: 'Test Space', type: spaceType, role: 'owner', status: 'active' }] }));
    await page.addInitScript(() => {
      if (!localStorage.getItem('rainver:locale')) localStorage.setItem('rainver:locale', 'en');
      if (!localStorage.getItem('rainver:theme')) localStorage.setItem('rainver:theme', 'dark');
    });
    const prefs = async (locale: string, theme: string) => page.evaluate(([l, t]: string[]) => { localStorage.setItem('rainver:locale', l!); localStorage.setItem('rainver:theme', t!); }, [locale, theme]);
    const area = `${base}/spaces/${space}/projects/${project}/plugins/applications/board`;
    const shoot = (name: string) => page.screenshot({ path: join(shots, `materials-${name}.png`), fullPage: true });
    const noOverflow = async () => expect(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).window.innerWidth)).toBe(true);
    const openPanel = async (entry: string) => {
      await page.goto(area);
      await page.getByRole('link', { name: 'PhD in Computer Science', exact: true }).click();
      const button = page.getByRole('button', { name: entry, exact: true });
      await button.scrollIntoViewIfNeeded();
      return button;
    };

    // Desktop, dark, English: the entry on the material row, beside its status and link actions.
    const entry = await openPanel('Notes and drafts for Statement of purpose');
    await shoot('desktop-entry-dark-en');
    await entry.click();
    const drafts = page.getByRole('region', { name: 'Draft with AI', exact: true });
    const sources = page.getByRole('region', { name: 'Source Notes', exact: true });
    // The pinned source shows its version and offers the newer one.
    await sources.getByText('Newer: version 2', { exact: true }).waitFor();
    await sources.getByRole('button', { name: 'Use version 2', exact: true }).waitFor();
    await drafts.getByLabel('Requirements for this application', { exact: false }).fill('ETH asks for a two-page statement on research fit with the Systems Group.');
    await drafts.getByLabel('Length (words)', { exact: true }).fill('800');
    await drafts.getByLabel('Emphasis (optional)', { exact: true }).fill('Verified compilers');
    await shoot('desktop-request-dark-en');
    await noOverflow();
    await drafts.getByRole('button', { name: 'Generate draft', exact: true }).click();
    await drafts.getByText('Writing the draft… this can take a minute.', { exact: true }).waitFor();
    await shoot('desktop-running-dark-en');
    // The worker performs the queued private Run; the open preview follows it without a reload.
    const generation = (await db.pool.query(`SELECT id,run_id FROM plugin_applications.application_material_generations WHERE material_id=$1`, [statement])).rows[0];
    expect((await db.pool.query(`SELECT visibility,status FROM runs WHERE id=$1`, [generation.run_id])).rows[0]).toEqual({ visibility: 'private', status: 'queued' });
    await performQueuedProviderTaskJob(db.pool, config, generation.run_id);
    const preview = page.getByRole('region', { name: 'Draft with AI', exact: true });
    await preview.getByText('Check before using', { exact: true }).waitFor({ timeout: 20000 });
    await preview.getByText('Confirm the MSc graduation year', { exact: true }).waitFor();
    await preview.getByText('Not used', { exact: true }).waitFor();
    await preview.getByText('Check before using', { exact: true }).scrollIntoViewIfNeeded();
    await shoot('desktop-preview-dark-en');
    await noOverflow();
    await preview.getByRole('button', { name: 'Save as a new private Note', exact: true }).click();
    await preview.getByText('Saved to Notes as version 1.', { exact: true }).waitFor();
    const saved = (await db.pool.query(`SELECT applied_note_id FROM plugin_applications.application_material_generations WHERE id=$1`, [generation.id])).rows[0].applied_note_id as string;
    expect((await db.pool.query(`SELECT visibility,owner_user_id,primary_project_id,title FROM space_objects WHERE id=$1`, [saved])).rows[0])
      .toEqual({ visibility: 'private', owner_user_id: user, primary_project_id: null, title: 'Statement of purpose — ETH Zurich' });
    // The material now shows its Note, not yet reviewed; the person records the review.
    const text = page.getByRole('region', { name: 'Text in Notes', exact: true });
    await text.getByText('Not reviewed yet', { exact: true }).waitFor();
    await text.getByRole('button', { name: 'Mark version 1 reviewed', exact: true }).click();
    await text.getByText('Reviewed', { exact: true }).waitFor();
    await text.scrollIntoViewIfNeeded();
    await shoot('desktop-saved-dark-en');
    expect((await db.pool.query(`SELECT note_id,note_version FROM plugin_applications.application_material_reviews WHERE material_id=$1`, [statement])).rows).toEqual([{ note_id: saved, note_version: 1 }]);
    // Opening it lands in the shared Notes editor with the saved text.
    await text.getByRole('link', { name: 'Open in Notes', exact: true }).click();
    await page.waitForURL(`${base}/spaces/${space}/knowledge/notes/${saved}`);
    // The shared editor itself (not the Area's preview) shows the saved text.
    await page.locator('.ProseMirror').getByText('At ETH I would join the Systems Group', { exact: false }).waitFor({ timeout: 30000 });
    expect(await page.getByRole('region', { name: 'Draft with AI', exact: true }).count()).toBe(0);
    await shoot('desktop-note-destination-dark-en');

    // Light theme, Chinese, desktop: the same panel and the kept preview.
    await prefs('zh-CN', 'light');
    const zh = await openPanel('个人陈述的笔记与草稿');
    await shoot('desktop-entry-light-zh');
    await zh.click();
    // The newest draft's preview opens with the panel.
    await page.getByRole('button', { name: '收起预览', exact: true }).first().waitFor();
    await page.getByText('使用前请核实', { exact: true }).waitFor();
    await page.getByText('已保存到笔记，第 1 版。', { exact: true }).waitFor();
    await page.getByText('使用前请核实', { exact: true }).scrollIntoViewIfNeeded();
    await shoot('desktop-preview-light-zh');
    await noOverflow();

    // The same Space as a shared team Space: a new draft can no longer become a new Note here
    // (it would have to move to the Personal Space), and the panel says so instead of offering it.
    await db.pool.query(`UPDATE spaces SET type='team' WHERE id=$1`, [space]);
    spaceType = 'team';
    const second = await post('actions/plugin.applications.material.generate', { project_id: project, material_id: statement, requirements: 'Second draft', include_linked: false });
    await performQueuedProviderTaskJob(db.pool, config, second.data.run_id);
    await prefs('en', 'dark');
    await (await openPanel('Notes and drafts for Statement of purpose')).click();
    const team = page.getByRole('region', { name: 'Draft with AI', exact: true });
    await team.getByText('In a shared Space a draft is saved only as the next version of a linked Note', { exact: false }).waitFor();
    expect(await team.getByRole('button', { name: 'Save as a new private Note', exact: true }).count()).toBe(0);
    await team.getByText('Check before using', { exact: true }).scrollIntoViewIfNeeded();
    await shoot('desktop-team-preview-dark-en');
    await noOverflow();

    // Phone width in both themes and languages: the panel wraps whole controls without overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [locale, theme, entryName] of [['zh-CN', 'dark', '个人陈述的笔记与草稿'], ['en', 'light', 'Notes and drafts for Statement of purpose']] as const) {
      await prefs(locale, theme);
      const phone = await openPanel(entryName);
      await shoot(`phone-entry-${theme}-${locale}`);
      await noOverflow();
      await phone.click();
      await page.getByText(locale === 'en' ? 'Check before using' : '使用前请核实', { exact: true }).waitFor();
      await page.getByRole('region', { name: locale === 'en' ? 'Draft with AI' : 'AI 起草', exact: true }).scrollIntoViewIfNeeded();
      await shoot(`phone-preview-${theme}-${locale}`);
      await noOverflow();
      const box = await page.getByRole('button', { name: locale === 'en' ? 'Generate draft' : '生成草稿', exact: true }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect(pageErrors).toEqual([]);
  } catch (error) {
    console.error(viteLog.slice(-4000));
    throw error;
  } finally {
    await browser?.close();
    vite.kill();
    await app.close();
  }
}, 300000);
