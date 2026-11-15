import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {registerActionSplitAdapter} from '../sources/sourceObjectOperationRoutes.js';
import {dbPool,params,resolveIdentity,sendRouteError} from '../routeUtils/common.js';
import {readReaderWriteRequest} from './writeJob.js';

/** The twelve retained Reader write URLs as formal core adapters (thirteen operations). */
export function registerReaderOperationRoutes(app:FastifyInstance,context:ModuleContext){
 const doc={documentType:'document_type',documentId:'document_id'};
 registerOperationAdapters(app,context.config,[
  {method:'POST',url:'/api/v1/reader/annotations',operation:'reader.annotation.create'},
  {method:'PATCH',url:'/api/v1/reader/annotations/:annotationId',operation:'reader.annotation.update',params:{annotationId:'annotation_id'}},
  {method:'DELETE',url:'/api/v1/reader/annotations/:annotationId',operation:'reader.annotation.archive',params:{annotationId:'annotation_id'}},
  {method:'PATCH',url:'/api/v1/reader/annotations/:annotationId/range',operation:'reader.annotation.range.replace',params:{annotationId:'annotation_id'}},
  {method:'POST',url:'/api/v1/reader/annotations/:annotationId/comments',operation:'reader.comment.create',params:{annotationId:'annotation_id'}},
  {method:'PATCH',url:'/api/v1/reader/comments/:commentId',operation:'reader.comment.update',params:{commentId:'comment_id'}},
  {method:'PATCH',url:'/api/v1/reader/comment-threads/:threadId',operation:'reader.thread.update',params:{threadId:'thread_id'}},
  {method:'POST',url:'/api/v1/reader/annotations/:annotationId/evidence',operation:'reader.evidence.create',params:{annotationId:'annotation_id'}},
  {method:'PUT',url:'/api/v1/reader/documents/:documentType/:documentId/position',operation:'reader.position.write',params:doc},
  {method:'PUT',url:'/api/v1/reader/preferences/appearance',operation:'reader.appearance.set'},
  {method:'POST',url:'/api/v1/reader/documents/:documentType/:documentId/note',operation:'reader.document_note.create',params:doc},
 ]);
 // The annotation's proposal kind selects its own registered proposal operation.
 registerActionSplitAdapter(app,context.config,{url:'/api/v1/reader/annotations/:annotationId/proposals',param:'annotationId',field:'annotation_id',discriminant:'proposal_type',operations:['reader.memory.propose','reader.knowledge.propose'],first:new Set(['memory_create'])});
 app.get('/api/v1/reader/write-requests/:jobId',async(request,reply)=>{
  const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
  try{reply.header('cache-control','private, no-store');return reply.send(await readReaderWriteRequest(dbPool(context.config),identity,params(request).jobId??''));}
  catch(error){return sendRouteError(reply,error);}
 });
}
