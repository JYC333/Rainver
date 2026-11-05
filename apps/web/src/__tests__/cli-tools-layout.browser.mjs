import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

// The built app's Command Center Host list and Host detail with its CLI tools
// section, and the Agents page without it. Every API answer is synthetic; no backend,
// Host, Feishu account or OAuth is touched. The login stream is proxied by
// the preview server to a local server that sends the official authorization
// event and stays open, as a waiting device flow does.
const shots = process.env.CLI_TOOLS_SHOTS ?? '/tmp/cli-tools-command-center-shots'
const space = 'space-cli'
const hostBase = { owner_user_id: null, platform: 'linux', arch: 'x64', daemon_version: '0.4.7', capabilities_json: null, created_at: '', updated_at: '', environment_kind: 'linux_native' }
const hosts = () => [
  { ...hostBase, id: 'builtin', machine_id: 'm-server', machine_name: 'Instance', name: 'server', kind: 'server', status: 'online', environment_kind: 'server', max_concurrent_runs: 2, last_heartbeat_at: new Date().toISOString() },
  // A Runtime copy on the paired Host, so its card shows a real Agent row beside the CLI rows.
  { ...hostBase, id: 'desk', machine_id: 'm-desk', machine_name: 'Desk workstation', name: 'Desk workstation', kind: 'remote', status: 'online', owner_user_id: 'user-cli', last_heartbeat_at: new Date().toISOString(),
    capabilities_json: { runtimes: ['claude'], versions: {}, installations: { claude_code: [{ id: 'own', version: '2.1.0', logged_in: true, options: null }] } } },
]
const runtimeDefinitions = [{ runtime_key: 'claude_code', display_name: 'Claude Code', command: 'claude', capability_probe: 'claude', remote_eligible: true, reports_managed_cli_version: true, supports_runtime_native: true, supports_model_provider: false, provider_api: 'claude_compatible' }]
const tool = (overrides) => ({
  tool_id: 'git', label: 'Git', executable: 'git', requires_account: false, host_status: 'available', reported_live: true,
  source: 'path', version: '2.43.0', version_text: 'git version 2.43.0', registered: false,
  managed: { catalog_version: null, installed_version: null, installable: false, update_available: false },
  sandbox_status: 'not_verified', account_status: 'not_applicable', ...overrides,
})
const lark = (overrides) => tool({ tool_id: 'lark_cli', label: 'Feishu / Lark CLI', executable: 'lark-cli', requires_account: true,
  account_status: 'not_verified', managed: { catalog_version: '1.0.99', installed_version: null, installable: true, update_available: false }, ...overrides })
const toolsFor = {
  // A member on the built-in Host: sees tools, manages only their own account.
  builtin: { host_id: 'builtin', host_state: 'online', can_manage: false, operations: [], tools: [
    tool({}), tool({ tool_id: 'curl', label: 'curl', executable: 'curl', version: '8.5.0' }),
    tool({ tool_id: 'jq', label: 'jq', executable: 'jq', host_status: 'missing', source: null, version: null }),
    lark({ host_status: 'available', source: 'managed', version: '1.0.99', managed: { catalog_version: '1.0.99', installed_version: '1.0.99', installable: true, update_available: false } }),
  ] },
  // The owner of a paired Host: may install and register.
  desk: { host_id: 'desk', host_state: 'online', can_manage: true, operations: [], tools: [tool({}), lark({ host_status: 'missing', source: null, version: null })] },
}
const accountFor = {
  builtin: { host_id: 'builtin', tool_id: 'lark_cli', availability: 'live', reason: null, session_active: false, sandbox_status: 'not_verified',
    status: { state: 'not_logged_in', account: null, reason: null } },
  desk: { host_id: 'desk', tool_id: 'lark_cli', availability: 'tool_unavailable', reason: 'The tool is not available on this Host.', session_active: false, sandbox_status: 'not_verified', status: null },
}

let sse
let sseOpen = 0
/** Lets CSS transitions (theme, disclosure) finish before a screenshot. */
const settled = page => page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 250)))
async function mockApi(page, counts, hostList = hosts) {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/api/v1', '')
    let data
    if (path === '/me') data = { id: 'user-cli', name: 'CLI tester', email: 'cli@example.test', default_space_id: space, instance_role: 'member', is_instance_admin: false }
    else if (path === '/me/spaces') data = [{ id: space, name: 'CLI Space', type: 'personal', role: 'owner' }]
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/hosts') { counts.hosts += 1; data = { items: hostList() } }
    else if (path === '/hosts/runtime-definitions') data = { items: runtimeDefinitions }
    else if (/^\/hosts\/[^/]+\/(usage|tool-operations)$/.test(path)) data = { items: [] }
    else if (path.endsWith('/runtime-provisioning/opencode')) data = { host_id: 'builtin', runtime_key: 'opencode', installation: { state: 'ready', desired_version: '1.2.3', installed_version: '1.2.3', active_version: '1.2.3', error: null, attempts: 1 }, native_account: { installation_id: 'managed:1.2.3', logged_in: false, accounts: [] } }
    else if (path === '/acp-agents' || path === '/acp-agents/registry') data = { items: [] }
    else if (path === '/agents') data = [{ id: 'agent-1', name: 'Research assistant', description: 'Reads and summarises sources', status: 'active', agent_kind: 'custom', model: null }]
    else if (path.endsWith('/runtime-profiles')) data = []
    else if (path.endsWith('/account/session/stream')) return route.continue()
    else if (/^\/hosts\/[^/]+\/ordinary-tools$/.test(path)) { counts.tools += 1; data = toolsFor[path.split('/')[2]] }
    else if (/^\/hosts\/[^/]+\/ordinary-tools\/lark_cli\/account$/.test(path)) data = accountFor[path.split('/')[2]]
    else if (path === '/me/agent-attention/snapshot') data = { type: 'attention.snapshot', seq: 1, version: 'cli', unread_count: 0, page: { items: [], total: 0, limit: 100, offset: 0 }, notices: [] }
    else if (path === '/me/agent-attention/stream') return route.fulfill({ status: 503, body: '' })
    else return route.fulfill({ status: 404, json: { detail: 'Unavailable in CLI tools fixture' } })
    return route.fulfill({ json: data })
  })
}

let server, browser, sseServer
let baseUrl = process.env.LAYOUT_BASE_URL
before(async () => {
  await mkdir(shots, { recursive: true })
  sseServer = createServer((request, response) => {
    sseOpen += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' })
    response.write(`data: ${JSON.stringify({ type: 'authorization', url: 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH', user_code: 'ABCD-EFGH', expires_in: 600 })}\n\n`)
    request.on('close', () => { sseOpen -= 1; response.end() })
  })
  await new Promise(resolve => sseServer.listen(0, '127.0.0.1', resolve))
  sse = `http://127.0.0.1:${sseServer.address().port}`
  if (!baseUrl) {
    server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0, proxy: { '^/api/v1/hosts/[^/]+/ordinary-tools/lark_cli/account/session/stream': sse } } })
    baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
})
after(async () => {
  await browser?.close()
  sseServer?.closeAllConnections?.()
  await new Promise(resolve => sseServer.close(resolve))
  if (server) await new Promise(resolve => server.httpServer.close(resolve))
})

async function noHorizontalOverflow(page, label) {
  const result = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(result.scroll <= result.viewport + 1, `${label}: ${JSON.stringify(result)}`)
}

const copy = {
  en: { show: host => `Show CLI tools for ${host}`, hide: host => `Hide CLI tools for ${host}`, login: 'Log in', cancel: 'Cancel', install: /Install 1\.0\.99/, tabTools: 'CLI tools', hosts: 'Execution environments', back: 'All environments', builtin: 'Built-in sandbox', runtimes: 'Agent Runtimes' },
  'zh-CN': { show: host => `${host}：显示 CLI 工具`, hide: host => `${host}：隐藏 CLI 工具`, login: '登录', cancel: '取消', install: /安装 1\.0\.99/, tabTools: 'CLI 工具', hosts: '执行环境', back: '全部执行环境', builtin: '内置沙箱', runtimes: 'Agent Runtime' },
}
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const hostButton = (page, c, name) => page.getByRole('navigation', { name: c.hosts }).getByRole('button', { name: new RegExp(name) })
const article = (page, name) => page.getByRole('article', { name })

for (const locale of ['en', 'zh-CN']) {
  for (const theme of ['dark', 'light']) {
    test(`Command Center Host list and detail (${locale}, ${theme})`, async () => {
      const counts = { hosts: 0, tools: 0 }
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' })
      const c = copy[locale]
      try {
        await page.addInitScript(value => localStorage.setItem('rainver:locale', value), locale)
        await mockApi(page, counts)
        const tag = `${locale}-${theme}`
        // The Agents page has no CLI tools view; its own actions stay.
        await page.goto(`${baseUrl}/spaces/${space}/agents`)
        if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
        await page.getByText('Research assistant').waitFor()
        assert.equal(await page.getByRole('tab').count(), 0)
        assert.equal(await page.getByText(c.tabTools, { exact: true }).count(), 0)
        await page.getByRole('link', { name: /New agent/ }).waitFor()
        await page.getByRole('link', { name: /Templates/ }).first().waitFor()
        await settled(page)
        await page.screenshot({ path: `${shots}/agents-${tag}-1280.png` })

        // Command Center: the Host list beside the instance Host's detail.
        await page.goto(`${baseUrl}/spaces/${space}/command-center`)
        if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
        await article(page, c.builtin).waitFor()
        assert.equal(await hostButton(page, c, c.builtin).getAttribute('aria-current'), 'true')
        await hostButton(page, c, 'Desk workstation').waitFor()
        assert.equal(await page.getByRole('article').count(), 1)
        assert.equal(counts.tools, 0)
        await noHorizontalOverflow(page, `${tag} parent 1280`)
        await settled(page)
        await page.screenshot({ path: `${shots}/command-center-${tag}-1280.png`, fullPage: true })

        // A history navigation that names this Host's CLI tools opens them in place.
        await page.evaluate(() => {
          window.history.pushState({}, '', `${location.pathname}?host=builtin&section=cli`)
          window.dispatchEvent(new PopStateEvent('popstate'))
        })
        await page.getByRole('button', { name: c.hide(c.builtin) }).waitFor()
        assert.equal(counts.tools > 0, true)
        await page.goBack()
        await page.getByRole('button', { name: c.show(c.builtin) }).waitFor()

        // The built-in Host for a member: tools, no Install, their own account.
        await page.getByRole('button', { name: c.show(c.builtin) }).click()
        await page.getByText('lark-cli').waitFor()
        assert.equal(await page.getByRole('button', { name: c.install }).count(), 0)
        await page.getByRole('button', { name: c.login, exact: true }).click()
        await page.getByText('ABCD-EFGH').waitFor()
        // The Host list refreshes every 3 s; the open login survives it.
        const before = counts.hosts
        await page.waitForTimeout(7_000)
        assert.ok(counts.hosts >= before + 2, `host list refreshed: ${before} -> ${counts.hosts}`)
        assert.equal(await page.getByText('ABCD-EFGH').count(), 1)
        assert.equal(sseOpen, 1)
        await settled(page)
        await page.screenshot({ path: `${shots}/cli-login-${tag}-1280.png`, fullPage: true })
        // The interaction named the Host in the URL, so a phone width keeps showing it.
        assert.match(new URL(page.url()).search, /host=builtin/)
        await page.setViewportSize({ width: 390, height: 900 })
        await frame(page)
        assert.equal(await page.getByText('ABCD-EFGH').isVisible(), true)
        assert.equal(sseOpen, 1)
        await noHorizontalOverflow(page, `${tag} login 390`)
        await settled(page)
        await page.screenshot({ path: `${shots}/cli-login-${tag}-390.png`, fullPage: true })
        // Back to the list on the phone leaves the Server detail: its login ends,
        // and opening the Server again shows no code from before.
        await page.getByRole('button', { name: c.back }).click()
        await page.getByRole('navigation', { name: c.hosts }).waitFor({ state: 'visible' })
        for (let i = 0; i < 20 && sseOpen > 0; i++) await page.waitForTimeout(100)
        assert.equal(sseOpen, 0)
        await hostButton(page, c, c.builtin).click()
        await page.getByRole('button', { name: c.show(c.builtin) }).waitFor({ state: 'visible' })
        assert.equal(await page.getByText('ABCD-EFGH').count(), 0)
        await page.setViewportSize({ width: 1280, height: 1000 })
        await frame(page)

        // Choosing another Host leaves this one: its login ends.
        await page.getByRole('button', { name: c.show(c.builtin) }).click()
        await page.waitForFunction(label => [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === label && !b.disabled), c.login)
        await page.getByRole('button', { name: c.login, exact: true }).click()
        await page.getByText('ABCD-EFGH').waitFor()
        assert.equal(sseOpen, 1)
        await hostButton(page, c, 'Desk workstation').click()
        await article(page, 'Desk workstation').waitFor()
        assert.equal(await page.getByText('ABCD-EFGH').count(), 0)
        for (let i = 0; i < 20 && sseOpen > 0; i++) await page.waitForTimeout(100)
        assert.equal(sseOpen, 0)
        assert.match(new URL(page.url()).search, /host=desk/)

        // The owner's paired Host: Runtime rows and CLI rows share one shape.
        await page.getByRole('button', { name: c.show('Desk workstation') }).click()
        await page.getByRole('button', { name: c.install }).waitFor()
        const agentRow = await page.getByTestId('host-agent-desk-claude_code').boundingBox()
        const toolRow = await page.getByTestId('host-cli-tool-desk-git').boundingBox()
        assert.ok(agentRow && toolRow, 'both rows render')
        assert.ok(Math.abs(agentRow.height - toolRow.height) <= 2, `row heights: agent ${agentRow.height}, tool ${toolRow.height}`)
        assert.ok(Math.abs(agentRow.x - toolRow.x) <= 1 && Math.abs(agentRow.width - toolRow.width) <= 1, `row boxes: ${JSON.stringify({ agentRow, toolRow })}`)
        const nameBoxes = await page.evaluate(() => ['host-agent-desk-claude_code', 'host-cli-tool-desk-git'].map(id => {
          const name = document.querySelector(`[data-testid="${id}"] span.font-medium`)?.getBoundingClientRect()
          return name ? { x: Math.round(name.x), width: Math.round(name.width) } : null
        }))
        assert.deepEqual(nameBoxes[0], nameBoxes[1])
        await settled(page)
        await page.screenshot({ path: `${shots}/cli-desk-${tag}-1280.png`, fullPage: true })

        // Phone: a link to a Host opens its detail alone; Back shows the list alone.
        await page.setViewportSize({ width: 390, height: 900 })
        await page.goto(`${baseUrl}/spaces/${space}/command-center?host=desk`)
        if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
        await article(page, 'Desk workstation').waitFor()
        assert.equal(await page.getByRole('navigation', { name: c.hosts }).isVisible(), false)
        await noHorizontalOverflow(page, `${tag} desk 390`)
        await settled(page)
        await page.screenshot({ path: `${shots}/mobile-detail-${tag}-390.png` })
        await page.getByRole('button', { name: c.back }).click()
        await hostButton(page, c, 'Desk workstation').waitFor()
        assert.equal(await page.getByRole('article').isVisible(), false)
        assert.doesNotMatch(new URL(page.url()).search, /host=/)
        await settled(page)
        await page.screenshot({ path: `${shots}/mobile-list-${tag}-390.png` })
      } finally {
        await page.close()
      }
    })
  }
}

test('Command Center with one Host shows it without a list', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' })
  try {
    await mockApi(page, { hosts: 0, tools: 0 }, () => hosts().slice(0, 1))
    await page.goto(`${baseUrl}/spaces/${space}/command-center`)
    await article(page, 'Built-in sandbox').waitFor()
    assert.equal(await page.getByRole('navigation', { name: 'Execution environments' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'All environments' }).count(), 0)
    await noHorizontalOverflow(page, 'single 390')
    await page.screenshot({ path: `${shots}/single-host-390.png`, fullPage: true })
    // A Host that is not there is said so, not swapped for the one that is.
    await page.goto(`${baseUrl}/spaces/${space}/command-center?host=nope`)
    await page.getByRole('alert').getByText('This Host is not available').waitFor()
    assert.equal(await page.getByRole('article').count(), 0)
    await page.screenshot({ path: `${shots}/unavailable-host-390.png` })
  } finally {
    await page.close()
  }
})

/** What has focus: its role, accessible label and text. */
const focused = page => page.evaluate(() => {
  const el = document.activeElement
  return { role: el?.getAttribute('role') ?? el?.tagName.toLowerCase(), label: el?.getAttribute('aria-label'), text: el?.textContent?.trim().slice(0, 40), expanded: el?.getAttribute('aria-expanded'), current: el?.getAttribute('aria-current') }
})
async function tabUntil(page, match, limit = 80, key = 'Tab') {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press(key)
    const now = await focused(page)
    if (match(now)) return now
  }
  throw new Error('focus never reached the target')
}

for (const width of [1280, 390]) {
  test(`Command Center Hosts and CLI tools by keyboard only (${width})`, async () => {
    const counts = { hosts: 0, tools: 0 }
    const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    try {
      await mockApi(page, counts)
      await page.goto(`${baseUrl}/spaces/${space}/command-center`)
      await page.getByRole('navigation', { name: 'Execution environments' }).getByRole('button', { name: /Desk workstation/ }).waitFor()
      if (width === 390) {
        // The instance Host's detail is already mounted (hidden) as the default;
        // choosing it still moves the keyboard into it, and Back returns.
        await tabUntil(page, f => f.role === 'button' && /^Built-in sandbox/.test(f.text ?? ''))
        await page.keyboard.press('Enter')
        await article(page, 'Built-in sandbox').waitFor({ state: 'visible' })
        // Focus moves in an effect after the navigation renders; wait for it, then assert.
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Built-in sandbox')
        assert.equal((await focused(page)).role, 'article')
        await tabUntil(page, f => f.text?.endsWith('All environments') ?? false, 3)
        await page.keyboard.press('Enter')
        await page.getByRole('navigation', { name: 'Execution environments' }).waitFor({ state: 'visible' })
        await page.waitForFunction(() => document.activeElement?.textContent?.trim().startsWith('Built-in sandbox'))
        assert.match((await focused(page)).text ?? '', /^Built-in sandbox/)
      }
      // Tab reaches the Host list; Enter opens the paired Host.
      await tabUntil(page, f => f.role === 'button' && /^Desk workstation/.test(f.text ?? ''))
      await page.keyboard.press('Enter')
      await article(page, 'Desk workstation').waitFor()
      if (width === 390) {
        // The pressed list button is hidden now; the keyboard is in the detail.
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Desk workstation')
        assert.equal((await focused(page)).role, 'article')
        await tabUntil(page, f => f.text?.endsWith('All environments') ?? false, 3)
        await page.keyboard.press('Enter')
        await page.getByRole('navigation', { name: 'Execution environments' }).getByRole('button', { name: /Desk workstation/ }).waitFor()
        // Back returns to the Host it left.
        await page.waitForFunction(() => document.activeElement?.textContent?.trim().startsWith('Desk workstation'))
        assert.match((await focused(page)).text ?? '', /^Desk workstation/)
        await page.keyboard.press('Enter')
        await article(page, 'Desk workstation').waitFor()
      }
      // On into the detail: its CLI tools toggle, then Install inside it.
      await tabUntil(page, f => f.label === 'Show CLI tools for Desk workstation', 30)
      await page.keyboard.press('Enter')
      await page.getByRole('button', { name: 'Install 1.0.99' }).waitFor()
      assert.equal((await focused(page)).label, 'Hide CLI tools for Desk workstation')
      await tabUntil(page, f => f.text === 'Install 1.0.99', 6)

      // The built-in Host: open it from the list, then its CLI tools, then Log in.
      if (width === 390) {
        await tabUntil(page, f => f.text?.endsWith('All environments') ?? false, 40, 'Shift+Tab')
        await page.keyboard.press('Enter')
        await page.getByRole('navigation', { name: 'Execution environments' }).getByRole('button', { name: /Desk workstation/ }).waitFor()
      }
      await tabUntil(page, f => f.role === 'button' && /^Built-in sandbox/.test(f.text ?? ''), 40, 'Shift+Tab')
      await page.keyboard.press('Enter')
      await article(page, 'Built-in sandbox').waitFor()
      await tabUntil(page, f => f.label === 'Show CLI tools for Built-in sandbox', 40)
      await page.keyboard.press('Enter')
      await page.getByText('lark-cli').waitFor()
      // The account card reads its account after the tool list; Log in exists,
      // and can take focus, only once that read is done.
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Log in' && !b.disabled))
      await tabUntil(page, f => f.role === 'button' && f.text === 'Log in', 30)
      await page.keyboard.press('Enter')
      await page.getByText('ABCD-EFGH').waitFor()
      assert.equal((await focused(page)).text, 'Cancel')
      // Escape belongs to nothing here (no dialog or menu); the session stays.
      await page.keyboard.press('Escape')
      assert.equal(await page.getByText('ABCD-EFGH').count(), 1)
      await settled(page)
      await page.screenshot({ path: `${shots}/keyboard-login-${width}.png`, fullPage: width === 390 })
      await page.keyboard.press('Enter')
      await page.getByText('Cancelled.').waitFor()
      assert.equal((await focused(page)).text, 'Cancelled.')
      assert.equal(await page.getByText('ABCD-EFGH').count(), 0)
      await noHorizontalOverflow(page, `keyboard ${width}`)
    } finally {
      await page.close()
    }
  })
}
