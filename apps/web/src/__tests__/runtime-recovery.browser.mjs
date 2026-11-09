import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { run, turn } from '../modules/agent_work/fixtures.test-support.ts'

const space = 'space-recovery', now = '2026-11-05T21:00:00Z'
const project = { id: 'project-recovery', space_id: space, name: 'Recovery project', status: 'active', current_user_can_read: true, current_user_can_write: true, owner_user_id: 'user-recovery' }
const shots = process.env.RUNTIME_RECOVERY_SHOTS ?? '/tmp/rainver-acp-experience-shots'
const room = { id: 'room-recovery', space_id: space, project_id: project.id, project_folder_id: null, title: 'Recovery conversation', status: 'active', created_by_user_id: 'user-recovery', created_at: now, updated_at: now }
const session = { id: 'session-recovery', room_id: room.id, space_id: space, project_id: project.id, title: room.title, status: 'active', created_at: now, updated_at: now }
const failed = run({ id: 'run-recovery', space_id: space, agent_id: 'agent-recovery', session_id: session.id, run_type: 'conversation', status: 'failed',
  owner_user_id: 'user-recovery', instructed_by_user_id: 'user-recovery', runtime_key: 'claude_code',
  error_message: 'Claude Code ACP RPC failed: Failed to authenticate. OAuth token expired.',
  error_json: { error_code: 'runtime_auth_required', runtime_target: { host_id: 'desk', runtime_key: 'claude_code', installation: 'managed:0.101.0', backend_mode: 'runtime_native' },
    runtime_failure: { rpc_code: -32603, vendor_code: 'authentication_failed', category: 'auth', message: 'Failed to authenticate', occurred_at: now, resets_at: null, phase: 'prompt', phase_elapsed_ms: 1500 } } })
const agent = { id: failed.agent_id, space_id: space, name: 'Research assistant', status: 'active', agent_kind: 'custom', description: '', model: null }
const messages = [
  { id: 'question', session_id: session.id, space_id: space, role: 'user', sender_user_id: 'user-recovery', sender_agent_id: null, run_id: null, content: 'Please continue the investigation.', metadata_json: { run_ids: [failed.id] }, created_at: now },
  { id: 'reply', session_id: session.id, space_id: space, role: 'assistant', sender_user_id: null, sender_agent_id: agent.id, run_id: failed.id, content: 'The runtime could not complete this request.', metadata_json: {}, created_at: now },
]
const pageOf = items => ({ items, total: items.length, limit: 100, offset: 0 })
const definition = { runtime_key: 'claude_code', display_name: 'Claude Code', command: 'claude', capability_probe: 'claude', remote_eligible: true, reports_managed_cli_version: true, supports_runtime_native: true, supports_model_provider: false, provider_api: 'claude_compatible' }

async function fixtures(page, counts, recoveryRun = failed) {
  let signedIn = false
  const runtimeKey = recoveryRun.runtime_key
  const adapter = runtimeKey === 'opencode'
    ? { ...definition, runtime_key: runtimeKey, display_name: 'OpenCode', command: 'opencode', capability_probe: 'opencode', reports_managed_cli_version: false, supports_model_provider: true, provider_api: 'openai_compatible' }
    : definition
  if (recoveryRun.status === 'running') await page.addInitScript(({ id, live }) => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = (resource, options) => {
      const url = typeof resource === 'string' ? resource : resource.url ?? String(resource)
      if (new URL(url, location.origin).pathname !== `/api/v1/runs/${id}/turn/stream`) return originalFetch(resource, options)
      const signal = options?.signal
      let abort
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: turn.snapshot\ndata: ${JSON.stringify({ type: 'turn.snapshot', turn: live })}\n\n`))
          abort = () => controller.error(new DOMException('Aborted', 'AbortError'))
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
        },
        cancel() { signal?.removeEventListener('abort', abort) },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
  }, { id: failed.id, live: turn({ run_id: failed.id, state: 'working', source: 'host_thread_events', parts: [
    { type: 'diagnostic', index: 0, error_code: 'runtime_compacted', level: 'info', text: 'native context compacted' },
    { type: 'diagnostic', index: 1, error_code: 'runtime_subagent_running', level: 'info', text: 'Check cancellation' },
    { type: 'text', index: 2, text: 'Checking the cancellation path and usage reports.' },
  ] }) })
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    let data
    if (route.request().method() !== 'GET') { counts.writes++; counts.writePaths?.push(path) }
    if (path === '/me') data = { id: 'user-recovery', name: 'Recovery tester', email: 'recovery@example.test', default_space_id: space, instance_role: 'admin', is_instance_admin: true }
    else if (path === '/me/spaces') data = [{ id: space, name: 'Recovery Space', type: 'personal', role: 'owner' }]
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/projects') data = pageOf([project])
    else if (path === `/projects/${project.id}`) data = project
    else if (path === `/projects/${project.id}/overview`) data = { project, brief: null, attention: [] }
    else if (path === '/rooms') data = pageOf([room])
    else if (path === '/rooms/pending-approvals') data = pageOf([])
    else if (path === `/rooms/${room.id}`) data = { room, viewer_can_write: true, other_member_names: [], agent_count: 1, agent_members: [{ agent_id: agent.id, agent_name: agent.name }], user_members: [] }
    else if (path === `/rooms/${room.id}/conversations`) data = pageOf([session])
    else if (path === `/rooms/${room.id}/agent-candidates`) data = { agents: [], presets: [], total: 0, limit: 100, offset: 0 }
    else if (path === `/rooms/${room.id}/invitations`) data = pageOf([])
    else if (path.endsWith('/messages')) data = { ...pageOf(recoveryRun.status === 'running' ? messages.map(message => message.role === 'assistant' ? { ...message, content: '' } : message) : messages), queued: [] }
    else if (path === `/sessions/${session.id}`) data = session
    else if (path === `/sessions/${session.id}/execution-context`) data = {
      summary: { session_id: session.id, state: 'initialized', host: null, runtime: null, runtimes: [], primary: null,
        attachments: [], dispatch_locked: false, queue_paused_at: null, can_send: true, blocked_reason: null },
      available_hosts: [], available_runtime_profiles: [], available_primary_locations: [],
    }
    else if (path === `/runtime-context/room-conversations/${session.id}/retrieval`) data = {
      work_context_scope_id: null, enabled: false, preferred_domains: [], setup_version: null,
    }
    else if (path === '/personal-memory-grants') data = []
    else if (path === '/agents') data = [agent]
    else if (path === `/agents/${agent.id}`) data = agent
    else if (path.endsWith('/members')) data = [{ agent_id: agent.id, agent_name: agent.name, status: 'active' }]
    else if (path.endsWith('/quota')) data = { warn_pct: 80, logins: [], holds: [] }
    else if (path === `/runs/${failed.id}`) data = recoveryRun
    else if (path === `/runs/${failed.id}/turn/stream`) {
      const live = turn({ run_id: failed.id, state: recoveryRun.status === 'running' ? 'working' : 'error', source: 'host_thread_events', parts: [
        { type: 'diagnostic', index: 0, error_code: 'runtime_compacted', level: 'info', text: 'native context compacted' },
        { type: 'diagnostic', index: 1, error_code: 'runtime_subagent_running', level: 'info', text: 'Check cancellation' },
        { type: 'text', index: 2, text: 'Checking the cancellation path and usage reports.' },
      ] })
      return route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: `event: turn.snapshot\ndata: ${JSON.stringify({ type: 'turn.snapshot', turn: live })}\n\n` })
    }
    else if (path === `/runs/${failed.id}/live-input`) {
      data = route.request().method() === 'POST'
        ? { state: 'injected', message_id: '30000000-0000-4000-8000-000000000091', delivery_id: '30000000-0000-4000-8000-000000000092' }
        : { available: recoveryRun.status === 'running', binding_id: '30000000-0000-4000-8000-000000000093' }
      if (route.request().method() === 'POST') counts.input = route.request().postDataJSON()
    }
    else if (path === `/runs/${failed.id}/turn`) data = recoveryRun.status === 'running'
      ? turn({ run_id: failed.id, state: 'working', source: 'host_thread_events', parts: [
          { type: 'diagnostic', index: 0, error_code: 'runtime_compacted', level: 'info', text: 'native context compacted' },
          { type: 'diagnostic', index: 1, error_code: 'runtime_subagent_running', level: 'info', text: 'Check cancellation' },
          { type: 'text', index: 2, text: 'Checking the cancellation path and usage reports.' },
        ] })
      : turn({ run_id: failed.id, state: 'error', source: 'host_thread_events', parts: [{ type: 'text', index: 0, text: 'The runtime could not complete this request.' }] })
    else if (path === `/runs/${failed.id}/attempts`) data = { attempts: [], supervisor_decisions: [] }
    else if (path === `/runs/${failed.id}/io`) data = { schema_version: 'run_io.v1', run_id: failed.id, input: {}, output: null, events: [], artifact_refs: [] }
    else if (/\/runs\/[^/]+\/(evaluations|verifications|finalizations|authorization-requests)$/.test(path)) data = []
    else if (/\/runs\/[^/]+\/(activities|artifacts|proposals)$/.test(path)) data = pageOf([])
    else if (path === '/hosts') data = { items: [{ id: 'desk', name: 'Desk workstation', kind: 'remote', status: 'online', owner_user_id: 'user-recovery', machine_id: 'm-desk', machine_name: 'Desk', platform: 'linux', arch: 'x64', daemon_version: '0.4.7', last_heartbeat_at: now,
      capabilities_json: { runtimes: [adapter.command], versions: {}, installations: { [runtimeKey]: runtimeKey === 'opencode' ? [
        { id: 'own', version: '1.0.0', logged_in: false, options: { config_options: [] } },
      ] : [
        { id: 'own', version: '2.1.232', logged_in: true, options: { config_options: [], cli_login_available: true } },
        { id: 'managed:0.101.0', version: '0.101.0', runtime_version: '2.1.232', logged_in: signedIn, options: { config_options: [], cli_login_available: true } },
      ] } } }] }
    else if (path === '/hosts/runtime-definitions') data = { items: [adapter] }
    else if (path === '/hosts/execution-targets') data = { targets: [] }
    else if (/^\/hosts\/[^/]+\/(usage|tool-operations)$/.test(path)) data = { items: [] }
    else if (path.endsWith('/login/stream')) {
      counts.logins++; signedIn = true
      return route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify({ type: 'output', data: 'Offline fixture: login completed.\r\n' })}\n\ndata: ${JSON.stringify({ type: 'exit', exit_code: 0, logged_in: true })}\n\n` })
    }
    else if (path === '/acp-agents' || path === '/acp-agents/registry') data = { items: [] }
    else if (path === '/me/agent-attention/snapshot') data = { type: 'attention.snapshot', seq: 1, version: 'recovery', unread_count: 0, page: { items: [], total: 0, limit: 100, offset: 0 }, notices: [] }
    else if (path === '/me/agent-attention/stream') return route.fulfill({ status: 503, body: '' })
    else return route.fulfill({ status: 404, json: { detail: `Unavailable in recovery fixture: ${path}` } })
    return route.fulfill({ json: data })
  })
}

for (const scenario of ['provider-auth', 'timeout', 'configuration']) for (const locale of ['en', 'zh-CN']) {
  test(`non-login recovery keeps its diagnosis through navigation: ${scenario}/${locale}`, async () => {
    const width = locale === 'en' ? 390 : 1280
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    await context.addInitScript(locale => localStorage.setItem('rainver:locale', locale), locale)
    const page = await context.newPage(), counts = { writes: 0, logins: 0 }, errors = []
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    const provider = scenario === 'provider-auth'
    const recoveryRun = { ...failed, runtime_key: provider ? 'opencode' : failed.runtime_key,
      error_message: provider ? 'Provider authentication failed' : scenario === 'timeout' ? 'Request timed out' : 'Model does not exist',
      error_json: { ...failed.error_json,
        error_code: provider ? 'runtime_auth_required' : scenario === 'timeout' ? 'runtime_timeout' : 'runtime_nonzero_exit',
        runtime_target: { ...failed.error_json.runtime_target, ...(provider ? { runtime_key: 'opencode', installation: 'own', backend_mode: 'model_provider' } : {}) },
        runtime_failure: { ...failed.error_json.runtime_failure, category: provider ? 'auth' : scenario === 'timeout' ? 'unknown' : 'configuration', vendor_code: null },
      } }
    const cause = {
      'provider-auth': locale === 'en' ? 'The model provider rejected authentication' : '模型服务商拒绝了认证',
      timeout: locale === 'en' ? 'The execution reached its time limit' : '执行达到时间限制',
      configuration: locale === 'en' ? 'The runtime could not accept this configuration' : '运行时无法接受当前配置',
    }[scenario]
    try {
      await fixtures(page, counts, recoveryRun)
      await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      if (locale === 'zh-CN') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
      const notice = page.getByTestId(`runtime-failure-${failed.id}`).first()
      await notice.getByText(cause, { exact: true }).waitFor()
      assert.equal(await notice.getByRole('link', { name: /Go to login|去登录/ }).count(), 0)
      await page.getByTestId(`conversation-run-controls-${failed.id}`).evaluate(element => element.scrollIntoView({ block: 'center' }))
      await capture(page, `${scenario}-entry-${locale}-${width}`)
      await notice.getByRole('link', { name: locale === 'en' ? 'View execution Host' : '查看执行机' }).click()
      await page.locator('[data-recovery-target="true"]').waitFor()
      const banner = page.getByRole('status').filter({ hasText: locale === 'en' ? 'Recovery target:' : '已定位恢复目标：' })
      assert.match(await banner.textContent(), locale === 'en' ? /follow the original failure guidance/ : /以原请求的失败指引为准/)
      await capture(page, `${scenario}-destination-${locale}-${width}`)
      await page.goBack()
      await notice.getByText(cause, { exact: true }).waitFor()
      await notice.getByRole('button', { name: locale === 'en' ? 'Refresh Host status' : '刷新执行机状态' }).click()
      await notice.getByRole('status').filter({ hasText: provider
        ? locale === 'en' ? 'does not verify its credentials' : '不能验证服务商凭据'
        : locale === 'en' ? 'reports this copy as signed out' : '上报这份安装尚未登录' }).waitFor()
      assert.deepEqual(counts, { writes: 0, logins: 0 })
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })
}

let server, browser, baseUrl = process.env.LAYOUT_BASE_URL
before(async () => {
  await mkdir(shots, { recursive: true })
  if (!baseUrl) { server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } }); baseUrl = `http://127.0.0.1:${server.httpServer.address().port}` }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.httpServer.close(resolve)) })
async function capture(page, path) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.deepEqual(await page.getByText('Unavailable in recovery fixture:', { exact: false }).allTextContents(), [], 'No fixture API errors on the visible surface')
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
  assert.ok(size.content <= size.width + 1, JSON.stringify(size))
  await page.screenshot({ path: `${shots}/${path}.png`, fullPage: true })
}

for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
  test(`recovery entry, exact login destination and return: ${locale}/${theme}/${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    await context.addInitScript(locale => localStorage.setItem('rainver:locale', locale), locale)
    const page = await context.newPage(), counts = { writes: 0, logins: 0 }, errors = []
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await fixtures(page, counts)
    const loginLabel = locale === 'en' ? 'Go to login' : '去登录'
    try {
      await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
      const notice = page.getByTestId(`runtime-failure-${failed.id}`).first()
      await notice.waitFor()
      const retry = page.getByTestId(`conversation-run-controls-${failed.id}`).getByRole('button', { name: /Retry|重试/ }).first()
      await retry.waitFor()
      assert.equal(await retry.isEnabled(), true, 'The existing retry remains available next to recovery guidance')
      await notice.scrollIntoViewIfNeeded()
      await page.getByTestId(`conversation-run-controls-${failed.id}`).evaluate(element => element.scrollIntoView({ block: 'center' }))
      assert.equal(counts.logins, 0)
      await capture(page, `conversation-${locale}-${theme}-${width}`)
      await notice.getByRole('link', { name: loginLabel }).focus()
      await page.keyboard.press('Enter')
      await page.locator('[data-recovery-target="true"]').waitFor()
      const target = page.locator('[data-recovery-target="true"]')
      assert.equal(await target.getAttribute('data-runtime-installation'), 'managed:0.101.0')
      assert.equal(counts.logins, 0)
      await capture(page, `destination-${locale}-${theme}-${width}`)
      await target.getByRole('button', { name: /^Log in managed/ }).click()
      await page.getByTestId('runtime-login-terminal').getByText('Logged in.', { exact: true }).waitFor()
      assert.equal(counts.logins, 1)
      await page.goBack()
      await notice.waitFor()
      await notice.getByRole('button', { name: locale === 'en' ? 'Refresh Host status' : '刷新执行机状态' }).click()
      await notice.getByRole('status').filter({ hasText: locale === 'en' ? 'reports this copy as signed in' : '上报这份安装已登录' }).waitFor()
      assert.equal(counts.logins, 1)
      assert.equal(counts.writes, 0)
      await page.goto(`${baseUrl}/spaces/${space}/runs/${failed.id}`)
      if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
      await notice.waitFor()
      await notice.scrollIntoViewIfNeeded()
      await capture(page, `run-detail-${locale}-${theme}-${width}`)
      assert.deepEqual(errors, [], 'No uncaught browser errors')
    } catch (error) {
      await page.screenshot({ path: `${shots}/failure-${locale}-${theme}-${width}.png`, fullPage: true })
      throw error
    } finally { await context.close() }
  })
}

for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
  test(`live input parent surface, dialog and delivery: ${locale}/${theme}/${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    await context.addInitScript(locale => localStorage.setItem('rainver:locale', locale), locale)
    const page = await context.newPage(), counts = { writes: 0, logins: 0, writePaths: [] }, errors = []
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    try {
      await fixtures(page, counts, { ...failed, status: 'running', ended_at: null, error_message: null, error_json: null })
      await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
      const label = locale === 'en' ? 'Add instruction' : '补充指令'
      const add = page.getByRole('button', { name: label, exact: true }).first()
      await add.waitFor()
      await add.scrollIntoViewIfNeeded()
      await page.getByText(locale === 'en' ? 'Native subagent working: Check cancellation' : '原生子代理正在执行：Check cancellation', { exact: true }).first().waitFor()
      assert.equal(await page.getByRole('button', { name: /^(Stop|停止)$/ }).count() > 0, true)
      assert.deepEqual(counts.writePaths.filter(path => path !== '/me/agent-attention/views'), [])
      await capture(page, `live-entry-${locale}-${theme}-${width}`)
      await add.click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('textbox', { name: label }).fill('Keep cancellation available while checking usage.')
      await dialog.evaluate(async element => {
        await Promise.allSettled(element.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))
      })
      const bounds = await dialog.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, JSON.stringify(bounds))
      await capture(page, `live-dialog-${locale}-${theme}-${width}`)
      await dialog.getByRole('button', { name: locale === 'en' ? 'Send to running turn' : '发送到当前回合' }).click()
      await dialog.getByRole('status').filter({ hasText: locale === 'en' ? 'Delivered to the running turn.' : '已送达当前执行回合。' }).waitFor()
      assert.deepEqual(counts.writePaths.filter(path => path !== '/me/agent-attention/views'), [`/runs/${failed.id}/live-input`])
      assert.equal(counts.input.binding_id, '30000000-0000-4000-8000-000000000093')
      assert.deepEqual(errors, [])
    } catch (error) {
      await page.screenshot({ path: `${shots}/live-failure-${locale}-${theme}-${width}.png`, fullPage: true })
      throw error
    } finally { await context.close() }
  })
}
