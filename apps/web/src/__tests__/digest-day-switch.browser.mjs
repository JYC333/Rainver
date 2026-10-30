import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

// Stepping between days of a Project and a personal digest, in the built app
// and the real Shell. Every request is answered by the fixture below, and each
// day read is held open until the test releases it, so the page can be looked
// at while the day loads. Synthetic data only.
let server, browser, baseUrl
before(async () => {
  server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } })
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.httpServer.close(resolve)) })

const spaceId = 'space-fixture'
const projectId = 'project-fixture'
const OUT = '/tmp/rainver-digest-day-switch'
const now = '2026-10-30T08:00:00.000Z'
const coverage = { since: null, cutoff: now, candidates: 1, included: 1, merged_duplicates: 0, not_ready: 0, truncated: 0, egress_refused: 0, not_shared_with_audience: 0, carried_from_previous: 0, unchanged_since_previous: 0, background: 0, context_changed: false, complete: true }
const briefing = { id: 'brief-1', version: 1, kind: 'manual', status: 'ready', outcome: 'briefing', comparison: 'baseline', period_date: null, cutoff_at: now, created_at: now, completed_at: now, checked_at: null, error_code: null, scope_type: 'project', previous_briefing_id: null, run_status: null, coverage, visibility: 'visible', hidden_units: 0, overview: { text: 'Synthetic fixture briefing that must outlive a day change.', refs: [] }, highlights: [], open_questions: [], evidence: [], context: [], context_outdated: false }
const limits = { runs_per_day: 6, runs_in_last_day: 0, attempts_per_version: 3, run_seconds: 900, news_inputs: 40, background_families: 12, request_chars: 48000, carried_items: 200, token_cap: null, cost_cap: null }
const summary = b => ({ id: b.id, version: b.version, kind: b.kind, status: b.status, outcome: b.outcome, comparison: b.comparison, period_date: b.period_date, cutoff_at: b.cutoff_at, created_at: b.created_at, completed_at: b.completed_at, checked_at: b.checked_at, error_code: b.error_code })
const item = date => ({ id: `item-${date}`, source_item_id: `source-${date}`, section: 'interest', position: 0, quota_slot: 'interest:1', matched_topic_id: null, serendipity_pool_item_id: null, target_domain_key: null, discovery_origin: null, score: 0.8, component_scores: {}, rationale: 'Fixture rationale.', title: `Fixture item of ${date}`, source_uri: null, source_domain: null, author: null, excerpt: null, occurred_at: now, domain_key: 'robotics', depth: 'overview', genre: 'news', summary: `Fixture summary of ${date}`, stance_target: null, stance_target_key: null, stance_polarity: 'neutral', stance_confidence: 0, read_status: 'unread', serendipity_feedback: null, anonymous_read_count: null })
const lookup = (date, type) => ({ status: 'available', digest: { id: `digest-${date}`, digest_type: type, owner_user_id: null, project_id: type === 'project' ? projectId : null, digest_date: date, timezone: 'UTC', period_start_utc: `${date}T00:00:00.000Z`, period_end_utc: `${date}T23:59:59.999Z`, generation_kind: 'scheduled', generated_at: now, profile_maturity: null, status: 'ready', settings: {}, created_at: now, updated_at: now, team_aggregates_available: false, team_blind_spot_domains: [], items: [item(date)] } })

/** Answers the Shell and page reads; a digest read of a dated day waits for `release`. */
async function routes(page, type) {
  const held = []
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/api/v1', '')
    const json = data => route.fulfill({ json: data })
    if (route.request().method() !== 'GET') return route.fulfill({ status: 404, json: { detail: 'Not part of the browser fixture' } })
    if (path.includes('/information-digests') && !path.includes('/profile') && !path.includes('/annotation') && !path.includes('/information-briefings')) {
      const date = url.searchParams.get('date')
      if (!date) return json(lookup('2026-10-29', type))
      held.push({ date, release: () => json(lookup(date, type)), fail: () => route.fulfill({ status: 503, json: { detail: 'Fixture day unavailable' } }) })
      return undefined
    }
    if (path.endsWith('/information-briefings')) return json({ can_generate: true, limits, daily_enabled: false, latest: briefing, latest_briefing: briefing, history: [summary(briefing)] })
    if (path === '/me') return json({ id: 'user-fixture', name: 'Tester', default_space_id: spaceId, instance_role: 'member' })
    if (path === '/me/spaces') return json([{ id: spaceId, name: 'Fixture Space', type: 'personal', role: 'owner' }])
    if (path === '/plugins/effective') return json({ plugins: {} })
    if (path === `/projects/${projectId}/overview`) return json({ project: { id: projectId, name: 'Fixture robotics', status: 'active' }, brief: null, attention: [] })
    if (path === `/projects/${projectId}`) return json({ id: projectId, space_id: spaceId, name: 'Fixture robotics', status: 'active' })
    if (path === '/projects') return json({ items: [{ id: projectId, name: 'Fixture robotics' }], total: 1, limit: 200, offset: 0 })
    if (path.endsWith('/members') || path.endsWith('/operations')) return json([])
    if (path.includes('briefings')) return json({ items: [], total: 0, limit: 10, offset: 0 })
    return route.fulfill({ status: 404, json: { detail: 'Not part of the browser fixture' } })
  })
  return held
}

const nextHeld = async (page, held, count) => { while (held.length < count) await page.waitForTimeout(20) }
const bigSkeletons = page => page.locator('.animate-pulse.h-32').count()

async function stepThrough(page, held, label, width) {
  await page.setViewportSize({ width, height: 900 })
  const first = held.length
  const shown = await page.getByTestId('digest-day-content').getByText(/^Fixture item of /).first().innerText()
  await page.getByRole('button', { name: 'Previous day', exact: true }).click()
  await nextHeld(page, held, first + 1)
  const { date } = held[first]

  // While the day loads: the frame stands, no large skeletons, both days named, the old one inert.
  assert.equal(await bigSkeletons(page), 0, 'no large skeletons while a day loads')
  await page.getByRole('button', { name: 'Previous day', exact: true }).waitFor()
  const pending = page.getByTestId('digest-day-pending')
  await pending.getByText(/^Loading .*Still showing /).waitFor()
  const content = page.getByTestId('digest-day-content')
  assert.equal(await content.getAttribute('aria-busy'), 'true')
  assert.equal(await content.evaluate(element => element.inert), true)
  await content.getByText(shown).waitFor()
  const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(geometry.scroll <= geometry.viewport + 1, JSON.stringify(geometry))
  await page.screenshot({ path: `${OUT}/${label}-pending-${width}.png` })

  await held[first].release()
  await content.getByText(`Fixture item of ${date}`).waitFor()
  assert.equal(await pending.count(), 0)
  assert.equal(await content.getAttribute('aria-busy'), 'false')
  await page.screenshot({ path: `${OUT}/${label}-loaded-${width}.png` })
}

test('Project digest: stepping days keeps the frame and the briefing, on phone and desktop', async () => {
  await mkdir(OUT, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' })
  try {
    const held = await routes(page, 'project')
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${baseUrl}/spaces/${spaceId}/projects/${projectId}/sources?tab=digest`)
    const panel = page.getByTestId('project-briefing')
    await panel.getByText(briefing.overview.text).waitFor()
    await page.getByTestId('digest-day-content').getByText('Fixture item of 2026-10-29').waitFor()
    // The very element must survive: not reloaded or rebuilt by a day change.
    await panel.evaluate(element => { element.dataset.fixtureKept = 'yes' })
    await stepThrough(page, held, 'project', 390)
    await stepThrough(page, held, 'project', 1280)
    assert.equal(await page.locator('[data-fixture-kept="yes"]').count(), 1, 'the briefing panel was not remounted')
    // A failed day: no earlier content under it, the navigation stays.
    await page.getByRole('button', { name: 'Previous day', exact: true }).click()
    await nextHeld(page, held, 3)
    await held[2].fail()
    await page.getByRole('alert').filter({ hasText: 'Could not load' }).waitFor()
    assert.equal(await page.getByTestId('digest-day-content').getByText(/^Fixture item of /).count(), 0)
    await page.getByRole('button', { name: 'Previous day', exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('Personal digest: stepping days keeps the frame, on phone and desktop', async () => {
  await mkdir(OUT, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' })
  try {
    const held = await routes(page, 'personal')
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${baseUrl}/spaces/${spaceId}/library/digests`)
    await page.getByTestId('digest-day-content').getByText('Fixture item of 2026-10-29').waitFor()
    await stepThrough(page, held, 'personal', 390)
    await stepThrough(page, held, 'personal', 1280)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
