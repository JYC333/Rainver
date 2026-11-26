import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { gmailUiEn } from '../i18n/gmailUi.en.ts'
import { gmailUiZhCN } from '../i18n/gmailUi.zh-CN.ts'

// The built app's personal Gmail surfaces with synthetic APIs only (no Google,
// no real mailbox): the Sources page entry beside its neighbours, the Access
// page (connections, consent link, not configured, disconnect receipt, new-mail
// monitoring with a draft to accept), the OAuth callback landing, the Project
// Sources panel (earlier selections only; manual search was retired) and the
// thread reader.
// Both themes and bundled locales at a phone and a desktop width. Screenshots
// go to GMAIL_SHOTS (default /tmp/rainver-gmail-shots) for visual inspection.
const shots = process.env.GMAIL_SHOTS ?? '/tmp/rainver-gmail-shots'
mkdirSync(shots, { recursive: true })
const now = '2026-11-16T09:00:00.000Z'
const space = { id: 'space-mail', name: 'Family Space', type: 'team', role: 'member' }
const project = { id: 'project-mail', space_id: space.id, owner_user_id: 'user-other', name: 'House renovation', description: null, status: 'active', current_focus: null,
  settings_json: null, active_brief_version_id: null, created_at: now, updated_at: now, archived_at: null, current_user_can_read: true, current_user_can_write: true }
const applicationsDescriptor = {
  id: 'phd_application', version: '1.0.0',
  frontend_entries: ['board', 'summary'].map(entry => ({
    module_id: `plugin.phd_application.${entry}`, entry_id: entry, label: 'PhD Application', path: `/plugins/phd_application/${entry}`,
    icon: 'graduation-cap', section: 'knowledge', group: 'work', placements: [entry === 'board' ? 'project.area' : 'project.overview.card'],
  })),
}
const other = { ...project, id: 'project-other', name: 'Holiday plans' }
const agent = { id: 'agent-manager', space_id: space.id, name: 'Mail Assistant', status: 'active', agent_kind: 'system_assistant' }
const room = { id: 'room-mail', space_id: space.id, project_id: project.id, title: 'House renovation', status: 'active', is_mainline: true }
const privateSession = 'session-private-mail'
const roomSession = { id: 'room-session-mail', room_id: room.id, space_id: space.id, project_id: project.id, title: 'Work updates',
  status: 'active', created_at: now, updated_at: now }
const summary = 'The builder sent the revised quote.'
const link = id => `https://mail.google.com/mail/u/?authuser=avery@example.test#all/${id}`
const conn = (id, email, status) => ({ id, mailbox_email: email, status, granted_scopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
  last_error_class: status === 'reauth_required' ? 'invalid_grant' : null, connected_at: '2026-11-02T08:30:00.000Z',
  disconnected_at: status === 'disconnected' ? '2026-11-10T10:00:00.000Z' : null, agent_read_enabled: false, agent_read_grants: [], updated_at: now })
const legacySelection = { id: 'sel-1', project_id: project.id, connection_id: 'conn-active', google_thread_id: '18c1a', read_after: null, read_before: null,
  project_readable: true, gmail_url: link('18c1a'), created_at: '2026-11-03T10:00:00.000Z', updated_at: now }
const criteria = { from_any: ['@builders.example', 'permits@city.example'], subject_any: ['quote', 'inspection'], label_any: [] }
const monitorRow = (id, purpose, status = 'active') => ({ id, connection_id: 'conn-active', project_id: project.id, purpose, criteria, status, active_since: '2026-11-15T08:00:00.000Z',
  match_count: 4, last_matched_at: now, created_at: now, updated_at: now })
const draftRow = { id: 'prop-1', created_at: now, title: 'Gmail new-mail monitor', payload_json: { proposal_type: 'gmail_monitor_create', action_id: 'source.gmail.monitor.propose',
  connection_id: 'conn-active', purpose: 'Tell me when the builder sends a revised kitchen quote or the city confirms the inspection — an unusually long purpose to check wrapping', criteria, target_project_id: project.id } }
const message = (id, from, text, extra = {}) => ({ google_message_id: id, internal_date: now, subject: 'Kitchen quote', from, to: 'Avery <avery@example.test>', cc: null,
  date_header: null, text, text_format: 'plain', text_truncated: false, attachment_count: 0, omitted: null, gmail_url: link(id), ...extra })
const readPage = (messages, next) => ({ selection_id: 'sel-1', project_id: project.id, connection_id: 'conn-active', google_thread_id: '18c1a', gmail_url: link('18c1a'),
  subject: 'Kitchen quote', messages_in_window: 23, messages, next_cursor: next, truncated: true, truncation: ['page_text_bytes'] })

async function mockApi(page) {
  const fixture = { configured: true, connections: [conn('conn-active', 'avery@example.test', 'active'), conn('conn-expired', 'avery.work@example.test', 'reauth_required'),
    conn('conn-old', 'old.address@example.test', 'disconnected')], selections: [legacySelection], readFailure: null, external: [], disconnects: [],
    monitors: [monitorRow('mon-1', 'Replies from the city about the permit', 'paused')], drafts: [draftRow], accepted: [], partial: true, agentRead: [],
    digestTime: '09:00', digestStatus: 'paused', shared: [], audience: ['Avery', 'Morgan'] }
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { fixture.external.push(url.href); return route.abort() }
    if (!url.pathname.startsWith('/api/v1/')) return route.fallback()
    const path = url.pathname.replace('/api/v1', '')
    const method = route.request().method()
    const ok = data => route.fulfill({ json: data, headers: { 'cache-control': 'private, no-store' } })
    const receipt = data => ok({ status: 'succeeded', data })
    if (path === '/me') return ok({ id: 'user-mail', name: 'Avery', email: 'avery@example.test', default_space_id: space.id, instance_role: 'member' })
    if (path === '/me/spaces') return ok([space])
    if (path === '/me/agent-attention' || path === '/me/agent-attention/snapshot') return ok({ type: 'attention.snapshot', seq: 1, version: 'f', unread_count: 0, notices: [], page: { items: [], total: 0, limit: 50, offset: 0 }, items: [], total: 0, limit: 50, offset: 0 })
    if (path === '/me/agent-attention/stream') return route.fulfill({ contentType: 'text/event-stream', body: '' })
    if (path === '/plugins/effective') return ok({ plugins: {} })
    if (path === '/plugins') return ok({ items: [{ descriptor: applicationsDescriptor, effective: { enabled: true } }] })
    if (path === '/queries/official_plugin.project_binding.list') return receipt({ project_id: project.id, can_manage: false, items: [{
      plugin_id: 'phd_application', name: 'PhD Application', version: '1.0.0', status: 'bound', plugin_enabled: true, effective: true, bound_at: now, unbound_at: null,
    }] })
    if (path.startsWith('/queries/plugin.phd_application.')) return receipt({ items: [] })

    if (path === '/projects') return ok({ items: [project, other], total: 2, limit: 50, offset: 0 })
    if (path === `/projects/${project.id}`) return ok(project)
    if (path === `/projects/${other.id}`) return ok(other)
    if (path === `/projects/${project.id}/overview`) return ok({ project, brief: null, attention: [] })
    if (path === `/projects/${other.id}/overview`) return ok({ project: other, brief: null, attention: [] })
    if (path === `/agents/${agent.id}`) return ok(agent)
    if (path === `/projects/${project.id}/agents/${agent.id}`) return ok({ agent_id: agent.id })
    if (path.endsWith('/conversation-backends')) return ok({
      options: [{ runtime_profile_id: 'mail-fixture-runtime', name: 'Test backend', runtime_key: 'opencode', usable: true }], binding: null,
    })
    if (path === `/projects/${project.id}/mainline-room`) return ok({ room })
    if (path.endsWith('/retrieval')) return ok({ enabled: false, preferred_domains: [] })
    if (path === `/sessions/${privateSession}/messages`) return ok([{
      id: 'gmail-summary', session_id: privateSession, space_id: space.id, role: 'assistant', run_id: null,
      content: summary, metadata_json: { gmail_result: true }, created_at: now,
    }])
    if (path === '/rooms') return ok({ items: [room], total: 1, limit: 100, offset: 0 })
    if (path === `/rooms/${room.id}/conversations`) {
      const items = url.searchParams.get('limit') === '100' ? [roomSession] : []
      return ok({ items, total: items.length, limit: 100, offset: 0 })
    }
    if (path === '/queries/source.gmail.summary.preview') return receipt({
      readers: fixture.audience.map(display_name => ({ display_name })),
      audience_version: (fixture.audience.length === 2 ? 'a' : 'b').repeat(64),
    })
    if (path === '/actions/source.gmail.summary.share') {
      const body = route.request().postDataJSON()
      if (body.audience_version === 'a'.repeat(64)) {
        fixture.audience.push('Jordan')
        return route.fulfill({ status: 409, json: { error: { code: 'operation_conflict', request_id: 'fixture' } } })
      }
      fixture.shared.push(body.content)
      return receipt({ ...body, content: undefined, audience_version: undefined, message_id: 'shared-gmail-summary' })
    }
    if (path === '/actions/source.gmail.digest.set_time') {
      fixture.digestTime = route.request().postDataJSON().local_time
      return receipt({ digest_id: 'digest-browser', space_id: space.id, status: 'paused' })
    }
    if (path === '/sources/gmail/digests/digest-browser/status') {
      fixture.digestStatus = route.request().postDataJSON().status
      return receipt({ digest_id: 'digest-browser', space_id: space.id, status: fixture.digestStatus })
    }
    if (path === '/sources/gmail/digests') return ok({ digests: [{
      id: 'digest-browser', connection_id: 'conn-active', project_id: project.id, project_name: project.name,
      session_id: privateSession, agent_id: agent.id, kind: 'daily', local_time: fixture.digestTime, time_zone: 'Europe/London',
      status: fixture.digestStatus, covered_until: now,
      next_run_at: fixture.digestStatus === 'active' ? '2026-11-17T10:30:00.000Z' : null, retry_at: null, last_delivered_at: null,
      failure_count: fixture.digestStatus === 'active' ? 0 : 1,
      last_error_code: fixture.digestStatus === 'active' ? null : 'gmail_digest_read_limit',
      last_delivery: { status: 'failed', window_start: '2026-11-15T09:00:00.000Z', window_end: now, message_count: 50, gap_before: false,
        error_code: 'gmail_digest_read_limit', finished_at: now }, created_at: now,
    }, {
      id: 'application-browser', connection_id: 'conn-active', project_id: project.id, project_name: project.name,
      session_id: privateSession, agent_id: agent.id, kind: 'application', local_time: null, time_zone: null,
      status: 'active', covered_until: now, next_run_at: null, retry_at: null, last_delivered_at: now,
      failure_count: 0, last_error_code: null, last_delivery: null, created_at: now,
      runtime: { agent_name: 'Mail Assistant', model_label: 'Original model' }, mail_items: { pending: 2, review: 1, failed: 0 },
      ...(url.searchParams.get('application_review_project_id') === project.id ? {
        review_items: [{ message_id: 'abc321', received_at: now, reason: 'no_matching_application', gmail_url: 'https://mail.google.com/mail/u/0/#all/abc321' }],
      } : {}),
    }] })
    if (path === '/sources/gmail/connections') return ok({ configured: fixture.configured, connections: fixture.connections })
    if (path === '/sources/gmail/oauth/start') return ok({ authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=fixture' })
    if (path === '/actions/source.gmail.connection.set_agent_read' && method === 'POST') {
      const body = route.request().postDataJSON(); fixture.agentRead.push([body.connection_id, body.enabled])
      // Turning reads on shows the Project the owner allowed earlier in a conversation (ADR 0033); off ends it.
      fixture.connections = fixture.connections.map(c => c.id === body.connection_id ? { ...c, agent_read_enabled: body.enabled,
        agent_read_grants: body.enabled ? [{ grant_id: 'grant-1', project_id: project.id, project_name: project.name, purpose: 'on_demand_read', created_at: '2026-11-04T09:00:00.000Z', last_used_at: '2026-11-15T18:30:00.000Z' }] : [] } : c)
      return receipt({ connection_id: body.connection_id, space_id: space.id, agent_read_enabled: body.enabled })
    }
    if (path.endsWith('/disconnect') && method === 'POST') {
      const id = path.split('/')[4]; fixture.disconnects.push(id)
      fixture.connections = fixture.connections.map(c => c.id === id ? { ...c, status: 'disconnected', disconnected_at: now } : c)
      return receipt({ connection_id: id, space_id: space.id, status: 'disconnected', generation: 4, remote_revocation: 'not_requested', manual_revocation_url: 'https://myaccount.google.com/connections' })
    }
    if (path === '/sources/gmail/selections' && method === 'GET') {
      const projectId = url.searchParams.get('project_id')
      return ok({ selections: fixture.selections.filter(s => s.project_id === projectId && s.connection_id === url.searchParams.get('connection_id')) })
    }
    if (path === '/sources/gmail/monitors' && method === 'GET') return ok({ push_configured: true, monitors: fixture.monitors,
      sync: [{ connection_id: 'conn-active', state: 'ok', push: 'active', last_success_at: now, next_check_at: '2026-11-16T15:00:00.000Z', recovery_partial: fixture.partial, last_error_code: null }],
      recent_matches: fixture.monitors.length ? [{ monitor_id: 'mon-1', google_message_id: '18c2f', gmail_url: link('18c2f'), matched_at: now }] : [] })
    if (path === '/proposals' && method === 'GET') {
      const items = url.searchParams.get('type') === 'gmail_monitor_create' && url.searchParams.get('status') === 'pending' ? fixture.drafts : []
      return ok({ items, total: items.length, limit: 50, offset: 0 })
    }
    if (path === '/proposals/prop-1/accept' && method === 'POST') {
      fixture.accepted.push('prop-1'); fixture.drafts = []
      fixture.monitors = [monitorRow('mon-2', draftRow.payload_json.purpose), ...fixture.monitors]
      return receipt({ proposal: { id: 'prop-1', status: 'accepted' }, result_type: 'gmail_monitor', result: { monitor_id: 'mon-2' } })
    }
    if (/^\/sources\/gmail\/monitors\/[^/]+\/status$/.test(path) && method === 'POST') {
      const id = path.split('/')[4]; const status = route.request().postDataJSON().status
      fixture.monitors = fixture.monitors.map(m => m.id === id ? { ...m, status } : m)
      return receipt({ monitor_id: id, space_id: space.id, status })
    }
    if (path === '/sources/gmail/selections' && method === 'POST') { fixture.external.push('retired selection add'); return route.fulfill({ status: 404, json: {} }) }
    if (path.startsWith('/sources/gmail/selections/') && method === 'DELETE') {
      const id = path.split('/')[4]; fixture.selections = fixture.selections.filter(s => s.id !== id)
      return receipt({ selection_id: id, space_id: space.id, removed: true })
    }
    if (path.endsWith('/search')) { fixture.external.push('retired search'); return route.fulfill({ status: 404, json: {} }) }
    if (path.endsWith('/read')) {
      if (fixture.readFailure) return route.fulfill({ status: fixture.readFailure.status, json: { error: { code: fixture.readFailure.code, request_id: 'r' } } })
      const body = route.request().postDataJSON()
      return ok(body.cursor ? readPage([message('a3', 'Jordan Builder', 'Earlier: we can start on the 4th.')], null) : readPage([
        message('a1', 'Jordan Builder <jordan@builders.example>', 'Hi Avery,\n\nThe revised quote is below. Quartz adds two weeks.\n<img src="https://tracker.example/pixel.png"> <script>alert(1)</script>\n\nThanks,\nJordan',
          { text_format: 'html_converted', attachment_count: 2, cc: 'Sam <sam@example.test>' }),
        message('a2', 'Avery <avery@example.test>', 'Thanks — can you split the countertop line item?', { text_truncated: true }),
        message('a2b', 'Jordan Builder', '', { omitted: 'too_large' }),
      ], 'read.2'))
    }
    if (method !== 'GET') return route.fulfill({ status: 404, json: { detail: 'Unavailable in Gmail fixture' } })
    // Neighbouring surfaces (Sources monitors, Project source manager) render their empty states.
    const page0 = { items: [], total: 0, limit: 50, offset: 0 }
    if (['/sources/evidence', '/sources/project-items', '/sources/post-processing/decisions', '/reader/annotations'].includes(path)) return ok(page0)
    if (path === '/prompts/reading-method/entry') return ok({ can_manage: false, project_id: project.id })
    if (path.startsWith('/sources/') || path.includes('/sources/')) return ok([])
    return route.fulfill({ status: 404, json: { detail: 'Unavailable in Gmail fixture' } })
  })
  return fixture
}

let server, browser
let baseUrl = process.env.LAYOUT_BASE_URL
before(async () => {
  if (!baseUrl) {
    server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } })
    baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
})
after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.httpServer.close(resolve))
})

const noOverflow = async (page, label) => {
  const o = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }))
  assert.ok(o.document <= o.viewport + 1, JSON.stringify({ label, ...o }))
}

for (const locale of ['en', 'zh-CN']) {
  const L = (locale === 'en' ? gmailUiEn : gmailUiZhCN).gmail_ui
  for (const theme of ['dark', 'light']) {
    test(`Gmail connection, monitoring, Project panel and reader (${locale}, ${theme})`, async () => {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
        const shot = async name => { await page.evaluate(() => document.fonts.ready); await noOverflow(page, `${name} ${width}`); await page.screenshot({ path: `${shots}/${name}-${locale}-${theme}-${width}.png`, animations: 'disabled' }) }
        try {
          await page.addInitScript(([nextLocale, nextTheme]) => {
            localStorage.setItem('rainver:locale', nextLocale)
            if (nextTheme === 'light') localStorage.setItem('rainver:theme', 'light')
          }, [locale, theme])
          const fixture = await mockApi(page)
          if (process.env.GMAIL_DEBUG) { page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 600)) }); page.on('request', r => { if (r.url().includes('/api/v1/')) console.log('req', r.method(), new URL(r.url()).pathname) }) }

          // 1. The entry on the Sources page, beside Refresh and the primary action.
          await page.goto(`${baseUrl}/spaces/${space.id}/sources`)
          const entry = page.getByRole('link', { name: L.entry })
          await entry.waitFor({ timeout: 15_000 })
          await shot('sources-entry')
          await entry.click()

          // 2. Access page: administrator note, then the person's own connections.
          await page.getByText(L.connections.title).waitFor()
          await page.getByText('avery.work@example.test').waitFor()
          await shot('access-connections')
          const openApplications = page.getByRole('link', { name: L.digests.open_project_applications.replace('{{project}}', project.name) })
          await openApplications.click()
          const updates = page.locator('#gmail-application-updates')
          await updates.getByText(L.digests.application, { exact: true }).waitFor()
          assert.equal(await updates.getByRole('link', { name: L.private_read.open }).count(), 1)
          await updates.getByText(L.digests.review_reason.no_matching_application, { exact: false }).waitFor()
          const reviewLink = updates.getByRole('link', { name: L.digests.review_open_gmail })
          const reviewUrl = 'https://mail.google.com/mail/u/0/#all/abc321'
          assert.equal(await reviewLink.getAttribute('href'), reviewUrl)
          await shot('project-application-updates')
          await page.context().route('https://mail.google.com/**', route => route.fulfill({ contentType: 'text/plain', body: 'Fixture Gmail message' }))
          const opened = page.waitForEvent('popup')
          await reviewLink.click()
          const mail = await opened
          await mail.waitForURL(reviewUrl)
          await mail.close()
          await updates.getByText(L.digests.application, { exact: true }).waitFor()
          await page.goBack()
          await page.getByText(L.connections.title).waitFor()

          // 2a. The owner's opt-in for on-demand Agent reads: only on the active connection, off by default.
          const agentRead = page.getByLabel(L.connections.agent_read.title)
          await agentRead.waitFor()
          assert.equal(await agentRead.count(), 1)
          await agentRead.getByText(L.connections.agent_read.off, { exact: true }).waitFor()
          await agentRead.getByRole('button', { name: L.connections.agent_read.enable }).click()
          await agentRead.getByText(L.connections.agent_read.on, { exact: true }).waitFor()
          assert.deepEqual(fixture.agentRead, [['conn-active', true]])
          // The one management place: each allowed Project, its last use and a confirmed revoke.
          const allowed = agentRead.getByRole('list', { name: L.connections.agent_read.grants_title })
          await allowed.getByText(project.name).waitFor()
          await allowed.getByRole('button', { name: L.connections.agent_read.revoke_label.replace('{{project}}', project.name) }).waitFor()
          await agentRead.scrollIntoViewIfNeeded()
          await shot('access-agent-read')
          const digest = page.getByText(L.digests.read_limit, { exact: true })
          await page.getByText(L.digests.daily, { exact: true }).waitFor()
          await digest.waitFor()
          await digest.evaluate(node => node.scrollIntoView({ block: 'center' }))
          await page.getByText(L.digests.resume_scope_daily, { exact: true }).waitFor()
          await shot('access-private-digest')
          await page.getByRole('button', { name: L.digests.change_time }).click()
          const timeDialog = page.getByRole('dialog')
          await timeDialog.getByLabel(L.digests.change_time).fill('10:30')
          await shot('access-digest-time')
          await timeDialog.getByRole('button', { name: L.digests.save_time }).click()
          await timeDialog.waitFor({ state: 'hidden' })
          await page.getByText(/10:30/).waitFor()
          assert.equal(fixture.digestTime, '10:30')
          await page.getByRole('listitem').filter({ has: page.getByText(L.digests.daily, { exact: true }) }).last()
            .getByRole('button', { name: L.digests.resume, exact: true }).click()
          const nextRunLabel = L.digests.next_run.split('{{date}}')[0]
          await page.getByText(new RegExp(nextRunLabel)).waitFor()
          await page.getByText(new RegExp(L.digests.failed_window.split('{{start}}')[0])).waitFor()
          await shot('access-digest-resumed')
          await page.getByRole('link', { name: L.private_read.open }).click()
          await page.getByText(summary, { exact: true }).waitFor()
          await shot('private-digest-conversation')
          await page.getByRole('button', { name: L.share.open }).click()
          const shareDialog = page.getByRole('dialog')
          const post = shareDialog.getByRole('button', { name: L.share.send })
          assert.equal(await post.isEnabled(), false)
          await shareDialog.getByLabel(L.share.room, { exact: true }).click()
          await shareDialog.getByRole('option', { name: L.share.mainline, exact: true }).click()
          await shareDialog.getByLabel(L.share.thread, { exact: true }).click()
          await shareDialog.getByRole('option', { name: roomSession.title }).click()
          await shareDialog.getByText('Morgan', { exact: true }).waitFor()
          await shareDialog.getByLabel(L.share.preview).fill('The revised quote arrived.')
          await shot('private-digest-audience')
          await post.click()
          await shareDialog.getByText(L.share.audience_changed, { exact: true }).waitFor()
          await shareDialog.getByText('Jordan', { exact: true }).waitFor()
          assert.deepEqual(fixture.shared, [])
          await shot('private-digest-audience-changed')
          await post.click()
          await shareDialog.waitFor({ state: 'hidden' })
          await page.getByText(L.share.posted, { exact: true }).waitFor()
          assert.deepEqual(fixture.shared, ['The revised quote arrived.'])
          await page.goBack()
          await page.getByText(new RegExp(nextRunLabel)).waitFor()
          await page.getByRole('button', { name: L.connections.connect }).click()
          const consent = page.getByRole('link', { name: L.connections.continue })
          await consent.waitFor()
          assert.equal(new URL(page.url()).hostname, '127.0.0.1', 'consent is never opened automatically')
          assert.match(await consent.getAttribute('href'), /^https:\/\/accounts\.google\.com\//)
          await consent.scrollIntoViewIfNeeded()
          await shot('access-consent')

          // 2b. New-mail monitoring beside the connections: a draft to decide, a paused monitor, partial-recovery note.
          const monitoring = page.locator('[aria-labelledby="gmail-monitors-title"]')
          await monitoring.getByText(L.monitors.drafts).waitFor()
          await monitoring.getByText(L.monitors.sync.partial).waitFor()
          await monitoring.scrollIntoViewIfNeeded()
          await shot('access-monitoring-draft')
          await monitoring.getByRole('button', { name: L.monitors.accept, exact: true }).click()
          await monitoring.getByRole('button', { name: L.monitors.accept, exact: true }).waitFor({ state: 'detached' })
          await monitoring.getByText(L.monitors.status.active, { exact: true }).waitFor()
          assert.deepEqual(fixture.accepted, ['prop-1'])
          await monitoring.getByRole('link', { name: L.monitors.open_match }).first().waitFor()
          await monitoring.scrollIntoViewIfNeeded()
          await shot('access-monitoring-accepted')

          // 3. Local-only disconnect with the manual revocation link.
          await page.getByRole('button', { name: L.connections.disconnect }).first().click()
          const dialog = page.getByRole('dialog')
          await dialog.waitFor()
          await page.waitForTimeout(250)
          await shot('access-disconnect-confirm')
          await dialog.getByRole('button', { name: L.connections.disconnect }).click()
          const revoke = page.getByRole('link', { name: L.connections.revoke_link }).first()
          await revoke.waitFor()
          assert.equal(await revoke.getAttribute('href'), 'https://myaccount.google.com/connections')
          await revoke.scrollIntoViewIfNeeded()
          await shot('access-disconnected')
          assert.deepEqual(fixture.disconnects, ['conn-active'])

          // 4. Not configured: explanation, no secret field, no connect action.
          fixture.configured = false
          await page.reload()
          await page.getByText(L.connections.not_configured).waitFor()
          assert.equal(await page.getByRole('button', { name: L.connections.connect }).count(), 0)
          await page.getByText(L.connections.not_configured).scrollIntoViewIfNeeded()
          await shot('access-not-configured')
          fixture.configured = true
          fixture.connections = fixture.connections.map(c => c.id === 'conn-active' ? { ...c, status: 'active', disconnected_at: null } : c)

          // 5. The OAuth callback lands on the Space's Access page with a fixed notice.
          await page.goto(`${baseUrl}/sources?gmail=connected`)
          await page.getByText(L.connections.callback.connected).waitFor()
          assert.equal(new URL(page.url()).pathname, `/spaces/${space.id}/sources/access`)
          assert.equal(new URL(page.url()).search, '')

          // 6. Project Sources: private panel with the monitoring pointer and earlier selections only, then the reader.
          await page.goto(`${baseUrl}/spaces/${space.id}/projects/${project.id}/sources?tab=settings`)
          const panel = page.locator('[aria-labelledby="project-gmail-title"]')
          await panel.waitFor({ timeout: 15_000 })
          await panel.getByRole('button', { name: L.project.read, exact: true }).waitFor()
          await panel.getByText(L.project.monitoring_hint).waitFor()
          assert.equal(await panel.getByRole('search').count(), 0, 'manual search is retired')
          assert.equal(await panel.getByRole('textbox').count(), 0)
          await panel.scrollIntoViewIfNeeded()
          await shot('project-panel-legacy')
          await panel.getByRole('button', { name: L.project.read, exact: true }).click()
          const reader = page.getByRole('dialog')
          await reader.getByText('The revised quote is below.', { exact: false }).waitFor()
          await page.waitForTimeout(250)
          assert.equal(await reader.locator('img, script, iframe').count(), 0, 'mail markup is text only')
          assert.ok((await reader.innerText()).includes('<img src="https://tracker.example/pixel.png">'))
          await shot('reader-page-1')
          await reader.getByRole('button', { name: L.reader.older }).click()
          await reader.getByText('Earlier: we can start on the 4th.').waitFor()
          await shot('reader-page-2')
          fixture.readFailure = { status: 429, code: 'gmail_rate_limited' }
          await reader.getByRole('button', { name: L.reader.refresh }).click()
          await reader.getByText(L.errors.rate_limited).waitFor()
          await shot('reader-rate-limited')
          fixture.readFailure = { status: 404, code: 'gmail_not_found' }
          await reader.getByRole('button', { name: L.reader.refresh }).click()
          await reader.waitFor({ state: 'detached' })
          fixture.readFailure = null
          assert.equal(await page.getByText('Earlier: we can start on the 4th.').count(), 0)

          // 7. Another Project shows none of the first Project's selections.
          await page.goto(`${baseUrl}/spaces/${space.id}/projects/${other.id}/sources?tab=settings`)
          await page.locator('[aria-labelledby="project-gmail-title"]').getByText(L.project.no_selections).waitFor()
          await page.locator('[aria-labelledby="project-gmail-title"]').scrollIntoViewIfNeeded()
          await shot('project-panel-empty')
          assert.equal(await page.getByRole('button', { name: L.project.read, exact: true }).count(), 0)

          // 8. Expired grant and no connection.
          fixture.connections = [conn('conn-expired', 'avery.work@example.test', 'reauth_required')]
          await page.reload()
          await page.getByText(L.errors.reauth).waitFor()
          await page.getByText(L.errors.reauth).scrollIntoViewIfNeeded()
          await shot('project-reauth')
          fixture.connections = []
          await page.reload()
          await page.getByText(L.project.no_connection).waitFor()
          await page.getByText(L.project.no_connection).scrollIntoViewIfNeeded()
          await shot('project-no-connection')
          assert.deepEqual(fixture.external, [], 'no request leaves the fixture origin')
        } catch (error) {
          await page.screenshot({ path: `${shots}/failure-${locale}-${theme}-${width}.png` }).catch(() => {})
          console.log('failure body:', (await page.innerText('body').catch(() => '')).slice(0, 1500))
          throw error
        } finally {
          await page.close()
        }
      }
    })
  }
}
