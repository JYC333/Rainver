import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {FastifyInstance,InjectOptions} from 'fastify';
import {expect} from 'vitest';
import type {ServerConfig} from '../../src/config.js';
import {JobHandlerRegistry} from '../../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../../src/modules/jobs/repository.js';
import {JobWorker} from '../../src/modules/jobs/worker.js';
import {SYSTEM_COMMAND_JOB} from '../../src/modules/systemCommands/intents.js';
import {registerSystemCommandHandler} from '../../src/modules/systemCommands/worker.js';

/** One keyed command at its retained URL (the operation core requires a key). */
export function keyed(app:FastifyInstance,options:InjectOptions,key:string=randomUUID()){
  return app.inject({...options,headers:{...(options.headers??{}),'idempotency-key':key}});
}
/** The succeeded outcome's data, asserting the envelope. */
export function succeeded<T=Record<string,unknown>>(response:{statusCode:number;body:string;json():unknown},status=200):T{
  expect(response.statusCode,response.body).toBe(status);
  const body=response.json() as {status:string;data:T};
  expect(body.status).toBe('succeeded');
  return body.data;
}
/** A refused or hidden outcome's error code. */
export function refused(response:{statusCode:number;body:string;json():unknown},status:number):string{
  expect(response.statusCode,response.body).toBe(status);
  return (response.json() as {error:{code:string}}).error.code;
}

/**
 * Real core admission over HTTP, the real system command Job worker, and the
 * issuer-only status read: the path a person's settings command takes.
 */
export function systemCommandHarness(pool:Pool,config:ServerConfig){
  const registry=new JobHandlerRegistry();registerSystemCommandHandler(registry,config);
  const worker=new JobWorker(new PgJobQueueRepository(pool),registry,`system-command-${randomUUID()}`,[SYSTEM_COMMAND_JOB]);
  return {
    process:()=>worker.processOne(),
    status:(app:FastifyInstance,commandId:string)=>app.inject({method:'GET',url:`/api/v1/system/commands/${commandId}`}),
    /** Admits (202 receipt), runs the Job once, and returns the released status. */
    async run(app:FastifyInstance,options:InjectOptions,key?:string){
      const accepted=await keyed(app,options,key);
      const receipt=succeeded<{id:string;kind:string;status:string;job_id:string}>(accepted,202);
      expect(receipt.status).toBe('pending');
      await worker.processOne();
      const read=await this.status(app,receipt.id);
      expect(read.statusCode,read.body).toBe(200);
      return {receipt,status:read.json() as {id:string;status:string;error:{code:string;detail:string|null}|null;result:Record<string,unknown>|null}};
    },
  };
}
