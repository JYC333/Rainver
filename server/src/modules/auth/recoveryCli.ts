import { loadConfig } from "../../config.js";
import { createAuthRuntime } from "./identity.js";
import { consumeManualResetLink } from "./recovery.js";
import { normalizeAuthEmail } from "./securityPolicy.js";

/** Sole-admin local recovery. The raw link is printed exactly once. */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.databaseUrl || !config.betterAuthSecret || !config.instanceAdminEmail) throw new Error("database, Better Auth secret, and INSTANCE_ADMIN_EMAIL are required");
  const email = normalizeAuthEmail(process.env.AUTH_RECOVERY_EMAIL ?? config.instanceAdminEmail);
  if (email !== normalizeAuthEmail(config.instanceAdminEmail)) throw new Error("only INSTANCE_ADMIN_EMAIL may use local recovery");
  const runtime = createAuthRuntime(config); if (!runtime) throw new Error("authentication runtime unavailable");
  const count = await runtime.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM users WHERE status <> 'disabled'");
  if (Number(count.rows[0]?.count ?? 0) !== 1) throw new Error("local recovery is limited to a sole active administrator");
  await runtime.auth.api.requestPasswordReset({ body: { email, redirectTo: `${config.frontendUrl.replace(/\/$/, "")}/reset-password` }, headers: new Headers() });
  const link = consumeManualResetLink(email); if (!link) throw new Error("reset link was not produced");
  process.stdout.write(`${link}\n`);
  await runtime.pool.end();
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
