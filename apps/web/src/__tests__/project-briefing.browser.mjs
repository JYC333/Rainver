import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {after,before,test} from 'node:test'
import {chromium} from 'playwright-core'
import {preview} from 'vite'
let server,browser,baseUrl
before(async()=>{
 server=await preview({configFile:false,preview:{host:'127.0.0.1',port:0}})
 baseUrl=`http://127.0.0.1:${server.httpServer.address().port}`
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE})
})
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve))})

// Synthetic fixture only: no real Source, member or model text.
const ITEM='11111111-1111-4111-8111-111111111111'
const coverage={since:null,cutoff:'2026-10-30T08:00:00.000Z',candidates:4,included:2,merged_duplicates:1,not_ready:1,truncated:0,egress_refused:0,not_shared_with_audience:0,carried_from_previous:0,unchanged_since_previous:0,background:0,context_changed:false,complete:false}
const base={id:'brief-1',version:1,kind:'manual',status:'queued',outcome:null,comparison:'baseline',period_date:null,cutoff_at:'2026-10-30T08:00:00.000Z',created_at:'2026-10-30T08:00:00.000Z',completed_at:null,checked_at:null,error_code:null,scope_type:'project',previous_briefing_id:null,run_status:'running',coverage,visibility:'visible',hidden_units:0,overview:null,highlights:[],open_questions:[],evidence:[],context:[{key:'C1',kind:'project_goal',label:'Project goal'}],context_outdated:false}
const ready={...base,status:'ready',outcome:'briefing',run_status:'succeeded',completed_at:'2026-10-30T08:02:00.000Z',
 overview:{text:'Synthetic fixture: two reports describe one gripper launch; a recall notice is unconfirmed.',refs:['S1','S2']},
 highlights:[{title:'Fixture gripper launch',what_changed:'A fixture vendor announced a soft gripper with a very-long-unbroken-identifier-fixture-gripper-model-x1000-to-check-wrapping.',novelty:'baseline',importance:'high',why_it_matters:'Fragile-item picking is the open risk in the fixture goal.',impact:{assessment:'affects',text:'Bears on the fixture picking goal.',context_refs:['C1']},suggested_action:'watch',statements:[{kind:'fact',text:'The fixture gripper was announced.',refs:['S1']},{kind:'inference',text:'It could replace the fixture prototype.',refs:['S1','C1']},{kind:'open_question',text:'Is the fixture price public?',refs:['S2']}],contradictions:'The fixture recall notice conflicts with the launch report.',refs:['S1','S2'],source_domains:2,rests_on_unverified:true,index:0}],
 open_questions:[{text:'Does the fixture recall affect the same model?',refs:['S2']}],
 evidence:[{key:'S1',source_item_id:ITEM,title:'Fixture launch report',source_domain:'news.fixture.test',occurred_at:'2026-10-29T10:00:00.000Z',delta_class:'baseline',unverified:false,lenses:[{kind:'corpus',label:'Project Corpus'}]},{key:'S2',source_item_id:'22222222-2222-4222-8222-222222222222',title:'Fixture recall notice',source_domain:'agent.fixture.test',occurred_at:null,delta_class:'unknown_time',unverified:true,lenses:[{kind:'following',label:'Fixture topic'}]}]}

const space = 'space-fixture'
const project = 'project-fixture'
const area = `/spaces/${space}/projects/${project}/sources`
const compositions = `/spaces/${space}/projects/${project}/reading-compositions`
const date = '2026-10-30'

/** The retired project briefings stay readable through the authorized Project Reading archive. */
test('Project Reading opens an exact archived analysis and its sources on phone and desktop', async () => {
 const page = await browser.newPage({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' })
 const writes = []
 const archived = []
 const errors = []
 page.on('pageerror', error => errors.push(error.message))
 try {
  await page.route('**/api/v1/**', async route => {
   const request = route.request()
   const path = new URL(request.url()).pathname.replace('/api/v1', '')
   const json = data => route.fulfill({ json: data })
   if (request.method() !== 'GET') {
    writes.push(path)
    return route.fulfill({ status: 404, json: { detail: 'Unexpected write in archive fixture' } })
   }
   if (path === '/me') return json({ id: 'user-fixture', name: 'Tester', default_space_id: space, instance_role: 'member' })
   if (path === '/me/spaces') return json([{ id: space, name: 'Fixture Space', type: 'personal', role: 'owner' }])
   if (path === '/plugins/effective') return json({ plugins: {} })
   if (path === `/projects/${project}`) return json({ id: project, name: 'Fixture robotics', space_id: space, status: 'active', current_user_can_write: true })
   if (path === `/projects/${project}/overview`) return json({ project: { id: project, name: 'Fixture robotics', status: 'active' }, brief: null, attention: [] })
   if (path === '/sources/goals') return json({ goals: [] })
   if (path === compositions) return json({ date, today: date, timezone: 'UTC', latest: null, history: [], rounds: [], cross_theme_status: 'not_generated' })
   if (path === `${compositions}/history`) return json({ items: [{ id: ready.id, kind: 'theme_analysis', date, created_at: ready.created_at, revision: 1 }], next_cursor: null })
   if (path === `${compositions}/analyses/${ready.id}`) { archived.push(path); return json(ready) }
   return route.fulfill({ status: 404, json: { detail: 'Not part of the archive fixture' } })
  })
  await page.goto(`${baseUrl}${area}?tab=digest`)
  await page.waitForURL(url => url.searchParams.get('tab') === 'overview')
  assert.deepEqual(archived, [], 'the old entry redirects without reading an arbitrary briefing')
  await page.getByRole('button', { name: 'History & archive' }).click()
  const dialog = page.getByRole('dialog', { name: 'History & archive' })
  await dialog.getByRole('link', { name: /Topic analysis/ }).click()
  await page.waitForURL(url => url.searchParams.get('archive') === 'theme' && url.searchParams.get('briefing') === ready.id)
  await page.getByText(ready.overview.text).waitFor()
  await page.getByText('Rests on agent-provided material that nobody verified.', { exact: true }).waitFor()
  const source = page.getByRole('link', { name: 'Fixture launch report', exact: true })
  const href = new URL(await source.getAttribute('href'), baseUrl)
  assert.equal(href.pathname, `/spaces/${space}/library/items/${ITEM}`)
  assert.equal(href.searchParams.get('returnTo'), `/projects/${project}/sources?tab=overview&archive=theme&briefing=${ready.id}`)
  assert.deepEqual(archived, [`${compositions}/analyses/${ready.id}`])
  assert.equal(await page.getByRole('button', { name: 'Generate briefing', exact: true }).count(), 0)
  await mkdir('/tmp/rainver-briefing-archive', { recursive: true })
  for (const width of [390, 1280]) {
   await page.setViewportSize({ width, height: 1000 })
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `the analysis fits at ${width}px`)
   await page.screenshot({ path: `/tmp/rainver-briefing-archive/${width}.png`, fullPage: true })
  }
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
 } finally { await page.close() }
})
