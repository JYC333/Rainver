import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {FastifyInstance,InjectOptions} from 'fastify';
import {expect} from 'vitest';
import type {ServerConfig} from '../../src/config.js';
import {JobHandlerRegistry} from '../../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../../src/modules/jobs/repository.js';
import {JobWorker} from '../../src/modules/jobs/worker.js';
import {HOST_COMMAND_JOB} from '../../src/modules/hosts/hostCommands.js';
import {registerHostCommandHandler} from '../../src/modules/hosts/hostCommandWorker.js';

/**
 * Real core admission over HTTP, the real Host command Job worker, and the
 * owner-only status read: the path a person's command takes. The Host
 * registry is whatever the test arranged (a spy or a connected socket).
 */
export function hostCommandHarness(pool:Pool,config:ServerConfig){
  const registry=new JobHandlerRegistry();registerHostCommandHandler(registry,config);
  const worker=new JobWorker(new PgJobQueueRepository(pool),registry,`host-command-${randomUUID()}`,[HOST_COMMAND_JOB]);
  return {
    process:()=>worker.processOne(),
    /** Submits one keyed command at its retained URL. */
    submit:(app:FastifyInstance,options:InjectOptions,key:string=randomUUID())=>app.inject({...options,headers:{...(options.headers??{}),'idempotency-key':key}}),
    status:(app:FastifyInstance,hostId:string,commandId:string,headers:InjectOptions['headers']={})=>app.inject({method:'GET',url:`/api/v1/hosts/${hostId}/commands/${commandId}`,headers}),
    /** Admits, runs the Job once, and returns the released status. */
    async run(app:FastifyInstance,options:InjectOptions,hostId:string){
      const accepted=await this.submit(app,options);
      expect(accepted.statusCode,accepted.body).toBe(202);
      const receipt=accepted.json() as {status:string;data:{id:string;host_id:string;status:string}};
      expect(receipt).toMatchObject({status:'succeeded',data:{status:'pending',host_id:hostId}});
      await worker.processOne();
      const read=await this.status(app,hostId,receipt.data.id,options.headers);
      expect(read.statusCode,read.body).toBe(200);
      return {receipt:receipt.data,status:read.json() as {id:string;status:string;error:{code:string;detail:string|null}|null;result:Record<string,unknown>|null}};
    },
  };
}

/** The Space every command is admitted in: the people as its active members. */
export async function seedHostCommandSpace(pool:Pool,spaceId:string,members:ReadonlyArray<{user:string;role?:string}>):Promise<void>{
  await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Hosts','team',now(),now()) ON CONFLICT (id) DO NOTHING`,[spaceId]);
  for(const member of members)await pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`,
    [randomUUID(),spaceId,member.user,member.role??'member']);
}
