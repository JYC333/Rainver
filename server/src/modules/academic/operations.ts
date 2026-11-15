import {AcademicInputError} from './operationErrors.js';
import {ACADEMIC_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import type {OperationRegistration,ResolvedOperation} from '../systemActions/operations/types.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {hidden,OperationError,markedRefusal} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {contentDecisionFromDb,contentOwnerFromDb} from '../access/contentAccessQuery.js';
import {assertProjectWriterForMutation,assertProjectReadableLocked} from '../projects/access.js';
import type {Queryable} from '../routeUtils/common.js';
import {AcademicService} from './service.js';
import {AcademicRepository} from './repository.js';
type Input=Record<string,any>;
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
async function discover(db:Queryable,i:Input,a:OperationActor){
 const refs=[...new Set<string>([i.object_id,i.person_object_id,i.cited_paper_object_id].filter(Boolean))].sort();
 const projects=new Map<string,boolean>();if(i.project_id)projects.set(i.project_id,true);
 for(const ref of refs){const row=(await db.query<{primary_project_id:string|null}>('SELECT primary_project_id FROM space_objects WHERE space_id=$1 AND id=$2 AND deleted_at IS NULL',[a.space_id,ref])).rows[0];if(!row)throw hidden();if(row.primary_project_id)projects.set(row.primary_project_id,(projects.get(row.primary_project_id)??false)||ref===i.object_id);}
 return {refs,projects:[...projects].sort(([a],[b])=>a.localeCompare(b))};
}
type Bound=Awaited<ReturnType<typeof discover>>;
export function academicRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{return Object.keys(ACADEMIC_OPERATION_SCHEMAS).map(id=>({
 definition:defs.get(id)!,...(id==='academic.paper.create'?{userContentCreation:true as const}:{}),successStatus:id.endsWith('.propose')?202:id.endsWith('.create')?201:200,
 async resolve(db,raw,a){const bound=await discover(db,raw as Input,a);return {authority:`academic:${(raw as Input).object_id??a.space_id}`,targets:bound,resourceType:'space_object',resourceId:(raw as Input).object_id??null,bound} as ResolvedOperation&{bound:Bound};},
 async authorize(db,raw,a,scope){const i=raw as Input,b=(scope as ResolvedOperation&{bound:Bound}).bound;
  for(const [project,write] of b.projects)await(write?assertProjectWriterForMutation:assertProjectReadableLocked)(db,a.space_id,project,a.on_behalf_of_user_id!);
  for(const ref of b.refs)await db.query('SELECT id FROM space_objects WHERE space_id=$1 AND id=$2 FOR UPDATE',[a.space_id,ref]);
  if(canonical(await discover(db,i,a))!==canonical(b))throw new OperationError('operation_conflict',409);
  for(const ref of b.refs)if(await contentDecisionFromDb(db,person(a),'space_object',ref,{includeOversight:false})!=='full')throw hidden();
  if(i.object_id&&!await contentOwnerFromDb(db,person(a),'space_object',i.object_id))throw hidden();
 },
 async authorizeResult(db,raw,a){const out=raw as {space_id:string;id:string;object_id:string;kind:string};if(out.space_id!==a.space_id)throw hidden();if(out.kind==='proposal'&&await contentDecisionFromDb(db,person(a),'proposal',out.id,{includeOversight:false})!=='full')throw hidden();if(!await contentOwnerFromDb(db,person(a),'space_object',out.object_id))throw hidden();},
 classifyError(error){return error instanceof AcademicInputError?markedRefusal(error,'academic'):undefined;},
 async execute(db,raw,a){const i=raw as Input,s=new AcademicService(db,new AcademicRepository(db));
  const result=id==='academic.paper.create'?await s.createPaper(person(a),{...i,visibility:i.project_id?'space_shared':'private'}):id==='academic.paper.update'?await s.updatePaper(person(a),i.object_id,i):id==='academic.paper.author.propose'?await s.linkAuthor(person(a),i.object_id,i):await s.linkCitation(person(a),i.object_id,i);
  const object='object_id' in result?result.object_id:i.object_id;
  return {id:'id' in result?result.id:object,space_id:a.space_id,object_id:object,kind:id.endsWith('.propose')?'proposal':'paper'};
 },
}));}
export function registerAcademicOperationRoutes(app:FastifyInstance,context:ModuleContext){registerOperationAdapters(app,context.config,[
 {method:'POST',url:'/api/v1/academic/papers',operation:'academic.paper.create'},
 {method:'PATCH',url:'/api/v1/academic/papers/:objectId',operation:'academic.paper.update',params:{objectId:'object_id'}},
 {method:'POST',url:'/api/v1/academic/papers/:objectId/authors',operation:'academic.paper.author.propose',params:{objectId:'object_id'}},
 {method:'POST',url:'/api/v1/academic/papers/:objectId/citations',operation:'academic.paper.citation.propose',params:{objectId:'object_id'}},
]);}
