import {sourcesModule} from '../src/modules/sources/index.js';
import {buildModuleServer} from './support/moduleServer.js';
import {RETIRED_SOURCE_CONNECTION_ROUTES} from '../src/modules/sources/retiredConnectionRoutes.js';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {BUILT_IN_PLUGINS} from '../src/modules/plugins/builtInPlugins.js';
import { SYSTEM_ACTION_REGISTRY } from "@rainver/protocol";
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createServerApp, registerGatewayConventions } from '../src/gateway/appShell.js';
import { SERVER_MODULES } from '../src/gateway/routeRegistry.js';
import { createConfigSnapshot, loadConfig } from '../src/config.js';
interface InventoryRow {
  method: string;
  path: string;
  classification: 'legacy_business' | 'transport_exempt' | 'core_entry';
  reason: string;
}
const path = new URL('../src/modules/systemActions/operations/routeInventory.json', import.meta.url);
// Inventory compares exact current method/path pairs; annotations alone never admit a route.
function classification(method: string, path: string): InventoryRow {
  if(RETIRED_SOURCE_CONNECTION_ROUTES.some(route=>route.method===method&&route.path===path))return {
    method,path,classification:'transport_exempt',
    reason:'Exact retired Source connection URL; fixed 410 refusal only, no auth lookup, domain writer or fallback'
  };

  if (path === '/api/v1/actions/:opId' || path === '/api/v1/projects/:projectId/research/operations/:operationId/cancel') return {
    method,
    path,
    classification: 'core_entry',
    reason: 'Generic operation adapter; enabled registrations only'
  };
  if (path.startsWith('/internal/')) return {
    method,
    path,
    classification: 'transport_exempt',
    reason: 'Existing authenticated internal service transport; exact path only'
  };
  if (path.startsWith('/api/v1/auth/')) return {
    method,
    path,
    classification: 'transport_exempt',
    reason: 'Existing authentication/session protocol owned by auth'
  };
  if (path.includes('/upload') || path.includes('/media')) return {
    method,
    path,
    classification: 'transport_exempt',
    reason: 'Existing binary/multipart transport; owning authorization remains required'
  };
  return {
    method,
    path,
    classification: 'legacy_business',
    reason: 'Unmigrated owning-module/plugin route; no generic entry authority'
  };
}
describe('operation route migration contract', () => {
  it('keeps every mutating core route in the exact core and bundled-plugin migration inventory', async () => {
    const config = loadConfig({}),
      app = createServerApp(config, {
        logger: false
      }),
      actual: InventoryRow[] = [];
    app.addHook('onRoute', route => {
      for (const method of [route.method].flat()) if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        const operation = route.config?.operation;
        if (operation) {
          const def = SYSTEM_ACTION_REGISTRY.find(d => d.id === operation);
          expect(def?.execution).toBeDefined();
        }
        actual.push(route.config?.operation ? {
          method,
          path: route.url,
          classification: 'core_entry',
          reason: `Migrated adapter for ${route.config.operation}`
        } : classification(method, route.url));
      }
    });
    registerGatewayConventions(app, config);
    const pluginHost=new PluginHost(BUILT_IN_PLUGINS);
    for (const module of SERVER_MODULES) module.registerRoutes(app, {
      config,
      snapshot: createConfigSnapshot(config),pluginHost
    });
    pluginHost.activate(app,config);
    try {
      await app.ready();
      actual.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
      if (process.env.UPDATE_OPERATION_ROUTE_INVENTORY === '1') writeFileSync(path, JSON.stringify(actual, null, 2) + '\n');
      const frozen = JSON.parse(readFileSync(path, 'utf8')) as InventoryRow[];
      expect(actual).toEqual(frozen);
      expect(actual.some(r => r.classification === 'core_entry' && r.path === '/api/v1/actions/:opId')).toBe(true);
    } finally {
      await app.close();
    }
  });
});


describe('retired Source connection transport',()=>{
  it.each(RETIRED_SOURCE_CONNECTION_ROUTES)('$method $path stays a fixed refusal without database or authenticated work',async route=>{
    const config=loadConfig({});expect(config.databaseUrl).toBeNull();
    const app=buildModuleServer(config,[sourcesModule]);
    try{
      const response=await app.inject({method:route.method,url:route.path.replace(':connectionId','known-or-absent'),...(route.method==='GET'?{}:{payload:{status:'active',credential_id:'untrusted-body'}})});
      expect(response.statusCode,response.body).toBe(410);expect(response.json()).toEqual({detail:route.detail});expect(response.headers['set-cookie']).toBeUndefined();
    }finally{await app.close();}
  });
  it('keeps live Channel subscription and connection Recipe reads outside prefix exemptions',async()=>{
    const app=buildModuleServer(loadConfig({}),[sourcesModule]);
    try{
      const live=await app.inject({method:'POST',url:'/api/v1/sources/channels/channel/subscription',payload:{status:'subscribed'}});
      expect(live.statusCode).not.toBe(410);expect(live.statusCode).toBeGreaterThanOrEqual(400);
      const recipe=await app.inject({method:'GET',url:'/api/v1/sources/connections/connection/recipe-versions'});expect(recipe.statusCode).not.toBe(410);
      expect(RETIRED_SOURCE_CONNECTION_ROUTES.filter(r=>r.method!=='GET')).toHaveLength(8);
    }finally{await app.close();}
  });
});
