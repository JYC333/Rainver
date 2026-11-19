import {randomBytes, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import pg from 'pg';
import {useTestDatabase} from './support/testDatabase.js';
import {assertLeastPrivilegeRuntimeRole, grantPluginRuntimeMemberships, inspectRuntimeRoles, reconcileRuntimeRoles, runtimeRoleSuperset, scramVerifier} from '../src/db/runtimeRoles.js';
import {provisionPluginRoles, pluginRoleNames} from '../src/modules/plugins/operationDb.js';
import {withTransaction} from '../src/db/tx.js';
import {loadConfig} from '../src/config.js';
import {buildModuleServer} from './support/moduleServer.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {seedSpaceOwnerProject} from './support/domainSeeds.js';

/**
 * ADR 0031 on real PostgreSQL. Roles are cluster-global, so every name is
 * unique to this file and dropped afterwards; only this file's test database
 * (and one scratch restore database in the same test container) is touched.
 */
const db = useTestDatabase(import.meta.filename);
const suffix = randomBytes(4).toString('hex');
const app = `rt_app_${suffix}`, backup = `rt_backup_${suffix}`, plugin = `rr${suffix}`;
const appPassword = randomBytes(18).toString('base64url'), backupPassword = randomBytes(18).toString('base64url');
const clients: pg.Client[] = [];
const urlFor = (role: string, password: string, database?: string) => {
  const url = new URL(db.connectionUri);
  url.username = role; url.password = password;
  if (database) url.pathname = `/${database}`;
  return url.toString();
};
async function connect(role: string, password: string, database?: string) {
  const client = new pg.Client({connectionString: urlFor(role, password, database)});
  // Scratch-database cleanup terminates its sessions; that is expected, not a test failure.
  client.on('error', () => {});
  await client.connect();
  clients.push(client);
  return client;
}
const reconcile = (database?: pg.Client) => (database ? Promise.resolve(database) : Promise.resolve(null)).then(client => client
  ? (async () => { await client.query('BEGIN'); try { const r = await reconcileRuntimeRoles(client, {appRole: app, backupRole: backup, appPassword, backupPassword}); await client.query('COMMIT'); return r; } catch (e) { await client.query('ROLLBACK'); throw e; } })()
  : withTransaction(db.pool, tx => reconcileRuntimeRoles(tx, {appRole: app, backupRole: backup, appPassword, backupPassword})));

beforeAll(async () => {
  if (!db.available) return;
  await provisionPluginRoles(db.pool, plugin);
  await withTransaction(db.pool, async tx => {
    await tx.query(`SET LOCAL ROLE ${pluginRoleNames(plugin).ddl}`);
    await tx.query(`CREATE TABLE ${pluginRoleNames(plugin).schema}.notes(id text PRIMARY KEY)`);
  });
});
afterAll(async () => {
  for (const client of clients) await client.end().catch(() => {});
  if (!db.available) return;
  for (const role of [app, backup]) {
    if ((await db.pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rows.length) {
      await db.pool.query(`DROP OWNED BY ${role}`);
      await db.pool.query(`DROP ROLE ${role}`);
    }
  }
});

describe('runtime database role separation', () => {
  it('computes a SCRAM verifier client-side and refuses short passwords', () => {
    expect(scramVerifier('x'.repeat(20))).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(() => scramVerifier('short')).toThrow(/16/);
  });

  it('provisions least-privilege app and read-only backup roles idempotently; the app cannot change schema or the migration journal', async () => {
    const first = await reconcile();
    expect(first.app).toMatchObject({exists: true, safe: true, can_login: true, owns_objects: 0});
    expect(first.backup).toMatchObject({exists: true, safe: true, can_login: true, owns_objects: 0});
    expect(first.plugin_roles).toContain(pluginRoleNames(plugin).runtime);
    expect((await reconcile()).app).toEqual(first.app);
    const runtime = await connect(app, appPassword);
    const space = randomUUID();
    await runtime.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Role probe','team',now(),now())`, [space]);
    expect((await runtime.query('SELECT name FROM spaces WHERE id=$1', [space])).rows).toEqual([{name: 'Role probe'}]);
    for (const [sql, pattern] of [
      ['CREATE TABLE public.escaped(id int)', /permission denied/],
      ['ALTER TABLE spaces ADD COLUMN escaped int', /must be owner/],
      ['DROP TABLE spaces', /must be owner/],
      [`CREATE SCHEMA escaped_${suffix}`, /permission denied/],
      [`CREATE ROLE escaped_${suffix}`, /permission denied/],
      [`INSERT INTO server_schema_migrations (version,name,checksum,applied_at) VALUES ('9999','x','x',now())`, /permission denied/],
      [`SET ROLE ${pluginRoleNames(plugin).ddl}`, /permission denied/],
      [`SELECT * FROM ${pluginRoleNames(plugin).schema}.notes`, /permission denied/],
    ] as const) await expect(runtime.query(sql), sql).rejects.toThrow(pattern);
    expect((await runtime.query('SELECT count(*)::int AS n FROM server_schema_migrations')).rows[0].n).toBeGreaterThan(0);
    // The plugin runtime role is reachable exactly like the host's own: SET, not inherited.
    await runtime.query('BEGIN');
    await runtime.query(`SET LOCAL ROLE ${pluginRoleNames(plugin).runtime}`);
    expect((await runtime.query(`SELECT count(*)::int AS n FROM ${pluginRoleNames(plugin).schema}.notes`)).rows[0].n).toBe(0);
    await runtime.query(`SET LOCAL ROLE ${app}`);
    await runtime.query('COMMIT');
    await expect(runtime.query('BEGIN; SELECT 1; ROLLBACK').then(() => reconcile(runtime))).rejects.toThrow(/owner channel/);
  });

  it('serves real P1 operations with policy audit as the app role', async () => {
    const space = randomUUID(), owner = randomUUID();
    await seedSpaceOwnerProject(db.pool, {space, owner, project: randomUUID()});
    const app_ = buildModuleServer(loadConfig({SERVER_DATABASE_URL: urlFor(app, appPassword)}), [systemActionsModule]);
    try {
      await app_.ready();
      __setAuthIdentityForTests({spaceId: space, userId: owner});
      const res = await app_.inject({method: 'GET', url: `/api/v1/queries/system.actions.list?input=${encodeURIComponent('{}')}`});
      expect(res.statusCode, res.body).toBe(200);
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM policy_decision_records WHERE space_id=$1 AND action='system.actions.list'`, [space])).rows[0].n).toBe(1);
    } finally { __setAuthIdentityForTests(null); await app_.close(); }
  });

  it('keeps backups read-only and future owner migrations reachable through default privileges', async () => {
    const reader = await connect(backup, backupPassword);
    expect((await reader.query(`SELECT count(*)::int >= 0 AS ok FROM ${pluginRoleNames(plugin).schema}.notes`)).rows[0].ok).toBe(true);
    await expect(reader.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ('${randomUUID()}','x','team',now(),now())`)).rejects.toThrow(/permission denied/);
    await db.pool.query(`CREATE TABLE public.rt_future_${suffix}(id text PRIMARY KEY)`);
    const runtime = await connect(app, appPassword);
    await runtime.query(`INSERT INTO public.rt_future_${suffix} VALUES ('one')`);
    expect((await reader.query(`SELECT id FROM public.rt_future_${suffix}`)).rows).toEqual([{id: 'one'}]);
    await db.pool.query(`DROP TABLE public.rt_future_${suffix}`);
  });

  it('admits only the least-privilege role at activated startup, and rollback to the owner URL needs no reassignment', async () => {
    await expect(assertLeastPrivilegeRuntimeRole(db.pool)).rejects.toThrow(/least-privilege/);
    await expect(assertLeastPrivilegeRuntimeRole(await connect(app, appPassword))).resolves.toBeUndefined();
    const plan = await inspectRuntimeRoles(db.pool, {appRole: app, backupRole: backup});
    expect(plan).toMatchObject({connected_superuser: true, app: {owns_objects: 0}, backup: {owns_objects: 0}});
    expect(JSON.stringify(plan)).not.toContain(appPassword);
    // Rollback is a URL switch back to the owner; the app role owns nothing, so it can also be removed without REASSIGN.
    expect((await db.pool.query('SELECT 1 AS ok')).rows).toEqual([{ok: 1}]);
  });

  it('refuses the same ownership at startup and reconcile, in any schema and for functions, types and large objects', async () => {
    const side = `rt_side_${suffix}`;
    await reconcile();
    // Each owned object alone; the table's owner even revoked its own grants, which ownership survives.
    const fixtures: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
      ['non-public table', async () => {
        await db.pool.query(`CREATE SCHEMA ${side}`);
        await db.pool.query(`CREATE TABLE ${side}.t(id int)`);
        await db.pool.query(`ALTER TABLE ${side}.t OWNER TO ${app}`);
        await db.pool.query(`REVOKE ALL ON ${side}.t FROM ${app}`);
      }, () => db.pool.query(`DROP SCHEMA ${side} CASCADE`)],
      ['function', async () => {
        await db.pool.query(`CREATE FUNCTION public.rt_fn_${suffix}() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
        await db.pool.query(`ALTER FUNCTION public.rt_fn_${suffix}() OWNER TO ${app}`);
      }, () => db.pool.query(`DROP FUNCTION public.rt_fn_${suffix}()`)],
      ['type', async () => {
        await db.pool.query(`CREATE TYPE public.rt_mood_${suffix} AS ENUM ('a')`);
        await db.pool.query(`ALTER TYPE public.rt_mood_${suffix} OWNER TO ${app}`);
      }, () => db.pool.query(`DROP TYPE public.rt_mood_${suffix}`)],
      ['large object', async () => {
        const oid = (await db.pool.query<{ oid: number }>(`SELECT lo_create(0) AS oid`)).rows[0]!.oid;
        await db.pool.query(`ALTER LARGE OBJECT ${oid} OWNER TO ${app}`);
      }, () => db.pool.query(`SELECT lo_unlink(oid) FROM pg_largeobject_metadata WHERE lomowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`, [app])],
    ];
    for (const [label, create, remove] of fixtures) {
      await create();
      try {
        expect(await runtimeRoleSuperset(db.pool, app, 'app'), label).toEqual([]);
        await expect(assertLeastPrivilegeRuntimeRole(await connect(app, appPassword)), label).rejects.toThrow(/least-privilege/);
        await expect(reconcile(), label).rejects.toThrow(/owns database objects/);
      } finally { await remove(); }
    }
    // A concurrent app session's temporary table is not lasting ownership; the safe role still starts and reconciles.
    const running = await connect(app, appPassword);
    await running.query(`CREATE TEMP TABLE rt_scratch(id int)`);
    await expect(assertLeastPrivilegeRuntimeRole(await connect(app, appPassword))).resolves.toBeUndefined();
    await expect(reconcile()).resolves.toMatchObject({app: {owns_objects: 0}});
    await running.query(`DROP TABLE rt_scratch`);
  });

  it('fails closed on an unsafe or object-owning existing role instead of repairing it by reassignment', async () => {
    const unsafe = `rt_unsafe_${suffix}`, owning = `rt_owning_${suffix}`;
    try {
      await db.pool.query(`CREATE ROLE ${unsafe} LOGIN CREATEROLE`);
      await expect(withTransaction(db.pool, tx => reconcileRuntimeRoles(tx, {appRole: unsafe, backupRole: backup}))).rejects.toThrow(/unsafe attributes/);
      await db.pool.query(`CREATE ROLE ${owning} LOGIN NOINHERIT`);
      await db.pool.query(`CREATE TABLE public.rt_owned_${suffix}(id int)`);
      await db.pool.query(`ALTER TABLE public.rt_owned_${suffix} OWNER TO ${owning}`);
      await expect(withTransaction(db.pool, tx => reconcileRuntimeRoles(tx, {appRole: owning, backupRole: backup}))).rejects.toThrow(/owns database objects/);
      expect((await db.pool.query(`SELECT tableowner FROM pg_tables WHERE tablename=$1`, [`rt_owned_${suffix}`])).rows).toEqual([{tableowner: owning}]);
    } finally {
      await db.pool.query(`DROP TABLE IF EXISTS public.rt_owned_${suffix}`);
      for (const role of [unsafe, owning]) if ((await db.pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rows.length) { await db.pool.query(`DROP OWNED BY ${role}`); await db.pool.query(`DROP ROLE ${role}`); }
    }
  });

  it('a --no-owner --no-acl restore loses app grants until the owner-channel reconcile restores them', async () => {
    // Locate this file's own test container strictly by the test database address; never an instance container.
    const address = new URL(db.connectionUri);
    let container = '';
    try {
      for (const id of execFileSync('docker', ['ps', '-q'], {encoding: 'utf8'}).split('\n').filter(Boolean)) {
        const ips = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', id], {encoding: 'utf8'}).trim().split(/\s+/);
        const ports = execFileSync('docker', ['port', id], {encoding: 'utf8'});
        if (ips.includes(address.hostname) || ports.includes(`:${address.port}`) && ['localhost', '127.0.0.1'].includes(address.hostname)) { container = id; break; }
      }
    } catch { container = ''; }
    const owner = new URL(db.connectionUri), source = owner.pathname.slice(1), target = `rt_restore_${suffix}`;
    // A real dump/restore or a failure: an ACL rehearsal is not reported as a restore.
    expect(container, 'the test PostgreSQL container must be reachable through the docker CLI').not.toBe('');
    await db.pool.query(`CREATE DATABASE ${target}`);
    try {
      const user = decodeURIComponent(owner.username);
      // The password is inherited by name, never spelled on the docker argv.
      const env = {...process.env, PGPASSWORD: decodeURIComponent(owner.password)};
      const dump = execFileSync('docker', ['exec', '-e', 'PGPASSWORD', container, 'pg_dump', '-h', '127.0.0.1', '-U', user, '-d', source, '-Fc'], {maxBuffer: 512 * 1024 * 1024, env});
      execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD', container, 'pg_restore', '-h', '127.0.0.1', '-U', user, '-d', target, '--no-owner', '--no-acl', '--exit-on-error'], {input: dump, maxBuffer: 64 * 1024 * 1024, env});
      const ownerTarget = new pg.Client({connectionString: (() => { const u = new URL(db.connectionUri); u.pathname = `/${target}`; return u.toString(); })()});
      ownerTarget.on('error', () => {});
      await ownerTarget.connect(); clients.push(ownerTarget);
      // Database-level grants and every object ACL are absent after --no-acl.
      await expect(connect(app, appPassword, target).then(c => c.query('SELECT 1 FROM spaces LIMIT 1'))).rejects.toThrow(/permission denied/);
      await provisionPluginRoles(ownerTarget, plugin, true);
      await reconcile(ownerTarget);
      expect(await grantPluginRuntimeMemberships(ownerTarget, app)).toContain(pluginRoleNames(plugin).runtime);
      const restored = await connect(app, appPassword, target);
      // The scratch database really carries the restored schema (not an empty database).
      expect((await ownerTarget.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'`)).rows[0].n).toBeGreaterThan(100);
      expect((await restored.query('SELECT count(*)::int >= 0 AS ok FROM spaces')).rows[0].ok).toBe(true);
      await expect(restored.query('CREATE TABLE public.escaped(id int)')).rejects.toThrow(/permission denied/);
      await assertLeastPrivilegeRuntimeRole(restored);
      // Default privileges were restored too: a later owner migration reaches the app, not the backup.
      await ownerTarget.query(`CREATE TABLE public.rt_after_restore(id text PRIMARY KEY)`);
      await restored.query(`INSERT INTO public.rt_after_restore VALUES ('x')`);
      expect(await runtimeRoleSuperset(ownerTarget, app, 'app')).toEqual([]);
      expect(await runtimeRoleSuperset(ownerTarget, backup, 'backup')).toEqual([]);
      await restored.end(); await ownerTarget.end();
    } finally {
      await db.pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [target]);
      await db.pool.query(`DROP DATABASE IF EXISTS ${target}`);
    }
  });
  it('refuses existing roles whose effective privileges exceed their target, and never revokes or reassigns them', async () => {
    const legacyBackup = `rt_lb_${suffix}`, legacyApp = `rt_la_${suffix}`, middle = `rt_mid_${suffix}`, indirectApp = `rt_ia_${suffix}`;
    const database = new URL(db.connectionUri).pathname.slice(1);
    const fn = `rt_definer_${suffix}`;
    const drop = async () => {
      await db.pool.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
      for (const role of [legacyBackup, legacyApp, indirectApp, middle]) if ((await db.pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rows.length) {
        await db.pool.query(`DROP OWNED BY ${role}`); await db.pool.query(`DROP ROLE ${role}`);
      }
    };
    try {
      // An old backup role that can write, directly and through future-object defaults.
      await db.pool.query(`CREATE ROLE ${legacyBackup} LOGIN INHERIT`);
      await db.pool.query(`GRANT INSERT ON public.spaces TO ${legacyBackup}`);
      await db.pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT DELETE ON TABLES TO ${legacyBackup}`);
      await expect(withTransaction(db.pool, tx => reconcileRuntimeRoles(tx, {appRole: app, backupRole: legacyBackup}))).rejects.toThrow(/exceeds its runtime privileges.*INSERT on public\.spaces.*default DELETE on future tables in public/);
      // Refused, not trimmed: the operator's grant is still there.
      expect((await db.pool.query(`SELECT has_table_privilege($1,'public.spaces','INSERT') AS can`, [legacyBackup])).rows[0].can).toBe(true);
      // An old app role that can create schemas in the database, and one that reaches write-all through a middle role.
      await db.pool.query(`CREATE ROLE ${legacyApp} LOGIN NOINHERIT`);
      await db.pool.query(`GRANT CREATE ON DATABASE "${database}" TO ${legacyApp}`);
      await expect(withTransaction(db.pool, tx => reconcileRuntimeRoles(tx, {appRole: legacyApp, backupRole: backup}))).rejects.toThrow(/can CREATE schemas in the database/);
      await db.pool.query(`CREATE ROLE ${middle} NOLOGIN INHERIT`);
      await db.pool.query(`GRANT pg_write_all_data TO ${middle}`);
      await db.pool.query(`CREATE ROLE ${indirectApp} LOGIN NOINHERIT`);
      await db.pool.query(`GRANT ${middle} TO ${indirectApp}`);
      await expect(withTransaction(db.pool, tx => reconcileRuntimeRoles(tx, {appRole: indirectApp, backupRole: backup}))).rejects.toThrow(new RegExp(`(?=.*member of ${middle})(?=.*member of pg_write_all_data \\(indirectly\\))`));
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)`, [indirectApp])).rows[0].n).toBe(1);
      // The read-only plan reports the same findings, without secrets.
      const plan = await inspectRuntimeRoles(db.pool, {appRole: legacyApp, backupRole: legacyBackup});
      expect(plan.app.exceeds).toContain('can CREATE schemas in the database');
      expect(plan.backup.exceeds).toEqual(expect.arrayContaining(['INSERT on public.spaces']));
      // After an explicit operator repair the same role reconciles, and the backup can no longer write.
      await db.pool.query(`REVOKE INSERT ON public.spaces FROM ${legacyBackup}`);
      await db.pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE DELETE ON TABLES FROM ${legacyBackup}`);
      const password = randomBytes(18).toString('base64url');
      await withTransaction(db.pool, tx => reconcileRuntimeRoles(tx, {appRole: app, backupRole: legacyBackup, backupPassword: password}));
      await expect((await connect(legacyBackup, password)).query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ('${randomUUID()}','x','team',now(),now())`)).rejects.toThrow(/permission denied/);
      // A privileged SECURITY DEFINER function the app may execute is an escalation path: startup and plan refuse it.
      await db.pool.query(`CREATE FUNCTION public.${fn}() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
      await db.pool.query(`GRANT EXECUTE ON FUNCTION public.${fn}() TO ${app}`);
      await expect(assertLeastPrivilegeRuntimeRole(await connect(app, appPassword))).rejects.toThrow(new RegExp(`SECURITY DEFINER function public\\.${fn}`));
      await db.pool.query(`DROP FUNCTION public.${fn}()`);
      await expect(assertLeastPrivilegeRuntimeRole(await connect(app, appPassword))).resolves.toBeUndefined();
    } finally { await drop(); }
  });

  it('judges a SECURITY DEFINER by what its owner can actually do: an ordinary owner escalates, a provably narrow one does not', async () => {
    const owner = `rt_fo_${suffix}`, narrow = `rt_fn_${suffix}`, table = `rt_owned_${suffix}`;
    const ddl = `rt_ddl_${suffix}`, journal = `rt_journal_${suffix}`, safe = `rt_safe_${suffix}`;
    const drop = async () => {
      for (const fn of [ddl, journal, safe]) await db.pool.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
      await db.pool.query(`DROP TABLE IF EXISTS public.${table}`);
      for (const role of [owner, narrow]) if ((await db.pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rows.length) {
        await db.pool.query(`DROP OWNED BY ${role}`); await db.pool.query(`DROP ROLE ${role}`);
      }
    };
    try {
      await reconcile();
      // An ordinary role: no superuser, CREATEROLE or CREATEDB. It owns one table and may write the journal.
      await db.pool.query(`CREATE ROLE ${owner} NOLOGIN NOINHERIT`);
      await db.pool.query(`CREATE TABLE public.${table}(id int)`);
      await db.pool.query(`ALTER TABLE public.${table} OWNER TO ${owner}`);
      await db.pool.query(`GRANT INSERT ON public.server_schema_migrations TO ${owner}`);
      await db.pool.query(`CREATE FUNCTION public.${ddl}() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$ BEGIN EXECUTE 'ALTER TABLE public.${table} ADD COLUMN escaped int'; RETURN 1; END $f$`);
      await db.pool.query(`CREATE FUNCTION public.${journal}() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$ BEGIN INSERT INTO public.server_schema_migrations(version, name, checksum) VALUES ('rt-escalation', 'rt-escalation', 'x'); RETURN 1; END $f$`);
      for (const fn of [ddl, journal]) await db.pool.query(`ALTER FUNCTION public.${fn}() OWNER TO ${owner}`);
      // Real escalation, proven as the app role and rolled back: DDL and a journal write through the definer.
      const runtime = await connect(app, appPassword);
      await expect(runtime.query(`ALTER TABLE public.${table} ADD COLUMN direct int`)).rejects.toThrow(/must be owner/);
      await runtime.query('BEGIN');
      try {
        await runtime.query(`SELECT public.${ddl}()`);
        await runtime.query(`SELECT public.${journal}()`);
        expect((await runtime.query(`SELECT count(*)::int AS n FROM public.server_schema_migrations WHERE version='rt-escalation'`)).rows[0].n).toBe(1);
      } finally { await runtime.query('ROLLBACK'); }
      const findings = await runtimeRoleSuperset(db.pool, app, 'app');
      expect(findings).toEqual(expect.arrayContaining([
        expect.stringMatching(new RegExp(`SECURITY DEFINER function public\\.${ddl} \\(owner ${owner} owns 1 database object`)),
        expect.stringMatching(new RegExp(`SECURITY DEFINER function public\\.${journal} \\(owner ${owner}`)),
      ]));
      await expect(assertLeastPrivilegeRuntimeRole(await connect(app, appPassword))).rejects.toThrow(/SECURITY DEFINER/);
      // Without the table, the journal grant alone is still an escalation the owner's effective privileges show.
      await db.pool.query(`DROP FUNCTION public.${ddl}()`);
      await db.pool.query(`DROP TABLE public.${table}`);
      expect(await runtimeRoleSuperset(db.pool, app, 'app')).toEqual([expect.stringMatching(new RegExp(`${journal} \\(owner ${owner} can INSERT on the migration journal\\)`))]);
      await db.pool.query(`DROP FUNCTION public.${journal}()`);
      // A provably narrow owner: no attributes, owns only this function, holds only what the app already holds.
      await db.pool.query(`CREATE ROLE ${narrow} NOLOGIN NOINHERIT`);
      await db.pool.query(`GRANT USAGE ON SCHEMA public TO ${narrow}`);
      await db.pool.query(`GRANT SELECT ON public.spaces TO ${narrow}`);
      await db.pool.query(`CREATE FUNCTION public.${safe}() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = public AS 'SELECT count(*) FROM public.spaces'`);
      await db.pool.query(`ALTER FUNCTION public.${safe}() OWNER TO ${narrow}`);
      expect(await runtimeRoleSuperset(db.pool, app, 'app')).toEqual([]);
      await expect(assertLeastPrivilegeRuntimeRole(await connect(app, appPassword))).resolves.toBeUndefined();
      // The same owner granted TRUNCATE (beyond the app target) stops being narrow.
      await db.pool.query(`GRANT TRUNCATE ON public.spaces TO ${narrow}`);
      expect(await runtimeRoleSuperset(db.pool, app, 'app')).toEqual([`EXECUTE on SECURITY DEFINER function public.${safe} (owner ${narrow} can TRUNCATE on public.spaces)`]);
      // Refused, never repaired: the operator's grants and ownership are untouched.
      expect((await db.pool.query(`SELECT has_table_privilege($1,'public.spaces','TRUNCATE') AS can`, [narrow])).rows[0].can).toBe(true);
    } finally { await drop(); }
  });

  it('counts default privileges that reach the role through PUBLIC or an inherited role, before the table exists', async () => {
    const group = `rt_grp_${suffix}`, first = `rt_future_${suffix}`, second = `rt_future2_${suffix}`;
    const ownerName = (await db.pool.query<{name: string}>('SELECT current_user AS name')).rows[0]!.name;
    const cleanup: string[] = [];
    try {
      await reconcile();
      expect(await runtimeRoleSuperset(db.pool, app, 'app')).toEqual([]);
      expect(await runtimeRoleSuperset(db.pool, backup, 'backup')).toEqual([]);
      // PUBLIC: nothing exists yet, and the finding already names the future TRUNCATE.
      await db.pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerName} IN SCHEMA public GRANT TRUNCATE ON TABLES TO PUBLIC`);
      cleanup.push(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerName} IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM PUBLIC`);
      expect((await db.pool.query('SELECT to_regclass($1) AS t', [`public.${first}`])).rows[0].t).toBeNull();
      expect(await runtimeRoleSuperset(db.pool, app, 'app')).toContain('default TRUNCATE on future tables in public to PUBLIC');
      expect(await runtimeRoleSuperset(db.pool, backup, 'backup')).toContain('default TRUNCATE on future tables in public to PUBLIC');
      // The counter-proof: the table the owner creates next really is TRUNCATE-able by both runtime roles.
      await db.pool.query(`CREATE TABLE public.${first}(id int)`);
      cleanup.push(`DROP TABLE IF EXISTS public.${first}`);
      for (const role of [app, backup]) expect((await db.pool.query(`SELECT has_table_privilege($1,$2,'TRUNCATE') AS can`, [role, `public.${first}`])).rows[0].can).toBe(true);
      await db.pool.query(cleanup.shift()!);
      await db.pool.query(cleanup.shift()!);
      // Inherited: a role the backup inherits from receives a future INSERT.
      await db.pool.query(`CREATE ROLE ${group} NOLOGIN`);
      await db.pool.query(`GRANT ${group} TO ${backup}`);
      await db.pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerName} IN SCHEMA public GRANT INSERT ON TABLES TO ${group}`);
      expect(await runtimeRoleSuperset(db.pool, backup, 'backup')).toContain(`default INSERT on future tables in public through ${group}`);
      await db.pool.query(`CREATE TABLE public.${second}(id int)`);
      cleanup.push(`DROP TABLE IF EXISTS public.${second}`);
      expect((await db.pool.query(`SELECT has_table_privilege($1,$2,'INSERT') AS can`, [backup, `public.${second}`])).rows[0].can).toBe(true);
      // The app role does not inherit (NOINHERIT) and never received the group: it is not charged with it.
      expect(await runtimeRoleSuperset(db.pool, app, 'app')).not.toContain(`default INSERT on future tables in public through ${group}`);
    } finally {
      for (const sql of cleanup) await db.pool.query(sql);
      if ((await db.pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [group])).rows.length) {
        await db.pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerName} IN SCHEMA public REVOKE INSERT ON TABLES FROM ${group}`);
        await db.pool.query(`DROP OWNED BY ${group}`); await db.pool.query(`DROP ROLE ${group}`);
      }
    }
    // The reconciled safe defaults still serve future tables: the app may write, the backup only read.
    expect(await runtimeRoleSuperset(db.pool, app, 'app')).toEqual([]);
    expect(await runtimeRoleSuperset(db.pool, backup, 'backup')).toEqual([]);
    const later = `rt_later_${suffix}`;
    await db.pool.query(`CREATE TABLE public.${later}(id int)`);
    try {
      expect((await db.pool.query(`SELECT has_table_privilege($1,$2,'INSERT') AS app_w, has_table_privilege($3,$2,'SELECT') AS b_r, has_table_privilege($3,$2,'INSERT') AS b_w`, [app, `public.${later}`, backup])).rows[0]).toEqual({app_w: true, b_r: true, b_w: false});
    } finally { await db.pool.query(`DROP TABLE public.${later}`); }
  });
});
