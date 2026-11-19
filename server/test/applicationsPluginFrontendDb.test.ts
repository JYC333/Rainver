import { agentsModule } from '../src/modules/agents/index.js';
import { projectFoldersModule } from '../src/modules/projectFolders/index.js';
import { projectWorkModule } from '../src/modules/projectWork/index.js';
import { agentAttentionModule } from '../src/modules/agentAttention/index.js';
import { focusAreasModule } from '../src/modules/focusAreas/index.js';
import { roomsModule } from '../src/modules/rooms/index.js';
import { it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
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
import { insertInitialNoteRevision } from '../src/modules/knowledge/noteRevisionService.js';
import { markdownToPm } from '../src/modules/knowledge/noteDocument.js';

/**
 * Visual and behavioural acceptance of the bundled application management
 * package in its parent Project surface: the Project overview card beside the
 * Project goal, the Project-navigation entry, and the Area destination, against
 * the real server, PostgreSQL and the normal (non-fixture) web bundle in
 * Chromium. Screenshots go to APPLICATIONS_VISUAL_OUT (default /tmp).
 */
const db = useTestDatabase(import.meta.filename);
afterEach(() => {
  __setAuthIdentityForTests(null);
  __setProposalIdentityForTests(null);
});
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

it('renders the Applications overview card, navigation entry and Area, and writes through the Operation Core from the UI', async () => {
  const plugin = BUILT_IN_PLUGINS.find(p => p.id === 'applications') as RainverPlugin;
  expect(plugin?.operationManifest).toBeTruthy();
  const space = randomUUID(), user = randomUUID(), project = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner: user, project, projectName: 'PhD applications 2027', spaceType: 'team' });
  await db.pool.query(`UPDATE projects SET goal=$2 WHERE id=$1`, [project, 'Apply to four PhD programs in systems for Fall 2027']).catch(() => {});
  await seedMainlineRoomsForAllProjects(db.pool);
  const port = await new Promise<number>(resolve => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const address = s.address() as { port: number }; s.close(() => resolve(address.port)); });
  });
  const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, FRONTEND_URL: `http://127.0.0.1:${port}` });
  const app = buildModuleServer(config, [projectsModule, pluginsModule, systemActionsModule, proposalsModule, roomsModule, agentsModule, projectFoldersModule, projectWorkModule, agentAttentionModule, focusAreasModule]);
  new PluginHost([plugin]).activate(app, config);
  __setAuthIdentityForTests(request => ({ spaceId: String(request.headers['x-rainver-space-id'] ?? request.headers['x-space-id'] ?? space), userId: user }));
  __setProposalIdentityForTests(() => ({ spaceId: space, userId: user }));
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${api}/api/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-space-id': space, 'idempotency-key': randomUUID() }, body: JSON.stringify(body) });
    expect(r.status, await r.clone().text()).toBeLessThan(300);
    return (await r.json()) as { data: Record<string, any>; proposal_id?: string };
  };
  await migrateOperationPlugin(db.pool, plugin);
  await post(`plugins/${plugin.id}/enable`, {});
  await post('actions/official_plugin.project_binding.bind', { plugin_id: plugin.id, project_id: project });
  // One application recorded beforehand, as an Agent or another tab would have, so the overview has content.
  const seeded = await post('actions/plugin.applications.application.create', {
    project_id: project, institution: 'ETH Zurich', program: 'PhD in Computer Science', department: 'Systems Group', intake: 'Fall 2027',
    source: { label: 'Department call', url: 'https://example.edu/phd' }, deadlines: [{ kind: 'application', due_on: day(21) }, { kind: 'funding', due_on: day(45) }],
  });
  const contact = await post('actions/plugin.applications.contact.create', { project_id: project, application_ids: [seeded.data.application_id], name: 'Prof. Ada Example', role: 'supervisor', email: 'ada@example.edu', affiliation: 'Systems Group' });
  await post('actions/plugin.applications.contact.log_event', { project_id: project, contact_id: contact.data.contact_id, occurred_on: day(-2), channel: 'email', direction: 'outbound', summary: 'Sent CV and a short research statement', response: 'awaiting', next_step: 'Follow up in two weeks' });

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
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(30000);
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => { pageErrors.push(e.message); });
    page.on('response', async (r: any) => { if (r.url().includes('/actions/plugin.applications') && r.status() >= 400) console.error('Operation response', r.status(), await r.text()); });
    await page.route('**/api/v1/me', (route: any) => route.fulfill({ json: { id: user, email: 'fixture@test.invalid', display_name: 'Fixture person', default_space_id: space, created_at: new Date().toISOString(), avatar_url: null, last_login_at: null } }));
    await page.route('**/api/v1/me/spaces', (route: any) => route.fulfill({ json: [{ id: space, name: 'Test Space', type: 'team', role: 'owner', status: 'active' }] }));
    const prefs = async (locale: string, theme: string) => page.evaluate(([l, t]: string[]) => { localStorage.setItem('rainver:locale', l!); localStorage.setItem('rainver:theme', t!); }, [locale, theme]);
    await page.addInitScript(() => {
      if (!localStorage.getItem('rainver:locale')) localStorage.setItem('rainver:locale', 'en');
      if (!localStorage.getItem('rainver:theme')) localStorage.setItem('rainver:theme', 'dark');
    });
    const pulse = `${base}/spaces/${space}/projects/${project}`;
    const area = `${pulse}/plugins/applications/board`;
    const shoot = (name: string) => page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
    const noOverflow = async () => expect(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).window.innerWidth)).toBe(true);
    const nav = (name: string) => page.getByRole('navigation', { name }).getByRole('link', { name: name === 'Project navigation' ? 'Applications' : '申请', exact: true });

    // Desktop, dark, English: the overview card in its parent Project surface, then the entry and destination.
    await page.goto(pulse);
    await page.getByText('Upcoming deadlines', { exact: true }).waitFor({ timeout: 30000 });
    await page.getByText('ETH Zurich · Application', { exact: false }).first().waitFor();
    await nav('Project navigation').waitFor();
    await shoot('desktop-parent-dark-en');
    // The overview card links straight to its Area.
    expect(await page.getByRole('link', { name: 'Open applications', exact: true }).getAttribute('href')).toBe(new URL(area).pathname);
    await nav('Project navigation').click();
    await page.waitForURL(area);
    await page.getByRole('button', { name: 'New application', exact: true }).waitFor();
    // Four tabs in the one entry; institution applications are the default, grouped by institution.
    expect(await page.getByRole('tab').allTextContents()).toEqual(['Programs', 'Scholarships & funding', 'My materials', 'Supervisors & contacts']);
    expect(await page.getByRole('tab', { name: 'Programs', exact: true }).getAttribute('aria-selected')).toBe('true');
    const group = (name: string) => page.getByRole('region', { name, exact: true });
    await group('ETH Zurich').getByRole('heading', { name: 'PhD in Computer Science', exact: true }).waitFor();
    await shoot('desktop-area-dark-en');
    await noOverflow();

    // Create from the UI: the same declared operation an Agent calls.
    await page.getByRole('button', { name: 'New application', exact: true }).click();
    await page.getByLabel('University or institution', { exact: true }).fill('Imperial College London');
    await page.getByLabel('Program', { exact: true }).fill('PhD in Computing');
    await page.getByLabel('Due date', { exact: true }).fill(day(14));
    await page.getByLabel('Also add to the Project Board as a Task', { exact: true }).check();
    await shoot('desktop-new-dark-en');
    await page.getByRole('button', { name: 'Create application', exact: true }).click();
    await group('Imperial College London').getByRole('heading', { name: 'PhD in Computing', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Materials', exact: false }).first().waitFor();
    const created = (await db.pool.query(`SELECT id,status,track FROM plugin_applications.applications WHERE space_id=$1 AND institution='Imperial College London'`, [space])).rows;
    expect(created).toEqual([expect.objectContaining({ status: 'planning', track: 'phd' })]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE space_id=$1 AND project_id=$2 AND title LIKE 'Application deadline — Imperial%'`, [space, project])).rows[0].n).toBe(1);
    await shoot('desktop-detail-dark-en');
    // A consequential decision is a proposal with a review link, not a direct write.
    await page.getByRole('button', { name: 'Propose decision', exact: true }).click();
    await page.getByRole('link', { name: 'Review proposal', exact: true }).waitFor();
    expect((await db.pool.query(`SELECT status FROM plugin_applications.applications WHERE id=$1`, [created[0].id])).rows[0].status).toBe('planning');
    // Mark a checklist item through the shared Select.
    // Room below the trigger for the shared Select's menu, then choose with the pointer.
    const cvStatus = page.getByRole('button', { name: 'Status of CV', exact: true }).first();
    // The detail and the list reload after proposing and may shift it: scroll until it stays near the top.
    await expect.poll(async () => {
      await cvStatus.evaluate((el: any) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(250);
      return (await cvStatus.boundingBox())!.y;
    }).toBeLessThan(200);
    await cvStatus.click();
    await page.getByRole('option', { name: 'Ready', exact: true }).click();
    await expect.poll(async () => (await db.pool.query(`SELECT status FROM plugin_applications.application_materials WHERE application_id=$1 AND kind='cv'`, [created[0].id])).rows[0]?.status).toBe('ready');
    await shoot('desktop-proposed-dark-en');
    await noOverflow();
    // The seeded application's detail shows its related contacts, kept in the contacts tab.
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();
    await group('ETH Zurich').getByRole('button', { name: 'Open', exact: true }).click();
    const related = page.getByRole('region', { name: 'Contacts', exact: true });
    await related.getByText('Prof. Ada Example', { exact: true }).waitFor();
    await related.scrollIntoViewIfNeeded();
    await shoot('desktop-contacts-dark-en');
    const seededId = seeded.data.application_id as string;
    // Edit a deadline in place: kind, label and date through deadline.update.
    await page.getByRole('button', { name: 'Edit deadline Application', exact: true }).click();
    await page.getByLabel('Deadline label', { exact: true }).first().fill('Online portal closes');
    await page.getByLabel('Due date', { exact: true }).first().fill(day(23));
    await shoot('desktop-deadline-edit-dark-en');
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await page.getByText('Online portal closes', { exact: false }).first().waitFor();
    expect((await db.pool.query(`SELECT label,to_char(due_on,'YYYY-MM-DD') AS due_on FROM plugin_applications.application_deadlines WHERE application_id=$1 AND kind='application'`, [seededId])).rows).toEqual([{ label: 'Online portal closes', due_on: day(23) }]);

    // Funding created for this application from its detail opens in the funding tab, pre-linked; the detail shows the same record.
    await page.getByRole('button', { name: 'New funding for this application', exact: true }).click();
    expect(await page.getByRole('tab', { name: 'Scholarships & funding', exact: true }).getAttribute('aria-selected')).toBe('true');
    await page.getByLabel('Funding name', { exact: true }).fill('Excellence Scholarship');
    await page.getByLabel('Funder', { exact: true }).fill('ETH Foundation');
    expect(await page.getByLabel('ETH Zurich · PhD in Computer Science', { exact: true }).isChecked()).toBe(true);
    await shoot('desktop-funding-new-dark-en');
    await page.getByRole('button', { name: 'Create application', exact: true }).click();
    await page.getByRole('region', { name: 'Applies to', exact: true }).getByText('ETH Zurich · PhD in Computer Science', { exact: true }).waitFor();
    const funding = (await db.pool.query(`SELECT id,submission FROM plugin_applications.applications WHERE space_id=$1 AND track='funding'`, [space])).rows;
    expect(funding).toEqual([{ id: expect.any(String), submission: 'separate' }]);
    expect((await db.pool.query(`SELECT application_id FROM plugin_applications.application_funding_links WHERE funding_id=$1`, [funding[0].id])).rows).toEqual([{ application_id: seededId }]);
    await shoot('desktop-funding-detail-dark-en');
    await noOverflow();
    await page.getByRole('region', { name: 'Applies to', exact: true }).getByRole('button', { name: 'Open', exact: true }).click();
    expect(await page.getByRole('tab', { name: 'Programs', exact: true }).getAttribute('aria-selected')).toBe('true');
    const linkedFunding = page.getByRole('region', { name: 'Funding', exact: true });
    await linkedFunding.getByText('Excellence Scholarship · ETH Foundation', { exact: true }).waitFor();
    await linkedFunding.scrollIntoViewIfNeeded();
    await shoot('desktop-program-funding-dark-en');

    // An edit that moves the open record to another institution group, or out of the funding filter,
    // keeps that record open where it was, with its save feedback, until it is closed.
    const card = (name: string) => page.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const imperial = card('PhD in Computing');
    await imperial.getByRole('button', { name: 'Open', exact: true }).first().click();
    const imperialFacts = imperial.getByRole('region', { name: 'Application details', exact: true });
    await imperialFacts.getByLabel('University or institution', { exact: true }).fill('Imperial College');
    // The list itself reloads after the save; the assertions below run on that reloaded list.
    const programsReloaded = page.waitForResponse((r: { url(): string }) => r.url().includes('application.list') && decodeURIComponent(r.url()).includes('"track":"phd"'));
    await imperialFacts.getByRole('button', { name: 'Save', exact: true }).click();
    await programsReloaded;
    await expect.poll(async () => (await db.pool.query(`SELECT institution FROM plugin_applications.applications WHERE id=$1`, [created[0].id])).rows[0].institution).toBe('Imperial College');
    await imperial.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    expect(await group('Imperial College London').getByRole('button', { name: 'Close', exact: true }).first().getAttribute('aria-expanded')).toBe('true');
    expect(await imperialFacts.getByLabel('University or institution', { exact: true }).inputValue()).toBe('Imperial College');
    await shoot('desktop-moved-group-open-dark-en');
    await imperial.getByRole('button', { name: 'Close', exact: true }).first().click();
    await group('Imperial College').getByRole('heading', { name: 'PhD in Computing', exact: true }).waitFor();
    expect(await group('Imperial College London').count()).toBe(0);
    await page.getByRole('tab', { name: 'Scholarships & funding', exact: true }).click();
    const filterBy = async (name: string) => { await page.getByRole('button', { name: 'Filter funding', exact: true }).click(); await page.getByRole('option', { name, exact: true }).click(); };
    const scholarship = card('Excellence Scholarship');
    await filterBy('Linked to a program');
    await scholarship.getByRole('button', { name: 'Open', exact: true }).first().click();
    const appliesTo = scholarship.getByRole('region', { name: 'Applies to', exact: true });
    // Unlinked under "Linked to a program": no longer matches, still open with the feedback.
    await appliesTo.getByRole('button', { name: 'Unlink ETH Zurich · PhD in Computer Science', exact: true }).click();
    await appliesTo.getByText('Not linked to a program application (independent funding).', { exact: true }).waitFor();
    await scholarship.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    expect(await scholarship.getByRole('button', { name: 'Close', exact: true }).first().getAttribute('aria-expanded')).toBe('true');
    await shoot('desktop-funding-filter-open-dark-en');
    // Linked again under "Independent": the same, in the other direction.
    await filterBy('Independent');
    // Room below the shared Select's trigger for its menu, as above.
    const linkTo = appliesTo.getByRole('button', { name: 'Link a program application', exact: true });
    await linkTo.evaluate((el: any) => el.scrollIntoView({ block: 'start' }));
    await linkTo.click();
    await page.getByRole('option', { name: 'ETH Zurich · PhD in Computer Science', exact: true }).click();
    await appliesTo.getByRole('button', { name: 'Link', exact: true }).click();
    await appliesTo.getByText('ETH Zurich · PhD in Computer Science', { exact: true }).waitFor();
    await scholarship.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    expect((await db.pool.query(`SELECT application_id FROM plugin_applications.application_funding_links WHERE funding_id=$1`, [funding[0].id])).rows).toEqual([{ application_id: seededId }]);
    await scholarship.getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.getByText('No scholarships or funding yet.', { exact: true }).waitFor();
    await filterBy('All funding');
    await scholarship.waitFor();
    await page.getByRole('tab', { name: 'Programs', exact: true }).click();
    // Back in Programs, the application opened from the funding record is open again.
    const eth = card('PhD in Computer Science').locator('button[aria-expanded]').first();
    await eth.waitFor();
    if (await eth.getAttribute('aria-expanded') !== 'true') await eth.click();

    // The contacts tab: a supervisor linked to several applications, with history, edited and made Project-level.
    await related.getByRole('button', { name: 'Open in contacts', exact: true }).click();
    expect(await page.getByRole('tab', { name: 'Supervisors & contacts', exact: true }).getAttribute('aria-selected')).toBe('true');
    const all = page.getByRole('region', { name: 'All contacts in this Project', exact: true });
    const ada = all.getByRole('listitem').filter({ hasText: 'Prof. Ada Example' }).first();
    await ada.getByText('Sent CV and a short research statement', { exact: true }).waitFor();
    await ada.getByRole('button', { name: 'Edit Prof. Ada Example', exact: true }).click();
    await ada.getByLabel('Note', { exact: true }).fill('Prefers short emails');
    await ada.getByLabel('Excellence Scholarship · ETH Foundation', { exact: true }).check();
    await shoot('desktop-contact-edit-dark-en');
    await ada.getByRole('button', { name: 'Save', exact: true }).click();
    const links = async () => (await db.pool.query(`SELECT application_id FROM plugin_applications.application_contact_links WHERE contact_id=$1 ORDER BY application_id`, [contact.data.contact_id])).rows.map(r => r.application_id);
    await expect.poll(links).toEqual([seededId, funding[0].id].sort());
    expect((await db.pool.query(`SELECT note FROM plugin_applications.application_contacts WHERE id=$1`, [contact.data.contact_id])).rows[0].note).toBe('Prefers short emails');
    await ada.getByRole('button', { name: 'Edit Prof. Ada Example', exact: true }).click();
    for (const name of ['ETH Zurich · PhD in Computer Science', 'Excellence Scholarship · ETH Foundation']) await ada.getByLabel(name, { exact: true }).uncheck();
    await ada.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(links).toEqual([]);
    await all.getByText('Project level (no application)', { exact: true }).first().waitFor();
    await all.getByRole('button', { name: 'Add contact', exact: true }).click();
    await all.getByLabel('Name', { exact: true }).fill('Graduate funding office');
    await all.getByRole('button', { name: 'Save', exact: true }).click();
    await all.getByText('Graduate funding office', { exact: true }).waitFor();
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_applications.application_contact_links l JOIN plugin_applications.application_contacts c ON c.id=l.contact_id WHERE c.space_id=$1 AND c.name='Graduate funding office'`, [space])).rows[0].n).toBe(0);
    await shoot('desktop-project-contacts-dark-en');
    await noOverflow();

    // The material library: an existing Note registered, with its use by an application's tailored material.
    const cvNote = randomUUID(), at = new Date().toISOString(), doc = markdownToPm('Master CV: systems research, teaching.');
    await db.pool.query(`INSERT INTO space_objects(id,space_id,object_type,title,visibility,owner_user_id,primary_project_id,created_at,updated_at) VALUES($1,$2,'note','Master CV','private',$3,NULL,now(),now())`, [cvNote, space, user]);
    await db.pool.query(`INSERT INTO notes(object_id,space_id,content_json,content_format,content_schema_version,plain_text) VALUES($1,$2,$3::jsonb,'prosemirror_json',1,'Master CV: systems research, teaching.')`, [cvNote, space, JSON.stringify(doc)]);
    await insertInitialNoteRevision(db.pool, { spaceId: space, noteId: cvNote, doc, at, userId: user });
    const statement = (await db.pool.query(`SELECT id FROM plugin_applications.application_materials WHERE application_id=$1 AND kind='statement'`, [seededId])).rows[0].id;
    await post('actions/plugin.applications.material.add_source', { project_id: project, material_id: statement, note_id: cvNote });
    await page.getByRole('tab', { name: 'My materials', exact: true }).click();
    await page.getByLabel('Note ID', { exact: true }).fill(cvNote);
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByRole('heading', { name: 'Master CV', exact: true }).waitFor();
    await page.getByText('ETH Zurich · PhD in Computer Science — Statement of purpose: source pinned at version 1', { exact: true }).waitFor();
    expect((await db.pool.query(`SELECT note_id,kind FROM plugin_applications.application_library_items WHERE space_id=$1`, [space])).rows).toEqual([{ note_id: cvNote, kind: 'cv' }]);
    await shoot('desktop-library-dark-en');
    await noOverflow();
    await page.getByRole('tab', { name: 'Programs', exact: true }).click();
    await group('ETH Zurich').getByRole('button', { name: 'Open', exact: true }).click();

    // Archive the open seeded application: its details become read-only and only Restore remains.
    const factsOf = () => page.getByRole('region', { name: 'Application details', exact: true });
    const deadlinesOf = () => page.getByRole('region', { name: 'Deadlines', exact: true });
    const materialsOf = () => page.getByRole('region', { name: 'Materials', exact: true });
    const archivedNow = async () => (await db.pool.query(`SELECT archived_at IS NOT NULL AS archived FROM plugin_applications.applications WHERE id=$1`, [seededId])).rows[0].archived;
    // With archived applications shown, the detail stays mounted across archiving: a deadline
    // editor and a material link editor are open when the application is archived.
    await page.getByRole('button', { name: 'Show archived', exact: true }).click();
    await deadlinesOf().getByRole('button', { name: /^Edit deadline / }).first().click();
    await deadlinesOf().getByRole('button', { name: 'Save', exact: true }).waitFor();
    await materialsOf().getByRole('button', { name: /^(Link|Change link)$/ }).first().click();
    await materialsOf().getByLabel('Artifact or Task ID', { exact: true }).waitFor();
    await factsOf().getByRole('button', { name: 'Archive', exact: true }).click();
    await expect.poll(archivedNow).toBe(true);
    await factsOf().getByText('This application is archived and read-only. Restore it to change its details.', { exact: true }).waitFor();
    expect(await factsOf().getByRole('button', { name: 'Save', exact: true }).count()).toBe(0);
    // The editors opened before archiving are closed and cannot be reopened.
    expect(await deadlinesOf().getByRole('button', { name: 'Save', exact: true }).count()).toBe(0);
    expect(await materialsOf().getByLabel('Artifact or Task ID', { exact: true }).count()).toBe(0);
    expect(await materialsOf().getByRole('button', { name: /^(Save|Unlink)$/ }).count()).toBe(0);
    expect(await deadlinesOf().getByRole('button', { name: /^Edit deadline / }).first().isDisabled()).toBe(true);
    expect(await materialsOf().getByRole('button', { name: /^(Link|Change link)$/ }).first().isDisabled()).toBe(true);
    for (const label of ['University or institution', 'Program', 'Department or group', 'Intake', 'Notes']) expect(await factsOf().getByLabel(label, { exact: true }).isDisabled(), label).toBe(true);
    await factsOf().scrollIntoViewIfNeeded();
    await shoot('desktop-archived-detail-dark-en');
    await noOverflow();
    await factsOf().getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(archivedNow).toBe(false);
    await expect.poll(() => factsOf().getByLabel('University or institution', { exact: true }).isDisabled()).toBe(false);
    await factsOf().getByRole('button', { name: 'Save', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Hide archived', exact: true }).click();

    // Phone, light, Simplified Chinese: entry in the Project navigation, overview and Area.
    await page.setViewportSize({ width: 390, height: 844 });
    await prefs('zh-CN', 'light');
    await page.goto(pulse);
    await page.getByText('即将到来的截止日', { exact: true }).waitFor();
    await page.getByText('即将到来的截止日', { exact: true }).scrollIntoViewIfNeeded();
    await shoot('phone-overview-light-zh');
    await noOverflow();
    await page.getByRole('button', { name: /^项目导航/ }).click();
    await nav('Project 导航').waitFor();
    await shoot('phone-parent-light-zh');
    await nav('Project 导航').click();
    await page.getByRole('button', { name: '新建申请', exact: true }).waitFor();
    await shoot('phone-area-light-zh');
    await noOverflow();
    expect((await page.getByRole('button', { name: '新建申请', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button', { name: '打开', exact: true }).first().click();
    await page.getByRole('heading', { name: '截止日', exact: true }).waitFor();
    await shoot('phone-detail-light-zh');
    await noOverflow();

    // The remaining theme/locale/width combinations.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(pulse);
    await page.getByText('即将到来的截止日', { exact: true }).waitFor();
    await shoot('desktop-parent-light-zh');
    await page.goto(area);
    await page.getByRole('button', { name: '新建申请', exact: true }).waitFor();
    await shoot('desktop-area-light-zh');
    await prefs('en', 'dark');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(area);
    await page.getByRole('button', { name: 'New application', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open', exact: true }).first().click();
    await page.getByRole('heading', { name: 'Deadlines', exact: true }).waitFor();
    await shoot('phone-detail-dark-en');
    await noOverflow();
    await page.goto(pulse);
    await page.getByText('Upcoming deadlines', { exact: true }).waitFor();
    await page.getByText('Upcoming deadlines', { exact: true }).scrollIntoViewIfNeeded();
    await shoot('phone-overview-dark-en');
    await noOverflow();

    // Disable and re-enable announced in this tab (as the Plugins page does): the Project entry follows
    // without a reload, focus change or poll.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(pulse);
    await nav('Project navigation').waitFor();
    await post(`plugins/${plugin.id}/disable`, {});
    await page.evaluate(() => (globalThis as any).window.dispatchEvent(new (globalThis as any).CustomEvent('rainver:plugin-state-changed')));
    await expect.poll(async () => nav('Project navigation').count(), { timeout: 10000 }).toBe(0);
    await post(`plugins/${plugin.id}/enable`, {});
    await page.evaluate(() => (globalThis as any).window.dispatchEvent(new (globalThis as any).CustomEvent('rainver:plugin-state-changed')));
    await nav('Project navigation').waitFor({ timeout: 10000 });

    // The funding editor explains the guard without presenting inferred history as an approval.
    const requested = await post('actions/plugin.applications.application.propose_status', {
      project_id: project, application_id: funding[0].id, status: 'submitted',
    });
    await post('actions/proposal.accept', { proposal_id: requested.proposal_id });
    for (const copy of [
      { locale: 'en', tab: 'Scholarships & funding', open: 'Open', details: 'Application details', mode: 'How you apply',
        automatic: 'Considered automatically', save: 'Save',
        error: 'You can’t switch to automatic consideration. This funding has a recorded submission, or its older history cannot rule one out.' },
      { locale: 'zh-CN', tab: '奖学金与资助', open: '打开', details: '申请详情', mode: '申请方式',
        automatic: '随院校申请自动参评', save: '保存', error: '无法改为自动参评。这项资助已有提交记录，或旧版历史无法排除曾经提交。' },
    ]) {
      await prefs(copy.locale, copy.locale === 'en' ? 'dark' : 'light');
      await page.setViewportSize(copy.locale === 'en' ? { width: 1280, height: 900 } : { width: 390, height: 844 });
      await page.goto(area);
      await page.getByRole('tab', { name: copy.tab, exact: true }).click();
      await scholarship.getByRole('button', { name: copy.open, exact: true }).first().click();
      const facts = page.getByRole('region', { name: copy.details, exact: true });
      await facts.getByRole('button', { name: copy.mode, exact: true }).press('ArrowDown');
      await page.getByRole('option', { name: copy.automatic, exact: true }).press('Enter');
      await facts.getByRole('button', { name: copy.save, exact: true }).click();
      const alert = scholarship.getByText(copy.error, { exact: true });
      await alert.scrollIntoViewIfNeeded();
      expect(await alert.getAttribute('role')).toBe('alert');
      await noOverflow();
      await shoot(`funding-submission-guard-${copy.locale}`);
    }
    await prefs('en', 'dark');

    // Unbinding closes the Area in place and keeps the records.
    await post('actions/official_plugin.project_binding.unbind', { plugin_id: plugin.id, project_id: project });
    await page.goto(area);
    await page.getByText('This module is disabled or you no longer have access.', { exact: true }).waitFor();
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_applications.applications WHERE space_id=$1`, [space])).rows[0].n).toBe(3);
    expect(pageErrors).toEqual([]);
  } catch (error) {
    console.error(viteLog.slice(-4000));
    throw error;
  } finally {
    await browser?.close();
    vite.kill();
    await app.close();
  }
}, 240000);
