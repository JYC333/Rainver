import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { run, turn, work, workRun, page as attentionPage } from '../modules/agent_work/fixtures.test-support.ts'
import {workspaceChange} from '../modules/runs/workspaceFixtures.test-support.ts'

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

async function fixtures(page, counts, recoveryRun = failed, liveParts = null) {
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
          window.__recoveryTurnFrame = frame => controller.enqueue(new TextEncoder().encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`))
          controller.enqueue(new TextEncoder().encode(`event: turn.snapshot\ndata: ${JSON.stringify({ type: 'turn.snapshot', turn: live })}\n\n`))
          abort = () => controller.error(new DOMException('Aborted', 'AbortError'))
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
        },
        cancel() { signal?.removeEventListener('abort', abort) },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
  }, { id: failed.id, live: turn({ run_id: failed.id, state: 'working', source: 'host_thread_events', parts: liveParts ?? [
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
    else if (path.endsWith('/messages')) data = { ...pageOf(liveParts ? messages.filter(message => message.role !== 'assistant') : recoveryRun.status === 'running' ? messages.map(message => message.role === 'assistant' ? { ...message, content: '' } : message) : messages), queued: [] }
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
      const live = turn({ run_id: failed.id, state: recoveryRun.status === 'running' ? 'working' : 'error', source: 'host_thread_events', parts: liveParts ?? [
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
      ? turn({ run_id: failed.id, state: 'working', source: 'host_thread_events', parts: liveParts ?? [
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

for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
  test(`live prose stays visible with collapsed tools: ${locale}/${theme}/${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    await context.addInitScript(({ locale, theme }) => {
      localStorage.setItem('rainver:locale', locale)
      localStorage.setItem('rainver:theme', theme)
    }, { locale, theme })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    try {
      const tool = (index, name) => ({ type: 'tool_call', index, call_id: `c${index}`, name, kind: 'read', status: 'succeeded', input: null, output: 'Tool details stay collapsed.' })
      await fixtures(page, { writes: 0, logins: 0 }, { ...failed, status: 'running', ended_at: null, error_message: null, error_json: null }, [
        { type: 'text', index: 0, text: 'Inspecting the conversation.' },
        tool(1, 'read_file'), tool(2, 'search_code'),
        { type: 'text', index: 3, text: 'Checking how messages are displayed.' },
        tool(4, 'run_checks'),
      ])
      await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      await page.getByText('Inspecting the conversation.', { exact: true }).waitFor()
      await page.getByText('Checking how messages are displayed.', { exact: true }).waitFor()
      assert.equal(await page.getByText('Tool details stay collapsed.', { exact: true }).count(), 0)
      assert.equal(await page.getByText('read_file', { exact: true }).count(), 0)
      const group = page.getByRole('button', { name: /search_code/ })
      assert.equal(await group.getAttribute('aria-expanded'), 'false')
      await capture(page, `live-prose-${locale}-${theme}-${width}`)
      await group.focus()
      await page.keyboard.press('Enter')
      await page.getByText('read_file', { exact: true }).waitFor()
      await page.getByText('Inspecting the conversation.', { exact: true }).waitFor()
      assert.equal(await page.getByText('Tool details stay collapsed.', { exact: true }).count(), 0)
      await page.getByRole('button', { name: /read_file/ }).click()
      await page.getByText('Tool details stay collapsed.', { exact: true }).waitFor()
      await capture(page, `live-prose-expanded-${locale}-${theme}-${width}`)
      const finalText = 'Final conversation conclusion.'
      await page.route('**/api/v1/**/messages*', route => route.fulfill({ json: {
        ...pageOf(messages.map(message => message.role === 'assistant' ? { ...message, content: finalText } : message)), queued: [],
      } }))
      await page.route(`**/api/v1/runs/${failed.id}`, route => route.fulfill({ json: { ...failed, status: 'succeeded', error_message: null, error_json: null } }))
      await page.evaluate(({ id, finalText }) => {
        window.__recoveryTurnFrame({ type: 'turn.part_appended', run_id: id, cursor: 6, part: { type: 'text', index: 5, text: finalText } })
        window.__recoveryTurnFrame({ type: 'turn.state_changed', run_id: id, state: 'done', blocked_on: null })
      }, { id: failed.id, finalText })
      await page.getByText(finalText, { exact: true }).waitFor()
      assert.equal(await page.getByText('Inspecting the conversation.', { exact: true }).count(), 0)
      assert.equal(await page.getByText('Checking how messages are displayed.', { exact: true }).count(), 0)
      assert.equal(await page.getByText('Tool details stay collapsed.', { exact: true }).count(), 0)
      const history = page.getByRole('button', { name: locale === 'en' ? /show work/ : /显示过程/ })
      assert.equal(await history.getAttribute('aria-expanded'), 'false')
      await page.getByText(finalText, { exact: true }).scrollIntoViewIfNeeded()
      await capture(page, `live-prose-completed-${locale}-${theme}-${width}`)
      await history.click()
      await page.getByText('Inspecting the conversation.', { exact: true }).waitFor()
      await page.getByText('Checking how messages are displayed.', { exact: true }).waitFor()
      assert.equal(await page.getByText(finalText, { exact: true }).count(), 1)
    } finally { await context.close() }
  })
}

for(const locale of ['en','zh-CN'])for(const width of [390,1280]){
 test(`final reply folds buffered progress: ${locale}/${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(locale=>localStorage.setItem('rainver:locale',locale),locale);
  const page=await context.newPage();page.setDefaultTimeout(10000);
  const finalText='Only the final answer.',progress='Checking the earlier changes.';
  const source={...failed,status:'succeeded',error_message:null,error_json:null};
  try{
   await fixtures(page,{writes:0,logins:0},source);
   await page.route('**/api/v1/**/messages*',route=>route.fulfill({json:{...pageOf(messages.map(m=>m.role==='assistant'?{...m,content:finalText}:m)),queued:[]}}));
   await page.route(`**/api/v1/runs/${failed.id}/turn`,route=>route.fulfill({json:turn({run_id:failed.id,state:'done',source:'host_thread_events',parts:[
    {type:'text',index:0,text:progress},{type:'text',index:1,text:finalText},
   ]})}));
   await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`);
   await page.getByText(finalText,{exact:true}).waitFor();
   assert.equal(await page.getByText(progress,{exact:true}).count(),0);
   await page.getByRole('button',{name:locale==='en'?/show work/:/显示过程/}).click();
   await page.getByText(progress,{exact:true}).waitFor();
   assert.equal(await page.getByText(finalText,{exact:true}).count(),1);
   await capture(page,`final-reply-${locale}-${width}`);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }finally{await context.close()}
 });
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

for (const [locale, width] of [['en', 1280], ['zh-CN', 390]]) {
  test(`verification failure preserves reply · ${locale} · ${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    await context.addInitScript(locale => localStorage.setItem('rainver:locale', locale), locale)
    const page = await context.newPage(), counts = { writes: 0, logins: 0, writePaths: [] }, errors = []
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message))
    const answer = locale === 'en' ? 'The investigation is complete and the changes are preserved.' : '调查已经完成，修改已经保留。'
    const note = locale === 'en' ? 'Run verification did not pass: the check could not start.' : '本轮校验未通过：检查未能启动。'
    const content = `${answer}\n\n${note}`
    try {
      await fixtures(page, counts, { ...failed, error_message: 'test checks could not run', error_json: { error_code: 'verification_failed' }, output_json: { schema_version: 'run_output.v1', status: 'failed', summary: answer, result: {}, output_manifest: [] } })
      await page.route('**/api/v1/**', async route => {
        const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
        if (path.endsWith('/messages')) return route.fulfill({ json: { ...pageOf(messages.map(message => message.role === 'assistant' ? { ...message, content, metadata_json: { status: 'failed', error_code: 'verification_failed' } } : message)), queued: [] } })
        const saved = turn({ run_id: failed.id, state: 'error', source: 'host_thread_events', parts: [{ type: 'text', index: 0, text: answer }] })
        if (path === `/runs/${failed.id}/turn`) return route.fulfill({ json: saved })
        if (path === `/runs/${failed.id}/turn/stream`) return route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: `event: turn.snapshot\ndata: ${JSON.stringify({ type: 'turn.snapshot', turn: saved })}\n\n` })
        return route.fallback()
      })
      await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      await page.getByText(answer, { exact: true }).waitFor()
      await page.getByText(note, { exact: true }).waitFor()
      assert.equal(await page.getByText('Room task failed', { exact: false }).count(), 0)
      assert.deepEqual(counts.writePaths.filter(path => path !== '/me/agent-attention/views'), [])
      assert.equal(counts.logins, 0); assert.deepEqual(errors, [])
      await capture(page, `verification-reply-${locale}-${width}`)
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

for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280]){
 test(`workspace continuation and retained actions: ${locale}/${theme}/${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'})
  await context.addInitScript(locale=>localStorage.setItem('rainver:locale',locale),locale)
  const page=await context.newPage(),counts={writes:0,logins:0,writePaths:[]},errors=[]
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message))
  try{
   await fixtures(page,counts,{...failed,contract_snapshot_json:{execution_workspace_version:1},
    error_message:'workspace_permission_violation_needs_review',error_json:{error_code:'execution_workspace_unavailable'},
    workspace_changes:[
     workspaceChange({workspace_id:'fresh',change_set_id:'fresh-change',generation:2,source_commit:null,integration_detail:{continuation_from_workspace_id:'retained'}}),
     workspaceChange({workspace_id:'retained',change_set_id:'retained-change',state:'blocked',workspace_state:'blocked',source_commit:null,integration_detail:{checkpoint_blocked:true}}),
    ]})
   const continuation=locale==='en'?'This turn uses a fresh workspace. Earlier changes are preserved separately.':'本轮使用新工作区继续，之前的修改单独保留。'
   const keep=locale==='en'?'Keep without merging':'保留成果，不合并'
   for(const [surface,path] of [['conversation',`/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`],['run',`/runs/${failed.id}`]]){
    await page.goto(`${baseUrl}/spaces/${space}${path}`)
    if(theme==='light')await page.evaluate(()=>document.documentElement.classList.add('theme-light'))
    const card=page.getByTestId(`workspace-changes-${failed.id}`).first()
    await card.getByText(continuation,{exact:true}).waitFor()
    await card.scrollIntoViewIfNeeded()
    assert.equal(await card.getByRole('button',{name:keep,exact:true}).last().isEnabled(),true)
    await capture(page,`workspace-${surface}-${locale}-${theme}-${width}`)
   }
   assert.deepEqual(counts.writePaths.filter(path=>path!=='/me/agent-attention/views'),[])
   assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
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

for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280]){
 test(`conversation conflict decisions and shared recovery: ${locale}/${theme}/${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'})
  await context.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme)},{locale,theme})
  const page=await context.newPage(),counts={writes:0,logins:0,writePaths:[]},errors=[],resolutions=[]
  page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message))
  const repair=run({...failed,id:'repair-decision',status:'waiting_for_review',contract_snapshot_json:{execution_workspace_version:1,workspace_integration_id:'fixture-integration'},error_message:'Conflict repair process exited with code 1.',error_json:{supervisor_review:true,error_code:'runtime_nonzero_exit'}})
  const source={...failed,status:'succeeded',error_message:null,error_json:null,contract_snapshot_json:{execution_workspace_version:1},workspace_changes:[
   workspaceChange({change_set_id:'repair-change',state:'integrating',integration_status:'resolving',resolution_run_id:repair.id}),
   workspaceChange({change_set_id:'conflict-change',state:'blocked',integration_id:'conflict-integration',integration_revision:9,integration_status:'conflict',integration_detail:{error:'integration_requires_semantic_decision',conflicted_files:['plan.md']}}),
  ]}
  const item=work({title:'Conflict recovery conversation',space_id:space,project_id:project.id,identity:{kind:'session',source_id:session.id},group:'needs_you',read_states:[],runs:[workRun({run_id:repair.id,status:'waiting_for_review',turn_state:'blocked',blocked_on:'run_decision',session_id:session.id,room_id:room.id})],reasons:[{kind:'run_decision',run_id:repair.id,responsible:{kind:'user',id:'user-recovery',display_name:'Recovery tester'}}],operations:[{kind:'open_session',space_id:space,session_id:session.id,room_id:room.id,agent_id:agent.id}]})
  const items=attentionPage([item],{counts:{needs_you:1,recently_finished:0,working:0,waiting:0,idle:0}})
  try{
   await fixtures(page,counts,source)
   await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname.replace('/api/v1','')
    if(path===`/runs/${repair.id}`)return route.fulfill({json:repair})
    if(path===`/runs/${repair.id}/turn`)return route.fulfill({json:turn({run_id:repair.id,state:'blocked',blocked_on:'run_decision'})})
    if(path===`/runs/${repair.id}/route-decision`)return route.fulfill({json:null})
    if(path===`/runs/${repair.id}/io`)return route.fulfill({json:{schema_version:'run_io.v1',run_id:repair.id,input:{},output:null,events:[],artifact_refs:[]}})
    if(path===`/runs/${repair.id}/resume`){counts.writePaths.push(path);repair.status='queued';return route.fulfill({status:202,json:{id:repair.id,status:'queued'}})}
    if(path==='/actions/workspace.integration.retry'){
     resolutions.push(route.request().postDataJSON());assert.ok(route.request().headers()['idempotency-key']);
     source.workspace_changes[1]={...source.workspace_changes[1],state:'integrating',integration_status:'queued'}
     return route.fulfill({json:{status:'completed',data:{change_set_id:'conflict-change',revision:3,state:'integrating',integration_id:'conflict-integration'}}})
    }
    if(path==='/me/agent-attention')return route.fulfill({json:items})
    if(path==='/me/agent-attention/item')return route.fulfill({json:item})
    if(path==='/me/agent-attention/snapshot')return route.fulfill({json:{type:'attention.snapshot',seq:1,version:'decisions',unread_count:1,page:items,notices:[]}})
    if(path==='/me/agent-attention/views')return route.fulfill({json:{read_count:0,read_states:[]}})
    if(path===`/runs/${repair.id}/attempts`)return route.fulfill({json:{attempts:[],supervisor_decisions:[]}})
    return route.fallback()
   })
   const retry=locale==='en'?'Retry execution':'重新尝试执行',resolve=locale==='en'?'Resolve conflict':'处理冲突'
   await page.goto(`${baseUrl}/agent-work`)
   if(theme==='light')await page.evaluate(()=>document.documentElement.classList.add('theme-light'))
   await page.getByRole('button',{name:/Conflict recovery conversation/}).click()
   await page.getByRole('button',{name:retry,exact:true}).waitFor()
   assert.equal(await page.getByRole('button',{name:retry,exact:true}).count(),1)
   await page.getByRole('button',{name:retry,exact:true}).scrollIntoViewIfNeeded()
   await capture(page,`decision-work-${locale}-${theme}-${width}`)
   await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
   if(theme==='light')await page.evaluate(()=>document.documentElement.classList.add('theme-light'))
   await page.getByRole('button',{name:retry,exact:true}).waitFor()
   await page.getByText(locale==='en'?'This background task handles an earlier code change. You can continue chatting independently.':'这是处理之前代码修改的后台任务，你可以继续在原对话中发消息。',{exact:true}).waitFor()
   assert.equal(await page.getByRole('button',{name:locale==='en'?'Abandon Run':'放弃 Run',exact:true}).isEnabled(),true)
   await page.getByRole('button',{name:resolve,exact:true}).scrollIntoViewIfNeeded()
   await capture(page,`decision-conversation-${locale}-${theme}-${width}`)
   await page.getByRole('button',{name:resolve,exact:true}).click()
   const dialog=page.getByRole('dialog'),confirm=dialog.getByRole('button',{name:locale==='en'?'Confirm':'确认',exact:true})
   assert.equal(await confirm.isEnabled(),false)
   const instruction=locale==='en'?'Keep the dev version of plan.md.':'保留 dev 中的 plan.md。'
   await dialog.getByRole('textbox',{name:locale==='en'?'Conflict resolution instruction':'冲突处理说明'}).fill(instruction)
   await dialog.evaluate(async element=>{await Promise.all(element.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})))})
   const bounds=await dialog.boundingBox();assert.ok(bounds&&bounds.x>=-1&&bounds.x+bounds.width<=width+1,JSON.stringify(bounds))
   await dialog.getByRole('textbox').press('Tab');await page.keyboard.press('Tab')
   assert.equal(await confirm.evaluate(element=>element===document.activeElement),true)
   await capture(page,`decision-dialog-${locale}-${theme}-${width}`)
   await confirm.press('Enter');await dialog.waitFor({state:'hidden'})
   assert.deepEqual(resolutions,[{integration_id:'conflict-integration',expected_revision:9,resolution:instruction}])
   await page.goto(`${baseUrl}/spaces/${space}/runs/${repair.id}`)
   if(theme==='light')await page.evaluate(()=>document.documentElement.classList.add('theme-light'))
   await page.getByRole('button',{name:retry,exact:true}).waitFor()
   await capture(page,`decision-run-${locale}-${theme}-${width}`)
   await page.getByRole('button',{name:retry,exact:true}).click()
   await page.getByRole('button',{name:retry,exact:true}).waitFor({state:'hidden'})
   assert.deepEqual(counts.writePaths.filter(path=>path!=='/me/agent-attention/views'),[`/runs/${repair.id}/resume`])
   assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
}

for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280]){
 test(`integration outcome in original conversation: ${locale}/${theme}/${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'})
  await context.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme)},{locale,theme})
  const page=await context.newPage(),counts={writes:0,logins:0,writePaths:[]},errors=[]
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000)
  const source={...failed,status:'succeeded',error_json:null,error_message:null,contract_snapshot_json:{execution_workspace_version:1},workspace_changes:[workspaceChange({integration_id:'notice-integration',attempt_id:'notice-attempt',state:'blocked',integration_status:'verification_failed',candidate_commit:'c'.repeat(40),integration_detail:{error:'verification_unconfigured'}})]}
  const notice={id:'outcome-notice',session_id:session.id,space_id:space,role:'system',user_id:null,sender_agent_id:null,run_id:null,content:'The isolated change is preserved.',created_at:'2026-11-07T16:28:51Z',metadata_json:{room_display:'system_notice',execution_event:'workspace_integration',execution_event_key:'notice-integration:notice-attempt:verification_failed',execution_details:{run_id:failed.id,integration_id:'notice-integration',outcome:'verification_failed'}}}
  try{
   await fixtures(page,counts,source)
   await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname.replace('/api/v1','')
    if(path.endsWith('/messages'))return route.fulfill({json:path.startsWith('/sessions/')?[...messages,notice]:{...pageOf([...messages,notice]),queued:[]}})
    if(path===`/agents/${agent.id}/conversation-backends`)return route.fulfill({json:{options:[{runtime_profile_id:'runtime-1',name:'Managed',runtime_key:'opencode',model_name:'gpt-test'}],binding:null}})
    if(path===`/runtime-context/work-contexts/${session.id}/retrieval`)return route.fulfill({json:{work_context_scope_id:session.id,enabled:false,preferred_domains:[],setup_version:null}})
    return route.fallback()
   })
   await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
   if(theme==='light')await page.evaluate(()=>document.documentElement.classList.add('theme-light'))
   const result=page.getByTestId('integration-notice-outcome-notice')
   await result.getByText(locale==='en'?'Verification incomplete · not integrated into dev':'验证未完成 · 未合入 dev',{exact:true}).waitFor()
   await result.getByText(locale==='en'?'No verification checks ran: this project folder has no configured test/build checks.':'尚未执行任何验证检查：这个项目文件夹没有配置测试或构建验证命令。',{exact:true}).waitFor()
   await result.getByText(locale==='en'?'An isolated candidate version has been built.':'已构建隔离的候选版本。',{exact:true}).waitFor()
   await result.scrollIntoViewIfNeeded();await capture(page,`integration-outcome-${locale}-${theme}-${width}`)
   const details=result.getByRole('link',{name:locale==='en'?'Run details':'运行详情',exact:true})
   assert.ok((await details.getAttribute('href')).includes(`/spaces/${space}/runs/${failed.id}`))
   await details.focus();await details.press('Enter');await page.waitForURL(`**/runs/${failed.id}`)
   await page.goBack();await result.waitFor();await result.getByRole('button',{name:locale==='en'?'Refresh':'刷新',exact:true}).press('Enter')
   await page.goto(`${baseUrl}/spaces/${space}/agents/${agent.id}/chat?session=${session.id}`)
   if(theme==='light')await page.evaluate(()=>document.documentElement.classList.add('theme-light'))
   await result.getByText(locale==='en'?'Verification incomplete · not integrated into dev':'验证未完成 · 未合入 dev',{exact:true}).waitFor()
   await result.scrollIntoViewIfNeeded();await capture(page,`integration-direct-${locale}-${theme}-${width}`)
   assert.deepEqual(counts.writePaths.filter(path=>path!=='/me/agent-attention/views'),[]);assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
}

// Agent verification acceptance: no human command or internal-ID form.
for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280]){
 test(`Agent verification without human configuration: ${locale}/${theme}/${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'})
  await context.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme)},{locale,theme})
  const page=await context.newPage(),counts={writes:0,logins:0,writePaths:[]},errors=[],commands=[]
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message))
  const source={...failed,status:'succeeded',error_json:null,error_message:null,contract_snapshot_json:{execution_workspace_version:1},workspace_changes:[workspaceChange({integration_id:'notice-integration',attempt_id:'notice-attempt',state:'blocked',integration_status:'verification_failed',candidate_commit:'c'.repeat(40),integration_detail:{error:'verification_unconfigured'}})]}
  const notice={id:'configure-notice',session_id:session.id,space_id:space,role:'system',user_id:null,sender_agent_id:null,run_id:null,content:'The isolated change is preserved.',created_at:now,metadata_json:{room_display:'system_notice',execution_event:'workspace_integration',execution_event_key:'notice-integration:notice-attempt:verification_failed',execution_details:{run_id:failed.id,integration_id:'notice-integration',outcome:'verification_failed'}}}
  const config={integration_id:'notice-integration',change_set_id:'change',project_id:project.id,folder_id:'folder',folder_name:'Rainver Dev Folder',config_version:null,test_commands:[],build_commands:[],validation_recipe_id:null,integration_revision:9,can_retry:true,conversation_id:session.id,room_id:room.id,agent_id:agent.id,source_commit:'b'.repeat(40)}
  const title=locale==='en'?'Let Agent verify and integrate':'让 Agent 验证并合并'
  try{
   await fixtures(page,counts,source)
   await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname.replace('/api/v1','')
    if(path.endsWith('/messages')&&route.request().method()==='POST'){commands.push({path,input:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});return route.fulfill({json:{message:{id:'continued'},conversation:session,task_group_ids:[],run_ids:['current-run']}})}
    if(path.endsWith('/messages'))return route.fulfill({json:path.startsWith('/sessions/')?[...messages,notice]:{...pageOf([...messages,notice]),queued:[]}})
    if(path==='/queries/workspace.integration.verification.get')return route.fulfill({json:{status:'succeeded',data:config}})
    if(path==='/actions/workspace.integration.retry'){
     commands.push({path,input:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']})
     return route.fulfill({json:{status:'succeeded',data:{change_set_id:'change',revision:10,state:'integrating',integration_id:'notice-integration'}}})
    }
    if(path==='/actions/workspace.integration.verification.configure'||path==='/actions/workspace.integration.retry')throw new Error('Users must not configure commands')
    return route.fallback()
   })
   await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
   const parent=page.getByTestId('integration-notice-configure-notice')
   await parent.getByRole('button',{name:title,exact:true}).waitFor();await parent.scrollIntoViewIfNeeded();await capture(page,`agent-verification-entry-${locale}-${theme}-${width}`)
   assert.deepEqual(commands,[]);assert.equal(await page.getByRole('dialog').count(),0)
   const action=parent.getByRole('button',{name:title,exact:true});await action.focus();await action.press('Enter')
   await parent.getByRole('status').first().waitFor();assert.equal(await page.getByRole('dialog').count(),0)
   await capture(page,`agent-verification-queued-${locale}-${theme}-${width}`)
   await page.goto(`${baseUrl}/spaces/${space}/runs/${failed.id}`)
   const runAction=page.getByRole('button',{name:title,exact:true});await runAction.waitFor();await runAction.scrollIntoViewIfNeeded()
   await capture(page,`agent-verification-run-${locale}-${theme}-${width}`)
   await runAction.click();await page.getByRole('status').filter({hasText:locale==='en'?'original conversation':'原对话'}).first().waitFor()
   assert.equal(await page.getByRole('dialog').count(),0)
   assert.deepEqual(commands.map(c=>c.path),Array(2).fill(`/rooms/${room.id}/conversations/${session.id}/messages`))
   assert.ok(commands.every(c=>c.input.recipient_segments[0].recipient_agent_ids[0]===agent.id&&c.key));assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
}

// Workspace publication recovery acceptance.
for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280]){
 test(`finish changes and reconcile without manual IDs: ${locale}/${theme}/${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'})
  await context.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme)},{locale,theme})
  const page=await context.newPage(),counts={writes:0,logins:0,writePaths:[]},errors=[],commands=[]
  page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message))
  const source={...failed,status:'succeeded',error_json:null,error_message:null,contract_snapshot_json:{execution_workspace_version:1},workspace_changes:[
   workspaceChange({change_set_id:'new-change',state:'open',base_commit:'a'.repeat(40),source_commit:'b'.repeat(40),integration_id:null}),
   workspaceChange({change_set_id:'old-change',state:'blocked',integration_id:'old-integration',integration_revision:9,integration_status:'conflict',integration_detail:{error:'integration_requires_semantic_decision',conflicted_files:['plan.md']}}),
  ]}
  try{
   await fixtures(page,counts,source)
   await page.route('**/api/v1/actions/**',async route=>{
    const path=new URL(route.request().url()).pathname.replace('/api/v1',''),input=route.request().postDataJSON()
    commands.push({path,input,key:route.request().headers()['idempotency-key']})
    return route.fulfill({json:{status:'succeeded',data:{change_set_id:input.change_set_id??'old-change',state:'ready',revision:10,integration_id:input.integration_id??null}}})
   })
   await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
   const card=page.getByTestId(`workspace-changes-${source.id}`),submit=card.getByRole('button',{name:locale==='en'?'Finish changes':'完成修改',exact:true})
   await submit.waitFor();await submit.scrollIntoViewIfNeeded();await capture(page,`publication-entry-${locale}-${theme}-${width}`)
   await submit.focus();await submit.press('Enter')
   const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:locale==='en'?'Confirm':'确认',exact:true}).waitFor();assert.equal(await dialog.getByLabel(/commit ID|提交 ID/).count(),0)
   await dialog.evaluate(async el=>{await Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{})))})
   const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width&&box.y>=0)
   await capture(page,`publication-dialog-${locale}-${theme}-${width}`)
   const confirm=dialog.getByRole('button',{name:locale==='en'?'Confirm':'确认',exact:true});await confirm.focus();await confirm.press('Enter');await dialog.waitFor({state:'hidden'})
   assert.equal(commands[0].path,'/actions/workspace.change.complete');assert.equal(Object.hasOwn(commands[0].input,'commit'),false);assert.equal(commands[0].input.change_set_id,'new-change')
   const reconcile=card.getByRole('button',{name:locale==='en'?'Check whether already integrated':'核对是否已合入',exact:true});await reconcile.focus();await reconcile.press('Enter')
   await page.waitForFunction(()=>!document.querySelector('[role=dialog]'))
   await card.getByRole('button',{name:locale==='en'?'Refresh':'刷新',exact:true}).waitFor({state:'visible'})
   assert.equal(commands[1].path,'/actions/workspace.integration.retry');assert.deepEqual(commands[1].input,{integration_id:'old-integration',expected_revision:9,reconcile_only:true});assert.ok(commands.every(c=>c.key));assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
}

for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280]){
 test(`native workspace merge follows the original conversation: ${locale}/${theme}/${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme)},{locale,theme});
  const page=await context.newPage(),counts={writes:0,logins:0,writePaths:[]},commands=[],errors=[];
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  const source={...failed,status:'succeeded',error_json:null,error_message:null,contract_snapshot_json:{execution_workspace_version:1},workspace_changes:[workspaceChange({native_integration:true})]};
  const status={change_set_id:'change',revision:2,state:'open',integration_id:null,progress:null,can_retry:true,integration_status:null,folder_name:'Rainver Dev Folder',source_commit:'b'.repeat(40),conversation_id:session.id,room_id:room.id,agent_id:agent.id};
  const label=locale==='en'?'Let Agent verify and integrate':'让 Agent 验证并合并';
  try{
   await fixtures(page,counts,source);
   await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname.replace('/api/v1','');
    if(path==='/queries/workspace.change.get')return route.fulfill({json:{status:'succeeded',data:status}});
    if(path.endsWith('/messages')&&route.request().method()==='POST'){commands.push({path,input:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});return route.fulfill({json:{message:{id:'native-followup'},conversation:session,task_group_ids:[],run_ids:['native-run']}});}
    if(path.startsWith('/actions/workspace.'))throw new Error('Native merge must use the ordinary conversation ingress');
    return route.fallback();
   });
   await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`);
   const card=page.getByTestId(`workspace-changes-${failed.id}`).first();await card.getByRole('button',{name:label,exact:true}).waitFor();await card.scrollIntoViewIfNeeded();await capture(page,`native-merge-conversation-${locale}-${theme}-${width}`);
   await card.getByRole('button',{name:label,exact:true}).click();await card.getByRole('status').filter({hasText:locale==='en'?'original conversation':'原对话'}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
   await page.goto(`${baseUrl}/spaces/${space}/runs/${failed.id}`);
   const action=page.getByRole('button',{name:label,exact:true});await action.waitFor();await action.scrollIntoViewIfNeeded();await capture(page,`native-merge-run-${locale}-${theme}-${width}`);
   await action.focus();await action.press('Enter');await page.getByRole('status').filter({hasText:locale==='en'?'original conversation':'原对话'}).first().waitFor();
   assert.deepEqual(commands.map(c=>c.path),Array(2).fill(`/rooms/${room.id}/conversations/${session.id}/messages`));assert.ok(commands.every(c=>c.key&&c.input.recipient_segments[0].recipient_agent_ids[0]===agent.id));assert.equal(await page.getByRole('dialog').count(),0);assert.deepEqual(errors,[]);
  }finally{await context.close();}
 });
}
