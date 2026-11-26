import {sourcesModule} from '../src/modules/sources/index.js';
import {buildModuleServer} from './support/moduleServer.js';
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
/**
 * Host block (P5) exemptions, exact method/path pairs. Daemon registration and
 * the exact bearer credential/Run transports below are Host protocol; the
 * daemon workspace business writes are core entries. Issuing a pairing code is a user's
 * credential issuance whose one-time secret may not be kept for replay. The relays carry interactive input or a live read
 * that is never persisted (keystrokes, one-time OAuth codes, Host-private
 * directory listings, an account status), so no replayable result may be kept.
 */
const HOST_PAIRING = 'Host pairing/bearer-token daemon protocol owned by hosts; credential and Host-run authority checked by its owner, no user operation principal';
const HOST_RELAY = 'Owner-only interactive Host relay; payload or answer is never persisted or replayed (B64), no durable state';
const HOST_TRANSPORT_EXEMPTIONS: ReadonlyArray<{ method: string; path: string; reason: string }> = [
  { method: 'POST', path: '/api/v1/hosts/pairing-codes', reason: 'Signed-in user credential issuance for Host pairing (same class as auth keys): user-level, not Space-scoped; the one-time code is hashed at rest, expires, and is shown once, so a replayable result would have to keep the plaintext secret' },
  { method: 'POST', path: '/api/v1/hosts/register', reason: HOST_PAIRING },
  { method: 'POST', path: '/api/v1/hosts/me/revoke', reason: HOST_PAIRING },
  { method: 'POST', path: '/api/v1/hosts/me/runs/:runId/diff', reason: `${HOST_PAIRING}; idempotent per launch attempt` },
  { method: 'POST', path: '/api/v1/hosts/me/runs/:runId/outputs', reason: `${HOST_PAIRING}; idempotent per launch attempt` },
  { method: 'POST', path: '/api/v1/hosts/:hostId/browse-directories', reason: HOST_RELAY },
  { method: 'POST', path: '/api/v1/hosts/:hostId/installations/:runtimeKey/:installation/login/input', reason: HOST_RELAY },
  { method: 'POST', path: '/api/v1/hosts/:hostId/installations/:runtimeKey/:installation/login/callback', reason: HOST_RELAY },
  { method: 'POST', path: '/api/v1/hosts/:hostId/ordinary-tools/:toolId/account/verify', reason: HOST_RELAY },
  { method: 'POST', path: '/api/v1/hosts/:hostId/ordinary-tools/:toolId/account/session/cancel', reason: HOST_RELAY },
];
/**
 * Settings block (P5) exemption, exact: the instance admin's keystrokes into
 * their own in-process managed-subscription OAuth login (`credentials.md`).
 * The one-time code goes to the live session and is never persisted or
 * replayed, so a replayable result would have to keep it.
 */
const SETTINGS_TRANSPORT_EXEMPTIONS: ReadonlyArray<{ method: string; path: string; reason: string }> = [
  { method: 'POST', path: '/api/v1/providers/subscriptions/login/input', reason: 'Instance-admin interactive relay into an in-process managed subscription OAuth login; the one-time code is never persisted or replayed (credential channel, ADR 0008)' },
];
/**
 * Sources block exemptions, exact: starting the owner's Gmail OAuth (`.agent/modules/sources.md`, "Personal Gmail connections").
 * It issues a single-use, expiring authorization state bound to the session;
 * the state is hashed at rest and the PKCE verifier is derived from it, so a
 * replayable result would have to keep the plaintext state. The callback is a
 * GET authentication step, not a command; disconnect/forget, legacy selection
 * removal and monitor pause/resume/delete are core entries. The legacy thread
 * read is POST so cursors stay out of URLs; it writes only the owner-read
 * audit row and cannot be a core command without retaining mail in the result.
 * (Manual search and selection add were retired with Gmail V2.) The Pub/Sub
 * push intake has no person actor: a Google-signed OIDC token authenticates it
 * and it only marks the named mailbox's monitored connections for a sync.
 */
const SOURCES_TRANSPORT_EXEMPTIONS: ReadonlyArray<{ method: string; path: string; reason: string }> = [
  { method: 'POST', path: '/api/v1/sources/gmail/oauth/start', reason: 'Owner-only Gmail OAuth start: single-use expiring authorization state (hashed at rest, PKCE verifier derived from it) shown once; a replayable result would have to keep the plaintext state' },
  { method: 'POST', path: '/api/v1/sources/gmail/push', reason: "Pub/Sub push intake: authenticated by a Google-signed OIDC token instead of a session, only marks the named mailbox's monitored connections for a background sync and must acknowledge every authenticated delivery; no person actor, body or replayable result" },
  { method: 'POST', path: '/api/v1/sources/gmail/selections/:selectionId/read', reason: 'Owner-only synchronous Gmail thread page: external reads plus a mandatory owner-read audit row before release; a retained command result would store mail bodies' },
];
// Baseline transport entries are enumerated by exact method/path. A new route
// needs its own owner review; matching a namespace or containing media/upload
// cannot authorize an exemption. Pending media deletion only discards unclaimed
// upload staging; it never deletes a message or its attached media.
const BASELINE_TRANSPORT_EXEMPTIONS: ReadonlyArray<{ method: string; path: string; reason: string }> = [
  { method: "POST", path: "/api/v1/auth/admin/invitations", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/admin/users/:userId/reset-link", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/browser-accounts/switch", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/google/link", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/google/unlink", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/keys", reason: "Existing authentication/session protocol owned by auth" },
  { method: "DELETE", path: "/api/v1/auth/keys/:keyId", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/logout", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/password/change", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/password/set", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/reauth", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/reauth/google", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/reauth/google/complete", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/recovery/complete", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/recovery/request", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/register", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/register/complete", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/register/google", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/registration-intents", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/sessions/:sessionId/revoke", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/sessions/revoke-others", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/auth/sign-in/email", reason: "Existing authentication/session protocol owned by auth" },
  { method: "POST", path: "/api/v1/conversation-inputs/media", reason: "Existing binary/multipart transport; owning authorization remains required" },
  { method: "DELETE", path: "/api/v1/conversation-inputs/media/:mediaId", reason: "Owner-only disposal of pending, unclaimed binary upload staging; claimed message media cannot be deleted here" },
  { method: "POST", path: "/internal/deployment/heartbeat", reason: "Existing authenticated internal service transport; exact path only" },
  { method: "POST", path: "/internal/deployment/jobs/:jobId/events", reason: "Existing authenticated internal service transport; exact path only" },
  { method: "POST", path: "/internal/policy/enforce-proposal-apply", reason: "Existing authenticated internal service transport; exact path only" },
  { method: "POST", path: "/internal/policy/enforce", reason: "Existing authenticated internal service transport; exact path only" },
  { method: "POST", path: "/internal/runs/execute", reason: "Existing authenticated internal service transport; exact path only" },
];
// Inventory compares exact current method/path pairs; annotations alone never admit a route.
function classification(method: string, path: string): InventoryRow {
  if (path === '/api/v1/actions/:opId' || path === '/api/v1/projects/:projectId/research/operations/:operationId/cancel') return {
    method,
    path,
    classification: 'core_entry',
    reason: 'Generic operation adapter; enabled registrations only'
  };
  const hostTransport = HOST_TRANSPORT_EXEMPTIONS.find(row => row.method === method && row.path === path);
  if (hostTransport) return { method, path, classification: 'transport_exempt', reason: hostTransport.reason };
  const settingsTransport = SETTINGS_TRANSPORT_EXEMPTIONS.find(row => row.method === method && row.path === path);
  if (settingsTransport) return { method, path, classification: 'transport_exempt', reason: settingsTransport.reason };
  const sourcesTransport = SOURCES_TRANSPORT_EXEMPTIONS.find(row => row.method === method && row.path === path);
  if (sourcesTransport) return { method, path, classification: 'transport_exempt', reason: sourcesTransport.reason };
  const baselineTransport = BASELINE_TRANSPORT_EXEMPTIONS.find(row => row.method === method && row.path === path);
  if (baselineTransport) return { method, path, classification: 'transport_exempt', reason: baselineTransport.reason };
  return {
    method,
    path,
    classification: 'legacy_business',
    reason: 'Unmigrated owning-module/plugin route; no generic entry authority'
  };
}
describe('operation route migration contract', () => {
  it('keeps the four corrected business writes out of exact transport exemptions',()=>{
    const inventory=JSON.parse(readFileSync(path,'utf8')) as InventoryRow[];
    for(const [method,url] of [['POST','/api/v1/hosts/me/workspaces'],['DELETE','/api/v1/hosts/me/workspaces/:folderId'],['POST','/api/v1/auth/admin/users/:userId/disable'],['POST','/api/v1/auth/admin/users/:userId/enable']]){
      expect(classification(method!,url!).classification).toBe('legacy_business');
      expect(inventory.find(row=>row.method===method&&row.path===url)?.classification).toBe('core_entry');
    }
  });
  it.each([
    ['POST', '/api/v1/auth/unreviewed-domain-write'],
    ['DELETE', '/api/v1/auth/sign-in/email'],
    ['POST', '/internal/unreviewed-domain-write'],
    ['DELETE', '/internal/runs/execute'],
    ['POST', '/api/v1/library/media/publish'],
    ['DELETE', '/api/v1/activity/upload'],
  ])('requires an individual exemption for %s %s', (method, path) => {
    expect(classification(method, path).classification).toBe('legacy_business');
  });
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

describe('live Source Channel and connection-scoped routes', () => {
  it('registers live Channel and connection-scoped Recipe / custom Source routes', async () => {
    const app = buildModuleServer(loadConfig({}), [sourcesModule]);
    try {
      await app.ready();
      for (const [method, url] of [
        ['POST', '/api/v1/sources/channels/:channelId/subscription'],
        ['GET', '/api/v1/sources/connections/:connectionId/recipe-versions'],
        ['GET', '/api/v1/sources/connections/:connectionId/recipe-versions/:versionId'],
        ['GET', '/api/v1/sources/connections/:connectionId/custom-source'],
        ['GET', '/api/v1/sources/connections/:connectionId/handler-versions'],
      ] as const) expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
      const live = await app.inject({ method: 'POST', url: '/api/v1/sources/channels/channel/subscription', payload: { status: 'subscribed' } });
      expect(live.statusCode).not.toBe(404);
      expect(live.statusCode).toBeGreaterThanOrEqual(400);
      const recipe = await app.inject({ method: 'GET', url: '/api/v1/sources/connections/connection/recipe-versions' });
      expect(recipe.statusCode).not.toBe(404);
    } finally { await app.close(); }
  });
});
