import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { PgHostRepository } from "../src/modules/hosts/repository.js";
import { hostControlPlaneUrl } from "../src/modules/hosts/controlPlaneUrl.js";
import {
  builtinHostCredentialPath,
  publishBuiltinHostCredential,
} from "../src/modules/hosts/builtinRegistration.js";

/**
 * The built-in host has no pairing step (plan decision 4): the control plane
 * issues its bearer token and leaves it in a directory only these two
 * containers share. What matters is that publishing is idempotent across
 * restarts — a token rotated on every boot would cut the daemon off from its
 * own instance every time — and that a lost file is recoverable, since the
 * server keeps only a hash.
 */
const db = useTestDatabase(import.meta.url);

let rainverHome: string;

function config(): ServerConfig {
  return { ...loadConfig({}), rainverHome, sandboxRunnerServerHost: "server", port: 8010 };
}

beforeEach(async () => {
  rainverHome = await mkdtemp(join(tmpdir(), "rainver-builtin-home-"));
  if (db.pool) await resetTables(db.pool, ["hosts", "machines"], { cascade: true });
});

afterEach(async () => {
  await rm(rainverHome, { recursive: true, force: true });
});

async function published(): Promise<{ server_url: string; host_id: string; token: string }> {
  return JSON.parse(await readFile(builtinHostCredentialPath(rainverHome), "utf8"));
}

describe("publishing the built-in host credential", () => {
  it("registers the instance's own execution host with no pairing code", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const result = await publishBuiltinHostCredential(db.pool, config());
    expect(result.rotated).toBe(true);

    const credential = await published();
    expect(credential.host_id).toBe(result.host_id);
    // The in-network address, not an operator-configured one: the built-in
    // host is a Compose service beside the server.
    expect(credential.server_url).toBe("http://server:8010");
    const repo = new PgHostRepository(db.pool);
    const row = await repo.authenticate(credential.token);
    expect(row).toMatchObject({ id: result.host_id, kind: "server", owner_user_id: null });
    // Children on the built-in host call back on the same address it registered at.
    expect(hostControlPlaneUrl(config(), "server")).toBe(credential.server_url);
  });

  it("leaves a valid credential alone across a restart", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    await publishBuiltinHostCredential(db.pool, config());
    const first = await published();

    const second = await publishBuiltinHostCredential(db.pool, config());
    expect(second.rotated).toBe(false);
    // Rotating on every boot would cut the daemon off from its own instance
    // on each server restart.
    expect(await published()).toEqual(first);
  });

  it("reissues when the published copy is gone, because only the daemon ever held it", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    await publishBuiltinHostCredential(db.pool, config());
    const first = await published();
    await rm(builtinHostCredentialPath(rainverHome), { force: true });

    expect((await publishBuiltinHostCredential(db.pool, config())).rotated).toBe(true);
    const second = await published();
    expect(second.token).not.toBe(first.token);
    expect(second.host_id).toBe(first.host_id);
    expect(await new PgHostRepository(db.pool).authenticate(first.token)).toBeNull();
  });

  it("reissues when the file no longer matches the row, such as after a restore", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    await publishBuiltinHostCredential(db.pool, config());
    const first = await published();
    await writeFile(
      builtinHostCredentialPath(rainverHome),
      JSON.stringify({ ...first, token: "a-token-this-instance-never-issued" }),
    );

    expect((await publishBuiltinHostCredential(db.pool, config())).rotated).toBe(true);
    expect((await published()).token).not.toBe("a-token-this-instance-never-issued");
  });
});
