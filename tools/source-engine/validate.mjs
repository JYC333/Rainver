/** Selected BasicCrawler fallback: HTTP client/HTML/retry + durable queue restart.
 * Run after benchmark: Node 24 validate.mjs /absolute/temp-root
 * The only network server is this test fixture. Product quotas are tested in server real-PG tests.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=process.argv[2];
if(!root || process.versions.node.split('.')[0]!=='24')throw new Error('Node 24 and benchmark root required');
const state=await mkdtemp(join(root,'checkpoint-'));
const hits={};
const server=createServer((req,res)=>{
  const url=req.url; hits[url]=(hits[url]??0)+1;
  if(url==='/retry' && hits[url]===1){res.writeHead(503);res.end();return;}
  if(url.startsWith('/api/')){
    const page=Number(url.slice(5)); res.setHeader('content-type','application/json');
    res.end(JSON.stringify({items:[page],next:page<3?`/api/${page+1}`:null}));return;
  }
  res.setHeader('content-type','text/html');res.end(url==='/html'?'<a href="/detail">Detail</a>':'<h1>Fixture</h1>');
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
const base=`http://127.0.0.1:${server.address().port}`;
async function run(stage){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'validate-worker.mjs'),root,state,base,stage],{stdio:['ignore','pipe','pipe']});
    const timeout=setTimeout(()=>child.kill('SIGKILL'),30_000);
    let out='',err=''; child.stdout.on('data',c=>out+=c); child.stderr.on('data',c=>err+=c);
    child.once('exit',code=>{clearTimeout(timeout);code===0?resolve(JSON.parse(out)):reject(new Error(err+out))});
  });
}
try {
  const first=await run('checkpoint');
  const second=await run('resume');
  const items=(await readFile(join(state,'items.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  if(items.length!==7 || new Set(items).size!==7 || hits['/retry']!==2 || Object.entries(hits).some(([url,count])=>url!=='/retry'&&count!==1))throw new Error(JSON.stringify({items,hits}));
  console.log(JSON.stringify({first,second,items,hits,passed:true},null,2));
} finally {await new Promise(resolve=>server.close(resolve));await rm(state,{recursive:true,force:true});}
