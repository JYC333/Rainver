import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

// The personal briefing above personal Reading, in the built app and the real
// Shell. Every request is answered by the in-memory fixture below; the data is
// synthetic and no instance data is read.
let server, browser, baseUrl
before(async () => {
  server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } })
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.httpServer.close(resolve)) })

const spaceId = 'space-personal'
const ITEM = '11111111-1111-4111-8111-111111111111'
const now = '2026-10-30T08:00:00.000Z'
const coverage = { since: null, cutoff: now, candidates: 3, included: 2, merged_duplicates: 0, not_ready: 1, truncated: 0, egress_refused: 0, not_shared_with_audience: 0, carried_from_previous: 0, unchanged_since_previous: 0, background: 0, context_changed: false, complete: false }
const queued = { id: 'pb-1', version: 1, kind: 'manual', status: 'queued', outcome: null, comparison: 'baseline', period_date: null, cutoff_at: now, created_at: now, completed_at: null, checked_at: null, error_code: null, scope_type: 'personal', previous_briefing_id: null, run_status: 'running', coverage, visibility: 'visible', hidden_units: 0, overview: null, highlights: [], open_questions: [], evidence: [], context: [], context_outdated: false }
const ready = { ...queued, status: 'ready', outcome: 'briefing', run_status: null, completed_at: now,
  overview: { text: 'Synthetic fixture: your gripper topic and the Robotics Project report one launch from two outlets.', refs: ['S1', 'S2'] },
  highlights: [{ title: 'Fixture gripper launch', what_changed: 'Two outlets report the same launch; grouped as one event.', novelty: 'baseline', importance: 'high', why_it_matters: 'It is your stated focus.', impact: { assessment: 'affects', text: 'Bears on your soft-gripper topic.', context_refs: ['C1'] }, suggested_action: 'watch', statements: [{ kind: 'fact', text: 'The fixture gripper launched.', refs: ['S1', 'S2'] }], contradictions: null, refs: ['S1', 'S2'], source_domains: 2, rests_on_unverified: false, index: 0 }],
  evidence: [
    { key: 'S1', source_item_id: ITEM, title: 'Fixture launch report', source_domain: 'news.fixture.test', occurred_at: now, delta_class: 'baseline', unverified: false, lenses: [{ kind: 'following', label: 'Soft grippers' }, { kind: 'corpus', label: 'Project "Robotics": Corpus' }] },
    { key: 'S2', source_item_id: '22222222-2222-4222-8222-222222222222', title: 'Fixture launch, other outlet', source_domain: 'other.fixture.test', occurred_at: now, delta_class: 'baseline', unverified: false, lenses: [{ kind: 'subscription', label: 'Fixture feed' }] },
  ],
  context: [{ key: 'C1', kind: 'personal_focus', label: 'Following: Soft grippers' }] }
const summary = b => ({ id: b.id, version: b.version, kind: b.kind, status: b.status, outcome: b.outcome, comparison: b.comparison, period_date: b.period_date, cutoff_at: b.cutoff_at, created_at: b.created_at, completed_at: b.completed_at, checked_at: b.checked_at, error_code: b.error_code })
const listItem = n => ({ key: `key-${n}`, source_item_id: `item-${n}`, source_item_ids: [`item-${n}`], title: `Synthetic reading item ${n}`, source_uri: null, occurred_at: now, summary: `Summary ${n}`, access_level: 'full', reader_origin: 'library', read_status: 'unread', dismissed: false, available_at: now, contributions: [], topics: [], material_links: [], reading_progress: null })

test('Personal briefing above Reading: generate, follow progress, open the cited briefing, list still in reach on phone and desktop', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' })
  let latest = null, reads = 0
  const writes = []
  try {
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url())
      const path = url.pathname.replace('/api/v1', '')
      const method = route.request().method()
      const json = data => route.fulfill({ json: data })
      if (path === `/spaces/${spaceId}/information-briefings/personal` && method === 'POST') { writes.push(path); latest = queued; reads = 0; return json({ created: true, briefing: queued }) }
      if (path === `/spaces/${spaceId}/information-briefings/personal`) {
        if (latest?.status === 'queued' && ++reads >= 2) latest = ready
        return json({ can_generate: true, daily_enabled: false, latest, latest_briefing: latest?.outcome === 'briefing' ? latest : null, history: latest ? [summary(latest)] : [] })
      }
      if (method !== 'GET') { writes.push(path); return route.fulfill({ status: 404, json: { detail: 'Not part of the browser fixture' } }) }
      if (path === '/me') return json({ id: 'user-p', name: 'Tester', default_space_id: spaceId, instance_role: 'member' })
      if (path === '/me/spaces') return json([{ id: spaceId, name: 'Personal Space', type: 'personal', role: 'owner' }])
      if (path === '/plugins/effective') return json({ plugins: {} })
      if (path === '/sources/goals') return json({ goals: [] })
      if (path === `/spaces/${spaceId}/reading`) return json({ items: Array.from({ length: 6 }, (_, n) => listItem(n + 1)), total: 6, next_cursor: null })
      return route.fulfill({ status: 404, json: { detail: 'Not part of the browser fixture' } })
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/reading`)
    const panel = page.getByTestId('personal-briefing')
    await panel.getByText('No briefing yet.', { exact: true }).waitFor()
    await page.getByRole('link', { name: 'Synthetic reading item 1' }).waitFor()
    assert.equal(writes.length, 0, 'Opening Reading must not generate a briefing')
    await panel.getByRole('button', { name: 'Generate briefing', exact: true }).click()
    await panel.getByText('Synthesizing… (Run running)', { exact: true }).waitFor()
    await panel.getByText(ready.overview.text).waitFor({ timeout: 15000 })
    assert.deepEqual(writes, [`/spaces/${spaceId}/information-briefings/personal`])
    // Collapsed: the list stays within reach right under it.
    assert.equal(await panel.getByText('Fixture gripper launch', { exact: true }).count(), 0)
    await page.getByRole('link', { name: 'Synthetic reading item 1' }).waitFor()
    await mkdir('/tmp/rainver-briefing-p2', { recursive: true })
    await page.screenshot({ path: '/tmp/rainver-briefing-p2/personal-collapsed-390.png' })
    await panel.getByRole('button', { name: 'Show full briefing', exact: true }).click()
    await panel.getByText('Fixture gripper launch', { exact: true }).waitFor()
    await panel.getByText(/Project "Robotics": Corpus/).waitFor()
    await panel.getByText('Impact on your focus:').waitFor()
    assert.equal(await panel.getByText('Impact on the Project:').count(), 0)
    assert.equal(await panel.getByRole('link', { name: 'Fixture launch report', exact: true }).getAttribute('href'), `/library/items/${ITEM}?from=library&returnTo=%2Flibrary%2Freading`)
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
      assert.ok(geometry.scroll <= geometry.viewport + 1, JSON.stringify(geometry))
      await panel.screenshot({ path: `/tmp/rainver-briefing-p2/personal-open-${width}.png` })
    }
    await panel.getByRole('button', { name: 'Show less', exact: true }).click()
    await page.getByRole('link', { name: 'Synthetic reading item 6' }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
