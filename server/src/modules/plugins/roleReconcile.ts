import type { Queryable } from '../routeUtils/common.js';
export function pluginRoleNames(id: string) {
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(id)) throw new Error('Invalid plugin role namespace');
  return {
    schema: `plugin_${id}`,
    runtime: `rainver_plugin_${id}`,
    ddl: `rainver_plugin_${id}_ddl`
  };
}
/** Explicit offline primitive, never activation/HTTP. Reconcile restores operation-package ownership. */
export async function provisionPluginRoles(db: Queryable, id: string, repair = false): Promise<void> {
  const {
    schema,
    runtime,
    ddl
  } = pluginRoleNames(id);
  for (const role of [runtime, ddl]) {
    if (repair && (await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rows.length) {
      await db.query(`ALTER ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      for (const parent of (await db.query<{
        rolname: string;
      }>('SELECT p.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles p ON p.oid=m.roleid WHERE r.rolname=$1', [role])).rows) await db.query(`REVOKE "${parent.rolname.replaceAll('"', '""')}" FROM ${role}`);
    }
    if (!(await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rows.length) await db.query(`DO $role$ BEGIN CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $role$`);
    const actual = (await db.query<{
      safe: boolean;
    }>(`SELECT NOT rolcanlogin AND NOT rolreplication AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AND NOT rolinherit AS safe FROM pg_roles WHERE rolname=$1`, [role])).rows[0];
    if (!actual?.safe) throw new Error('Unsafe existing plugin role');
    if ((await db.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1', [role])).rows.length) throw new Error('Plugin role has unexpected memberships');
  }
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${ddl}`);
  if (repair) await db.query(`ALTER SCHEMA ${schema} OWNER TO ${ddl}`);
  if (!(await db.query('SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname=$1 AND r.rolname=$2', [schema, ddl])).rows.length) throw new Error('Plugin schema owner mismatch');
  await db.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC, ${runtime}`);
  await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtime}`);
  await db.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtime}`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ddl} IN SCHEMA ${schema} GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${runtime}`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ddl} IN SCHEMA ${schema} GRANT USAGE,SELECT ON SEQUENCES TO ${runtime}`);
  const owner = (await db.query<{
    name: string;
  }>('SELECT current_user AS name')).rows[0]!.name;
  if (!/^[a-z_][a-z0-9_]*$/.test(owner)) throw new Error('Unsupported database owner identifier');
  await db.query(`GRANT ${runtime}, ${ddl} TO ${owner} WITH INHERIT FALSE, SET TRUE`);
}
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
/** Offline only: restores no-owner/no-acl dumps for operation packages, never legacy public tables. */
export async function reconcilePluginRole(db: Queryable, id: string): Promise<void> {
  await provisionPluginRoles(db, id, true);
  const {
    schema,
    runtime,
    ddl
  } = pluginRoleNames(id);
  const foreign = (await db.query('SELECT 1 FROM information_schema.role_table_grants WHERE grantee=$1 AND table_schema<>$2 LIMIT 1', [runtime, schema])).rows;
  if (foreign.length) throw new Error('Plugin runtime has foreign table privileges');
  const relations = (await db.query<{
    relname: string;
    relkind: string;
  }>('SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind::text=ANY($2::text[])', [schema, ['r', 'p', 'v', 'm', 'S']])).rows;
  for (const r of relations) {
    const kind = r.relkind === 'S' ? 'SEQUENCE' : r.relkind === 'v' ? 'VIEW' : r.relkind === 'm' ? 'MATERIALIZED VIEW' : 'TABLE';
    await db.query(`ALTER ${kind} ${quote(schema)}.${quote(r.relname)} OWNER TO ${ddl}`);
  }
  const types = (await db.query<{
    name: string;
    kind: string;
  }>("SELECT t.typname AS name,CASE WHEN t.typtype='d' THEN 'DOMAIN' ELSE 'TYPE' END AS kind FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_class c ON c.oid=t.typrelid WHERE n.nspname=$1 AND (t.typtype IN ('e','d','r','m') OR (t.typtype='c' AND c.relkind='c'))", [schema])).rows;
  for (const t of types) await db.query(`ALTER ${t.kind} ${quote(schema)}.${quote(t.name)} OWNER TO ${ddl}`);
  const routines = (await db.query<{
    signature: string;
    kind: string;
  }>("SELECT format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS signature,CASE WHEN p.prokind='p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS kind FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prokind IN ('f','p')", [schema])).rows;
  for (const r of routines) {
    await db.query(`ALTER ${r.kind} ${r.signature} OWNER TO ${ddl}`);
    await db.query(`REVOKE ALL ON ${r.kind} ${r.signature} FROM PUBLIC`);
    await db.query(`GRANT EXECUTE ON ${r.kind} ${r.signature} TO ${runtime}`);
  }
  await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC, ${runtime}`);
  await db.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC, ${runtime}`);
  await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtime}`);
  await db.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtime}`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ddl} IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM PUBLIC,${runtime}`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ddl} IN SCHEMA ${schema} GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${runtime}`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ddl} IN SCHEMA ${schema} REVOKE ALL ON SEQUENCES FROM PUBLIC,${runtime}`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ddl} IN SCHEMA ${schema} GRANT USAGE,SELECT ON SEQUENCES TO ${runtime}`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ddl} IN SCHEMA ${schema} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ddl} IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${runtime}`);
}
export async function assertPluginRuntimeRole(db: Queryable, id: string) {
  const {
    runtime
  } = pluginRoleNames(id);
  const row = (await db.query<{
    safe: boolean;
  }>(`SELECT NOT rolcanlogin AND NOT rolreplication AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AND NOT rolinherit AS safe FROM pg_roles WHERE rolname=$1`, [runtime])).rows[0];
  if (!row?.safe || (await db.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1', [runtime])).rows.length) throw new Error('Unsafe plugin runtime role');
}
