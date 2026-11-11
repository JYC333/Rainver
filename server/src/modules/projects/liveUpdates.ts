import type {Pool,PoolClient} from '../../db/pool.js';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {sseResponseHeaders} from '../../gateway/sse.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {introspectIdentity} from '../auth/identity.js';
import {dbPool,params,requiredString,resolveIdentity,sendRouteError} from '../routeUtils/common.js';
import {assertProjectReadable} from './access.js';

const CHANNEL='rainver_project_live';
type Subscriber={space:string;project:string;change:()=>void;disconnected:()=>void};
/** One LISTEN connection per server pool, shared by all authorized viewers.
 * No durable content or versions in the bus; reconnect always revalidates. */
const hubs=new WeakMap<Pool,{subscribers:Set<Subscriber>;client:Promise<PoolClient>}>();
export async function subscribeProjectUpdates(pool:Pool,subscriber:Subscriber){
 let hub=hubs.get(pool);
 if(!hub){
  const subscribers=new Set<Subscriber>();
  const client=pool.connect().then(async client=>{
   client.on('notification',message=>{
    if(message.channel!==CHANNEL||!message.payload)return;
    try{const p=JSON.parse(message.payload) as {space_id?:unknown;project_id?:unknown};
     for(const s of subscribers)if(s.space===p.space_id&&s.project===p.project_id)s.change();
    }catch{/* Not a content transport; ignore malformed notifications. */}
   });
   const failed=()=>{for(const s of subscribers)s.disconnected()};
   client.on('error',failed);client.on('end',failed);
   try{await client.query(`LISTEN ${CHANNEL}`);return client}catch(error){client.release(true);throw error}
  });
  hub={subscribers,client};hubs.set(pool,hub);
 }
 const current=hub;current.subscribers.add(subscriber);
 try{await current.client}catch(error){current.subscribers.delete(subscriber);if(hubs.get(pool)===current)hubs.delete(pool);throw error}
 let closed=false;
 return async()=>{
  if(closed)return;closed=true;current.subscribers.delete(subscriber);
  if(!current.subscribers.size&&hubs.get(pool)===current){
   hubs.delete(pool);const client=await current.client;
   try{await client.query(`UNLISTEN ${CHANNEL}`);client.removeAllListeners('notification');client.release(true)}catch{client.release(true)}
  }
 };
}

export function registerProjectLiveUpdates(app:FastifyInstance,context:ModuleContext){
 const streams=new Set<()=>void|Promise<void>>();let shuttingDown=false;
 app.addHook('preClose',async()=>{shuttingDown=true;await Promise.all([...streams].map(close=>close()))});
 app.get('/api/v1/projects/:projectId/updates/stream',async(request,reply)=>{
  const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
  const pool=dbPool(context.config);let stop:(()=>Promise<void>)|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
  let closed=false,checking=false,dirty=false;
  const finish=()=>{if(closed)return;closed=true;streams.delete(finish);if(timer)clearTimeout(timer);if(heartbeat)clearInterval(heartbeat);reply.raw.end();return stop?.().catch(()=>{})};
  try{
   const project=requiredString(params(request).projectId,'project_id');
   const allowed=async()=>{
    const current=await introspectIdentity(context.config,request);
    if(!current.ok||current.userId!==identity.userId||current.spaceId!==identity.spaceId)return false;
    try{await assertProjectReadable(pool,identity.spaceId,project,identity.userId);return true}catch(error){if([401,403,404].includes((error as {statusCode?:number}).statusCode??0))return false;throw error}
   };
   await assertProjectReadable(pool,identity.spaceId,project,identity.userId);
   const send=(type:'ready'|'changed'|'denied')=>{
    if(closed)return;
    // Content-free frames are coalesced; a slow/disconnected viewer reconnects
    // and re-reads rather than accumulating an unbounded output queue.
    if(reply.raw.writableLength>65536){finish();return}
    reply.raw.write(`event: project.${type}\ndata: {"type":"${type}"}\n\n`);
   };
   const flush=async()=>{
    if(closed||checking)return;checking=true;dirty=false;
    try{if(!await allowed()){send('denied');finish();return}send('changed')}
    catch{finish()}
    finally{checking=false;if(dirty&&!closed)schedule()}
   };
   const schedule=()=>{dirty=true;if(!timer&&!checking)timer=setTimeout(()=>{timer=undefined;void flush()},500)};
   stop=await subscribeProjectUpdates(pool,{space:identity.spaceId,project,change:schedule,disconnected:finish});
   if(reply.raw.destroyed||shuttingDown){await stop();if(!reply.raw.destroyed)return reply.code(503).send({error:'Project stream stopping'});return}
   streams.add(finish);reply.hijack();reply.raw.writeHead(200,sseResponseHeaders(resolveRequestId(request)));
   reply.raw.on('close',finish);
   send('ready'); // Subscribe before the initial invalidation: no read/listen gap.
   heartbeat=setInterval(()=>{if(checking||closed)return;checking=true;void allowed().then(ok=>{if(!ok){send('denied');finish()}else reply.raw.write(': heartbeat\n\n')}).catch(finish).finally(()=>{checking=false;if(dirty&&!closed)schedule()})},30000);
  }catch(error){await stop?.();if(reply.raw.headersSent)finish();else return sendRouteError(reply,error)}
 });
}
