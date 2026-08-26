/**
 * Server entrypoint.
 *
 * Loads + validates config (fail-fast), builds the server, and listens. This
 * process serves the backend routes. Unknown `/api/v1/*` paths fail
 * closed with the local 404 catch-all. When the database is configured, it also
 * runs the unified jobs worker and in-process schedulers.
 */

import { buildServer } from "./server.js";
import {
  collectConfigDiagnostics,
  ConfigError,
  createConfigSnapshot,
  describeConfig,
  loadConfig,
} from "./config.js";
import { startBackgroundServices } from "./modules/scheduler/backgroundServices.js";
import { enforceBackupPolicy, BackupPolicyError } from "./modules/backups/guard.js";
import { startProviderProxyServer } from "./modules/providers/proxy/server.js";
import { PluginHost } from "./modules/plugins/host/index.js";
import { BUILT_IN_PLUGINS } from "./modules/plugins/builtInPlugins.js";
import { runBuiltInSeeds } from "./db/seeds.js";
import { getDbPool } from "./db/pool.js";
import { PgWorkspaceLocationRepository } from "./modules/projectFolders/workspaceLocations.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Print to stderr without a stack trace or secrets, then exit non-zero.
      process.stderr.write(
        `[server] invalid configuration [${err.code}]: ${err.message}\n`,
      );
      process.exit(1);
    }
    if (err instanceof BackupPolicyError) {
      process.stderr.write(`[server] backup policy: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  try {
    enforceBackupPolicy(config);
  } catch (err) {
    if (err instanceof BackupPolicyError) {
      process.stderr.write(`[server] backup policy: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const pluginHost = new PluginHost(BUILT_IN_PLUGINS);

  const app = buildServer(config, { pluginHost });
  for (const diagnostic of collectConfigDiagnostics(process.env, config)) {
    app.log.warn(`[server] config [${diagnostic.code}]: ${diagnostic.message}`);
  }
  const snapshot = createConfigSnapshot(config);
  app.log.info(
    `[server] starting (${describeConfig(config)}) ` +
      `config_schema=${snapshot.schema_version} config_hash=${snapshot.content_hash.slice(0, 12)}` +
      ` plugins=${pluginHost.pluginCount}`,
  );

  let background: ReturnType<typeof startBackgroundServices> | null = null;
  let providerProxy: Awaited<ReturnType<typeof startProviderProxyServer>> | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`[server] received ${signal}, shutting down`);
    if (background) {
      await background.worker?.stop();
      await background.scheduler.stop();
    }
    if (providerProxy) {
      await providerProxy.close();
    }
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    providerProxy = await startProviderProxyServer(config);
    app.log.info(`[server] provider proxy listening on ${providerProxy.baseUrl}`);
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    await providerProxy?.close();
    app.log.error(err, "[server] failed to start");
    process.exit(1);
  }

  if (config.databaseUrl) {
    const db = getDbPool(config.databaseUrl);
    await new PgWorkspaceLocationRepository(db).refreshServerLocations(config.workspaceRoot).catch((err) => {
      app.log.error(err, "[workspace-locations] server Location refresh failed");
    });
    void runBuiltInSeeds(db, {
      info: (msg) => app.log.info(msg),
    }, config.catalogRoot).catch((err) => app.log.error(err, "[seeds] built-in seed failed"));
  }

  background = startBackgroundServices(
    config,
    {
      info: (message) => app.log.info(message),
      warn: (message) => app.log.warn(message),
      error: (message) => app.log.error(message),
    },
    pluginHost,
  );
  if (background.worker) {
    app.log.info(`[server] jobs worker active (${background.worker.worker_id})`);
  }
}

void main();
