// Real compiled server services, HTTP sockets and queue handlers; no simulated database.
const report=value=>process.send?.(value);
process.on('message',async options=>{
  if(options.cmd!=='start')return;
  try {
    const base=options.dist ?? new URL('../../dist/',import.meta.url).href;
    const load=path=>import(new URL(path,base));
    if(options.bridge) {
      const {startLocalToolBridge}=await import(new URL('../../../packages/agent-cli/dist/localBridge.js',import.meta.url));
      const {toolHttpRequest}=await import(new URL('../../../packages/agent-cli/dist/toolHttp.js',import.meta.url));
      const bridge=await startLocalToolBridge(options.home,async(request,signal)=>{
        const result=await toolHttpRequest(options.toolIdentity,request,signal);
        if(options.holdBridge) {report({type:'bridgeResponseHeld',requestId:request.id,key:request.idempotency_key});await new Promise(()=>{});}
        return result;
      });report({type:'ready',address:bridge.directory});return;
    }
    const {loadConfig}=await load('config.js');
    const config=loadConfig({SERVER_DATABASE_URL:options.url,RAINVER_HOME:options.home});
    if(options.workerLoop) {
      const {startJobsWorker}=await load('modules/jobs/workerRuntime.js');
      const worker=startJobsWorker(config);
      if(!worker)throw new Error('No actual jobs worker');
      worker.registry.wrap('research_operation_cancel',handler=>async job=>{
        const result=await handler(job);
        if(options.holdWorker){report({type:'effect',result,job:job.job_id});await new Promise(()=>{});}
        const timer=setInterval(async()=>{
          const current=await worker.queue.getJob(job.job_id);
          if(current?.status==='completed'){clearInterval(timer);report({type:'workerDone',result,job:job.job_id});}
        },10);
        return result;
      });return;
    }
    const {createServerApp,registerGatewayConventions}=await load('gateway/appShell.js');
    const {__setAuthIdentityForTests}=await load('modules/auth/identity.js');
    __setAuthIdentityForTests(options.identity);
    const app=createServerApp(config,{logger:false});registerGatewayConventions(app,config);
    if(options.legacy) {
      const {registerRoutes}=await load('modules/projectResearch/routes.js');
      const {createConfigSnapshot}=await load('config.js');
      registerRoutes(app,{config,snapshot:createConfigSnapshot(config)});
    } else {
      const {registerRoutes}=await load('modules/systemActions/routes.js');registerRoutes(app,config);
    }
    if(options.tools) {
      const {registerRoutes}=await load('modules/runs/routes.js');
      const {createConfigSnapshot}=await load('config.js');registerRoutes(app,{config,snapshot:createConfigSnapshot(config)});
    }
    if(options.holdResponse)app.addHook('onSend',async(_request,_reply,payload)=>{
      report({type:'responseHeld'});await new Promise(()=>{});return payload;
    });
    const address=await app.listen({host:'127.0.0.1',port:0});report({type:'ready',address});
  }catch(error){report({type:'fatal',message:String(error?.stack??error)});process.exit(1);}
});
