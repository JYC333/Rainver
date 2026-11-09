import {PROJECT_CORPUS_SCHEMAS,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {assertProjectWriterForMutation} from './access.js';
import {ProjectCorpusRepository} from './corpusRepository.js';
import {ProjectCorpusMutationError,ProjectCorpusReferenceUnavailable} from './corpusMutationError.js';
import {discoverCorpusScope,authorizeCorpusScope,type CorpusScopeInput} from './corpusOperationAdmission.js';
export function projectCorpusRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return Object.keys(PROJECT_CORPUS_SCHEMAS).map(id=>({
  definition:definitions.get(id)!,successStatus:id==='project.corpus.upsert'?201:200,
  async resolve(db,raw,a){const i=raw as CorpusScopeInput;return {authority:`project:${i.project_id}`,targets:{project_id:i.project_id,corpus_item_id:i.corpus_item_id??null,object_id:i.object_id??null,source_item_id:i.source_item_id??null,evidence_id:i.evidence_id??null},resourceType:'project',resourceId:i.project_id,closure:await discoverCorpusScope(db,i,a)};},
  async authorize(db,raw,a,scope){const i=raw as CorpusScopeInput,repo=new ProjectCorpusRepository(db),person={spaceId:a.space_id,userId:a.on_behalf_of_user_id!};await authorizeCorpusScope(db,i,a,(scope as typeof scope&{closure:Awaited<ReturnType<typeof discoverCorpusScope>>}).closure);
   if(i.corpus_item_id){if(!await repo.canReadItem(person,i.project_id,i.corpus_item_id))throw hidden();}
   else try{await repo.assertCommandTarget(person,i.project_id,raw as Record<string,unknown>);}catch(e){if(e instanceof ProjectCorpusReferenceUnavailable)throw hidden();if(e instanceof ProjectCorpusMutationError)throw new OperationError('operation_invalid_input',422,false,'projects');throw e;}
  },
  async authorizeResult(db,raw,a){const out=raw as {id:string;project_id:string;space_id:string};if(out.space_id!==a.space_id)throw hidden();await assertProjectWriterForMutation(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);if(!await new ProjectCorpusRepository(db).canReadItem({spaceId:a.space_id,userId:a.on_behalf_of_user_id!},out.project_id,out.id))throw hidden();},
  async execute(db,raw,a){const i=raw as CorpusScopeInput,repo=new ProjectCorpusRepository(db),person={spaceId:a.space_id,userId:a.on_behalf_of_user_id!},row=i.corpus_item_id?await repo.update(person,i.project_id,i.corpus_item_id,raw as Record<string,unknown>):await repo.upsert(person,i.project_id,raw as Record<string,unknown>);return {id:row.id,project_id:i.project_id,space_id:a.space_id};},
  classifyError(e){if(e instanceof ProjectCorpusMutationError)return new OperationBusinessError(e.statusCode===409?'operation_conflict':'operation_invalid_input',e.statusCode===409?409:422,'projects');return undefined;},
 }));
}
