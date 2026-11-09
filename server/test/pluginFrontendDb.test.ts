import { agentsModule } from '../src/modules/agents/index.js';
import { projectFoldersModule } from '../src/modules/projectFolders/index.js';
import { projectWorkModule } from '../src/modules/projectWork/index.js';
import { agentAttentionModule } from '../src/modules/agentAttention/index.js';
import { focusAreasModule } from '../src/modules/focusAreas/index.js';
import { setOperationPluginEnabled } from '../src/modules/plugins/lifecycle.js';
import { roomsModule } from '../src/modules/rooms/index.js';
import { it, expect, inject, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject, seedMainlineRoomsForAllProjects, seedSpaceMember } from './support/domainSeeds.js';
import { buildModuleServer } from './support/moduleServer.js';
import { loadConfig } from '../src/config.js';
import { projectsModule } from '../src/modules/projects/index.js';
import { pluginsModule } from '../src/modules/plugins/index.js';
import { systemActionsModule } from '../src/modules/systemActions/index.js';
import { proposalsModule, __setProposalIdentityForTests } from '../src/modules/proposals/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { PluginHost } from '../src/modules/plugins/host/index.js';
import { createLifecycleProbe, jobId } from './fixtures/pluginOperation/lifecycleRuntime.js';
import { migrateOperationPlugin, reconcileOperationPlugins } from '../src/modules/plugins/operationMigrations.js';
import { JobHandlerRegistry } from '../src/modules/jobs/handlerRegistry.js';
import { PgJobQueueRepository } from '../src/modules/jobs/repository.js';
import { JobWorker } from '../src/modules/jobs/worker.js';
const db = useTestDatabase(import.meta.filename);
afterEach(() => {
  __setAuthIdentityForTests(null);
  __setProposalIdentityForTests(null);
});
it('renders the real Project entry and bundled slot against actual PG/HTTP/proposal/worker/restore', async () => {
  const space = randomUUID(),
    user = randomUUID(),
    project = randomUUID(),
    project2 = randomUUID(),
    space2 = randomUUID(),
    other = randomUUID(),
    project3 = randomUUID(),
    secondUser = randomUUID();
  await seedSpaceOwnerProject(db.pool, {
    space,
    owner: user,
    project,
    projectName: 'Operation platform',
    spaceType: 'team'
  });
  await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Second project','active',now(),now())", [project2, space, user]);
  await seedSpaceOwnerProject(db.pool, {
    space: space2,
    owner: other,
    project: project3,
    projectName: 'Other Space project',
    spaceType: 'team'
  });
  await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())", [randomUUID(), space2, user]);
  await seedSpaceMember(db.pool, {
    space,
    user: secondUser
  });
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())", [randomUUID(), space2, project3, user]);
  await seedMainlineRoomsForAllProjects(db.pool);
  const port = await new Promise<number>(resolve => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const address = s.address() as {
        port: number;
      };
      s.close(() => resolve(address.port));
    });
  });
  const config = loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      FRONTEND_URL: `http://127.0.0.1:${port}`
    }),
    plugin = createLifecycleProbe(),
    host = new PluginHost([plugin]);
  const app = buildModuleServer(config, [projectsModule, pluginsModule, systemActionsModule, proposalsModule, roomsModule, agentsModule, projectFoldersModule, projectWorkModule, agentAttentionModule, focusAreasModule]);
  host.activate(app, config);
  let actorUser = user;
  __setAuthIdentityForTests(request => ({
    spaceId: String(request.headers['x-rainver-space-id'] ?? request.headers['x-space-id'] ?? space),
    userId: actorUser
  }));
  __setProposalIdentityForTests(() => ({
    spaceId: space,
    userId: actorUser
  }));
  const api = await app.listen({
    host: '127.0.0.1',
    port: 0
  });
  const web = join(import.meta.dirname, '../../apps/web'),
    shots = process.env.PLUGIN_VISUAL_OUT ?? '/tmp/rainver-plugin-platform-visual';
  await mkdir(shots, {
    recursive: true
  });
  const vite = spawn(process.execPath, [join(web, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--mode', 'plugin-acceptance'], {
    cwd: web,
    env: {
      PATH: process.env.PATH,
      API_URL: api
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let viteLog = '';
  vite.stdout.on('data', d => {
    viteLog += d;
  });
  vite.stderr.on('data', d => {
    viteLog += d;
  });
  const base = `http://127.0.0.1:${port}`;
  const {
    chromium
  } = await import(pathToFileURL(join(web, 'node_modules/playwright-core/index.mjs')).href);
  let browser: any;
  try {
    await expect.poll(async () => {
      try {
        return (await fetch(base)).status;
      } catch {
        return 0;
      }
    }, {
      timeout: 30000
    }).toBe(200);
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE
    });
    const page = await browser.newPage({
      viewport: {
        width: 1280,
        height: 900
      }
    });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => {
      pageErrors.push(e.message);
      console.error('Browser error', e.message);
    });
    page.on('response', async (r: any) => {
      if (r.url().includes('/actions/') && r.status() >= 400) console.error('Operation response', r.status(), await r.text());
    });
    // Identity/bootstrap chrome is a fixture; Project, plugin, operations and Proposal requests go to the real server.
    await page.route('**/api/v1/me', (route: any) => route.fulfill({
      json: {
        id: actorUser,
        email: 'fixture@test.invalid',
        display_name: 'Fixture person',
        default_space_id: space,
        created_at: new Date().toISOString(),
        avatar_url: null,
        last_login_at: null
      }
    }));
    await page.route('**/api/v1/me/spaces', (route: any) => route.fulfill({
      json: [{
        id: space,
        name: 'Test Space',
        type: 'team',
        role: actorUser === user ? 'owner' : 'member',
        status: 'active'
      }, {
        id: space2,
        name: 'Other Space',
        type: 'team',
        role: 'member',
        status: 'active'
      }]
    }));
    await page.addInitScript(() => {
      if (!localStorage.getItem('rainver:locale')) localStorage.setItem('rainver:locale', 'en');
      if (!localStorage.getItem('rainver:theme')) localStorage.setItem('rainver:theme', 'dark');
    });
    const pulse = `${base}/spaces/${space}/projects/${project}`,
      slot = `${pulse}/plugins/operation_probe/records`;
    await page.goto(pulse);
    await expect.poll(() => page.getByText('Operation platform', {
      exact: true
    }).count(), {
      timeout: 30000
    }).toBeGreaterThan(0);
    expect(await page.getByRole('link', {
      name: 'Records',
      exact: true
    }).count()).toBe(0);
    await migrateOperationPlugin(db.pool, plugin);
    const enable = await fetch(`${api}/api/v1/plugins/${plugin.id}/enable`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-space-id': space
      },
      body: '{}'
    });
    expect(enable.status).toBe(200);
    await page.reload();
    await page.getByRole('navigation', {
      name: 'Project navigation'
    }).getByRole('link', {
      name: 'Records',
      exact: true
    }).waitFor({
      timeout: 30000
    });
    await page.getByLabel('Record text', {
      exact: true
    }).waitFor();
    await page.screenshot({
      path: join(shots, 'desktop-parent-dark-en.png'),
      fullPage: true
    });
    await page.getByRole('navigation', {
      name: 'Project navigation'
    }).getByRole('link', {
      name: 'Records',
      exact: true
    }).click();
    await page.waitForURL(slot);
    const field = page.locator('[data-plugin-page]').getByLabel('Record text', {
      exact: true
    });
    await field.waitFor();
    await field.focus();
    await page.keyboard.press('Tab');
    expect(await page.getByRole('button', {
      name: 'Save',
      exact: true
    }).evaluate((el: any) => el === (globalThis as any).document.activeElement)).toBe(true);
    await field.fill('Browser saved record');
    await page.getByRole('button', {
      name: 'Save',
      exact: true
    }).click();
    await page.getByText('Browser saved record', {
      exact: true
    }).waitFor();
    expect((await db.pool.query('SELECT value FROM plugin_operation_probe.records WHERE space_id=$1 AND user_id=$2', [space, user])).rows.map(r => r.value)).toContain('Browser saved record');
    await page.screenshot({
      path: join(shots, 'desktop-slot-dark-en.png'),
      fullPage: true
    });
    await field.fill('Browser approved record');
    await page.getByRole('button', {
      name: 'Propose change',
      exact: true
    }).click();
    await page.getByRole('link', {
      name: 'Review proposal',
      exact: true
    }).click();
    await page.getByRole('button', {
      name: 'Accept',
      exact: true
    }).click();
    await page.getByText('Proposal accepted.', {
      exact: true
    }).waitFor();
    const proposal = (await db.pool.query("SELECT id,status FROM proposals WHERE space_id=$1 AND proposal_type='plugin.operation_probe.record.approve'", [space])).rows[0];
    expect(proposal.status).toBe('accepted');
    await page.goto(slot);
    await field.waitFor();
    await page.getByText('Browser approved record', {
      exact: true
    }).waitFor();
    await field.fill('Browser background record');
    await page.getByRole('button', {
      name: 'Run in background',
      exact: true
    }).click();
    await page.getByText('Background work queued', {
      exact: true
    }).waitFor();
    const registry = new JobHandlerRegistry();
    host.applyJobHandlers(registry);
    expect((await new JobWorker(new PgJobQueueRepository(db.pool), registry, 'browser-worker', [jobId]).processOne()).status).toBe('completed');
    await page.getByRole('button', {
      name: 'Refresh',
      exact: true
    }).click();
    await page.getByText('Browser background record', {
      exact: true
    }).waitFor();
    // Real pg_dump/restore strips role ownership/ACL; host reconcile repairs before a browser reload reads the old data.
    const context = inject('sharedPostgres'),
      uri = new URL(db.connectionUri);
    if (!context.containerId) throw new Error('Shared PG container identity required');
    const args = ['-U', decodeURIComponent(uri.username), '-d', uri.pathname.slice(1)];
    const dump = execFileSync('docker', ['exec', context.containerId, 'pg_dump', ...args, '-Fc', '--schema=plugin_operation_probe']);
    await field.fill('After dump');
    await page.getByRole('button', {
      name: 'Save',
      exact: true
    }).click();
    await page.getByText('After dump', {
      exact: true
    }).waitFor();
    execFileSync('docker', ['exec', '-i', context.containerId, 'pg_restore', ...args, '--clean', '--if-exists', '--no-owner', '--no-acl'], {
      input: dump
    });
    await reconcileOperationPlugins(db.pool, [plugin]);
    await page.reload();
    await page.getByText('Browser approved record', {
      exact: true
    }).waitFor();
    expect(await page.getByText('After dump', {
      exact: true
    }).count()).toBe(0);
    // Honest host loading/error states, with the real request delayed or failed rather than replacing domain data.
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    await page.route('**/api/v1/plugins', async (route: any) => {
      await gate;
      await route.continue();
    });
    const loadingNavigation = page.goto(slot);
    await page.getByText('Loading module…', {
      exact: true
    }).waitFor();
    await page.screenshot({
      path: join(shots, 'desktop-loading.png'),
      fullPage: true
    });
    release();
    await loadingNavigation;
    await field.waitFor();
    await page.unroute('**/api/v1/plugins');
    await page.route('**/api/v1/plugins', (route: any) => route.fulfill({
      status: 503,
      json: {
        detail: 'Injected transport outage'
      }
    }));
    await page.reload();
    await page.getByText('The module could not be loaded.', {
      exact: true
    }).waitFor();
    await page.screenshot({
      path: join(shots, 'desktop-error.png'),
      fullPage: true
    });
    await page.unroute('**/api/v1/plugins');
    await page.getByRole('button', {
      name: 'Retry',
      exact: true
    }).click();
    await field.waitFor();
    const disabled = await fetch(`${api}/api/v1/plugins/${plugin.id}/disable`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-space-id': space
      },
      body: '{}'
    });
    expect(disabled.status).toBe(200);
    await page.evaluate(() => (globalThis as any).window.dispatchEvent(new Event('focus')));
    await page.getByText('This module is disabled or you no longer have access.', {
      exact: true
    }).waitFor();
    expect(await page.getByText('Browser approved record', {
      exact: true
    }).count()).toBe(0);
    await page.screenshot({
      path: join(shots, 'desktop-disabled.png'),
      fullPage: true
    });
    await fetch(`${api}/api/v1/plugins/${plugin.id}/enable`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-space-id': space
      },
      body: '{}'
    });
    await page.getByRole('button', {
      name: 'Close Project chat',
      exact: true
    }).click().catch(() => {});
    await page.setViewportSize({
      width: 390,
      height: 844
    });
    await page.evaluate(() => {
      localStorage.setItem('rainver:locale', 'zh-CN');
      localStorage.setItem('rainver:theme', 'light');
    });
    await page.goto(pulse);
    await page.getByLabel('记录内容', {
      exact: true
    }).waitFor();
    await page.getByRole('button', {
      name: /^项目导航/
    }).click();
    await page.screenshot({
      path: join(shots, 'phone-parent-light-zh.png'),
      fullPage: true
    });
    await page.getByLabel('记录内容', {
      exact: true
    }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shots, 'phone-overview-light-zh.png'),
      fullPage: true
    });
    await page.getByRole('navigation', {
      name: 'Project 导航'
    }).getByRole('link', {
      name: '记录',
      exact: true
    }).click();
    await page.locator('[data-plugin-page]').getByLabel('记录内容', {
      exact: true
    }).waitFor();
    expect((await page.getByLabel('记录内容', {
      exact: true
    }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: join(shots, 'phone-slot-light-zh.png'),
      fullPage: true
    });
    expect(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).window.innerWidth)).toBe(true);
    // Both themes/locales at both widths; navigation entry and destination are inspected separately.
    await page.setViewportSize({
      width: 1280,
      height: 900
    });
    await page.goto(pulse);
    await page.getByLabel('记录内容', {
      exact: true
    }).waitFor();
    await page.screenshot({
      path: join(shots, 'desktop-parent-light-zh.png'),
      fullPage: true
    });
    await page.getByRole('navigation', {
      name: 'Project 导航'
    }).getByRole('link', {
      name: '记录',
      exact: true
    }).click();
    await page.locator('[data-plugin-page]').getByLabel('记录内容', {
      exact: true
    }).waitFor();
    await page.screenshot({
      path: join(shots, 'desktop-slot-light-zh.png'),
      fullPage: true
    });
    await page.evaluate(() => {
      localStorage.setItem('rainver:locale', 'en');
      localStorage.setItem('rainver:theme', 'dark');
    });
    await page.setViewportSize({
      width: 390,
      height: 844
    });
    await page.goto(pulse);
    await page.getByLabel('Record text', {
      exact: true
    }).waitFor();
    await page.getByRole('button', {
      name: /^Project navigation/
    }).click();
    await page.screenshot({
      path: join(shots, 'phone-parent-dark-en.png'),
      fullPage: true
    });
    await page.getByLabel('Record text', {
      exact: true
    }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shots, 'phone-overview-dark-en.png'),
      fullPage: true
    });
    await page.getByRole('navigation', {
      name: 'Project navigation'
    }).getByRole('link', {
      name: 'Records',
      exact: true
    }).click();
    await field.waitFor();
    await page.screenshot({
      path: join(shots, 'phone-slot-dark-en.png'),
      fullPage: true
    });
    let releasePhone!: () => void;
    const phoneGate = new Promise<void>(r => {
      releasePhone = r;
    });
    await page.route('**/api/v1/plugins', async (route: any) => {
      await phoneGate;
      await route.continue();
    });
    const phoneLoading = page.goto(slot);
    await page.getByText('Loading module…', {
      exact: true
    }).waitFor();
    await page.screenshot({
      path: join(shots, 'phone-loading.png'),
      fullPage: true
    });
    releasePhone();
    await phoneLoading;
    await field.waitFor();
    await page.unroute('**/api/v1/plugins');
    await page.route('**/api/v1/plugins', (route: any) => route.fulfill({
      status: 503,
      json: {
        detail: 'Injected transport outage'
      }
    }));
    await page.reload();
    await page.getByText('The module could not be loaded.', {
      exact: true
    }).waitFor();
    await page.screenshot({
      path: join(shots, 'phone-error.png'),
      fullPage: true
    });
    await page.unroute('**/api/v1/plugins');
    await page.getByRole('button', {
      name: 'Retry',
      exact: true
    }).click();
    await field.waitFor();
    await fetch(`${api}/api/v1/plugins/${plugin.id}/disable`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-space-id': space
      },
      body: '{}'
    });
    await page.evaluate(() => (globalThis as any).window.dispatchEvent(new Event('focus')));
    await page.getByText('This module is disabled or you no longer have access.', {
      exact: true
    }).waitFor();
    await page.screenshot({
      path: join(shots, 'phone-disabled.png'),
      fullPage: true
    });
    await fetch(`${api}/api/v1/plugins/${plugin.id}/enable`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-space-id': space
      },
      body: '{}'
    });
    await page.reload();
    await field.waitFor();
    // The old query really reached PostgreSQL; a client-side Project switch must expire its response/port.
    let releaseOld!: () => void, oldReady!: () => void;
    const oldGate = new Promise<void>(r => {
        releaseOld = r;
      }),
      ready = new Promise<void>(r => {
        oldReady = r;
      });
    let held = false;
    await page.route('**/api/v1/queries/plugin.operation_probe.record.list*', async (route: any) => {
      if (held) {
        await route.continue();
        return;
      }
      held = true;
      const snapshot = await route.fetch();
      oldReady();
      await oldGate;
      await route.fulfill({
        response: snapshot
      }).catch(() => {});
    });
    await page.getByRole('button', {
      name: 'Refresh',
      exact: true
    }).click();
    await ready;
    await page.evaluate((target: string) => {
      (globalThis as any).history.pushState({}, '', target);
      (globalThis as any).window.dispatchEvent(new Event('popstate'));
    }, `/spaces/${space}/projects/${project2}/plugins/operation_probe/records`);
    await expect.poll(() => page.getByText('Second project', {
      exact: true
    }).count()).toBeGreaterThan(0);
    await field.waitFor();
    releaseOld();
    await page.unroute('**/api/v1/queries/plugin.operation_probe.record.list*');
    await page.goto(slot);
    await field.waitFor();
    await setOperationPluginEnabled(config, plugin.id, space2, other, true);
    let releaseSpace!: () => void, spaceReady!: () => void;
    const spaceGate = new Promise<void>(r => {
        releaseSpace = r;
      }),
      readySpace = new Promise<void>(r => {
        spaceReady = r;
      });
    let spaceHeld = false;
    await page.route('**/api/v1/queries/plugin.operation_probe.record.list*', async (route: any) => {
      if (spaceHeld) {
        await route.continue();
        return;
      }
      spaceHeld = true;
      const snapshot = await route.fetch();
      spaceReady();
      await spaceGate;
      await route.fulfill({
        response: snapshot
      }).catch(() => {});
    });
    await page.getByRole('button', {
      name: 'Refresh',
      exact: true
    }).click();
    await readySpace;
    await page.evaluate((target: string) => {
      (globalThis as any).history.pushState({}, '', target);
      (globalThis as any).window.dispatchEvent(new Event('popstate'));
    }, `/spaces/${space2}/projects/${project3}/plugins/operation_probe/records`);
    await expect.poll(() => page.getByText('Other Space project', {
      exact: true
    }).count()).toBeGreaterThan(0);
    await field.waitFor();
    releaseSpace();
    await page.unroute('**/api/v1/queries/plugin.operation_probe.record.list*');
    await page.getByText('No records yet.', {
      exact: true
    }).waitFor();
    expect(await page.getByText('Browser approved record', {
      exact: true
    }).count()).toBe(0);
    // A second real member reads their own empty partition, then loses a private Project grant.
    await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())", [randomUUID(), space, project, secondUser]);
    actorUser = secondUser;
    await page.goto(slot);
    await field.waitFor();
    await page.getByText('No records yet.', {
      exact: true
    }).waitFor();
    expect(await page.getByText('Browser approved record', {
      exact: true
    }).count()).toBe(0);
    await db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2", [project, secondUser]);
    await page.reload();
    await expect.poll(() => page.getByLabel('Record text', {
      exact: true
    }).count()).toBe(0);
    expect((await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project}/overview`
    })).statusCode).toBe(404);
    expect(pageErrors).toEqual([]);
    console.info('Plugin visual evidence', shots);
  } catch (error) {
    console.error('Vite fixture log', viteLog.slice(-3000));
    if (browser) {
      for (const p of browser.contexts().flatMap((c: any) => c.pages())) await p.screenshot({
        path: join(shots, 'failure.png'),
        fullPage: true
      }).catch(() => {});
    }
    throw error;
  } finally {
    await browser?.close();
    vite.kill('SIGTERM');
    await new Promise<void>(r => {
      if (vite.exitCode !== null) r();else vite.once('exit', () => r());
    });
    __setAuthIdentityForTests(null);
    __setProposalIdentityForTests(null);
    await app.close();
  }
}, 180000);
