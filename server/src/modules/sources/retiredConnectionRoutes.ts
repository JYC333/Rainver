import type {FastifyInstance} from 'fastify';

/** Exact retired URLs: fixed transport refusal, never a domain capability. */
export const RETIRED_SOURCE_CONNECTION_ROUTES = [
  {
    "method": "GET",
    "path": "/api/v1/sources/connections",
    "detail": "Source connections are internal provenance; use Source Channels"
  },
  {
    "method": "POST",
    "path": "/api/v1/sources/connections",
    "detail": "Source connections are not user-created resources; create a Source Channel"
  },
  {
    "method": "POST",
    "path": "/api/v1/sources/connections/drafts",
    "detail": "Source connection drafts were replaced by Source Channels"
  },
  {
    "method": "POST",
    "path": "/api/v1/sources/connections/proposals",
    "detail": "Source connection proposals were replaced by Source Channel activation proposals"
  },
  {
    "method": "GET",
    "path": "/api/v1/sources/connections/:connectionId",
    "detail": "Source connections are internal provenance; use Source Channels"
  },
  {
    "method": "POST",
    "path": "/api/v1/sources/connections/:connectionId/recommendations",
    "detail": "Subscriptions are managed at Source Channel level"
  },
  {
    "method": "POST",
    "path": "/api/v1/sources/connections/:connectionId/subscription",
    "detail": "Subscriptions are managed at Source Channel level"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/sources/connections/:connectionId",
    "detail": "Source connections are internal provenance; update the Source Channel"
  },
  {
    "method": "DELETE",
    "path": "/api/v1/sources/connections/:connectionId",
    "detail": "Source connections are internal provenance; archive the Source Channel"
  },
  {
    "method": "POST",
    "path": "/api/v1/sources/connections/:connectionId/scan",
    "detail": "Scan the Source Channel instead"
  }
] as const;

export function registerRetiredSourceConnectionRoutes(app:FastifyInstance){
  for(const route of RETIRED_SOURCE_CONNECTION_ROUTES)app.route({method:route.method,url:route.path,handler:async(_request,reply)=>reply.code(410).send({detail:route.detail})});
}
