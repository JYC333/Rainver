import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createServer,createConnection,type Socket} from 'node:net';
export interface FaultReport {type:string;address?:string;result?:Record<string,unknown>;job?:string;message?:string}
export function operationFaultProcess(options:Record<string,unknown>) {
  const child:ChildProcess=fork(fileURLToPath(new URL('./operationFaultProcess.mjs',import.meta.url)),[],{env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','ignore','pipe','ipc']});
  const reports:FaultReport[]=[],errors:string[]=[];
  child.stderr!.on('data',data=>errors.push(String(data)));
  child.on('message',data=>reports.push(data as FaultReport));
  const exit=once(child,'exit');
  child.send({cmd:'start',...options});
  return {child,reports,errors,async next(type:string) {
    const deadline=Date.now()+20000;
    while(Date.now()<deadline) {
      const fatal=reports.find(r=>r.type==='fatal');if(fatal)throw new Error(fatal.message);
      const report=reports.find(r=>r.type===type);if(report)return report;
      if(child.exitCode!==null || child.signalCode!==null)throw new Error(`child exited: ${errors.join('')}`);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error(`child report timed out: ${type}; ${errors.join('')}`);
  },async kill(){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;}};
}
/** Real PostgreSQL wire relay: observe a COMMIT completing at the backend, then
 * withhold its acknowledgement from the real driver. All other bytes pass through.
 */
export async function holdCommitAcknowledgement(databaseUrl:string) {
  const destination=new URL(databaseUrl),sockets=new Set<Socket>();
  let committedResolve!:()=>void;
  const committed=new Promise<void>(resolve=>{committedResolve=resolve;});
  const server=createServer(front=>{
    const back=createConnection({host:destination.hostname,port:Number(destination.port)});
    for(const socket of [front,back]){sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));}
    front.on('close',()=>back.destroy());back.on('close',()=>front.destroy());
    front.on('data',data=>back.write(data));
    let buffer=Buffer.alloc(0),blocked=false;
    back.on('data',data=>{
      buffer=Buffer.concat([buffer,data]);
      while(buffer.length>=5) {
        const size=buffer.readInt32BE(1)+1;if(buffer.length<size)return;
        const frame=buffer.subarray(0,size);buffer=buffer.subarray(size);
        if(frame[0]===67 && frame.subarray(5).toString()==='COMMIT\0'){blocked=true;committedResolve();}
        if(!blocked)front.write(frame);
      }
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();if(!address||typeof address==='string')throw new Error('No relay port');
  const url=new URL(databaseUrl);url.hostname='127.0.0.1';url.port=String(address.port);
  return {url:url.toString(),committed,disconnect(){for(const socket of sockets)socket.destroy();},async close(){for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
