import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
/** Retained human Note link and atomic jot URLs as formal core adapters. */
export function registerNoteLinkOperationRoutes(app:FastifyInstance,context:ModuleContext){
  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/knowledge/notes/jot',operation:'knowledge.note.jot'},
    {method:'POST',url:'/api/v1/knowledge/notes/:noteId/links',operation:'knowledge.note.link.create',params:{noteId:'note_id'}},
    {method:'DELETE',url:'/api/v1/knowledge/notes/:noteId/links/:linkId',operation:'knowledge.note.link.delete',params:{noteId:'note_id',linkId:'link_id'}},
  ]);
}
