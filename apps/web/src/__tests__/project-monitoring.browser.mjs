import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {after,before,test} from 'node:test'
import {chromium} from 'playwright-core'
import {preview} from 'vite'
let server,browser,baseUrl
const config={objective:'Agent 的可靠性与长期记忆',include:['reliability'],exclude:['advertising'],source_channel_id:'source-monitor',from:'2026-09-24T00:00:00Z',to:'2026-10-24T00:00:00Z',total_candidates:30,batch:{candidates:30,pages:3,source_requests:6,model_runs:6},daily:{candidates:20,pages:2,source_requests:4,model_runs:4},recommendation_count:5,language:'English',timezone:'UTC',evidence_depth:'abstract',agent_id:'agent-monitor'}
const version={id:'version-monitor',version:1,config,config_hash:'a'.repeat(64),proposal_id:null,backfill_plan_id:'plan-monitor',rule_id:'rule-monitor'}
const candidate={id:'item-monitor',title:'让 Agent 的长期记忆变得可验证',source_uri:'https://example.test/paper',occurred_at:'2026-10-23T12:00:00Z',summary:'这项研究把记忆更新与可追溯证据结合，减少长期运行中的信息漂移，并给出了可复现的评估方法。',relevance:'relevant',reason:'直接回应你关注的 Agent 可靠性，尤其适合比较长期任务中的记忆方案。',recommended:true,evidence_depth:'abstract',feedback:'relevant',read_status:'read'}
const state={active:version,draft:null,available_sources:[],can_write:true,paused:false,dependencies:[],latest_run:{id:'operation-monitor',status:'completed',progress:{phase:'completed',reason:null,as_of:'2026-10-24T12:00:00Z'}},candidates:[candidate,{...candidate,id:'other-monitor',title:'An excluded candidate remains inspectable',relevance:'not_relevant',recommended:false}]}
const pageOf=items=>({items,total:items.length,limit:100,offset:0})
before(async()=>{
 server=await preview({configFile:false,preview:{host:'127.0.0.1',port:0}})
 baseUrl=`http://127.0.0.1:${server.httpServer.address().port}`
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE})
})
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve))})
test('Project monitoring keeps linked-source settings, candidates and private feedback reachable', async () => {
 const page = await browser.newPage({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' })
 const writes = []
 const errors = []
 const space = 'space-monitor', project = 'project-monitor'
 const root = `/spaces/${space}/projects/${project}`
 page.on('pageerror', error => errors.push(error.message))
 try {
  await page.route('**/api/v1/**', async route => {
   const request = route.request()
   const path = new URL(request.url()).pathname.replace('/api/v1', '')
   const json = data => route.fulfill({ json: data })
   if (request.method() !== 'GET') {
    writes.push({ path, body: request.postDataJSON() })
    if (path === '/actions/project.monitoring.feedback') {
     assert.ok(request.headers()['idempotency-key'])
     return json({ status: 'succeeded', data: { space_id: space, user_id: 'user-monitor', feedback: 'not_relevant', item_id: candidate.id, project_id: project } })
    }
    return route.fulfill({ status: 404, json: { detail: 'Unexpected write in monitoring fixture' } })
   }
   if (path === '/me') return json({ id: 'user-monitor', name: 'Tester', default_space_id: space, instance_role: 'member' })
   if (path === '/me/spaces') return json([{ id: space, name: 'Monitor Space', type: 'personal', role: 'owner' }])
   if (path === '/plugins/effective') return json({ plugins: {} })
   if (path === `/projects/${project}/overview`) return json({ project: { id: project, name: 'Agent 信息观察', status: 'active' }, brief: null, attention: [] })
   if (path === `/projects/${project}`) return json({ id: project, space_id: space, name: 'Agent 信息观察', status: 'active' })
   if (path === '/projects') return json(pageOf([{ id: project, name: 'Agent 信息观察' }]))
   if (path.endsWith('/information-monitoring')) return json({ ...state, candidates: state.candidates.map((record, index) => index === 0 && writes.length ? { ...record, feedback: 'not_relevant' } : record) })
   if (path.endsWith('/inquiry/threads')) return json([])
   if (path === '/sources/goals') return json({ goals: [] })
   if (path === '/sources/gmail/connections') return json({ configured: false, connections: [] })
   if (['/sources/project-items', '/sources/evidence', '/sources/post-processing/decisions'].includes(path)) return json(pageOf([]))
   if (path === '/reader/annotations') return json({ items: [] })
   if (path === '/sources/channels' || ['/sources/bindings', '/sources/extraction-profiles', '/sources/health', '/members'].some(suffix => path.endsWith(suffix))) return json([])
   return route.fulfill({ status: 404, json: { detail: 'Not part of the monitoring fixture' } })
  })
  await page.goto(`${baseUrl}${root}/research`)
  await page.waitForURL(url => url.pathname.endsWith('/inquiry') && url.searchParams.get('section') === 'research')
  assert.deepEqual(writes, [], 'opening Research only redirects')
  await page.goto(`${baseUrl}${root}/sources?tab=candidates`)
  await page.getByRole('heading', { name: 'All monitoring candidates', exact: true }).waitFor()
  await page.getByRole('link', { name: candidate.title, exact: true }).waitFor()
  await page.getByRole('link', { name: 'An excluded candidate remains inspectable', exact: true }).waitFor()
  assert.equal(await page.getByLabel('Direction / objective', { exact: true }).count(), 0)

  await mkdir('/tmp/rainver-project-monitoring', { recursive: true })
  for (const width of [390, 800, 1280]) {
   await page.setViewportSize({ width, height: 900 })
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `candidate controls fit at ${width}px`)
   await page.screenshot({ path: `/tmp/rainver-project-monitoring/candidates-${width}.png`, fullPage: true })
  }
  const feedback = page.waitForResponse(response => response.url().endsWith('/actions/project.monitoring.feedback'))
  await page.getByRole('button', { name: 'Not relevant', exact: true }).first().click()
  assert.equal((await feedback).ok(), true)
  assert.deepEqual(writes, [{ path: '/actions/project.monitoring.feedback', body: { project_id: project, item_id: candidate.id, feedback: 'not_relevant' } }])

  await page.getByRole('button', { name: 'Following settings', exact: true }).click()
  await page.getByText('Manage linked sources', { exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: 'All monitoring candidates', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'All monitoring candidates', exact: true }).click({ timeout: 8000 })
  await page.getByRole('link', { name: candidate.title, exact: true }).waitFor()
  assert.equal(writes.length, 1, 'settings navigation does not activate collection')
  assert.deepEqual(errors, [])
 } catch (error) {
  console.error(page.url(), (await page.locator('body').innerText()).slice(0, 1800))
  throw error
 } finally { await page.close() }
})
