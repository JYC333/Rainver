import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { acpRuntimeInfo } from "@rainver/protocol";
import { launchAcpContract } from "./support/acpContract.js";

/** Only the vendor process boundary is fake; ACP package and config validation are real. */
async function nativeFixture(runtime: "codex_cli" | "claude_code", root: string, turns = false): Promise<string> {
  const executable = join(root, "native-fixture.cjs");
  const body = runtime === "claude_code" ? `
    if (msg.type === 'user' && ${turns}) {
      const usage = {input_tokens:10,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0};
      for (const event of [
        {...msg,session_id:'fixture-session'},
        {type:'assistant',uuid:'assistant-1',session_id:'fixture-session',message:{id:'message-1',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'text',text:'Offline response'}],stop_reason:'end_turn',stop_sequence:null,usage}},
        {type:'result',subtype:'success',uuid:'result-1',session_id:'fixture-session',result:'Offline response',is_error:false,duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage,modelUsage:{'claude-opus-5-5':{inputTokens:10,outputTokens:2,cacheReadInputTokens:0,cacheCreationInputTokens:0,costUSD:0,contextWindow:200000,maxOutputTokens:1000}},permission_denials:[]}
      ]) process.stdout.write(JSON.stringify(event)+'\\n');
      return;
    }
    if (msg.type !== 'control_request') throw new Error('Inference was attempted');
    const result = msg.request?.subtype === 'initialize'
      ? { commands: [], agents: [], account: {}, models: [
          { value: 'fixture-a', displayName: 'Fixture A', description: 'Offline fixture' },
          { value: 'fixture-b', displayName: 'Fixture B', description: 'Offline fixture' }] }
      : {};
    process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:msg.request_id,response:result}})+'\\n');
  ` : `
    if (msg.id === undefined) return;
    if (msg.method === 'thread/start' && msg.params?.ephemeral && ${turns}) {
      process.stdout.write(JSON.stringify({id:msg.id,result:{thread:{id:'fixture-title',cwd:process.cwd(),path:null},model:'fixture-a',modelProvider:'openai',reasoningEffort:'medium',serviceTier:null}})+'\\n');
      return;
    }
    if (msg.method === 'turn/start' && msg.params?.threadId === 'fixture-title' && ${turns}) {
      process.stdout.write(JSON.stringify({id:msg.id,result:{turn:{id:'title-turn',items:[],status:'inProgress',error:null}}})+'\\n');
      for (const event of [
        {method:'item/completed',params:{threadId:'fixture-title',turnId:'title-turn',item:{type:'agentMessage',id:'title-message',text:JSON.stringify({title:'Offline conversation'}),phase:'final_answer'}}},
        {method:'turn/completed',params:{threadId:'fixture-title',turn:{id:'title-turn',items:[],status:'completed',error:null}}}
      ]) process.stdout.write(JSON.stringify(event)+'\\n');
      return;
    }
    if (msg.method === 'turn/start' && ${turns}) {
      const turnId='turn-'+(++syntheticTurnsCount), previous=syntheticTurnsCount-1;
      process.stdout.write(JSON.stringify({id:msg.id,result:{turn:{id:turnId,items:[],status:'inProgress',error:null}}})+'\\n');
      const count={inputTokens:100+150*previous,cachedInputTokens:80+100*previous,cacheWriteInputTokens:0,outputTokens:10+15*previous,reasoningOutputTokens:5+8*previous,totalTokens:110+165*previous};
      const total={inputTokens:150+150*previous,cachedInputTokens:100+100*previous,cacheWriteInputTokens:0,outputTokens:15+15*previous,reasoningOutputTokens:8+8*previous,totalTokens:165+165*previous};
      const last={inputTokens:50,cachedInputTokens:20,cacheWriteInputTokens:0,outputTokens:5,reasoningOutputTokens:3,totalTokens:55};
      for (const event of [
        {method:'item/agentMessage/delta',params:{threadId:'fixture-session',turnId,itemId:'message-1',delta:'Offline response'}},
        {method:'thread/tokenUsage/updated',params:{threadId:'fixture-session',turnId,tokenUsage:{total:count,last:{inputTokens:100,cachedInputTokens:80,cacheWriteInputTokens:0,outputTokens:10,reasoningOutputTokens:5,totalTokens:110},modelContextWindow:200000}}},
        {method:'thread/tokenUsage/updated',params:{threadId:'fixture-session',turnId,tokenUsage:{total:count,last:{inputTokens:100,cachedInputTokens:80,cacheWriteInputTokens:0,outputTokens:10,reasoningOutputTokens:5,totalTokens:110},modelContextWindow:200000}}},
        {method:'thread/tokenUsage/updated',params:{threadId:'fixture-session',turnId,tokenUsage:{total,last,modelContextWindow:200000}}},
        {method:'turn/completed',params:{threadId:'fixture-session',turn:{id:turnId,items:[],status:'completed',error:null}}}
      ]) process.stdout.write(JSON.stringify(event)+'\\n');
      return;
    }
    if (msg.method === 'turn/start') throw new Error('Inference was attempted');
    const models = ['fixture-a', 'fixture-b'].map((model, index) => ({ id:model,model,displayName:model,isDefault:index===0,
      description:'Offline fixture',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Medium'}],defaultReasoningEffort:'medium',inputModalities:['text'],supportsPersonality:false }));
    const result = {
      initialize: {userAgent:'offline-fixture',codexHome:process.env.CODEX_HOME},
      'account/read': {account:{type:'apiKey'},requiresOpenaiAuth:false},
      'config/read': {config:{},origins:{},layers:[]},
      'model/list': {data:models,nextCursor:null},
      'skills/list': {data:[],errors:[]}, 'skills/config/write': {}, 'skills/extraRoots/set': {},
      'collaborationMode/list': {data:[]},
      'thread/start': {thread:{id:'fixture-session',cwd:process.cwd(),path:null},model:'fixture-a',modelProvider:'openai',reasoningEffort:'medium',serviceTier:null},
      'thread/resume': {thread:{id:'fixture-session',cwd:process.cwd(),path:null},model:'fixture-a',modelProvider:'openai',reasoningEffort:'medium',serviceTier:null},
      'thread/unsubscribe': {},
    }[msg.method];
    process.stdout.write(JSON.stringify({id:msg.id,...(result === undefined ? {error:{code:-32601,message:'Unknown fixture method '+msg.method}} : {result})})+'\\n');
  `;
  await writeFile(executable, `#!${process.execPath}
    if (process.argv.includes('auth') && process.argv.includes('status')) {
      process.stdout.write(JSON.stringify({loggedIn:false})+'\\n'); process.exit(0);
    }
    if (process.argv.includes('--version')) { process.stdout.write('99.0.0\\n'); process.exit(0); }
    const fs=require('node:fs');
    let syntheticTurnsCount=0;
    const rl=require('node:readline').createInterface({input:process.stdin});
    rl.on('line', line => { const msg=JSON.parse(line); fs.appendFileSync('native-requests', JSON.stringify(msg)+'\\n'); ${body} });
  `);
  await chmod(executable, 0o755);
  return executable;
}

describe.skipIf(process.platform === "win32")("current stable ACP package conformance", () => {
  it.each(["codex_cli", "claude_code"] as const)("reads prompt usage and model identity from the actual %s wrapper without inference", async runtime => {
    const root = await mkdtemp(join(tmpdir(), "rainver-acp-turn-contract-"));
    await mkdir(join(root, "codex")); await mkdir(join(root, "claude"));
    const executable = await nativeFixture(runtime, root, true);
    const acp = launchAcpContract(runtime, root, executable, { syntheticTurns: true });
    try {
      const identity = await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      expect(identity.protocolVersion).toBe(1);
      const session = await acp.request("session/new", { cwd: root, mcpServers: [] });
      const result = await acp.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "offline native fixture" }] });
      expect(result.stopReason).toBe("end_turn");
      expect(result.usage.totalTokens).toBe(runtime === "codex_cli" ? 165 : 12);
      expect(result._meta.quota.model_usage).toEqual(expect.arrayContaining([expect.objectContaining({ model: expect.any(String) })]));
      expect(result._meta.quota.model_usage.some((row: { model: string }) => row.model === "default")).toBe(false);
      expect(identity._meta.steering.supported).toBe(true);
      expect(acpRuntimeInfo(identity)?.capabilities.steering_idle_prompt_required).toBe(true);
      const idle = await acp.request("_session/steering", { sessionId: session.sessionId, prompt: [{ type: "text", text: "owned idle check" }], _meta: { steering: { idleBehavior: "promptRequired" } } });
      expect(idle.outcome).toBe("promptRequired");
      if (runtime === "codex_cli") {
        const next = await acp.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "second offline turn" }] });
        expect(next.usage.totalTokens).toBe(165);
      }
      acp.notify("session/cancel", { sessionId: session.sessionId });
      await acp.request("session/close", { sessionId: session.sessionId });
      if (runtime === "codex_cli") {
        const resumed = await acp.request("session/resume", { sessionId: session.sessionId, cwd: root, mcpServers: [] });
        expect(resumed.configOptions.find((option: any) => option.id === "model")).toBeDefined();
        await acp.request("session/close", { sessionId: session.sessionId });
      }
    } finally { await acp.close(); await rm(root, { recursive: true, force: true }); }
  }, 20_000);
  it.each(["codex_cli", "claude_code"] as const)("reads back model and mode changes from the actual %s adapter", async runtime => {
    const root = await mkdtemp(join(tmpdir(), "rainver-acp-contract-"));
    await mkdir(join(root, "codex")); await mkdir(join(root, "claude"));
    const native = await nativeFixture(runtime, root);
    const acp = launchAcpContract(runtime, root, native);
    try {
      const identity = await acp.request("initialize", { protocolVersion: 1, clientCapabilities: { session: { configOptions: { boolean: {} } } } });
      const manifest = JSON.parse(await readFile(join(dirname(dirname(acp.entry)), "package.json"), "utf8"));
      expect(identity.protocolVersion).toBe(1);
      expect(identity.agentInfo.version).toBe(manifest.version);
      expect(identity.agentInfo.name).toBe(manifest.name);
      const session = await acp.request("session/new", { cwd: root, mcpServers: [] });
      expect(session.sessionId).toEqual(expect.any(String));
      const model = session.configOptions.find((option: any) => option.id === "model");
      const alternative = model.options.find((option: any) => option.value !== model.currentValue);
      expect(alternative).toBeDefined();
      const changed = await acp.request("session/set_config_option", { sessionId: session.sessionId, configId: "model", type: "select", value: alternative.value });
      expect(changed.configOptions.find((option: any) => option.id === "model").currentValue).toBe(alternative.value);
      const mode = session.modes.availableModes.find((option: any) => option.id !== session.modes.currentModeId);
      expect(mode).toBeDefined();
      await acp.request("session/set_mode", { sessionId: session.sessionId, modeId: mode.id });
      const readBack = await acp.request("session/set_config_option", { sessionId: session.sessionId, configId: "model", type: "select", value: alternative.value });
      expect(readBack.configOptions.find((option: any) => option.id === "mode").currentValue).toBe(mode.id);
      const requests = await readFile(join(root, "native-requests"), "utf8");
      expect(requests).not.toContain('"method":"turn/start"');
      expect(requests).not.toContain('"type":"user"');
    } finally { await acp.close(); await rm(root, { recursive: true, force: true }); }
  }, 20_000);
});
