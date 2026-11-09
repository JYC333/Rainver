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
