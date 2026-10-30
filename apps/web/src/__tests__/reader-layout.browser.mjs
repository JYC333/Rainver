import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { markdownToReaderDocument, readerNodeText } from '@rainver/reader-document'

// The built Reader inside the real Shell, with a synthetic mixed Chinese/English
// article. No request reaches a backend and no instance data is read.
const spaceId = 'space-reader'
const now = '2026-10-29T08:00:00.000Z'
const text = value => ({ type: 'text', text: value })
const p = value => ({ type: 'paragraph', content: [text(value)] })
const zh = '阅读体验的第一步是让正文安静而清楚：段落之间要有可见的呼吸，标题要分出层次，长句在窄屏上也不能把页面撑出横向滚动。'
const en = 'Long-form reading needs a calm measure, visible paragraph rhythm and headings that separate sections without shouting.'
const longUrl = `https://example.test/${'very-long-path-segment-'.repeat(12)}`
const content = { type: 'doc', content: [
  p(zh), p(en), p(`${zh}${en}`),
  { type: 'heading', attrs: { level: 2 }, content: [text('第二节 Section two')] },
  p(`${zh} ${longUrl}`),
  { type: 'bulletList', content: [
    { type: 'listItem', content: [p('第一项 first item'), { type: 'bulletList', content: [{ type: 'listItem', content: [p('嵌套项 nested item')] }] }] },
    { type: 'listItem', content: [p('第二项 second item')] },
  ] },
  { type: 'blockquote', content: [p(zh), p(en)] },
  { type: 'table', content: [
    { type: 'tableRow', content: [1, 2, 3].map(n => ({ type: 'tableHeader', content: [p(`UnbrokenTableHeading${'X'.repeat(30)}${n}`)] })) },
    { type: 'tableRow', content: [1, 2, 3].map(n => ({ type: 'tableCell', content: [p(`单元格 ${n}`), p(`cell ${n}`)] })) },
  ] },
  { type: 'codeBlock', content: [text(`    indented = "${'0123456789'.repeat(12)}"`)] },
  { type: 'heading', attrs: { level: 3 }, content: [text('第三节 Section three')] },
  p(en),
] }
const plain = content.content.map(function flat(node) { return node.text ?? (node.content ?? []).map(flat).join('\n\n') }).join('\n\n')
const doc = {
  document_type: 'source_item', document_id: 'item-1', space_id: spaceId, project_id: null,
  title: '长文阅读体验：一篇用于验证段距、标题层级与窄屏换行的合成文章 Synthetic reading layout article',
  plain_text: plain, normalized_text: plain.replace(/\n{2,}/g, ' '), content_hash: 'synthetic', structure_hash: 'synthetic-tree', content_format: 'tiptap_json',
  content_schema_version: 1, content_json: content, source_item_id: 'item-1', artifact_id: null, source_snapshot_id: null,
  raw_artifact_id: null, extracted_artifact_id: null, source_uri: 'https://example.test/article', content_state: 'content_saved',
  retention_policy: null, can_annotate: true,
}
const annotation = {
  id: 'ann-1', space_id: spaceId, project_id: null, document_type: 'source_item', document_id: 'item-1', annotation_type: 'highlight',
  quote_text: '阅读体验的第一步', anchor_json: { schema_version: 1, normalizer: 'plain_text_v1', structure_hash: 'synthetic-tree', quote_text: '阅读体验的第一步',
    text_range: { start: 0, end: 8, unit: 'utf16' }, before_context: '', after_context: '', tiptap_range: { from: 1, to: 9 } },
  color: null, label: null, visibility: 'private', status: 'active', anchor_state: 'verified', created_by_user_id: 'user-reader',
  created_at: now, updated_at: now,
}

const projectId = 'project-reader'
const report = {
  id: 'report-1', project_id: projectId, workflow_id: 'wf', operation_id: 'op', synthesis_run_id: 'run-1', run_kind: 'incremental',
  research_question: `长文研究问题：如何在窄屏和侧栏并存时保持报告可读？ ${'A long research question that must wrap. '.repeat(3)}`,
  current_research_question: null, research_question_version: 1, status: 'awaiting_review', created_at: now, updated_at: now,
  content: {}, integrity: { artifact_id: null, status: 'not_run' }, archive_descriptors: [], resolved_references: [],
}
const briefing = {
  source_channel_id: 'conn-1', connection_name: 'Synthetic digest source', project_id: null, date: '2026-10-29', runs: [],
  digests: [{ artifact_id: 'digest-1', content: `# 今日摘要\n\n${zh}\n\n${en}\n\n- 第一条 ${longUrl}\n- 第二条\n\n| ${'UnbrokenDigestHeading'.repeat(4)} | B |\n|---|---|\n| 1 | 2 |\n\n\`\`\`\n${'0123456789'.repeat(15)}\n\`\`\`` }],
  item_summaries: [], item_decisions: [],
}

// Agent-declared Markdown converted by the shared converter, as the server writer stores it.
const markdownCode = '    def measure(width):\n        return width / 2  # 中文 🙂\n\n\tindented with tab'
const markdownSource = [
  '# Agent 正文 Markdown', '', '**粗体** *斜体* `inline()` [link](https://example.test/l) 🙂', '',
  '#### Four', '##### Five', '###### Six', '',
  '```python', markdownCode, '```', '',
  '- 第一层', '  - 第二层', '    - 第三层', '', '3. three', '4. four', '',
  `| ${'UnbrokenMarkdownHeading'.repeat(5)} | B |`, '|---|---|', '| 1 | 2 |', '',
  '![broken]()', '', 'Repeated sentence here. Repeated sentence here. Unique closing words.',
].join('\n')
const markdownJson = markdownToReaderDocument(markdownSource)
const markdownPlain = markdownJson.content.map(readerNodeText).filter(Boolean).join('\n\n')
const markdownDoc = { ...doc, document_id: 'item-md', source_item_id: 'item-md', title: 'Agent Markdown', content_json: markdownJson,
  plain_text: markdownPlain, normalized_text: markdownPlain.replace(/\n{2,}/g, ' '), content_hash: 'text-2', structure_hash: 'tree-2', image_policy: 'none',
  result_provenance: 'agent_provided_unverified' }
const staleAnchor = (id, quote, extra = {}) => ({ ...annotation, id, quote_text: quote, document_id: 'item-md',
  anchor_json: { ...annotation.anchor_json, quote_text: quote, before_context: '', after_context: '', tiptap_range: { from: 1, to: 9 }, structure_hash: 'tree-1', ...extra } })
const markdownAnnotations = [
  staleAnchor('ann-relocated', 'Unique closing words'),
  staleAnchor('ann-ambiguous', 'Repeated sentence here'),
]

async function mockApi(page, { annotations = 'ok', created } = {}) {
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    const method = route.request().method()
    let data
    if (path === '/me') data = { id: 'user-reader', name: 'Reader tester', email: 'reader@example.test', default_space_id: spaceId, instance_role: 'member' }
    else if (path === '/me/spaces') data = [{ id: spaceId, name: 'Reader Space', type: 'personal', role: 'owner' }]
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/reader/documents/source_item/item-1') data = doc
    else if (path === '/reader/documents/source_item/item-md') data = markdownDoc
    else if (path === '/reader/documents/source_item/item-md/annotations') data = { items: markdownAnnotations }
    else if (path === '/sources/items/item-md/processing') data = { status: 'idle' }
    else if (path === '/reader/documents/source_item/item-1/annotations') {
      if (annotations === 'fail') return route.fulfill({ status: 500, json: { detail: 'Annotation service unavailable' } })
      data = { items: [annotation] }
    } else if (path === '/reader/annotations' && method === 'POST') {
      created?.push(route.request().postDataJSON())
      data = { ...annotation, id: `created-${created?.length ?? 0}` }
    } else if (path === '/sources/items/item-1/processing') data = { status: 'idle' }
    else if (path === '/reader/annotations/ann-1/threads') data = { items: [] }
    else if (path === `/projects/${projectId}`) data = { id: projectId, space_id: spaceId, name: 'Reader project', status: 'active' }
    else if (path === '/projects') data = { items: [{ id: projectId, space_id: spaceId, name: 'Reader project', status: 'active' }], total: 1, limit: 100, offset: 0 }
    else if (path === `/projects/${projectId}/research/reports/report-1`) data = report
    else if (path === '/reader/documents/research_report/report-1') data = { ...doc, document_type: 'research_report', document_id: 'report-1', project_id: projectId, title: 'Research report', source_item_id: null, source_uri: null, content_state: null }
    else if (path === '/reader/documents/research_report/report-1/annotations') data = { items: [] }
    else if (path === '/sources/briefings/conn-1/2026-10-29') data = briefing
    else if (path === '/me/agent-attention/stream') return route.fulfill({ status: 503, body: '' })
    else return route.fulfill({ status: 404, json: { detail: 'Unavailable in reader fixture' } })
    return route.fulfill({ json: data })
  })
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

async function openReader({ width, height = 900, locale = 'en', theme = 'dark', options, touch = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, serviceWorkers: 'block' })
  await page.addInitScript(([lng, mode]) => { localStorage.setItem('rainver:locale', lng); localStorage.setItem('rainver:theme', mode) }, [locale, theme])
  await mockApi(page, options)
  await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-1`)
  await page.locator('.reader-surface p').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  return page
}

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

const measure = page => page.evaluate(() => {
  const surface = document.querySelector('.reader-surface')
  const top = el => parseFloat(getComputedStyle(el).marginTop)
  const blocks = [...surface.children]
  const pAfterP = blocks.find((el, i) => i > 0 && el.tagName === 'P' && blocks[i - 1].tagName === 'P')
  const pAfterH2 = blocks.find((el, i) => i > 0 && el.tagName === 'P' && blocks[i - 1].tagName === 'H2')
  const ul = blocks.find((el, i) => i > 0 && el.tagName === 'UL')
  const quote = surface.querySelector('blockquote')
  const cell = surface.querySelector('td')
  const shell = document.querySelector('.reader-document-shell')
  const column = document.querySelector('.reader-column')
  return {
    viewport: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth,
    shellClient: shell.clientWidth, shellScroll: shell.scrollWidth,
    columnWidth: column.getBoundingClientRect().width,
    fontSize: parseFloat(getComputedStyle(surface).fontSize), lineHeight: parseFloat(getComputedStyle(surface).lineHeight),
    pAfterP: top(pAfterP), pAfterH2: top(pAfterH2), h2: top(surface.querySelector('h2')), ul: top(ul),
    quoteP: top(quote.children[1]), cellP: top(cell.children[1]),
    leadTitle: document.querySelector('.reader-lead-title')?.textContent ?? null,
    inspector: Boolean(document.querySelector('.reader-inspector')),
  }
})

test('Reader body has visible paragraph and heading rhythm and no page-wide horizontal scroll', async () => {
  for (const locale of ['en', 'zh-CN']) {
    for (const theme of ['dark', 'light']) {
      const page = await openReader({ width: 1440, locale, theme })
      try {
        const desktop = await measure(page)
        assert.equal(desktop.fontSize, 18, JSON.stringify(desktop))
        assert.ok(Math.abs(desktop.lineHeight - 31.5) < 0.5, JSON.stringify(desktop))
        assert.ok(desktop.pAfterP >= 14 && desktop.pAfterP <= 18, JSON.stringify(desktop))
        assert.ok(desktop.h2 > desktop.pAfterP && desktop.pAfterH2 > 0 && desktop.pAfterH2 < desktop.pAfterP, JSON.stringify(desktop))
        assert.ok(desktop.ul > 0 && desktop.quoteP > 0 && desktop.cellP > 0, JSON.stringify(desktop))
        assert.ok(desktop.columnWidth <= 18 * 38 + 1, JSON.stringify(desktop))
        assert.equal(desktop.leadTitle, doc.title)
        assert.ok(desktop.inspector, 'desktop opens with the inspector')
        await page.screenshot({ path: `/tmp/reader-stage1-desktop-${locale}-${theme}.png` })

        for (const width of [1024, 768, 390, 320]) {
          await page.setViewportSize({ width, height: 900 })
          await settle(page)
          const narrow = await measure(page)
          assert.ok(narrow.documentWidth <= narrow.viewport + 1, JSON.stringify({ width, ...narrow }))
          assert.ok(narrow.shellScroll <= narrow.shellClient + 1, JSON.stringify({ width, ...narrow }))
          if (width <= 390) assert.equal(narrow.fontSize, 17, JSON.stringify({ width, ...narrow }))
        }
      } finally {
        await page.close()
      }
    }
  }
})

test('a phone opens on the text; the drawer opens on demand, stays closable and keeps the column', async () => {
  for (const width of [390, 320]) {
    const page = await openReader({ width, height: 780, locale: 'zh-CN' })
    try {
      const initial = await measure(page)
      assert.equal(initial.inspector, false, JSON.stringify(initial))
      await page.screenshot({ path: `/tmp/reader-stage1-phone-${width}-closed.png` })
      await page.getByRole('button', { name: '显示检查面板' }).click()
      const drawer = page.getByRole('complementary', { name: '阅读检查面板' })
      await drawer.waitFor()
      const close = drawer.getByRole('button', { name: '关闭检查面板' })
      const hit = await close.evaluate(button => {
        const box = button.getBoundingClientRect()
        const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return { inViewport: box.top >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth, reachable: button.contains(at) }
      })
      assert.deepEqual(hit, { inViewport: true, reachable: true })
      const box = await drawer.boundingBox()
      assert.ok(box && box.height <= 780 * 0.65 + 1, JSON.stringify(box))
      await page.screenshot({ path: `/tmp/reader-stage1-phone-${width}-drawer.png` })
      await close.click()
      await drawer.waitFor({ state: 'detached' })
      const closed = await measure(page)
      assert.ok(closed.documentWidth <= closed.viewport + 1, JSON.stringify(closed))
    } finally {
      await page.close()
    }
  }
})

test('an annotation outage leaves the body readable and says so', async () => {
  const page = await openReader({ width: 1280, options: { annotations: 'fail' } })
  try {
    const inspector = page.getByRole('complementary', { name: 'Reader inspector' })
    await inspector.getByRole('alert').waitFor()
    assert.match(await inspector.getByRole('alert').textContent(), /Annotation service unavailable/)
    assert.ok((await page.locator('.reader-surface p').count()) > 3)
    assert.equal(await inspector.getByText('0 annotations').count(), 0)
    await page.screenshot({ path: '/tmp/reader-stage1-annotations-failed.png' })
  } finally {
    await page.close()
  }
})

test('reading shortcuts work in the real Shell and pause during IME composition', async () => {
  const created = []
  const page = await openReader({ width: 1280, options: { created } })
  try {
    await page.locator('.reader-surface p').first().click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowDown')
    await page.evaluate(() => {
      for (const key of ['h', 'n']) window.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true }))
    })
    await settle(page)
    assert.equal(created.length, 0)
    await page.keyboard.press('h')
    await page.getByText('Highlighted', { exact: true }).waitFor()
    assert.equal(created.length, 1)
    assert.equal(created[0].annotation_type, 'highlight')
  } finally {
    await page.close()
  }
})

test('Research report keeps the shared Reader typography, a single main heading and no horizontal scroll', async () => {
  for (const width of [1440, 1024, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(() => { localStorage.setItem('rainver:locale', 'zh-CN'); localStorage.setItem('rainver:theme', 'light') })
      await mockApi(page)
      await page.goto(`${baseUrl}/spaces/${spaceId}/projects/${projectId}/research/reports/report-1`)
      await page.locator('.reader-surface p').first().waitFor()
      await settle(page)
      const result = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth,
        shell: (s => ({ client: s.clientWidth, scroll: s.scrollWidth }))(document.querySelector('.reader-document-shell')),
        // Shell's page title is outside the Reader; inside it the question is the only main heading.
        h1: [...document.querySelectorAll('.reader-workspace h1')].map(h => h.textContent.trim().slice(0, 12)),
        column: document.querySelector('.reader-column').getBoundingClientRect().width,
        overlay: Boolean(document.querySelector('.reader-inspector-overlay')),
        pGap: parseFloat(getComputedStyle(document.querySelector('.reader-surface > p + p')).marginTop),
      }))
      await page.screenshot({ path: `/tmp/reader-stage1-research-${width}.png` })
      assert.ok(result.documentWidth <= result.viewport + 1, JSON.stringify({ width, ...result }))
      assert.ok(result.shell.scroll <= result.shell.client + 1, JSON.stringify({ width, ...result }))
      assert.equal(result.h1.length, 1, JSON.stringify(result))
      assert.ok(result.h1[0].startsWith('长文研究问题'), JSON.stringify(result))
      assert.ok(result.pGap > 0, JSON.stringify(result))
      // The article is never squeezed below a readable column by a docked panel.
      assert.ok(result.column >= Math.min(560, result.shell.client) - 1, JSON.stringify({ width, ...result }))
      if (width > 768) {
        await page.getByRole('button', { name: '显示检查面板' }).click()
        const opened = await page.evaluate(() => ({ overlay: Boolean(document.querySelector('.reader-inspector-overlay')), column: document.querySelector('.reader-column').getBoundingClientRect().width }))
        assert.ok(opened.column >= result.column - 1, JSON.stringify({ width, opened, result }))
        await page.screenshot({ path: `/tmp/reader-stage1-research-${width}-panel.png` })
      }
    } finally {
      await page.close()
    }
  }
})

test('digest Markdown keeps its compact card size with visible rhythm and local scrolling', async () => {
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    try {
      await mockApi(page)
      await page.goto(`${baseUrl}/spaces/${spaceId}/library/digests/conn-1/2026-10-29`)
      await page.locator('.reader-markdown .reader-surface p').first().waitFor()
      await settle(page)
      const result = await page.evaluate(() => {
        const surface = document.querySelector('.reader-markdown .reader-surface')
        return {
          viewport: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth,
          fontSize: parseFloat(getComputedStyle(surface).fontSize),
          pGap: parseFloat(getComputedStyle(surface.querySelector(':scope > p + p')).marginTop),
          // The card body must not overflow its card (block hover offsets belong to the Reader column only).
          overflow: [...document.querySelectorAll('main, [role="main"], .reader-markdown')].map(el => el.scrollWidth - el.clientWidth),
        }
      })
      assert.equal(result.fontSize, 15, JSON.stringify(result))
      assert.ok(result.pGap > 0, JSON.stringify(result))
      assert.ok(result.documentWidth <= result.viewport + 1, JSON.stringify({ width, ...result }))
      assert.ok(result.overflow.every(value => value <= 1), JSON.stringify({ width, ...result }))
      await page.screenshot({ path: `/tmp/reader-stage1-digest-${width}.png`, fullPage: true })
    } finally {
      await page.close()
    }
  }
})

test('an unsent comment survives Shell navigation and browser history, and a modal pauses reading keys', async () => {
  const created = []
  const page = await openReader({ width: 1280, options: { created } })
  try {
    const inspector = page.getByRole('complementary', { name: 'Reader inspector' })
    await inspector.getByRole('button', { name: /阅读体验的第一步/ }).click()
    await inspector.getByPlaceholder('Add a comment…').fill('Draft kept across navigation')
    // Shell rail navigation, then browser Back.
    await page.locator('a[href$="/home"]').first().click()
    await page.waitForURL(/\/home/)
    await page.goBack()
    await page.locator('.reader-surface p').first().waitFor()
    await inspector.getByText('1 unsent comment is kept here').waitFor()
    await inspector.getByRole('button', { name: /阅读体验的第一步/ }).click()
    assert.equal(await inspector.getByPlaceholder('Add a comment…').inputValue(), 'Draft kept across navigation')
    // Browser Forward and Back again.
    await page.goForward(); await page.waitForURL(/\/home/); await page.goBack()
    await page.locator('.reader-surface p').first().waitFor()
    await inspector.getByText('1 unsent comment is kept here').waitFor()

    // The shortcut reference is a modal: while open, H does nothing; after closing, H works.
    await page.locator('.reader-surface p').first().click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('?')
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor()
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('h')
    await settle(page)
    assert.equal(created.length, 0)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('h')
    await page.getByText('Highlighted', { exact: true }).waitFor()
    assert.equal(created.length, 1)
  } finally {
    await page.close()
  }
})

test('declared Markdown renders its structure and stale anchors are relocated or listed as unlocated', async () => {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(() => { localStorage.setItem('rainver:locale', 'en'); localStorage.setItem('rainver:theme', 'light') })
      await mockApi(page)
      await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-md`)
      await page.locator('.reader-surface pre').waitFor()
      await settle(page)
      const result = await page.evaluate(() => {
        const surface = document.querySelector('.reader-surface')
        let depth = 0
        for (let list = surface.querySelector(':scope > ul'); list; list = list.querySelector(':scope > li > ul')) depth += 1
        const tableScroll = surface.querySelector('table').closest('.reader-table-scroll')
        return {
          // The copy button is a widget outside the document tree; the code is the rest.
          code: (() => { const pre = surface.querySelector('pre').cloneNode(true); pre.querySelector('[data-copy-code]')?.remove(); return pre.textContent })(),
          depth,
          headings: ['h4', 'h5', 'h6'].map(tag => Boolean(surface.querySelector(tag))),
          marks: ['strong', 'em', 'code', 'a[href]'].map(selector => Boolean(surface.querySelector(`p ${selector}`))),
          orderedStart: surface.querySelector('ol')?.getAttribute('start'),
          images: surface.querySelectorAll('img').length,
          highlights: [...surface.querySelectorAll('.reader-highlight')].map(el => [el.dataset.annotationId, el.textContent]),
          viewport: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth,
          tableOverflow: getComputedStyle(tableScroll).overflowX,
        }
      })
      assert.equal(result.code, markdownCode, JSON.stringify(result))
      assert.equal(result.depth, 3, JSON.stringify(result))
      assert.deepEqual(result.headings, [true, true, true])
      assert.deepEqual(result.marks, [true, true, true, true])
      assert.equal(result.orderedStart, '3')
      assert.equal(result.images, 0)
      // The stale range (1–9) is never painted; the unique quote is found again, the repeated one is not guessed.
      assert.deepEqual(result.highlights, [['ann-relocated', 'Unique closing words']])
      assert.ok(result.documentWidth <= result.viewport + 1, JSON.stringify(result))
      assert.equal(result.tableOverflow, 'auto')
      if (width > 768) {
        const inspector = page.getByRole('complementary', { name: 'Reader inspector' })
        await inspector.getByText('The text has changed: 1 annotation cannot be placed in it. Its quote and comments are kept below.').waitFor()
        await inspector.getByText('Not located', { exact: true }).waitFor()
      }
      await page.screenshot({ path: `/tmp/reader-stage2-markdown-${width}.png`, fullPage: false })
    } finally {
      await page.close()
    }
  }
})

// Positive end-to-end check of the reprocess flow with real request interception.
// It is not the regression detector for the redraw ordering: Chromium defers
// `loading="lazy"` images, so a momentary <img> may never be fetched here. The
// ordering itself is pinned by readerImagePolicy.test.tsx, which records every
// src written to an image element.
test('reading an Agent document again as a source page never fetches the Agent document’s images', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const imageRequests = []
  try {
    await page.addInitScript(() => { localStorage.setItem('rainver:locale', 'en'); localStorage.setItem('rainver:theme', 'light') })
    await mockApi(page)
    // Registered after mockApi so these take precedence for this item.
    let reprocessed = false
    const body = (src) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reprocessed body' }] }, { type: 'image', attrs: { src, alt: '', title: null } }] })
    await page.route('**/api/v1/reader/documents/source_item/item-rp', route => route.fulfill({ json: reprocessed
      ? { ...doc, document_id: 'item-rp', source_item_id: 'item-rp', content_json: body('https://news.example/new-source.jpg'), image_policy: 'remote_reference', content_hash: 'v2', structure_hash: 's2' }
      : { ...doc, document_id: 'item-rp', source_item_id: 'item-rp', content_json: body('https://tracker.example/old-agent.jpg'), image_policy: 'none', content_hash: 'v1', structure_hash: 's1' } }))
    await page.route('**/api/v1/reader/documents/source_item/item-rp/annotations', route => route.fulfill({ json: { items: [] } }))
    await page.route('**/api/v1/sources/items/item-rp/processing', route => route.fulfill({ json: reprocessed ? { status: 'succeeded', run_id: 'run-rp' } : { status: 'idle' } }))
    await page.route('**/api/v1/sources/items/item-rp/processing/start', route => { reprocessed = true; return route.fulfill({ json: { status: 'queued', run_id: 'run-rp' } }) })
    // Real network interception: any request to either image host is recorded and answered locally.
    await page.route(/https:\/\/(tracker|news)\.example\//, route => { imageRequests.push(route.request().url()); return route.fulfill({ status: 204, body: '' }) })

    await page.goto(`${baseUrl}/spaces/${spaceId}/library/items/item-rp`)
    await page.locator('a[data-external-image][href="https://tracker.example/old-agent.jpg"]').waitFor()
    await page.getByRole('button', { name: 'Read again' }).click()
    await page.getByRole('dialog', { name: 'Read this material again?' }).getByRole('button', { name: 'Read again' }).click()
    await page.locator('.reader-surface img[src="https://news.example/new-source.jpg"]').waitFor()
    await settle(page)
    assert.deepEqual(imageRequests, ['https://news.example/new-source.jpg'])
  } finally {
    await page.close()
  }
})

test('paragraph focus stays quiet, selection stays readable, and neither shifts the text', async () => {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const page = await openReader({ width, theme, locale: 'zh-CN' })
    try {
      await page.locator('.reader-surface p').nth(1).click()
      await page.keyboard.press('Escape')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      const focused = page.locator('.reader-block-focused')
      await focused.waitFor()
      await page.mouse.move(1, 1)
      const rect = await focused.boundingBox()
      const old = await page.addStyleTag({ content: `.reader-column .reader-surface > .reader-block-focused { background: color-mix(in oklch, var(--primary) 7%, transparent); box-shadow: inset 2.5px 0 0 var(--primary), 0 0 0 1px color-mix(in oklch, var(--primary) 22%, transparent); }` })
      await page.screenshot({ path: `/tmp/reader-focus-before-${width}-${theme}.png`, animations: 'disabled' })
      await old.evaluate(el => el.remove())
      const paint = await focused.evaluate(el => ({ shadow: getComputedStyle(el).boxShadow, background: getComputedStyle(el).backgroundColor }))
      assert.equal(paint.shadow, 'none', 'paragraph focus must not draw a left rail or card outline')
      assert.notEqual(paint.background, 'rgba(0, 0, 0, 0)', 'reading position must remain visible')
      assert.deepEqual(await focused.boundingBox(), rect, 'styling must not move the paragraph')
      await page.screenshot({ path: `/tmp/reader-focus-after-${width}-${theme}.png`, animations: 'disabled' })
      await page.locator('.reader-surface p').nth(1).evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el)
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
      await settle(page)
      assert.ok(await page.evaluate(() => getSelection().toString().length > 0))
      await page.locator('.reader-selection-toolbar').waitFor()
      await page.screenshot({ path: `/tmp/reader-focus-selection-${width}-${theme}.png`, animations: 'disabled' })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page-wide overflow')
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.reader-block-focused').count(), 0)
      const highlight = page.locator('.reader-highlight').first()
      await highlight.click()
      await page.locator('.reader-highlight-selected').waitFor()
      const mark = await highlight.evaluate(el => ({ display: getComputedStyle(el).display,
        shadow: getComputedStyle(el).boxShadow, border: getComputedStyle(el).borderBottomWidth }))
      assert.equal(mark.display, 'inline', 'saved highlighter follows text, not paragraph cards')
      assert.equal(mark.shadow, 'none', 'selected wrapped text must not acquire fragment outlines')
      assert.equal(mark.border, '1px', 'the annotation underline stays fine')
    } finally { await page.close() }
  }
})

test('paragraph selection can be dismissed by repeating the click, blank space, outside click and Escape', async () => {
  for (const [width, touch] of [[1280, false], [390, true]]) {
    const created = []
    const page = await openReader({ width, touch, options: { created } })
    try {
      const paragraph = page.locator('.reader-surface p').nth(1)
      const toolbar = page.locator('.reader-selection-toolbar')
      const press = async (locator, options) => touch ? locator.tap(options) : locator.click(options)
      const clickParagraph = async () => { await press(paragraph); await toolbar.waitFor({ timeout: 3000 }) }
      const cleared = async () => {
        await toolbar.waitFor({ state: 'hidden', timeout: 1500 })
        assert.equal(await page.locator('.reader-block-focused').count(), 0)
      }
      await clickParagraph()
      await press(paragraph)
      await cleared()
      await clickParagraph()
      await press(page.locator('.reader-document-shell'), { position: { x: 4, y: 20 } })
      await cleared()
      await clickParagraph()
      await press(page.locator('[data-shell-chrome] header').first(), { position: { x: 2, y: 2 } })
      await cleared()
      await clickParagraph()
      await paragraph.evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el)
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
      await toolbar.waitFor({ timeout: 3000 })
      await page.keyboard.press('Escape')
      await cleared()
      assert.equal(await page.evaluate(() => getSelection().toString()), '')
      await clickParagraph()
      await press(toolbar.locator('button').first())
      assert.equal(created.length, 1, 'toolbar actions must retain their selection until invoked')
    } finally { await page.close() }
  }
})

test('Reader docked panels resize with pointer and keyboard, remember widths, and leave phone drawers alone', async () => {
  const page = await openReader({ width: 1600, theme: 'light' })
  try {
    const inspector = page.locator('.reader-inspector')
    const resize = page.getByRole('separator', { name: 'Resize annotation panel' })
    await resize.waitFor()
    const original = (await inspector.boundingBox()).width
    await resize.focus()
    await page.keyboard.press('ArrowLeft')
    assert.equal((await inspector.boundingBox()).width, original + 16)
    const handle = await resize.boundingBox()
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 64, handle.y + handle.height / 2, { steps: 4 })
    await page.mouse.up()
    const changed = (await inspector.boundingBox()).width
    assert.ok(changed > original + 32)
    await page.reload()
    await page.locator('.reader-surface p').first().waitFor()
    assert.equal((await inspector.boundingBox()).width, changed)
    await page.getByRole('button', { name: 'Show contents', exact: true }).click()
    const outlineResize = page.getByRole('separator', { name: 'Resize contents panel' })
    await outlineResize.focus()
    await page.keyboard.press('Home')
    assert.equal(Math.round((await page.locator('.reader-outline').boundingBox()).width), 200)
    await page.keyboard.press('End')
    assert.ok((await page.locator('.reader-document-shell').boundingBox()).width >= 400)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await page.locator('.reader-surface p').first().waitFor()
    assert.equal(await page.getByRole('separator').count(), 0)
    await page.getByRole('button', { name: 'Show inspector', exact: true }).click()
    await inspector.waitFor()
    assert.ok((await inspector.boundingBox()).width <= 390)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: '/tmp/reader-plan-resize-phone.png' })
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.reload()
    await resize.waitFor()
    assert.equal((await inspector.boundingBox()).width, changed)
    await page.screenshot({ path: '/tmp/reader-plan-resize-desktop.png' })
  } finally { await page.close() }
})
