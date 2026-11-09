import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { run, turn } from '../modules/agent_work/fixtures.test-support.ts'

const space = 'space-recovery', now = '2026-11-05T21:00:00Z'
const project = { id: 'project-recovery', space_id: space, name: 'Recovery project', status: 'active', current_user_can_read: true, current_user_can_write: true, owner_user_id: 'user-recovery' }
const shots = process.env.WORKSPACE_SHOTS ?? '/tmp/rainver-workspace-shots'
const room = { id: 'room-recovery', space_id: space, project_id: project.id, project_folder_id: null, title: 'Recovery conversation', status: 'active', created_by_user_id: 'user-recovery', created_at: now, updated_at: now }
const session = { id: 'session-recovery', room_id: room.id, space_id: space, project_id: project.id, title: room.title, status: 'active', created_at: now, updated_at: now }
const change={change_set_id:'workspace-change',workspace_id:'workspace-id',generation:1,revision:2,workspace_location_id:'folder',parent_workspace_id:null,target_ref:'refs/heads/dev',state:'open',summary:'The conversation has a saved private change.',base_commit:'a'.repeat(40),source_commit:'b'.repeat(40),workspace_state:'ready',baseline_mode:'snapshot',cleanup_state:'pending',cleanup_errors:[],can_manage:true,integration_id:null,integration_revision:null,integration_status:null,attempt_id:null,onto_commit:null,candidate_commit:null,merged_commit:null,integration_detail:null,inventory:{free_bytes:42*1024**3}}
const failed = run({id:'run-recovery',space_id:space,agent_id:'agent-recovery',session_id:session.id,run_type:'conversation',status:'succeeded',owner_user_id:'user-recovery',instructed_by_user_id:'user-recovery',runtime_key:'claude_code',contract_snapshot_json:{execution_workspace_version:1},workspace_changes:[change]})
const agent = { id: failed.agent_id, space_id: space, name: 'Research assistant', status: 'active', agent_kind: 'custom', description: '', model: null }
const messages = [
  { id: 'question', session_id: session.id, space_id: space, role: 'user', sender_user_id: 'user-recovery', sender_agent_id: null, run_id: null, content: 'Please continue the investigation.', metadata_json: { run_ids: [failed.id] }, created_at: now },
  { id: 'reply', session_id: session.id, space_id: space, role: 'assistant', sender_user_id: null, sender_agent_id: agent.id, run_id: failed.id, content: 'The runtime could not complete this request.', metadata_json: {}, created_at: now },
]
const pageOf = items => ({ items, total: items.length, limit: 100, offset: 0 })
const definition = { runtime_key: 'claude_code', display_name: 'Claude Code', command: 'claude', capability_probe: 'claude', remote_eligible: true, reports_managed_cli_version: true, supports_runtime_native: true, supports_model_provider: false, provider_api: 'claude_compatible' }

async function fixtures(page, counts, recoveryRun = failed, blockedReason = null) {
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
    if(path==='/actions/workspace.change.complete') {counts.commands=(counts.commands??0)+1;counts.commandBody=route.request().postDataJSON();data={status:'completed',data:{change_set_id:change.change_set_id,state:'ready',revision:3,integration_id:null}}}
    else if (path === '/me') data = { id: 'user-recovery', name: 'Recovery tester', email: 'recovery@example.test', default_space_id: space, instance_role: 'admin', is_instance_admin: true }
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
    else if (path === `/sessions/${session.id}/workspace-changes`) data = { items: [] }
    else if (path === `/sessions/${session.id}/execution-context`) data = {
      summary: { session_id: session.id, state: 'initialized', host: null, runtime: null, runtimes: [], primary: null,
        attachments: [], dispatch_locked: false, queue_paused_at: null, can_send: !blockedReason, blocked_reason: blockedReason },
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


// The conversation shows one default-collapsed summary per turn; open it to act.
async function openSummary(page){const summary=page.getByTestId('turn-workspace-summary').first();await summary.waitFor();await summary.evaluate(element=>element.scrollIntoView({block:'start'}));assert.equal(await page.getByTestId('turn-workspace-summary').count(),1);if(!await summary.evaluate(element=>element.open))await summary.locator('summary').first().click();return summary}
let server, browser, baseUrl=process.env.LAYOUT_BASE_URL
before(async()=>{await mkdir(shots,{recursive:true});if(!baseUrl){server=await preview({configFile:false,preview:{host:'127.0.0.1',port:0}});baseUrl=`http://127.0.0.1:${server.httpServer.address().port}`}browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE})})
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve))})
async function capture(page,name){await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).forEach(a=>a.finish()));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const size=await page.evaluate(()=>({width:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));assert.ok(size.content<=size.width+1,JSON.stringify(size));await page.screenshot({path:`${shots}/${name}.png`,fullPage:true})}
for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280]){
 test(`workspace result entry, explicit completion and Run destination: ${locale}/${theme}/${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});await context.addInitScript(locale=>localStorage.setItem('rainver:locale',locale),locale)
  const page=await context.newPage(),counts={writes:0,logins:0},errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  try{
   await fixtures(page,counts);await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
   if(theme==='light')await page.evaluate(()=>document.documentElement.classList.add('theme-light'))
   const card=await openSummary(page);await card.evaluate(element=>element.scrollIntoView({block:'start'}));
   assert.equal(counts.commands??0,0);await capture(page,`entry-${locale}-${theme}-${width}`)
   await card.getByRole('button',{name:locale==='en'?'Finish changes':'完成修改',exact:true}).click();
   await page.getByRole('dialog').waitFor();await capture(page,`completion-${locale}-${theme}-${width}`)
   await page.getByRole('dialog').getByRole('button',{name:locale==='en'?'Confirm':'确认',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
   assert.equal(counts.commands,1);assert.equal(counts.commandBody.expected_revision,2)
   await card.getByRole('link',{name:locale==='en'?'Run details':'运行详情',exact:true}).click();
   await page.waitForURL(`**/runs/${failed.id}`);await page.getByRole('heading',{name:'Run Context',exact:true}).waitFor();await page.getByTestId(`workspace-changes-${failed.id}`).first().waitFor();
   await page.getByTestId(`workspace-changes-${failed.id}`).first().scrollIntoViewIfNeeded();await capture(page,`destination-${locale}-${theme}-${width}`)
   assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
}


for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280]){
 test(`blocked checkpoint entry and destination: ${locale}/${theme}/${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(locale=>localStorage.setItem('rainver:locale',locale),locale);
  const page=await context.newPage(),counts={writes:0,logins:0};page.setDefaultTimeout(10000);
  try{
   const blocked={...failed,workspace_changes:[{...change,state:'blocked',workspace_state:'blocked',integration_detail:{checkpoint_blocked:true}}]};
   await fixtures(page,counts,blocked,'execution_workspace_host_upgrade_required');
   await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`);
   if(theme==='light')await page.evaluate(()=>document.documentElement.classList.add('theme-light'));
   const card=await openSummary(page);await card.evaluate(element=>element.scrollIntoView({block:'start'}));
   assert.equal(await card.getByRole('button',{name:locale==='en'?'Finish changes':'完成修改',exact:true}).isDisabled(),true);
   assert.equal(await page.getByText('execution_workspace_host_upgrade_required',{exact:true}).count(),0);
   await page.getByTestId('execution-preflight').waitFor();
   await capture(page,`blocked-preflight-${locale}-${theme}-${width}`);
   await page.getByRole('button',{name:locale==='en'?'Collapse execution context':'收起执行上下文',exact:true}).click();
   await card.evaluate(element=>element.scrollIntoView({block:'start'}));
   await capture(page,`blocked-entry-${locale}-${theme}-${width}`);
   await card.getByRole('button',{name:locale==='en'?'Keep without merging':'保留成果，不合并',exact:true}).click();
   await page.getByRole('dialog').waitFor();
   await capture(page,`blocked-retention-${locale}-${theme}-${width}`);
   await page.keyboard.press('Escape');
   await card.getByRole('link',{name:locale==='en'?'Run details':'运行详情',exact:true}).click();
   await page.waitForURL(`**/runs/${failed.id}`);
   await page.getByRole('heading',{name:'Run Context',exact:true}).waitFor();
   await page.getByTestId(`workspace-changes-${failed.id}`).first().evaluate(element=>element.scrollIntoView({block:'start'}));
   await capture(page,`blocked-destination-${locale}-${theme}-${width}`);
   assert.equal(counts.commands??0,0);
  }finally{await context.close()}
 });
}


for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280]){
 test(`workspace retention entry and reclaim control: ${locale}/${theme}/${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(locale=>localStorage.setItem('rainver:locale',locale),locale);
  const page=await context.newPage(),counts={writes:0,logins:0,writePaths:[]},errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  try{
   const grace={state:'grace',reason:'merged',reclaim_after:'2026-11-05T21:10:00Z',hold_until:null,reclaimed_at:null,assessed_at:now,retained_refs:0,unclaimed_refs:1};
   const retained={state:'retained',reason:'unpublished_changes',reclaim_after:null,hold_until:null,reclaimed_at:null,assessed_at:now,retained_refs:2,unclaimed_refs:0};
   const withRetention={...failed,workspace_changes:[{...change,retention:retained},{...change,change_set_id:'merged-change',workspace_id:'merged-workspace',state:'integrated',summary:'Integrated earlier turn.',cleanup_state:'cleaned',retention:grace}]};
   await fixtures(page,counts,withRetention);
   await page.route('**/api/v1/actions/workspace.retention.update',route=>{counts.retention=route.request().postDataJSON();return route.fulfill({json:{status:'completed',data:{workspace_id:'merged-workspace',retention:{...grace,state:'reclaimable'}}}})});
   await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`);
   if(theme==='light')await page.evaluate(()=>document.documentElement.classList.add('theme-light'));
   const card=await openSummary(page);
   const kept=card.getByTestId(`workspace-retention-${change.workspace_id}`);await kept.waitFor();await card.evaluate(element=>element.scrollIntoView({block:'start'}));
   assert.match(await kept.innerText(),locale==='en'?/Branch kept[\s\S]*not integrated/:/分支已保留[\s\S]*尚未整合/);
   await capture(page,`retention-entry-${locale}-${theme}-${width}`);
   await card.getByRole('link',{name:locale==='en'?'Run details':'运行详情',exact:true}).click();
   await page.waitForURL(`**/runs/${failed.id}`);await page.getByRole('heading',{name:'Run Context',exact:true}).waitFor();
   const detail=page.getByTestId(`workspace-changes-${failed.id}`).first(),merged=detail.getByTestId('workspace-retention-merged-workspace');
   await merged.waitFor();await merged.evaluate(element=>element.scrollIntoView({block:'center'}));
   await capture(page,`retention-destination-${locale}-${theme}-${width}`);
   await merged.getByRole('button',{name:locale==='en'?'Reclaim now':'立即回收',exact:true}).click();
   await page.waitForFunction(()=>true);await new Promise(resolve=>setTimeout(resolve,300));
   assert.deepEqual(counts.retention,{change_set_id:'merged-change',action:'reclaim_now'});
   assert.deepEqual(errors,[]);
  }finally{await context.close()}
 });
}

for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280]){
 test(`expired Run-history file preview entry and destination: ${locale}/${theme}/${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(locale=>localStorage.setItem('rainver:locale',locale),locale);
  const page=await context.newPage(),counts={writes:0,logins:0,writePaths:[]},errors=[],asked=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  try{
   const reclaimed={state:'reclaimed',reason:'merged',reclaim_after:null,hold_until:null,reclaimed_at:'2026-10-01T09:00:00Z',assessed_at:now,retained_refs:0,unclaimed_refs:0};
   const released={...failed,workspace_changes:[{...change,state:'integrated',summary:'Integrated earlier turn.',cleanup_state:'cleaned',retention:reclaimed}]};
   await fixtures(page,counts,released);
   const text='The draft is in [notes.md](notes.md).';
   await page.route('**/api/v1/**',route=>{
    const url=new URL(route.request().url()),path=url.pathname.replace('/api/v1','');
    if(path===`/runs/${failed.id}/file-preview`){asked.push(url.searchParams.get('path'));return route.fulfill({json:{kind:'expired',name:'notes.md',expired_at:'2026-10-31T09:00:00Z'}})}
    if(path===`/runs/${failed.id}/turn`)return route.fulfill({json:turn({run_id:failed.id,state:'completed',source:'host_thread_events',parts:[{type:'text',index:0,text}]})});
    if(path===`/runs/${failed.id}/turn/stream`)return route.fulfill({headers:{'content-type':'text/event-stream'},body:`event: turn.snapshot\ndata: ${JSON.stringify({type:'turn.snapshot',turn:turn({run_id:failed.id,state:'completed',source:'host_thread_events',parts:[{type:'text',index:0,text}]})})}\n\n`});
    if(path.endsWith('/messages'))return route.fulfill({json:{...pageOf(messages.map(m=>m.role==='assistant'?{...m,content:text}:m)),queued:[]}});
    return route.fallback();
   });
   await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`);
   if(theme==='light')await page.evaluate(()=>document.documentElement.classList.add('theme-light'));
   const link=page.getByRole('link',{name:'notes.md',exact:true}).first();await link.waitFor();await link.evaluate(element=>element.scrollIntoView({block:'center'}));
   await capture(page,`history-expired-entry-${locale}-${theme}-${width}`);
   await link.click();
   const dialog=page.getByRole('dialog').filter({hasText:'notes.md'}),status=dialog.getByRole('status');await status.waitFor();
   assert.match(await status.innerText(),locale==='en'?/no longer kept[\s\S]*history period ended/:/不再保留[\s\S]*历史保留期已结束/);
   // An explicit expiry offers no retry: the version is gone, not temporarily unreachable.
   assert.equal(await dialog.getByRole('button',{name:locale==='en'?'Try again':'重试',exact:true}).count(),0,await dialog.innerHTML());
   await capture(page,`history-expired-destination-${locale}-${theme}-${width}`);
   assert.deepEqual(asked,['notes.md']);assert.deepEqual(counts.writePaths.filter(p=>p!=='/me/agent-attention/views'),[]);assert.deepEqual(errors,[]);
  }finally{await context.close()}
 });
}
