import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { markdownToReaderDocument } from '@rainver/reader-document'

// Five Reader journeys and a performance check in the built app inside the
// real Shell. Every request is answered by the in-memory fixture below; the
// corpus is synthetic (mixed Chinese/English) and no instance data is read.
const spaceId = 'space-journeys'
const now = '2026-10-29T08:00:00.000Z'
const text = value => ({ type: 'text', text: value })
const p = value => ({ type: 'paragraph', content: [text(value)] })
const h = (level, value) => ({ type: 'heading', attrs: { level }, content: [text(value)] })
const zh = n => `第${n}段：长文阅读需要稳定的版心、清楚的段距和可以恢复的位置，这一段用于验证滚动、查找和批注。`
const en = n => `Paragraph ${n}: a calm measure and a position that survives devices and versions keep long reading continuous.`

function article(sections = 6, perSection = 12, extra = []) {
  const content = [...extra]
  for (let s = 1; s <= sections; s++) {
    content.push(h(2, `第${s}节 Section ${s}`))
    for (let n = 1; n <= perSection; n++) content.push(p(n % 2 ? zh(`${s}-${n}`) : en(`${s}-${n}`)))
    if (s === 2) content.push({ type: 'codeBlock', content: [text('  const exact = "keep  spaces"\n\treturn exact')] })
  }
  return { type: 'doc', content }
}
const plainOf = json => json.content.map(function flat(node) { return node.text ?? (node.content ?? []).map(flat).join('\n\n') }).join('\n\n')
const documentFor = (id, json, version = 'v1') => {
  const plain = plainOf(json)
  return { document_type: 'source_item', document_id: id, space_id: spaceId, project_id: null, title: `Synthetic article ${id}`,
    plain_text: plain, normalized_text: plain.replace(/\n{2,}/g, ' '), content_hash: `text-${version}`, structure_hash: `tree-${version}`,
    content_format: 'tiptap_json', content_schema_version: 1, content_json: json, source_item_id: id, artifact_id: null, source_snapshot_id: null,
    raw_artifact_id: null, extracted_artifact_id: null, source_uri: `https://example.test/${id}`, content_state: 'content_saved',
    retention_policy: null, can_annotate: true, image_policy: 'remote_reference' }
}
const topicLink = { goal_id: 'topic-a', project_id: null, title: 'Robot learning', selection_status: 'important', selection_reason: 'A new benchmark', judged_by: 'collection_agent', delivery_kind: 'new_publication', change_evidence_url: null }
const listItem = n => ({ key: `key-${n}`, source_item_id: `item-${n}`, source_item_ids: [`item-${n}`], title: `Synthetic article item-${n}`, source_uri: null,
  occurred_at: now, summary: `Summary ${n}`, access_level: n === 4 ? 'summary' : 'full', reader_origin: 'library', read_status: 'unread', dismissed: false,
  available_at: new Date(Date.parse(now) - n * 3600_000).toISOString(), contributions: [], topics: n % 3 === 0 ? [topicLink] : [], material_links: [], reading_progress: null })

/** One person's server, in memory: positions, appearance, annotations and read state behave like the real routes. */
function makeServer({ versions = {}, failReadOnce = false, failCreateOnce = false, longDocument } = {}) {
  const state = { positions: new Map(), appearance: { font_size: null, line_height: 'normal', width: 'medium', font: 'sans', theme: 'app' },
    annotations: new Map(), read: new Set(), puts: [], failRead: failReadOnce, failCreate: failCreateOnce, readCalls: 0 }
  const server = { state, doc: id => longDocument && id === 'item-long' ? longDocument : documentFor(id, article(), versions[id] ?? 'v1'), route }
  return server
  async function route(route) {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/api/v1', '')
    const method = route.request().method()
    const body = () => route.request().postDataJSON()
    const json = data => route.fulfill({ json: data })
    if (path === '/me') return json({ id: 'user-j', name: 'Journey tester', email: 'j@example.test', default_space_id: spaceId, instance_role: 'member' })
    if (path === '/me/spaces') return json([{ id: spaceId, name: 'Journey Space', type: 'personal', role: 'owner' }])
    if (path === '/agents') return json([{ id: 'research-agent', name: 'Research Agent', created_by_user_id: 'user-j', agent_kind: 'personal', status: 'active' }])
    if (path === '/agents/research-agent/runtime-profiles') return json([
      { id: 'opencode-api', name: 'OpenCode API', runtime_key: 'opencode', enabled: true, is_default: true, backend_mode: 'model_provider', provider_binding: { model: 'Configured model' } },
      { id: 'antigravity-native', name: 'Antigravity', runtime_key: 'antigravity', enabled: true, is_default: false, backend_mode: 'runtime_native', provider_binding: { model: null } },
    ])
    if (path === '/agents/research-agent/conversation-backends') return json({ options: ['opencode-api', 'antigravity-native'].map(runtime_profile_id => ({ runtime_profile_id, usable: true, session_config_options: [] })), session_config: [] })
    if (/^\/sources\/items\/[^/]+\/processing\/start$/.test(path)) { state.prepared = body(); return json({ status: 'queued', run_id: 'research-run' }) }
    if (path === '/plugins/effective') return json({ plugins: {} })
    if (path === '/sources/goals') return json({ goals: [{ id: 'topic-a', space_id: spaceId, project_id: null, status: 'running', intent_json: { intent: 'Robot learning' }, compatibility_json: {}, follow_state: { intent: 'following', phase: 'scheduled' } }] })
    if (path === `/spaces/${spaceId}/reading`) {
      const q = url.searchParams.get('q')?.toLowerCase(), topic = url.searchParams.get('topic')
      const all = Array.from({ length: 45 }, (_, n) => listItem(n + 1)).filter(item => url.searchParams.get('view') === 'all' || !state.read.has(item.source_item_id))
        .filter(item => !q || item.title.toLowerCase().includes(q)).filter(item => !topic || item.topics.some(link => link.goal_id === topic))
      if (url.searchParams.get('sort') === 'oldest') all.reverse()
      const start = Number(url.searchParams.get('cursor') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 30)
      const items = all.slice(start, start + limit).map(item => ({ ...item, reading_progress: state.positions.has(item.source_item_id)
        ? { current: state.positions.get(item.source_item_id).current.progress, furthest: state.positions.get(item.source_item_id).furthest?.progress ?? 0 } : null }))
      return json({ items, total: all.length, next_cursor: start + limit < all.length ? String(start + limit) : null })
    }
    const state_ = /^\/spaces\/[^/]+\/reading\/items\/([^/]+)\/state$/.exec(path)
    if (state_ && method === 'PATCH') {
      state.readCalls++
      if (state.failRead) { state.failRead = false; return route.fulfill({ status: 503, json: { detail: 'Read state temporarily unavailable' } }) }
      if (body().read_status === 'unread') state.read.delete(state_[1]); else state.read.add(state_[1]); return json({ updated: 1 })
    }
    if (path === '/reader/preferences/appearance') {
      if (method === 'PUT') state.appearance = body()
      return json(state.appearance)
    }
    const position = /^\/reader\/documents\/source_item\/([^/]+)\/position$/.exec(path)
    if (position) {
      const id = position[1]
      if (method === 'PUT') {
        const report = body(); state.puts.push({ id, ...report })
        const existing = state.positions.get(id)
        if (!existing || Date.parse(report.client_at) > Date.parse(existing.current_client_at)) {
          const sameVersion = existing && existing.structure_hash === report.structure_hash
          const furthest = report.reset_furthest ? report.current : report.dwelled && (!sameVersion || !existing?.furthest || report.current.progress > existing.furthest.progress) ? report.current : sameVersion ? existing.furthest : null
          state.positions.set(id, { content_hash: report.content_hash, structure_hash: report.structure_hash, current: report.current, furthest, current_client_at: report.client_at, updated_at: report.client_at, revision: (existing?.revision ?? 0) + 1 })
        }
        return json({ position: state.positions.get(id) ?? null, accepted: true })
      }
      return json({ position: state.positions.get(id) ?? null, accepted: true })
    }
    const history = /^\/reader\/source-items\/([^/]+)\/versions(?:\/([^/]+))?$/.exec(path)
    if (history) {
      const id = history[1]
      if (history[2]) return json({ ...documentFor(id, { type: 'doc', content: [h(1, 'Earlier analysis'), p('Retained evidence from the earlier reading.')] }, 'historical'),
        document_type: 'source_snapshot', document_id: history[2], can_annotate: false, image_policy: 'none', version_captured_at: '2026-10-30T08:00:00Z' })
      return json({ items: [{ snapshot_id: 'current-snapshot', captured_at: '2026-10-31T08:00:00Z', is_current: true }, { snapshot_id: 'earlier-snapshot', captured_at: '2026-10-30T08:00:00Z', is_current: false }], next_offset: null })
    }
    const document_ = /^\/reader\/documents\/source_item\/([^/]+)$/.exec(path)
    if (document_) return json(server.doc(document_[1]))
    const documentNote = /^\/reader\/documents\/source_item\/([^/]+)\/note$/.exec(path)
    if (documentNote) {
      state.documentNotes ??= new Map()
      if (method === 'POST' && !state.documentNotes.has(documentNote[1])) state.documentNotes.set(documentNote[1], { id: `note-${documentNote[1]}`, space_id: 'personal-notes-space', status: 'active' })
      return json({ note: state.documentNotes.get(documentNote[1]) ?? null })
    }
    const annotations = /^\/reader\/documents\/source_item\/([^/]+)\/annotations$/.exec(path)
    if (annotations) return json({ items: [...state.annotations.values()].filter(a => a.document_id === annotations[1] && a.status === 'active') })
    if (path === '/reader/annotations' && method === 'POST') {
      if (state.beforeCreate) await state.beforeCreate()
      if (state.failCreate) { state.failCreate = false; return route.fulfill({ status: 503, json: { detail: 'Annotation service busy' } }) }
      const input = body(); const id = `ann-${state.annotations.size + 1}`
      const created = { ...input, id, space_id: spaceId, project_id: null, color: null, label: null, visibility: 'private', status: 'active', anchor_state: 'verified', created_by_user_id: 'user-j', created_at: now, updated_at: now }
      state.annotations.set(id, created); return json(created)
    }
    const rangeEdit = /^\/reader\/annotations\/([^/]+)\/range$/.exec(path)
    if (rangeEdit && method === 'PATCH') {
      const current = state.annotations.get(rangeEdit[1]), input = body()
      if (!current || current.status !== 'active' || current.quote_text !== input.expected_quote_text) return route.fulfill({ status: 409, json: { detail: 'Annotation changed' } })
      Object.assign(current, { quote_text: input.quote_text, anchor_json: input.anchor_json, anchor_state: 'unverified' })
      return json(current)
    }
    const one = /^\/reader\/annotations\/([^/]+)$/.exec(path)
    if (one && method === 'DELETE') { state.annotations.get(one[1]).status = 'archived'; return route.fulfill({ status: 204, body: '' }) }
    if (one && method === 'PATCH') { Object.assign(state.annotations.get(one[1]), body()); return json(state.annotations.get(one[1])) }
    if (/^\/reader\/annotations\/[^/]+\/threads$/.test(path)) return json({ items: [] })
    if (/^\/sources\/items\/[^/]+\/processing$/.test(path)) return json(state.prepared ? {status:'queued',run_id:'research-run'} : { status: 'idle' })
    if (path === '/me/agent-attention/stream') return route.fulfill({ status: 503, body: '' })
    return route.fulfill({ status: 404, json: { detail: 'Unavailable in journey fixture' } })
  }
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

async function newPage(fixture, { width = 1440, height = 900, reducedMotion = 'no-preference', theme = 'dark', locale = 'en' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', reducedMotion })
  const page = await context.newPage()
  await page.addInitScript(({theme,locale}) => { localStorage.setItem('rainver:locale', locale); localStorage.setItem('rainver:theme', theme) }, {theme,locale})
  await page.route('**/api/v1/**', route => fixture.route(route))
  return page
}
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const shell = page => page.locator('.reader-document-shell')
async function openItem(page, id, query = '') {
  await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/${id}${query}`)
  await page.locator('.reader-surface p').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
}
/** The text at the top of the reading pane. */
const topText = page => page.evaluate(() => {
  const pane = document.querySelector('.reader-document-shell').getBoundingClientRect()
  const block = [...document.querySelectorAll('.reader-surface > *')].find(el => el.getBoundingClientRect().bottom > pane.top + 4)
  return block?.textContent.slice(0, 24) ?? ''
})

test('Journey 1 — search, topic, keyboard, read, next and back: the list keeps its query and returns to the item', async () => {
  const fixture = makeServer()
  const page = await newPage(fixture)
  try {
    // Search and topic filter first (plan journey 1); both are server queries kept in the address.
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/reading`)
    await page.locator('[data-reading-row]').first().waitFor()
    await page.getByRole('textbox', { name: /Search this list/ }).fill('item-1')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.waitForURL(/q=item-1/)
    await page.getByRole('button', { name: 'Topic' }).click()
    await page.getByRole('option', { name: 'Robot learning' }).click()
    await page.waitForURL(/topic=topic-a/)
    await page.waitForFunction(() => [...document.querySelectorAll('[data-reading-row]')].map(row => row.dataset.key).join() === 'key-12,key-15,key-18')
    await page.locator('[data-key="key-12"]').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-key')), 'key-12')
    await page.keyboard.press('Enter')
    await page.locator('.reader-surface p').first().waitFor()
    assert.match(page.url(), /\/library\/items\/item-12\?/)
    await page.getByRole('link', { name: 'Next item' }).click()
    await page.waitForURL(/item-15\?/)
    await page.locator('.reader-workspace header a').first().click()
    await page.waitForURL(/library\/reading\?/)
    assert.match(page.url(), /topic=topic-a/); assert.match(page.url(), /q=item-1/)
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-key') === 'key-15')
    // No collection was started by reading: only list, document and position requests were made.
    assert.equal(fixture.state.readCalls, 0)

    // Then the unfiltered list: keyboard open, read, next skips summary-only, back returns to the item.
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/reading`)
    const rows = page.locator('[data-reading-row]')
    await rows.first().waitFor()
    await rows.first().focus()
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-key')), 'key-3')
    await page.keyboard.press('Enter')
    await page.locator('.reader-surface p').first().waitFor()
    assert.match(page.url(), /\/library\/items\/item-3\?/)
    // Read part of the article: stop, stay, and the place and the furthest are saved.
    await shell(page).evaluate(el => { el.scrollTop = el.scrollHeight * 0.4 })
    await page.waitForTimeout(5600)
    const reports = fixture.state.puts.filter(put => put.id === 'item-3')
    assert.ok(reports.some(put => !put.dwelled) && reports.some(put => put.dwelled), JSON.stringify(reports.map(r => r.dwelled)))
    assert.ok(fixture.state.positions.get('item-3').furthest.progress > 0.3)
    // Next skips the summary-only item 4.
    assert.match(await page.getByRole('link', { name: 'Next item' }).getAttribute('href'), /item-5/)
    // The Reader's own back link, to the list it came from.
    await page.locator('.reader-workspace header a').first().click()
    await page.locator('[data-reading-row]').first().waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-key') === 'key-3')
    assert.match(await page.locator('[data-key="key-3"]').innerText(), /Read \d+%/)
  } finally { await page.context().close() }
})

test('Journey 2 — another device and a new version: the place is restored, or found again, and reset is separate', async () => {
  const fixture = makeServer()
  const first = await newPage(fixture)
  let saved
  try {
    await openItem(first, 'item-7')
    await first.getByRole('heading', { name: '第3节 Section 3' }).scrollIntoViewIfNeeded()
    await shell(first).evaluate(el => { el.scrollTop += 0 })
    await first.evaluate(() => { const target = [...document.querySelectorAll('.reader-surface h2')][2]; const pane = document.querySelector('.reader-document-shell'); pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top })
    await first.waitForTimeout(1800)
    saved = await topText(first)
    await first.close()
  } finally { await first.context().close() }
  assert.ok(fixture.state.positions.get('item-7'), 'position saved')
  // A second device (fresh browser context) opens the same document.
  const second = await newPage(fixture, { width: 390, height: 844 })
  try {
    await openItem(second, 'item-7')
    await second.waitForFunction(() => document.querySelector('.reader-document-shell').scrollTop > 100)
    await settle(second)
    assert.equal(await topText(second), saved)
    // Explicit reset of the furthest position, separate from going back.
    await second.getByRole('button', { name: 'Reading progress' }).click()
    await second.getByRole('button', { name: 'Make this my reading progress' }).click()
    await second.getByText('Reading progress set to this position').waitFor()
    assert.equal(fixture.state.puts.at(-1).reset_furthest, true)
  } finally { await second.context().close() }
  const furthestBefore = fixture.state.positions.get('item-7').furthest?.progress ?? 0
  // Another device with a larger, wider serif text: the same passage is at the top.
  fixture.state.appearance = { font_size: 24, line_height: 'relaxed', width: 'wide', font: 'serif', theme: 'sepia' }
  const fourth = await newPage(fixture, { width: 1024, height: 768 })
  try {
    await openItem(fourth, 'item-7')
    await fourth.waitForFunction(() => document.querySelector('.reader-document-shell').scrollTop > 100)
    await settle(fourth)
    assert.equal(await topText(fourth), saved)
    // Reading an earlier part again does not lower the furthest position.
    await shell(fourth).evaluate(el => { el.scrollTop = 200 })
    await fourth.waitForTimeout(5600)
    assert.ok((fixture.state.positions.get('item-7').furthest?.progress ?? 0) >= furthestBefore)
    // The current place is now this earlier passage.
    saved = await topText(fourth)
  } finally { await fourth.context().close() }
  // Saving positions never wrote read state (completion, origin, Topic confirmation).
  assert.equal(fixture.state.readCalls, 0)
  assert.equal(fixture.state.read.size, 0)
  // The document changes: a new introduction moves every block; the saved text is found again.
  fixture.doc = id => documentFor(id, article(6, 12, [p('A new introduction added in a later version.'), p('另一段新加的导言。')]), 'v2')
  const third = await newPage(fixture)
  try {
    await openItem(third, 'item-7')
    await third.getByText('The document was updated; you are back at the passage you were reading.').waitFor()
    assert.equal(await topText(third), saved)
  } finally { await third.context().close() }
})

test('Journey 3 — appearance follows the person: changed, kept on reload, restored to defaults', async () => {
  const fixture = makeServer()
  const page = await newPage(fixture)
  try {
    await openItem(page, 'item-1')
    const size = () => page.locator('.reader-surface p').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize))
    const before = await size()
    await page.getByRole('button', { name: 'Reader appearance' }).click()
    await page.getByRole('button', { name: 'Larger text' }).click()
    await page.getByRole('button', { name: 'Larger text' }).click()
    await page.getByRole('button', { name: 'Serif' }).click()
    await page.getByRole('button', { name: 'Sepia' }).click()
    await page.getByRole('button', { name: 'Wide' }).click()
    await page.keyboard.press('Escape')
    assert.ok(await size() > before)
    await page.waitForTimeout(700)
    assert.deepEqual(fixture.state.appearance, { font_size: 20, line_height: 'normal', width: 'wide', font: 'serif', theme: 'sepia' })
    const bg = await shell(page).evaluate(el => getComputedStyle(el).backgroundColor)
    await page.reload()
    await page.locator('.reader-surface p').first().waitFor()
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('.reader-document-shell')).backgroundColor === expected, bg)
    assert.ok(Math.abs(await size() - 20) < 0.5)
    // The text stays inside the pane at the widest setting on a phone.
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.getByRole('button', { name: 'Reader appearance' }).click()
    await page.getByRole('button', { name: 'Restore defaults' }).click()
    await page.waitForTimeout(700)
    assert.equal(fixture.state.appearance.theme, 'app')
  } finally { await page.context().close() }
})

test('Journey 4 — a failed save then a quiet highlight, copy text and code, remove and undo through the server', async () => {
  const fixture = makeServer({ failCreateOnce: true })
  const page = await newPage(fixture)
  try {
    await page.addInitScript(() => localStorage.setItem('rainver:reader-layout', JSON.stringify({ outline: false, inspector: false })))
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })
    await openItem(page, 'item-2')
    // Select the start of a paragraph and highlight it.
    await page.locator('.reader-surface p').nth(1).evaluate(el => {
      const range = document.createRange(); range.setStart(el.firstChild, 0); range.setEnd(el.firstChild, 12)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    })
    await page.getByRole('toolbar', { name: 'Annotate selection' }).waitFor()
    await page.getByRole('button', { name: 'Copy text' }).click()
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).length, 12)
    await page.evaluate(() => { const el = document.querySelectorAll('.reader-surface p')[1]; const range = document.createRange(); range.setStart(el.firstChild, 0); range.setEnd(el.firstChild, 12); getSelection().removeAllRanges(); getSelection().addRange(range) })
    // The first save fails: an error, no false success, the selection stays for a retry.
    await page.getByRole('toolbar', { name: 'Annotate selection' }).getByRole('button', { name: 'Highlight' }).click()
    await page.getByText('Annotation service busy').waitFor()
    assert.equal(await page.getByText('Highlighted', { exact: true }).count(), 0)
    assert.equal(await page.locator('.reader-highlight').count(), 0)
    await page.getByRole('toolbar', { name: 'Annotate selection' }).getByRole('button', { name: 'Highlight' }).click()
    await page.getByText('Highlighted', { exact: true }).waitFor()
    assert.equal(await page.getByRole('complementary', { name: 'Reader inspector' }).count(), 0)
    assert.equal(await page.locator('.reader-highlight').count(), 1)
    // A code block's copy button copies its text exactly.
    await page.locator('[data-copy-code]').first().click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '  const exact = "keep  spaces"\n\treturn exact')
    // Open it from the confirmation, remove it, then undo.
    await page.getByRole('button', { name: 'View' }).click()
    const inspector = page.getByRole('complementary', { name: 'Reader inspector' })
    await inspector.getByRole('button', { name: 'Remove annotation' }).click()
    await page.getByText('Annotation removed').waitFor()
    assert.equal(await page.locator('.reader-highlight').count(), 0)
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.getByText('Annotation restored').waitFor()
    assert.equal(fixture.state.annotations.get('ann-1').status, 'active')
    await page.locator('.reader-highlight').first().waitFor()
  } finally { await page.context().close() }
})

test('Journey 5 — contents, find, focus, and "mark read and next" that stays on a failure', async () => {
  const fixture = makeServer({ failReadOnce: true })
  const page = await newPage(fixture, { reducedMotion: 'reduce' })
  try {
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/reading`)
    await page.locator('[data-reading-row]').first().waitFor()
    await page.getByRole('link', { name: 'Synthetic article item-1' }).first().click()
    await page.locator('.reader-surface p').first().waitFor()
    // Contents, independent of the inspector.
    await page.keyboard.press('[')
    const outline = page.getByRole('navigation', { name: 'Contents' })
    await outline.getByRole('button', { name: '第4节 Section 4' }).click()
    await settle(page)
    assert.match(await topText(page), /第4节/)
    // Find in this document; Escape goes back to where finding started.
    const before = await shell(page).evaluate(el => el.scrollTop)
    await page.keyboard.press('/')
    await page.getByRole('textbox', { name: 'Find in this document' }).fill('Section 6')
    await page.getByText('1/1').waitFor()
    assert.equal(await page.locator('.reader-find-current').count(), 1)
    await page.keyboard.press('Escape')
    await settle(page)
    assert.equal(await shell(page).evaluate(el => el.scrollTop), before)
    assert.equal(await page.locator('.reader-find-match').count(), 0)
    // Focus mode hides the app's navigation; Escape brings it back.
    await page.locator('.reader-surface p').first().click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('f')
    assert.equal(await page.locator('[data-shell-chrome]').first().evaluate(el => getComputedStyle(el).display), 'none')
    await page.keyboard.press('Escape')
    assert.notEqual(await page.locator('[data-shell-chrome]').first().evaluate(el => getComputedStyle(el).display), 'none')
    // Mark read and next: the first attempt fails and the Reader stays; the second moves on.
    await page.getByRole('button', { name: 'Mark read and next' }).click()
    await page.getByText(/Could not open the next item; you are still here/).waitFor()
    assert.match(page.url(), /item-1\?/)
    await page.getByRole('button', { name: 'Mark read and next' }).click()
    await page.waitForURL(/item-2\?/)
    assert.ok(fixture.state.read.has('item-1'))
    assert.equal(fixture.state.readCalls, 2)
  } finally { await page.context().close() }
})

// Touch and narrow screens. 640 CSS px stands for a 1280px window at 200%
// zoom: the same layout width, but not browser zoom itself (text rendering and
// device pixels differ), so it is reported as an equivalent, not as zoom.
for (const { width, height, label, touch } of [
  { width: 320, height: 640, label: 'a 320px phone', touch: true },
  { width: 640, height: 450, label: '640 CSS px (1280 at 200%, equivalent)', touch: false },
]) {
  test(`Reader settings and tools are reachable with 44px targets on ${label}`, async () => {
    const fixture = makeServer()
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', hasTouch: touch, isMobile: touch })
    const page = await context.newPage()
    await page.addInitScript(() => { localStorage.setItem('rainver:locale', 'en'); localStorage.setItem('rainver:theme', 'dark') })
    await page.route('**/api/v1/**', route => fixture.route(route))
    try {
      await openItem(page, 'item-1')
      const small = await page.locator('.reader-tools button').evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect()).filter(r => r.width < 44 || r.height < 44).length)
      assert.equal(small, 0, 'every Reader tool is at least 44×44 CSS px')
      await page.getByRole('button', { name: 'Reader appearance' }).click()
      const panel = page.getByRole('dialog', { name: 'Reader appearance' })
      const box = await panel.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= width, `panel ${box.x}..${box.x + box.width} inside ${width}`)
      assert.ok(box.y + box.height <= height + 1, 'panel ends inside the viewport (it scrolls)')
      // Every setting, down to Restore defaults, can be reached and pressed.
      for (const name of ['Larger text', 'Relaxed', 'Wide', 'Serif', 'Sepia', 'Restore defaults']) {
        const control = panel.getByRole('button', { name, exact: true })
        await control.scrollIntoViewIfNeeded()
        const target = await control.boundingBox()
        assert.ok(target.width >= 44 && target.height >= 44, `${name} ${target.width}×${target.height}`)
        assert.ok(target.x >= 0 && target.x + target.width <= width, `${name} inside the viewport`)
        await control.click()
      }
      await page.keyboard.press('Escape')
      assert.equal(await panel.count(), 0)
      // Reading list actions on the same screen.
      await page.goto(`${baseUrl}/spaces/${spaceId}/library/reading`)
      await page.locator('[data-reading-row]').first().waitFor()
      const listSmall = await page.locator('.reading-touch [data-reading-row] button').evaluateAll(buttons => buttons.filter(b => b.offsetParent).map(b => b.getBoundingClientRect()).filter(r => r.width < 44 || r.height < 44).length)
      assert.equal(listSmall, 0, 'every list action is at least 44×44 CSS px')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    } finally { await context.close() }
  })
}

test('a document without text shows no reading percentage or position actions; once prepared, it does', async () => {
  const fixture = makeServer()
  const page = await newPage(fixture, { width: 390, height: 844 })
  try {
    let prepared = false
    const empty = { ...documentFor('item-empty', { type: 'doc', content: [{ type: 'paragraph' }] }, 'empty'), plain_text: '', normalized_text: '', content_state: 'metadata_only', extracted_artifact_id: null }
    // Registered after the fixture, so these answer first for this item.
    await page.route('**/api/v1/reader/documents/source_item/item-empty', route => route.fulfill({ json: prepared ? documentFor('item-empty', article(1, 2), 'prepared') : empty }))
    await page.route('**/api/v1/sources/items/item-empty/processing', route => route.fulfill({ json: prepared ? { status: 'succeeded', run_id: 'run-e' } : { status: 'idle' } }))
    await page.route('**/api/v1/sources/items/item-empty/processing/start', route => { prepared = true; return route.fulfill({ json: { status: 'queued', run_id: 'run-e' } }) })
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-empty`)
    await page.getByRole('button', { name: 'Read and prepare' }).waitFor()
    await settle(page)
    assert.equal(await page.getByRole('progressbar').count(), 0, 'no percentage for a body that does not exist')
    assert.equal(await page.locator('[aria-valuenow]').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Reading progress' }).count(), 0)
    await shell(page).evaluate(el => el.dispatchEvent(new Event('scroll')))
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    assert.equal(fixture.state.puts.filter(put => put.id === 'item-empty').length, 0, 'nothing saved for an empty body')
    // Preparing brings the text: the position appears, with its actions.
    await page.getByRole('button', { name: 'Read and prepare' }).click()
    await page.locator('.reader-surface p').first().waitFor()
    await page.getByRole('progressbar').waitFor()
    await page.getByRole('button', { name: 'Reading progress' }).click()
    await page.getByRole('button', { name: 'Make this my reading progress' }).waitFor()
  } finally { await page.context().close() }
})

// The report: Agent-provided Markdown saved without a declared syntax shows its marks as text.
// After the explicit action the same text is structured: headings, bold, a list, spacing.
const PENCHAN = '# Penchan\n\nPenchan 是一个面向研究阅读的信号排序工具。\n\n## 1. 核心定位\n\n- **非线性排名**：按信号而不是时间排序\n- **可解释**：每条结果给出原因\n\n## 2. 使用方式\n\n先订阅来源，再查看 **今日重点**。'
/** Leftmost x of light pixels (the bullet marker) left of a list item's text, from a real screenshot. */
async function markerLeft(page, li) {
  await li.scrollIntoViewIfNeeded()
  const box = await li.boundingBox()
  const textLeft = await li.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects()[0].left })
  const shot = await page.screenshot({ clip: { x: 0, y: box.y, width: Math.max(1, Math.floor(textLeft)), height: Math.min(box.height, 30) } })
  return page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode()
    const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height })
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, image.width, image.height).data
    for (let x = 0; x < image.width; x++) for (let y = 0; y < image.height; y++) {
      const i = (y * image.width + x) * 4
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 450) return x / devicePixelRatio
    }
    return null
  }, shot.toString('base64'))
}

for (const width of [320, 390, 1280]) {
  test(`Agent Markdown shown literally can be shown as Markdown, with a structured first screen (${width}px)`, async () => {
    const fixture = makeServer()
    const page = await newPage(fixture, { width, height: 844 })
    try {
      let structured = false
      const literal = { type: 'doc', content: PENCHAN.split('\n\n').map(part => ({ type: 'paragraph', content: [{ type: 'text', text: part }] })) }
      const agentDoc = () => ({ ...documentFor('item-agent', structured ? markdownToReaderDocument(PENCHAN) : literal, structured ? 'md' : 'literal'), artifact_id: structured ? 'art-md' : 'art-literal', source_snapshot_id: null,
        plain_text: PENCHAN, normalized_text: PENCHAN.replace(/\n{2,}/g, ' '), image_policy: 'none', result_provenance: 'agent_provided_unverified',
        reading_info: { kind: 'article', format: 'source_text', sources: ['https://example.test/penchan'], method: 'agent', ...(structured ? { syntax: 'markdown' } : {}) },
        agent_text_syntax: structured ? 'markdown' : 'undeclared' })
      await page.route('**/api/v1/reader/documents/source_item/item-agent', route => route.fulfill({ json: agentDoc() }))
      let requests = 0
      let asked = null
      await page.route('**/api/v1/sources/items/item-agent/reading-syntax', route => { requests++; asked = route.request().postDataJSON(); structured = true; return route.fulfill({ json: { artifact_id: 'art-md' } }) })
      await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-agent`)
      await page.locator('.reader-surface p').first().waitFor()
      await page.evaluate(() => document.fonts.ready)
      assert.equal(await page.locator('.reader-surface h1, .reader-surface h2').count(), 0)
      assert.match(await page.locator('.reader-surface').innerText(), /# Penchan/)
      await page.screenshot({ path: `/tmp/reader-markdown-before-${width}.png` })
      await page.getByRole('button', { name: 'Show as Markdown' }).click()
      const dialog = page.getByRole('dialog', { name: 'Show this material as Markdown?' })
      assert.match(await dialog.innerText(), /current version is kept/)
      await dialog.getByRole('button', { name: 'Show as Markdown' }).click()
      await page.locator('.reader-surface h1').waitFor()
      assert.equal(requests, 1)
      // The request names the version that was shown.
      assert.deepEqual(asked, { syntax: 'markdown', artifact_id: 'art-literal', source_snapshot_id: null })
      const shape = await page.evaluate(() => {
        const surface = document.querySelector('.reader-surface')
        const size = el => parseFloat(getComputedStyle(el).fontSize)
        const h1 = surface.querySelector('h1'), h2 = surface.querySelector('h2'), p = surface.querySelector('p'), ul = surface.querySelector('ul')
        return { text: surface.innerText, h1: h1?.textContent, h2s: [...surface.querySelectorAll('h2')].map(h => h.textContent), strong: [...surface.querySelectorAll('strong')].map(s => s.textContent),
          items: ul ? ul.querySelectorAll(':scope > li').length : 0, bullet: ul ? getComputedStyle(ul).listStyleType : '', h1Bigger: size(h1) > size(p), h2Bigger: size(h2) > size(p),
          gap: h2.getBoundingClientRect().top - h2.previousElementSibling.getBoundingClientRect().bottom, firstScreen: h1.getBoundingClientRect().top < innerHeight && ul.getBoundingClientRect().top < innerHeight * 1.5,
          overflow: document.documentElement.scrollWidth > innerWidth }
      })
      assert.equal(shape.h1, 'Penchan')
      assert.deepEqual(shape.h2s, ['1. 核心定位', '2. 使用方式'])
      assert.deepEqual(shape.strong, ['非线性排名', '可解释', '今日重点'])
      assert.equal(shape.items, 2)
      assert.equal(shape.bullet, 'disc')
      assert.ok(shape.h1Bigger && shape.h2Bigger, 'headings are larger than the body text')
      assert.ok(shape.gap > 8, `space above a section heading: ${shape.gap}px`)
      assert.ok(!/(^|\n)#|\*\*|(^|\n)- /.test(shape.text), 'no Markdown marks left in the text')
      assert.ok(shape.firstScreen)
      assert.equal(shape.overflow, false)
      // Bullet markers sit inside the reading column, clear of the screen edge (measured in pixels).
      const columnLeft = await page.locator('.reader-column').evaluate(el => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft))
      for (const li of await page.locator('.reader-surface > ul > li').all()) {
        const x = await markerLeft(page, li)
        assert.ok(x !== null, 'a marker is drawn')
        assert.ok(x >= columnLeft - 2, `marker at ${x}px, column text starts at ${columnLeft}px`)
      }
      // The first screen leads with the text: the management line and the Agent notice are compact.
      const firstText = await page.locator('.reader-surface h1').evaluate(el => el.getBoundingClientRect().top)
      assert.ok(firstText < 844 * (width < 400 ? 0.62 : 0.5), `body heading at ${firstText}px`)
      await page.screenshot({ path: `/tmp/reader-markdown-after-${width}.png` })
    } finally { await page.context().close() }
  })
}

test('nested ordered and unordered lists keep their markers inside the column, also right to left (320px)', async () => {
  const fixture = makeServer()
  const page = await newPage(fixture, { width: 320, height: 700 })
  try {
    const markdown = '1. 第一项 first\n   - 嵌套 a\n   - 嵌套 b\n2. 第二项 second\n\n- top bullet\n  1. inner one\n  2. inner two'
    fixture.doc = id => ({ ...documentFor(id, markdownToReaderDocument(markdown), 'lists'), image_policy: 'none' })
    await openItem(page, 'item-lists')
    const columnLeft = await page.locator('.reader-column').evaluate(el => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft))
    for (const li of await page.locator('.reader-surface li').all()) {
      const x = await markerLeft(page, li)
      assert.ok(x !== null && x >= columnLeft - 2, `marker at ${x}px, column text at ${columnLeft}px`)
    }
    // Nested lists are indented from their parent item.
    const nested = await page.locator('.reader-surface li > ul').first().evaluate(el => ({ inner: el.getBoundingClientRect().left, outer: el.parentElement.getBoundingClientRect().left }))
    assert.ok(nested.inner >= nested.outer)
    await page.screenshot({ path: '/tmp/reader-markdown-lists-320.png' })
    // Right to left: the indent is on the right.
    const rtl = await page.locator('.reader-surface').evaluate(el => { el.setAttribute('dir', 'rtl'); const ul = el.querySelector(':scope > ul'); const s = getComputedStyle(ul); return { right: parseFloat(s.paddingRight), left: parseFloat(s.paddingLeft) } })
    assert.ok(rtl.right > rtl.left && rtl.right >= 30, JSON.stringify(rtl))
  } finally { await page.context().close() }
})

// ── Performance ───────────────────────────────────────────────────────────────
// Target device budget (decided before measuring): a low-end phone, emulated
// as Chromium with 4× CPU throttling on this machine — a proxy, not a device.
// For a 2,000-paragraph (~240k characters) mixed article:
//   open to first text ≤ 3,000 ms · scroll p95 frame ≤ 50 ms
//   find (~1,000 matches; at most 300 painted around the current one) ≤ 400 ms · reading-place measure p95 ≤ 8 ms
const BUDGET = { openMs: 3000, frameP95Ms: 50, findMs: 400, anchorP95Ms: 8 }

test('performance on a long synthetic article stays inside the low-end budget (4× CPU throttle)', async () => {
  const longJson = { type: 'doc', content: Array.from({ length: 2000 }, (_, n) => n % 100 === 0 ? h(2, `Part ${n / 100}`) : p(n % 2 ? zh(n) : en(n))) }
  const fixture = makeServer({ longDocument: documentFor('item-long', longJson) })
  const page = await newPage(fixture, { width: 390, height: 844 })
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.goto(`${baseUrl}/spaces/${spaceId}/home`).catch(() => {})
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const started = Date.now()
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-long`)
    await page.locator('.reader-surface p').first().waitFor()
    const openMs = Date.now() - started
    await page.evaluate(() => document.fonts.ready)
    const frames = await page.evaluate(() => new Promise(resolve => {
      const pane = document.querySelector('.reader-document-shell')
      const times = []; let last = performance.now(); let steps = 0
      const step = now => { times.push(now - last); last = now; pane.scrollTop += 600; if (++steps < 120) requestAnimationFrame(step); else resolve(times.slice(1)) }
      requestAnimationFrame(step)
    }))
    const p95 = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length * 0.95)]
    const p50 = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length * 0.5)]
    await page.keyboard.press('/')
    const findStart = Date.now()
    await page.getByRole('textbox', { name: 'Find in this document' }).fill('Paragraph')
    await page.getByText(/^1\/\d+$/).waitFor()
    const findMs = Date.now() - findStart - 150 // minus the input debounce
    const matches = Number((await page.getByText(/^1\/\d+$/).innerText()).split('/')[1])
    const painted = await page.locator('.reader-find-match').count()
    await page.keyboard.press('Escape')
    const anchors = await page.evaluate(async () => {
      const pane = document.querySelector('.reader-document-shell'); const times = []
      for (let i = 0; i < 40; i++) {
        pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * (i / 40)
        await new Promise(resolve => requestAnimationFrame(resolve))
        const blocks = document.querySelector('.reader-surface').children; const bounds = pane.getBoundingClientRect()
        const start = performance.now()
        let lo = 0, hi = blocks.length - 1
        while (lo < hi) { const mid = (lo + hi) >> 1; if (blocks[mid].getBoundingClientRect().bottom <= bounds.top + 4) lo = mid + 1; else hi = mid }
        times.push(performance.now() - start)
      }
      return times
    })
    const result = { device: 'Chromium, 390×844, 4× CPU throttle (proxy, not a real phone)', paragraphs: 2000, characters: plainOf(longJson).length,
      openMs, frameP50Ms: Math.round(p50(frames)), frameP95Ms: Math.round(p95(frames)), findMs, findMatches: matches, findPainted: painted, anchorP95Ms: Number(p95(anchors).toFixed(2)), budget: BUDGET }
    console.info('Reader performance', JSON.stringify(result))
    if (process.env.READER_PERF_OUT) writeFileSync(process.env.READER_PERF_OUT, JSON.stringify(result, null, 2))
    assert.ok(openMs <= BUDGET.openMs, `open ${openMs} ms`)
    assert.ok(result.frameP95Ms <= BUDGET.frameP95Ms, `frame p95 ${result.frameP95Ms} ms`)
    assert.ok(findMs <= BUDGET.findMs, `find ${findMs} ms`)
    assert.ok(result.anchorP95Ms <= BUDGET.anchorP95Ms, `anchor p95 ${result.anchorP95Ms} ms`)
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {})
    await page.context().close()
  }
})


test('wide Reading previews follow selection and confirmed read changes can be undone', async () => {
  const fixture = makeServer()
  const page = await newPage(fixture, { width: 1600 })
  try {
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/reading`)
    const rows = page.locator('[data-reading-row]')
    await rows.first().waitFor()
    await rows.first().focus()
    const preview = page.getByRole('complementary', { name: 'Preview' })
    await preview.getByRole('heading', { name: 'Synthetic article item-1', exact: true }).waitFor()
    await page.keyboard.press('ArrowDown')
    await preview.getByRole('heading', { name: 'Synthetic article item-2', exact: true }).waitFor()
    await rows.nth(3).focus()
    await preview.getByText('Only the summary is available; full text cannot be opened.').waitFor()
    assert.equal(await preview.getByRole('link', { name: 'Open article' }).count(), 0)
    await rows.first().getByRole('button', { name: 'Mark read', exact: true }).click()
    await page.getByText('Marked as read', { exact: true }).waitFor()
    assert.ok(fixture.state.read.has('item-1'))
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-reading-row][data-key="key-1"]') != null)
    assert.equal(fixture.state.read.has('item-1'), false)
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await preview.isVisible(), false)
    await rows.first().getByRole('link', { name: 'Synthetic article item-1', exact: true }).click()
    await page.waitForURL(/item-1\?/)
  } finally { await page.close() }
})


test('annotation export downloads freshly authorized quotes without comment threads', async () => {
  const fixture = makeServer()
  const page = await newPage(fixture)
  try {
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-1`)
    await page.locator('.tiptap').waitFor()
    // Added after initial Reader load: export must revalidate, not use the cached empty list.
    fixture.state.annotations.set('export-1', { id: 'export-1', document_type: 'source_item', document_id: 'item-1', annotation_type: 'highlight', status: 'active', quote_text: 'Fresh authorized quote', label: 'My label', color: null, created_at: now, anchor_json: { quote_text: 'Fresh authorized quote' } })
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export annotation quotes', exact: true }).click()
    const download = await downloadPromise
    assert.equal(download.suggestedFilename(), 'reader-quotes.json')
    const result = JSON.parse(readFileSync(await download.path(), 'utf8'))
    assert.equal(result.quotes.length, 1)
    assert.equal(result.quotes[0].quote, 'Fresh authorized quote')
    assert.equal(result.quotes[0].label, 'My label')
    assert.equal('comments' in result.quotes[0], false)
  } finally { await page.context().close() }
})


test('custom Reader keys replace old keys, reject collisions and reset in the real dialog', async () => {
  const page = await newPage(makeServer())
  try {
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-1`)
    await page.locator('.tiptap').waitFor()
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: 'Enter or leave focus mode' }).fill('x')
    await page.keyboard.press('Escape')
    await page.locator('.tiptap').click()
    await page.keyboard.press('f')
    assert.equal(await page.getByRole('button', { name: 'Exit focus mode', exact: true }).count(), 0)
    await page.keyboard.press('x')
    await page.getByRole('button', { name: 'Exit focus mode', exact: true }).first().waitFor()
    await page.reload()
    await page.locator('.tiptap').waitFor()
    assert.match(await page.getByRole('button', { name: 'Focus mode', exact: true }).getAttribute('title'), /x/)
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Enter or leave focus mode' }).fill('h')
    await dialog.getByRole('alert').waitFor()
    await dialog.getByRole('button', { name: 'Reset keyboard shortcuts' }).click()
    assert.equal(await dialog.getByRole('textbox', { name: 'Enter or leave focus mode' }).inputValue(), 'f')
    await page.setViewportSize({ width: 320, height: 450 })
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getBoundingClientRect().height < 450)
    const sizes = await dialog.getByRole('textbox').evaluateAll(inputs => inputs.map(input => { const rect = input.getBoundingClientRect(); return { width: rect.width, height: rect.height, font: parseFloat(getComputedStyle(input).fontSize) } }))
    assert.ok(sizes.every(size => size.width >= 44 && size.height >= 44 && size.font >= 16), JSON.stringify(sizes))
    await dialog.getByRole('button', { name: 'Reset keyboard shortcuts' }).scrollIntoViewIfNeeded()
    const bounds = await dialog.boundingBox()
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 450, JSON.stringify(bounds))
    await page.screenshot({ path: '/tmp/reader-keyboard-settings-320.png' })
  } finally { await page.context().close() }
})

test('automatic highlighting is opt-in, native ranges only, and undoable', async () => {
  const fixture = makeServer()
  const page = await newPage(fixture)
  try {
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-1`)
    const paragraph = page.locator('.tiptap p').first()
    await paragraph.waitFor()
    await paragraph.click()
    assert.equal(fixture.state.annotations.size, 0)
    const drag = async () => {
      const rect = await paragraph.boundingBox()
      await page.mouse.move(rect.x + 4, rect.y + 10)
      await page.mouse.down()
      await page.mouse.move(rect.x + 160, rect.y + 10, { steps: 8 })
      await page.mouse.up()
    }
    await drag()
    await page.getByRole('toolbar', { name: 'Annotate selection' }).waitFor()
    assert.equal(fixture.state.annotations.size, 0, 'default range selection does not write')
    await page.getByRole('button', { name: 'Reader appearance', exact: true }).click()
    await page.getByRole('checkbox', { name: /Automatically highlight selected text/ }).check()
    await page.keyboard.press('Escape')
    await paragraph.click()
    assert.equal(fixture.state.annotations.size, 0, 'paragraph focus is never an auto-save')
    await drag()
    await page.getByText('Highlighted', { exact: true }).waitFor()
    assert.equal(fixture.state.annotations.size, 1)
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await page.getByText('Annotation removed', { exact: true }).waitFor()
    assert.equal([...fixture.state.annotations.values()][0].status, 'archived')
    await page.getByRole('button', { name: 'Reader appearance', exact: true }).click()
    await page.getByRole('checkbox', { name: /Automatically highlight selected text/ }).uncheck()
    await page.keyboard.press('Escape')
    await drag()
    assert.equal(fixture.state.annotations.size, 1, 'disabled mode does not create another annotation')
  } finally { await page.context().close() }
})


test('adjusting highlight boundaries previews locally, cancels cleanly and saves the same annotation', async () => {
  const fixture = makeServer()
  const page = await newPage(fixture, { width: 1280 })
  try {
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-1`)
    await page.locator('.tiptap p').first().click()
    await page.getByRole('toolbar', { name: 'Annotate selection' }).getByRole('button', { name: 'Highlight', exact: true }).click()
    await page.getByRole('button', { name: 'View', exact: true }).click()
    const original = { ...fixture.state.annotations.get('ann-1') }
    await page.getByRole('button', { name: 'Adjust quote range' }).click()
    const editor = page.getByRole('region', { name: 'Adjust quote range' })
    await editor.getByRole('slider', { name: 'End', exact: true }).focus()
    await page.keyboard.press('ArrowLeft')
    assert.equal(fixture.state.annotations.get('ann-1').quote_text, original.quote_text)
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(fixture.state.annotations.get('ann-1').quote_text, original.quote_text)
    await page.getByRole('button', { name: 'Adjust quote range' }).click()
    await editor.getByRole('slider', { name: 'Start', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await editor.getByRole('button', { name: 'Save range', exact: true }).click()
    await page.getByText('Quote range saved', { exact: true }).waitFor()
    assert.equal(fixture.state.annotations.size, 1)
    const saved = fixture.state.annotations.get('ann-1')
    assert.notEqual(saved.quote_text, original.quote_text)
    assert.equal(saved.id, original.id)
    await page.screenshot({ path: '/tmp/reader-range-adjusted.png' })
  } finally { await page.context().close() }
})


test('document notes require explicit creation and reopen the same independent Notes entry', async () => {
  const fixture = makeServer()
  const page = await newPage(fixture, { width: 390 })
  try {
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-1`)
    await page.getByRole('button', { name: 'Document note', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Create private document note' }).waitFor()
    assert.equal(fixture.state.documentNotes.size, 0)
    await dialog.getByRole('button', { name: 'Create private document note' }).click()
    const link = dialog.getByRole('link', { name: 'Open in Notes' })
    await link.waitFor()
    assert.equal(await link.getAttribute('href'), '/spaces/personal-notes-space/knowledge/notes/note-item-1')
    assert.equal(fixture.state.documentNotes.size, 1)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Document note', exact: true }).click()
    await link.waitFor()
    assert.equal(fixture.state.documentNotes.size, 1)
    assert.equal(fixture.state.annotations.size, 0, 'a document note is not an empty quote annotation')
    await page.screenshot({ path: '/tmp/reader-document-note-390.png' })
  } finally { await page.context().close() }
})

test('opt-in touch swipes follow articles without hijacking wide tables', async () => {
  const fixture = makeServer()
  const tableDoc = markdownToReaderDocument('| A | B |\n|---|---|\n| Wide cell | Second cell |\n\nOrdinary prose for the swipe test.\n\nAnother paragraph for vertical scrolling.')
  fixture.doc = id => documentFor(id, tableDoc)
  const page = await newPage(fixture, { width: 390, height: 844 })
  const cdp = await page.context().newCDPSession(page)
  const swipe = async (target, left = 290, right = 70) => {
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox(), y = Math.max(5, Math.min(830, box.y + 12))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: left, y }] })
    for (let n = 1; n <= 8; n++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: left + (right - left) * n / 8, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  try {
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/reading`)
    await page.getByRole('link', { name: 'Synthetic article item-1', exact: true }).first().click()
    const paragraph = page.locator('.reader-surface > p').first()
    await paragraph.waitFor()
    await swipe(paragraph)
    assert.match(page.url(), /items\/item-1/)
    await page.getByRole('button', { name: 'Swipe between articles', exact: true }).click()
    const table = page.locator('.reader-surface table')
    await table.evaluate(el => { el.style.width = '900px' })
    await swipe(table)
    assert.match(page.url(), /items\/item-1/)
    assert.ok(await page.locator('.reader-table-scroll').evaluate(el => el.scrollLeft > 0), 'wide table keeps native horizontal panning')
    await swipe(paragraph)
    await page.waitForURL(/items\/item-2/)
    assert.equal(fixture.state.readCalls, 0, 'navigation does not mark an article read')
  } finally { await cdp.detach(); await page.context().close() }
})

test('portrait–landscape–portrait keeps the reading paragraph and saved highlight', async () => {
  const fixture = makeServer()
  const page = await newPage(fixture, { width: 390, height: 844 })
  const topBlock = () => page.locator('.reader-document-shell').evaluate(pane => {
    const top = pane.getBoundingClientRect().top
    return [...pane.querySelector('.reader-surface').children].findIndex(block => block.getBoundingClientRect().bottom > top + 8)
  })
  try {
    await openItem(page, 'item-orientation')
    const paragraph = page.locator('.reader-surface > p').nth(24)
    await paragraph.scrollIntoViewIfNeeded()
    await paragraph.click()
    await page.getByRole('toolbar', { name: 'Annotate selection' }).getByRole('button', { name: 'Highlight', exact: true }).click()
    await page.getByText('Highlighted', { exact: true }).waitFor()
    await paragraph.evaluate(el => el.scrollIntoView({ block: 'start' }))
    await settle(page)
    const original = await topBlock()
    for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await settle(page)
      const after = await topBlock()
      assert.ok(Math.abs(after - original) <= 1, `top block moved ${original} → ${after}`)
      assert.ok(await page.locator('.reader-surface [data-annotation-id="ann-1"]').count() > 0)
      assert.equal(fixture.state.readCalls, 0)
    }
  } finally { await page.context().close() }
})

// Established before measuring: real Chromium JS heap (not OS/device RAM),
// 2,000 paragraphs and 0/20/200 annotations; 4× CPU proxy. Open<=3s,
// retained JS heap<=128MiB; 10 SPA document replacements after GC grow<=16MiB.
const MATRIX_BUDGET = { openMs: 3000, heapBytes: 128 * 1024 * 1024, retainedGrowthBytes: 16 * 1024 * 1024 }
test('short/long annotation matrix and ten-document retained heap stay within declared budgets', async () => {
  const results = []
  for (const paragraphs of [20, 2000]) for (const count of [0, 20, 200]) for (const sample of [1, 2, 3]) {
    const content = { type: 'doc', content: Array.from({ length: paragraphs }, (_, n) => p(`Unique row ${n}. ${n % 2 ? zh(n) : en(n)}`)) }
    const fixture = makeServer(); fixture.doc = id => documentFor(id, content)
    for (let n = 0; n < count; n++) {
      const quote = `Unique row ${n % paragraphs}.`
      fixture.state.annotations.set(`matrix-${n}`, { id: `matrix-${n}`, document_type: 'source_item', document_id: 'item-matrix', annotation_type: 'highlight', status: 'active', quote_text: quote,
        color: null, label: null, created_at: now, anchor_state: 'unverified', anchor_json: { schema_version: 1, quote_text: quote, before_context: '', after_context: '' } })
    }
    const page = await newPage(fixture, { width: 390, height: 844 })
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      const annotationsLoaded = page.waitForResponse(response => response.url().endsWith('/item-matrix/annotations'))
      const start = Date.now()
      await openItem(page, 'item-matrix')
      assert.equal((await (await annotationsLoaded).json()).items.length, count)
      if (count) await page.locator('.reader-surface [data-annotation-id]').first().waitFor()
      await settle(page)
      const openMs = Date.now() - start
      await cdp.send('HeapProfiler.collectGarbage')
      const heap = (await cdp.send('Runtime.getHeapUsage')).usedSize
      results.push({ paragraphs, annotations: count, sample, openMs, heapBytes: heap })
      assert.ok(openMs <= MATRIX_BUDGET.openMs, JSON.stringify(results.at(-1)))
      assert.ok(heap <= MATRIX_BUDGET.heapBytes, JSON.stringify(results.at(-1)))
      if (paragraphs === 2000 && count === 200 && sample === 3) {
        // Same JS application: push/pop history to replace the Reader without
        // resetting the entire browser heap as page.goto/reload would do.
        for (let n = 0; n < 10; n++) {
          for (const annotation of fixture.state.annotations.values()) annotation.document_id = `item-cycle-${n}`
          const nextAnnotations = page.waitForResponse(response => response.url().endsWith(`/item-cycle-${n}/annotations`))
          await page.evaluate(n => { history.pushState({}, '', location.pathname.replace(/item-[^/?]+/, `item-cycle-${n}`)); dispatchEvent(new PopStateEvent('popstate')) }, n)
          await page.getByRole('heading', { name: `Synthetic article item-cycle-${n}`, exact: true }).waitFor()
          await page.locator('.reader-surface p').first().waitFor()
          assert.equal((await (await nextAnnotations).json()).items.length, count)
          await page.locator('.reader-surface [data-annotation-id]').first().waitFor()
        }
        await cdp.send('HeapProfiler.collectGarbage')
        const retained = (await cdp.send('Runtime.getHeapUsage')).usedSize
        results.push({ tenDocumentGrowthBytes: retained - heap })
        assert.ok(retained - heap <= MATRIX_BUDGET.retainedGrowthBytes, JSON.stringify(results.at(-1)))
      }
    } finally { await cdp.detach(); await page.context().close() }
  }
  const percentile = (values, fraction) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]
  const summaries = [20, 2000].flatMap(paragraphs => [0, 20, 200].map(annotations => {
    const rows = results.filter(row => row.paragraphs === paragraphs && row.annotations === annotations)
    return { paragraphs, annotations, samples: rows.length, openP50Ms: percentile(rows.map(row => row.openMs), 0.5), openP95Ms: percentile(rows.map(row => row.openMs), 0.95), heapP95Bytes: percentile(rows.map(row => row.heapBytes), 0.95) }
  }))
  writeFileSync('/tmp/reader-memory-annotation-matrix.json', JSON.stringify({ summaries, environment: 'Chromium390×844,4×CPU,JS heap via CDP; synthetic corpus,not physical-device RAM', budget: MATRIX_BUDGET, results }, null, 2))
})


test('real browser 200 percent zoom preserves readable reflow and reachable tools', async () => {
  // Chrome's actual tab zoom, not CSS zoom, device emulation or pinch scaling.
  // Official API: developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom
  // Persistent Chromium extension setup: playwright.dev/docs/chrome-extensions
  const root = mkdtempSync(join(tmpdir(), 'rainver-reader-zoom-'))
  const extension = join(root, 'extension'); mkdirSync(extension)
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Isolated Reader zoom acceptance', version: '1.0', permissions: ['tabs'], background: { service_worker: 'worker.js' } }))
  writeFileSync(join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});')
  let context
  try {
    context = await chromium.launchPersistentContext(join(root, 'profile'), {
      executablePath: process.env.CHROMIUM_EXECUTABLE, channel: 'chromium', viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    })
    const fixture = makeServer()
    const page = context.pages()[0] ?? await context.newPage()
    await page.addInitScript(() => {
      localStorage.setItem('rainver:locale', 'en'); localStorage.setItem('rainver:theme', 'light')
      // Extension startup is independent; keep app API fixture routing authoritative.
      if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('PWA disabled in isolated zoom acceptance'))
    })
    await page.route('**/api/v1/**', route => fixture.route(route))
    await openItem(page, 'item-zoom')
    let worker = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://'))
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 5000, predicate: worker => worker.url().startsWith('chrome-extension://') })
    const before = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio }))
    const actualZoom = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      await chrome.tabs.setZoom(tabs[0].id, 2)
      return chrome.tabs.getZoom(tabs[0].id)
    })
    assert.equal(actualZoom, 2)
    await page.waitForFunction(width => innerWidth <= width / 2 + 1, before.width)
    const metrics = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio, scale: visualViewport.scale, cssZoom: getComputedStyle(document.documentElement).zoom }))
    assert.equal(metrics.ratio, before.ratio * 2)
    assert.equal(metrics.scale, 1)
    assert.equal(metrics.cssZoom, '1')
    assert.ok(await page.locator('.reader-workspace').evaluate(el => el.scrollWidth <= el.clientWidth + 1))
    await page.getByRole('button', { name: 'Reader appearance', exact: true }).click()
    const reset = page.getByRole('button', { name: 'Restore defaults', exact: true })
    await reset.scrollIntoViewIfNeeded()
    assert.ok(await reset.isVisible())
    await page.screenshot({ path: '/tmp/reader-real-browser-zoom-200.png' })
    writeFileSync('/tmp/reader-real-browser-zoom-200.json', JSON.stringify({ actualZoom, before, metrics }, null, 2))
  } finally { await context?.close(); rmSync(root, { recursive: true, force: true }) }
})

test('Reader light and dark state gallery covers normal hover focus selection disabled error and saved', async () => {
  const gallery = []
  for (const theme of ['light', 'dark']) {
    const fixture = makeServer()
    const page = await newPage(fixture, { width: 1280, height: 900, theme })
    const capture = async state => { const path = `/tmp/reader-state-${theme}-${state}.png`; await page.screenshot({ path, animations: 'disabled' }); gallery.push({ theme, state, path }) }
    let release
    try {
      await openItem(page, 'item-gallery')
      await page.evaluate(() => document.fonts.ready)
      await capture('normal')
      const paragraph = page.locator('.reader-surface p').first()
      await paragraph.hover(); await capture('hover')
      await page.getByRole('button', { name: 'Reader appearance', exact: true }).focus(); await capture('focus')
      await paragraph.click(); await capture('selection')
      fixture.state.failCreate = true
      fixture.state.beforeCreate = () => new Promise(resolve => { release = resolve })
      const highlight = page.getByRole('toolbar', { name: 'Annotate selection' }).getByRole('button', { name: 'Highlight', exact: true })
      await highlight.click()
      await page.waitForFunction(() => document.querySelector('.reader-selection-toolbar button')?.disabled)
      await capture('disabled')
      release(); fixture.state.beforeCreate = null
      await page.getByText('Annotation service busy').waitFor(); await capture('error')
      await highlight.click()
      await page.getByText('Highlighted', { exact: true }).waitFor(); await capture('saved')
    } finally { release?.(); await page.context().close() }
  }
  writeFileSync('/tmp/reader-state-gallery.json', JSON.stringify(gallery, null, 2))
})

test('a delayed image after restoring a reading place keeps the same text anchor', async () => {
  const fixture = makeServer(), imageUrl = 'https://reader-image.test/late.svg'
  const content = article(6, 12, [{ type: 'image', attrs: { src: imageUrl, alt: 'Synthetic delayed image' } }])
  fixture.doc = id => documentFor(id, content)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#888"/></svg>'
  const first = await newPage(fixture, { width: 390, height: 844 })
  let saved
  try {
    await first.route(imageUrl, route => route.fulfill({ contentType: 'image/svg+xml', body: svg }))
    await openItem(first, 'item-image-late')
    await first.locator('.reader-surface img').evaluate(el => { el.loading = 'eager' })
    await first.waitForFunction(() => document.querySelector('.reader-surface img')?.naturalWidth > 0)
    const recorded = first.waitForResponse(response => response.url().includes('/item-image-late/position') && response.request().method() === 'PUT')
    await first.locator('.reader-surface > h2').nth(3).evaluate(el => el.scrollIntoView({ block: 'start' }))
    await recorded
    saved = await topText(first)
  } finally { await first.context().close() }
  assert.ok(fixture.state.positions.has('item-image-late'))
  const second = await newPage(fixture, { width: 390, height: 844 })
  let pending, receive
  const routed = new Promise(resolve => { receive = resolve })
  try {
    await second.route(imageUrl, route => { pending = route; receive() })
    await second.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-image-late`, { waitUntil: 'domcontentloaded' })
    await second.locator('.reader-surface p').first().waitFor()
    await second.waitForFunction(() => document.querySelector('.reader-document-shell').scrollTop > 100)
    await second.locator('.reader-surface img').evaluate(el => { el.loading = 'eager' })
    let timeout
    try { await Promise.race([routed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Delayed synthetic image was never requested')), 5000) })]) }
    finally { clearTimeout(timeout) }
    assert.equal(await topText(second), saved)
    await pending.fulfill({ contentType: 'image/svg+xml', body: svg }); pending = null
    await second.waitForFunction(() => document.querySelector('.reader-surface img')?.naturalWidth > 0)
    await settle(second)
    assert.equal(await topText(second), saved)
    assert.equal(fixture.state.readCalls, 0)
  } finally { await second.context().close() }
})


test('main Reading arrival chip matches the reported material card without adding rows or height',async()=>{
 for(const width of [390,1280])for(const density of ['comfortable','compact']){
  const sizes=[];
  for(const fresh of [false,true]){
   const base=makeServer();const row={...listItem(3),title:'Agent工作台资料（合成验收）',summary:null,occurred_at:null,result_provenance:'agent_provided_unverified',topics:[{...topicLink,delivery_kind:'unknown_freshness',new_in_latest_collection:fresh}]};
   const fixture={...base,route:async route=>{const url=new URL(route.request().url());if(url.pathname===`/api/v1/spaces/${spaceId}/reading`)return route.fulfill({json:{items:[row],total:1,next_cursor:null}});return base.route(route)}};
   const page=await newPage(fixture,{width,theme:'light',locale:'zh-CN'});
   try{
    await page.addInitScript(density=>localStorage.setItem('rainver:reading-density',density),density);
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/reading`);
    const card=page.locator('[data-reading-row]').filter({has:page.getByRole('link',{name:row.title})});await card.getByText(fresh?'本次新增':'未读',{exact:true}).waitFor();await settle(page);
    sizes.push(await card.evaluate(el=>{const metadata=el.querySelector('h2').previousElementSibling;return {height:el.getBoundingClientRect().height,metadataHeight:metadata.getBoundingClientRect().height,badges:metadata.querySelectorAll('[class*="rounded-full"]').length,overflow:el.scrollWidth>el.clientWidth}}));
    assert.equal(await card.locator('details[open]').count(),0);assert.equal(base.state.readCalls,0);
    if(density==='comfortable')await card.screenshot({path:`/tmp/reading-main-arrival-${fresh?'after':'before'}-${width}.png`});
   }finally{await page.context().close()}
  }
  assert.equal(sizes[1].badges,sizes[0].badges);assert.equal(sizes[1].metadataHeight,sizes[0].metadataHeight);assert.equal(sizes[1].height,sizes[0].height);assert.equal(sizes[1].overflow,false);
 }
});


test('Version history — header entry, retained body, read-only state and return in both themes and languages', async () => {
  const output = process.env.READER_HISTORY_OUT ?? '/tmp/reader-history-browser'
  mkdirSync(output, { recursive: true })
  for (const theme of ['dark', 'light']) for (const locale of ['en', 'zh-CN']) for (const width of [390, 1280]) {
    const fixture = makeServer(), page = await newPage(fixture, { theme, locale, width })
    const zh = locale === 'zh-CN', tag = `${theme}-${locale}-${width}`
    try {
      await openItem(page, 'history-article', '?from=project&returnTo=%2Flibrary%2Freading')
      const entry = page.getByRole('button', { name: zh ? '版本历史' : 'Version history', exact: true })
      await entry.focus()
      await page.screenshot({ path: join(output, `${tag}-entry.png`), animations: 'disabled' })
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog'); await dialog.waitFor()
      await dialog.getByText(zh ? '当前版本' : 'Current', { exact: true }).waitFor()
      await page.screenshot({ path: join(output, `${tag}-list.png`), animations: 'disabled' })
      const box = await dialog.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `Dialog must fit ${tag}: ${JSON.stringify(box)}`)
      await dialog.locator('li').nth(1).getByRole('button').click()
      await page.getByText('Retained evidence from the earlier reading.', { exact: true }).waitFor()
      assert.match(page.url(), /version=earlier-snapshot/)
      assert.equal(await page.getByRole('button', { name: zh ? '重新读取整理' : 'Read again', exact: true }).count(), 0)
      await page.screenshot({ path: join(output, `${tag}-body.png`), animations: 'disabled' })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.getByRole('button', { name: zh ? '返回最新版本' : 'Back to latest', exact: true }).click()
      await page.locator('.reader-surface p').first().waitFor()
      assert.doesNotMatch(page.url(), /version=/)
      assert.match(page.url(), /from=project/)
      assert.equal(fixture.state.annotations.size, 0)
    } finally { await page.context().close() }
  }
})


test('Reading execution — choose Antigravity or OpenCode API before rerunning, without starting a model on settings open', async () => {
  const output = '/tmp/reading-investigation-browser'; mkdirSync(output, { recursive: true })
  for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
    const fixture=makeServer(), page=await newPage(fixture,{locale,theme,width}), zh=locale==='zh-CN', tag=`${theme}-${locale}-${width}`
    try {
      await openItem(page,'investigation-test')
      await page.screenshot({path:join(output,`${tag}-entry.png`),animations:'disabled'})
      await page.getByRole('button',{name:zh?'执行设置':'Execution settings',exact:true}).click()
      const dialog=page.getByRole('dialog');await dialog.waitFor()
      const agent=dialog.getByRole('button',{name:zh?'Agent':'Agent',exact:true}); await agent.click()
      await page.getByRole('option',{name:'Research Agent',exact:true}).click()
      await dialog.getByText(/OpenCode API · opencode/).waitFor()
      const profile=dialog.getByRole('button',{name:zh?'运行配置':'Runtime configuration',exact:true});await profile.click()
      await page.getByRole('option',{name:'Antigravity · antigravity',exact:true}).click()
      await page.screenshot({path:join(output,`${tag}-antigravity.png`),animations:'disabled'})
      const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1)
      assert.equal(fixture.state.prepared,undefined)
      await profile.click();await page.getByRole('option',{name:/OpenCode API · opencode/}).click()
      await page.screenshot({path:join(output,`${tag}-api.png`),animations:'disabled'})
      await dialog.getByRole('button',{name:zh?'完成':'Done',exact:true}).click()
      await page.getByRole('button',{name:zh?'重新读取整理':'Read again',exact:true}).click()
      await page.getByRole('dialog').getByRole('button',{name:zh?'重新读取':'Read again',exact:true}).click()
      await page.waitForFunction(()=>document.querySelector('a[href$="/runs/research-run"]'))
      assert.deepEqual(fixture.state.prepared,{agent_id:'research-agent',runtime_profile_id:'opencode-api',investigation:true})
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    } finally {await page.context().close()}
  }
})
