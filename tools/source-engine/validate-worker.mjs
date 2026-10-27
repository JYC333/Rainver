import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const [root,state,base,stage]=process.argv.slice(2);
process.chdir(state);
process.env.CRAWLEE_STORAGE_DIR=join(state,'storage');
process.env.CRAWLEE_PURGE_ON_START='false';
const require=createRequire(join(root,'basic','package.json'));
const {load}=require('cheerio');
const {BasicCrawler,Configuration,RequestQueue,log}=await import(pathToFileURL(join(root,'basic/node_modules/@crawlee/basic/index.mjs')));
const {guardedFetch,undiciPinnedFetch}=await import(new URL('../../packages/outbound-guard/dist/index.js',import.meta.url));
log.setLevel(0);
const config=new Configuration({storageClientOptions:{localDataDirectory:join(state,'storage')},persistStorage:true,purgeOnStart:false});
const queue=await RequestQueue.open('fixture',{config});
queue.requestLockSecs=1;
if(stage==='checkpoint') await queue.addRequests(['/api/0','/html','/retry'].map(path=>({url:base+path})));
let count=0,admissions=0;
const crawler=new BasicCrawler({requestQueue:queue,minConcurrency:1,maxConcurrency:1,useSessionPool:false,maxRequestRetries:1,
  ...(stage==='checkpoint'?{maxRequestsPerCrawl:2}:{}),
  requestHandler:async({request})=>{
    const response=await guardedFetch({url:request.url,maxDownloadBytes:8192,deadlineMs:2000,beforeSend:async()=>{admissions++;}},
      {guard:{pin:async()=>[{address:'127.0.0.1',family:4}]},fetch:undiciPinnedFetch});
    if(response.status!==200)throw new Error('fixture retry');
    const body=Buffer.from(response.bytes).toString(); const url=new URL(request.url);
    if(url.pathname.startsWith('/api/')){const page=JSON.parse(body);if(page.next)await queue.addRequest({url:base+page.next});}
    else {for(const link of load(body)('a[href]').toArray())await queue.addRequest({url:new URL(load(body)(link).attr('href'),base).href});}
    await appendFile(join(state,'items.jsonl'),JSON.stringify(url.pathname)+'\n');count++;
  }},config);
// Short fixture lease makes restart recovery observable without waiting the production 5-minute lease.
queue.requestLockSecs=1;
await crawler.run();
console.log(JSON.stringify({stage,completed:count,admissions}));
