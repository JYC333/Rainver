import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
const {guardedFetch,undiciPinnedFetch}=await import(new URL('../../packages/outbound-guard/dist/index.js',import.meta.url));
const controlled=async url=>{const r=await guardedFetch({url:String(url),maxDownloadBytes:8192,deadlineMs:2000},{guard:{pin:async()=>[{address:'127.0.0.1',family:4}]},fetch:undiciPinnedFetch});return {url:r.url,status:r.status,headers:r.headers,text:async()=>Buffer.from(r.bytes).toString()};};
const [mode,root]=process.argv.slice(2);
const t=performance.now();
const dir=await mkdtemp(join(root,'run-'));
process.chdir(dir);
let api;
if(mode!=='baseline') api=await import(pathToFileURL(join(root,mode,'node_modules/@crawlee',mode==='basic'?'basic':'cheerio','index.mjs')));
const coldMs=performance.now()-t;
const idleRss=process.memoryUsage().rss;
let sends=0;
const server=createServer((req,res)=>{
  sends++;
  res.setHeader('Content-Type','text/html');
  res.end(`<html><body><a href="/detail">detail</a>${'x'.repeat(4096)}</body></html>`);
});
await new Promise((r,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',r)});
const base=`http://127.0.0.1:${server.address().port}`;
const urls=Array.from({length:100},(_,i)=>`${base}/document/${i}`);
let completed=0;
const started=performance.now();
if(mode==='baseline') {
  let i=0;
  await Promise.all(Array.from({length:4},async()=>{while(i<urls.length){const url=urls[i++];await (await controlled(url)).text();completed++;}}));
} else {
  const {Configuration,log}=api;
  log.setLevel(0);
  const config=new Configuration({persistStorage:false,purgeOnStart:true});
  // Cheerio's experimental client is probed here, never used as a security boundary.
  const httpClient={
    async sendRequest(request){const res=await controlled(request.url);return {request,url:res.url,statusCode:res.status,headers:Object.fromEntries(res.headers),trailers:{},redirectUrls:[],complete:true,body:await res.text()};},
    async stream(request){const result=await this.sendRequest(request);return {...result,stream:Readable.from([Buffer.from(result.body)]),downloadProgress:{percent:1,transferred:result.body.length},uploadProgress:{percent:1,transferred:0}};}
  };
  const crawler=mode==='basic'
    ?new api.BasicCrawler({minConcurrency:4,maxConcurrency:4,useSessionPool:false,requestHandler:async({request})=>{await (await controlled(request.url)).text();completed++;}},config)
    :new api.CheerioCrawler({minConcurrency:4,maxConcurrency:4,useSessionPool:false,httpClient,requestHandler:async({$})=>{if($('a').attr('href')!=='/detail')throw new Error('HTML extraction failed');completed++;}},config);
  await crawler.run(urls);
}
const elapsed=performance.now()-started;
await new Promise(r=>server.close(r));
await rm(dir,{recursive:true,force:true});
if(completed!==100||sends!==100)throw new Error(`Fixture mismatch ${completed}/${sends}`);
console.log(JSON.stringify({cold_ms:coldMs,idle_rss_bytes:idleRss,peak_rss_bytes:process.resourceUsage().maxRSS*1024,elapsed_ms:elapsed,requests_per_second:completed/(elapsed/1000),completed,sends}));
