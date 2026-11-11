import {InstanceOperationsSettingsSchema,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {isInstanceAdminIn} from '../routeUtils/access.js';
import {InstanceOperationsSettingsService,readInstanceOperationsPolicy} from '../settings/index.js';
import {admitSystemCommand,SystemCommandRefusal,type SystemCommandKindHandler} from '../systemCommands/intents.js';
import {classifySettingsError,keyedSecretFingerprint,settingsPolicyContext,user} from '../systemCommands/operationSupport.js';
import {BackupInProgressError,BackupService} from '../backups/service.js';

/**
 * Instance-wide operating configuration owned by the instance admin:
 * `system.instance_settings.update` (transactional) and
 * `system.backup.create` (a system command: the archive is filesystem and
 * subprocess IO, performed by the worker after commit).
 */
const adminOnly=async(db:Queryable,config:ServerConfig,userId:string)=>{if(!await isInstanceAdminIn(db,config,userId))throw hidden();};

export function systemSettingsOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  const settings:OperationRegistration={
    definition:definitions.get('system.instance_settings.update')!,
    async resolve(){return {authority:'instance:operations_settings',targets:{},resourceType:'instance',resourceId:null};},
    authorize:(db,_raw,a)=>adminOnly(db,config,user(a)),
    authorizeResult:(db,_raw,a)=>adminOnly(db,config,user(a)),
    policyContext:settingsPolicyContext,
    fingerprintInput:input=>keyedSecretFingerprint(config,input,['managed_host_proxy_url']),
    async execute(db,raw,a){
      return InstanceOperationsSettingsSchema.parse(await new InstanceOperationsSettingsService(config,db).update(user(a),raw as never));
    },
    classifyError:error=>classifySettingsError(error,'system'),
  };
  const backup:OperationRegistration={
    definition:definitions.get('system.backup.create')!,successStatus:202,
    async resolve(){return {authority:'instance:backup',targets:{},resourceType:'instance',resourceId:null};},
    authorize:(db,_raw,a)=>adminOnly(db,config,user(a)),
    authorizeResult:(db,_raw,a)=>adminOnly(db,config,user(a)),
    policyContext:settingsPolicyContext,
    async execute(db,_raw,a){
      if(!config.backupEnabled)throw new SystemCommandRefusal(409,'Backup service not running — set BACKUP_ENABLED=true to enable',{code:'backup_disabled'});
      // One instance backup at a time, whoever asked.
      return admitSystemCommand(db,{spaceId:a.space_id,userId:user(a),kind:'backup_manual',scope:{instance:'backup'},frozen:{operation_id:'system.backup.create'}});
    },
    classifyError:error=>classifySettingsError(error,'system'),
  };
  return [settings,backup];
}

/** `backup_manual`: a second backup is a cost, not a harm, but an unconfirmed one is still never repeated. */
export const SYSTEM_SYSTEM_COMMAND_HANDLERS={
  backup_manual:{
    policy:'instance.settings.manage',resourceType:'instance',resourceId:()=>null,repeatable:false,
    async authorize(db,config,intent){await adminOnly(db,config,intent.user_id);},
    async run(config){
      if(!config.backupEnabled)return {ok:false,code:'backup_disabled',detail:'Backup service not running — set BACKUP_ENABLED=true to enable'};
      const service=new BackupService(config,await readInstanceOperationsPolicy(config));
      try{
        const archivePath=await service.createBackup('manual');
        await service.pruneOldBackups();
        return {ok:true,result:{status:'ok',backup:archivePath.split('/').pop()??archivePath}};
      }catch(error){
        if(error instanceof BackupInProgressError)return {ok:false,code:'backup_in_progress',detail:error.message};
        throw error;
      }
    },
  },
} satisfies Record<string,SystemCommandKindHandler>;
