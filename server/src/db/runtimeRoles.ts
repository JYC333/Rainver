import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { Queryable } from "../modules/routeUtils/common.js";

/**
 * Runtime database role separation (ADR 0031).
 *
 * The bootstrap owner (the Compose `POSTGRES_USER`) keeps schema ownership and
 * is used only by explicit offline commands: migrations, plugin install and
 * reconcile, restore and this reconciler. The application connects as a
 * LOGIN role with no ownership and no role/database/replication/RLS-bypass
 * attributes; backups use a separate read-only role. Everything here is an
 * explicit offline primitive — never a server start, activation or HTTP side
 * effect — and it never changes ownership of existing objects (no REASSIGN).
 */
export const DEFAULT_APP_ROLE = "rainver_app";
export const DEFAULT_BACKUP_ROLE = "rainver_backup";
const MIGRATIONS_TABLE = "server_schema_migrations";
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

function ident(name: string, label: string): string {
  if (!IDENT.test(name)) throw new Error(`${label} must be a lowercase PostgreSQL identifier`);
  return name;
}

/** SCRAM-SHA-256 verifier computed client-side: the plaintext password never reaches the server or its statement log. */
export function scramVerifier(password: string, iterations = 4096, salt = randomBytes(16)): string {
  if (password.length < 16) throw new Error("Database role passwords must be at least 16 characters");
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export interface RuntimeRoleOptions {
  appRole?: string;
  backupRole?: string;
  /** Set or rotate a password; omitted keeps the existing one (or none for a new role, which then cannot log in until set). */
  appPassword?: string;
  backupPassword?: string;
}

export interface RoleState {
  role: string;
  exists: boolean;
  safe: boolean;
  can_login: boolean;
  owns_objects: number;
  /** Effective privileges beyond the role's target; reconcile and startup refuse while any remain. */
  exceeds?: string[];
}

/**
 * How many objects a role owns — the one ownership fact reconcile, startup and
 * SECURITY DEFINER owner judgement all use. An owner can ALTER, DROP or re-GRANT
 * what it owns whatever was granted or revoked, so the database, every schema,
 * relation, standalone type (implicit array types follow their element) and
 * large object counts, in any schema, and `functions` adds functions for a
 * runtime role (a definer owner necessarily owns its own function and is judged
 * by what depends on it instead). Session-temporary schemas are excluded: the
 * app role holds TEMPORARY, and a concurrent session's temp tables vanish with
 * that session and confer no lasting ownership.
 */
function ownedObjects(roleOid: string, functions: boolean): string {
  const lasting = "n.nspname !~ '^pg_(toast_)?temp_'";
  return `((SELECT count(*) FROM pg_database d WHERE d.datdba = ${roleOid})
      + (SELECT count(*) FROM pg_namespace n WHERE n.nspowner = ${roleOid} AND ${lasting})
      + (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relowner = ${roleOid} AND ${lasting})
      + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typowner = ${roleOid} AND t.typrelid = 0 AND ${lasting}
           AND NOT EXISTS (SELECT 1 FROM pg_type e WHERE e.typarray = t.oid))
      + (SELECT count(*) FROM pg_largeobject_metadata l WHERE l.lomowner = ${roleOid})${functions ? `
      + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proowner = ${roleOid} AND ${lasting})` : ""})`;
}

async function roleState(db: Queryable, role: string, inherit: boolean): Promise<RoleState> {
  const row = (await db.query<{ rolcanlogin: boolean; safe: boolean; owned: string }>(
    `SELECT r.rolcanlogin,
            NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls AND r.rolinherit = $2 AS safe,
            ${ownedObjects("r.oid", true)} AS owned
       FROM pg_roles r WHERE r.rolname = $1`, [role, inherit])).rows[0];
  return row ? { role, exists: true, safe: row.safe, can_login: row.rolcanlogin, owns_objects: Number(row.owned) } : { role, exists: false, safe: false, can_login: false, owns_objects: 0 };
}

const PLUGIN_RUNTIME = /^rainver_plugin_[a-z][a-z0-9_]{0,23}$/;
const SYSTEM_SCHEMA = `n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`;

/**
 * Everything an app or backup role can *effectively* do beyond its target
 * (ADR 0031), read from the catalogs through PostgreSQL's own privilege
 * functions, so inherited memberships, PUBLIC and default privileges count:
 * database ownership or CREATE, CREATE on any schema, any membership other
 * than the reviewed ones (transitively), table/sequence rights beyond the
 * role's, a writable migration journal, callable SECURITY DEFINER functions
 * whose owner is not provably within the same target, and default privileges
 * (direct, PUBLIC or inherited) that would hand it more on future objects.
 * Empty means the role is exactly within its target.
 * Nothing here changes a privilege.
 */
export async function runtimeRoleSuperset(db: Queryable, role: string, kind: "app" | "backup"): Promise<string[]> {
  return roleSuperset(db, role, kind, [role]);
}

/** How deep a chain of SECURITY DEFINER owners is followed before it is refused as unprovable. */
const MAX_DEFINER_DEPTH = 4;

async function roleSuperset(db: Queryable, role: string, kind: "app" | "backup", chain: readonly string[]): Promise<string[]> {
  const findings: string[] = [];
  const rows = async <T>(sql: string) => (await db.query<T>(sql, [role])).rows;
  const target = "(SELECT oid FROM pg_roles WHERE rolname = $1)";
  for (const d of await rows<{ owner: boolean; create: boolean }>(`SELECT d.datdba = ${target} AS owner, has_database_privilege(${target}, d.oid, 'CREATE') AS create FROM pg_database d WHERE d.datname = current_database()`)) {
    if (d.owner) findings.push("owns the database");
    if (d.create) findings.push("can CREATE schemas in the database");
  }
  for (const n of await rows<{ nspname: string; owner: boolean }>(`SELECT n.nspname, n.nspowner = ${target} AS owner FROM pg_namespace n WHERE ${SYSTEM_SCHEMA} AND (n.nspowner = ${target} OR has_schema_privilege(${target}, n.oid, 'CREATE')) ORDER BY 1`)) findings.push(`${n.owner ? "owns" : "can CREATE in"} schema ${n.nspname}`);
  // Only a direct, reviewed membership passes; every indirect one (depth >= 2)
  // is a finding. The depth cap only stops membership cycles: a chain of any
  // length is already reported at its second level, so the cap hides nothing.
  for (const m of await rows<{ parent: string; inherit: boolean; set: boolean; admin: boolean; depth: number }>(`WITH RECURSIVE m AS (
      SELECT roleid, inherit_option, set_option, admin_option, 1 AS depth FROM pg_auth_members WHERE member = ${target}
      UNION ALL SELECT a.roleid, a.inherit_option, a.set_option, a.admin_option, m.depth + 1 FROM pg_auth_members a JOIN m ON a.member = m.roleid WHERE m.depth < 16)
    SELECT p.rolname AS parent, m.inherit_option AS inherit, m.set_option AS set, m.admin_option AS admin, m.depth FROM m JOIN pg_roles p ON p.oid = m.roleid ORDER BY 1`)) {
    const reviewed = m.depth === 1 && !m.admin && (kind === "backup"
      ? m.parent === "pg_read_all_data" && m.inherit
      : PLUGIN_RUNTIME.test(m.parent) && !m.parent.endsWith("_ddl") && !m.inherit && m.set);
    if (!reviewed) findings.push(`member of ${m.parent}${m.depth > 1 ? " (indirectly)" : ""}${m.admin ? " with ADMIN" : ""}${m.inherit ? " with INHERIT" : ""}`);
  }
  // Tables: the app writes public tables (never the journal) and nothing else directly; the backup only reads.
  const tablePrivileges = kind === "backup" ? "INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER" : "TRUNCATE,REFERENCES,TRIGGER";
  for (const t of await rows<{ name: string; privilege: string }>(`SELECT n.nspname || '.' || c.relname AS name, p.privilege FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(string_to_array('${tablePrivileges}', ',')) AS p(privilege)
     WHERE c.relkind IN ('r','p','v','m','f') AND ${SYSTEM_SCHEMA} AND has_table_privilege(${target}, c.oid, p.privilege) ORDER BY 1, 2 LIMIT 20`)) findings.push(`${t.privilege} on ${t.name}`);
  if (kind === "app") {
    for (const t of await rows<{ name: string; privilege: string }>(`SELECT n.nspname || '.' || c.relname AS name, p.privilege FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)
       WHERE c.relkind IN ('r','p','v','m','f') AND ${SYSTEM_SCHEMA} AND n.nspname <> 'public' AND has_table_privilege(${target}, c.oid, p.privilege) ORDER BY 1, 2 LIMIT 20`)) findings.push(`${t.privilege} on ${t.name} without SET ROLE`);
    for (const t of await rows<{ privilege: string }>(`SELECT p.privilege FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) AS p(privilege)
       WHERE to_regclass('public.${MIGRATIONS_TABLE}') IS NOT NULL AND has_table_privilege(${target}, 'public.${MIGRATIONS_TABLE}', p.privilege)`)) findings.push(`${t.privilege} on the migration journal`);
  }
  const sequencePrivileges = kind === "backup" ? "USAGE,UPDATE" : "";
  if (sequencePrivileges) for (const q of await rows<{ name: string; privilege: string }>(`SELECT n.nspname || '.' || c.relname AS name, p.privilege FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(string_to_array('${sequencePrivileges}', ',')) AS p(privilege)
     WHERE c.relkind = 'S' AND ${SYSTEM_SCHEMA} AND has_sequence_privilege(${target}, c.oid, p.privilege) ORDER BY 1, 2 LIMIT 20`)) findings.push(`${q.privilege} on sequence ${q.name}`);
  // SECURITY DEFINER functions the role can actually call (EXECUTE and USAGE on
  // their schema, directly, through PUBLIC or an inherited role) run with their
  // owner's rights. Whether that is an escalation depends on what the owner can
  // do, not on its role attributes: an ordinary role that owns a table can
  // TRUNCATE or ALTER it, and one granted the journal can write it. So each
  // owner is judged by its own ownership and effective privileges against the
  // same target; an owner that cannot be resolved or proven fails closed.
  // Every callable definer is judged (no LIMIT: an unjudged one would pass);
  // only the reported list is capped.
  const definers = new Map<string, string[]>();
  let escalating = 0;
  for (const f of await rows<{ name: string; owner: string | null }>(`SELECT n.nspname || '.' || p.proname AS name, o.rolname AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace LEFT JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.prosecdef AND ${SYSTEM_SCHEMA} AND has_function_privilege(${target}, p.oid, 'EXECUTE') AND has_schema_privilege(${target}, n.oid, 'USAGE') ORDER BY 1`)) {
    if (f.owner === role) continue;
    let reasons = f.owner ? definers.get(f.owner) : ["has no resolvable owner"];
    if (!reasons) {
      reasons = await definerExceeds(db, f.owner!, kind, chain);
      definers.set(f.owner!, reasons);
    }
    if (!reasons.length) continue;
    if (++escalating <= 20) findings.push(`EXECUTE on SECURITY DEFINER function ${f.name} (owner ${f.owner ?? "unknown"} ${reasons[0]})`);
  }
  if (escalating > 20) findings.push(`EXECUTE on ${escalating - 20} more SECURITY DEFINER function(s) whose owner exceeds the target`);
  // Default privileges: the app may receive DML on future public tables and
  // sequence use, nothing else. A default grant reaches the role directly,
  // through PUBLIC, or through any role whose privileges it inherits; all
  // three are what the role will hold on an object created later. PUBLIC's own
  // built-in defaults (EXECUTE on functions, USAGE on types) are what any new
  // object carries anyway, and a callable SECURITY DEFINER is judged above.
  for (const a of await rows<{ objtype: string; schema: string | null; privilege: string; grantee: string }>(`SELECT d.defaclobjtype AS objtype, n.nspname AS schema, x.privilege_type AS privilege,
            CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid = x.grantee) END AS grantee
       FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) x
      WHERE CASE WHEN x.grantee = 0 THEN true ELSE pg_has_role(${target}, x.grantee, 'USAGE') END ORDER BY 1, 2, 3, 4`)) {
    const publicBuiltIn = a.grantee === "PUBLIC" && ((a.objtype === "f" && a.privilege === "EXECUTE") || (a.objtype === "T" && a.privilege === "USAGE"));
    const allowed = publicBuiltIn || (kind === "app" && a.schema === "public" && (a.objtype === "r" ? ["SELECT", "INSERT", "UPDATE", "DELETE"] : a.objtype === "S" ? ["SELECT", "UPDATE", "USAGE"] : []).includes(a.privilege));
    if (!allowed) findings.push(`default ${a.privilege} on future ${{ r: "tables", S: "sequences", f: "functions", T: "types", n: "schemas" }[a.objtype] ?? a.objtype}${a.schema ? ` in ${a.schema}` : ""}${a.grantee === role ? "" : a.grantee === "PUBLIC" ? " to PUBLIC" : ` through ${a.grantee}`}`);
  }
  return findings;
}

/**
 * Why a SECURITY DEFINER owner can do more than `kind`'s target — empty only
 * when it provably cannot. The owner must carry no role attribute, own no
 * database, schema, relation, type or large object (an owner can always
 * TRUNCATE, ALTER or DROP what it owns, whatever was granted), own no function
 * another object depends on (DROP ... CASCADE would take a trigger, default or
 * view with it), and hold no effective privilege beyond the same target —
 * including through its own callable definers, followed to a bounded depth.
 */
async function definerExceeds(db: Queryable, owner: string, kind: "app" | "backup", chain: readonly string[]): Promise<string[]> {
  if (chain.includes(owner)) return [`reaches itself through a SECURITY DEFINER chain`];
  if (chain.length >= MAX_DEFINER_DEPTH) return ["is behind too long a SECURITY DEFINER chain to prove"];
  const row = (await db.query<{ attributes: boolean; owned: string; depended: string }>(
    `SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls AS attributes,
            ${ownedObjects("r.oid", false)} AS owned,
            (SELECT count(*) FROM pg_proc p JOIN pg_depend d ON d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid AND d.deptype = 'n'
              WHERE p.proowner = r.oid) AS depended
       FROM pg_roles r WHERE r.rolname = $1`, [owner])).rows[0];
  if (!row) return ["cannot be resolved"];
  if (row.attributes) return ["has role attributes beyond a runtime role"];
  if (Number(row.owned) > 0) return [`owns ${row.owned} database object(s)`];
  if (Number(row.depended) > 0) return ["owns a function other objects depend on"];
  return (await roleSuperset(db, owner, kind, [...chain, owner])).map((reason) => `can ${reason}`);
}

/**
 * The migration journal is the owner's: after `migrate up` creates or touches
 * it, an already provisioned app role keeps read-only access even when default
 * privileges (granted when the roles were reconciled before the first
 * migration) handed it DML. Declared target state, not a blind revoke.
 */
export async function protectMigrationJournal(db: Queryable, appRole: string = DEFAULT_APP_ROLE): Promise<boolean> {
  const app = ident(appRole, "app role");
  const present = (await db.query<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AND to_regclass($2) IS NOT NULL AS ok`, [app, `public.${MIGRATIONS_TABLE}`])).rows[0]?.ok;
  if (!present) return false;
  await db.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.${MIGRATIONS_TABLE} FROM ${app}`);
  return true;
}

/** Read-only inventory for `plan`; reports roles and the connected identity, never secrets. */
export async function inspectRuntimeRoles(db: Queryable, options: RuntimeRoleOptions = {}) {
  const app = ident(options.appRole ?? DEFAULT_APP_ROLE, "app role"), backup = ident(options.backupRole ?? DEFAULT_BACKUP_ROLE, "backup role");
  const current = (await db.query<{ name: string; superuser: boolean }>(`SELECT current_user AS name, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`)).rows[0]!;
  const withFindings = async (role: string, kind: "app" | "backup", inherit: boolean) => {
    const state = await roleState(db, role, inherit);
    return state.exists ? { ...state, exceeds: await runtimeRoleSuperset(db, role, kind) } : state;
  };
  return { connected_as: current.name, connected_superuser: current.superuser, app: await withFindings(app, "app", false), backup: await withFindings(backup, "backup", true) };
}

/**
 * Create or repair the runtime and backup roles and their grants. Must run on
 * the owner channel inside one transaction. Idempotent; fails closed on an
 * existing role with unsafe attributes or owned objects instead of
 * reassigning anything.
 */
export async function reconcileRuntimeRoles(db: Queryable, options: RuntimeRoleOptions = {}): Promise<{ app: RoleState; backup: RoleState; plugin_roles: string[] }> {
  const app = ident(options.appRole ?? DEFAULT_APP_ROLE, "app role"), backup = ident(options.backupRole ?? DEFAULT_BACKUP_ROLE, "backup role");
  if (app === backup) throw new Error("App and backup roles must differ");
  const owner = (await db.query<{ name: string; database: string; can: boolean }>(
    `SELECT current_user AS name, current_database() AS database, (rolsuper OR rolcreaterole) AS can FROM pg_roles WHERE rolname = current_user`)).rows[0]!;
  if (!owner.can) throw new Error("Runtime role reconcile requires the bootstrap owner channel");
  if (owner.name === app || owner.name === backup) throw new Error("The owner channel cannot be the runtime or backup role");
  ident(owner.name, "owner role");
  const database = owner.database.replaceAll('"', '""');
  await db.query("SELECT pg_advisory_xact_lock(hashtext('rainver.runtime_roles'))");
  for (const [role, inherit] of [[app, false], [backup, true]] as const) {
    await db.query(`DO $r$ BEGIN CREATE ROLE ${role} LOGIN ${inherit ? "INHERIT" : "NOINHERIT"} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $r$`);
    const state = await roleState(db, role, inherit);
    if (!state.safe) throw new Error(`Existing role ${role} has unsafe attributes; repair it explicitly before reconcile`);
    if (state.owns_objects > 0) throw new Error(`Existing role ${role} owns database objects; it must own none`);
    // A role that can already do more than its target is refused, never trimmed: no REASSIGN and no revoke of a grant this reconciler did not make.
    const exceeds = await runtimeRoleSuperset(db, role, role === backup ? "backup" : "app");
    if (exceeds.length) throw new Error(`Existing role ${role} exceeds its runtime privileges (${exceeds.slice(0, 8).join("; ")}); repair it explicitly before reconcile`);
  }
  if (options.appPassword) await db.query(`ALTER ROLE ${app} PASSWORD '${scramVerifier(options.appPassword)}'`);
  if (options.backupPassword) await db.query(`ALTER ROLE ${backup} PASSWORD '${scramVerifier(options.backupPassword)}'`);
  await db.query(`GRANT CONNECT, TEMPORARY ON DATABASE "${database}" TO ${app}`);
  await db.query(`GRANT CONNECT ON DATABASE "${database}" TO ${backup}`);
  await db.query(`GRANT pg_read_all_data TO ${backup}`);
  // Core schema: data access only, never DDL; future owner-created objects follow by default privileges.
  await db.query(`REVOKE CREATE ON SCHEMA public FROM ${app}, ${backup}`);
  await db.query(`GRANT USAGE ON SCHEMA public TO ${app}`);
  await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app}`);
  await db.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${app}`);
  await db.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${app}`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner.name} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner.name} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${app}`);
  // The migration journal is the owner's: the application may read it, never record or rewrite a migration.
  await protectMigrationJournal(db, app);
  const plugins = await grantPluginRuntimeMemberships(db, app);
  return { app: await roleState(db, app, false), backup: await roleState(db, backup, true), plugin_roles: plugins };
}

/** Operation-plugin runtime roles: SET without inheritance, exactly like the host's own; never a DDL role. */
export async function grantPluginRuntimeMemberships(db: Queryable, appRole: string = DEFAULT_APP_ROLE): Promise<string[]> {
  const app = ident(appRole, "app role");
  if (!(await db.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [app])).rows.length) return [];
  const roles = (await db.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname ~ '^rainver_plugin_[a-z][a-z0-9_]{0,23}$' AND rolname !~ '_ddl$' ORDER BY rolname`)).rows.map(r => r.rolname);
  for (const role of roles) await db.query(`GRANT ${role} TO ${app} WITH INHERIT FALSE, SET TRUE`);
  return roles;
}

/**
 * Startup admission for an activated instance: the connected role must be the
 * least-privilege runtime role — no ownership or role attributes and nothing
 * beyond the app target (a writable journal, CREATE, extra memberships or
 * default privileges are drift and refuse the start).
 */
export async function assertLeastPrivilegeRuntimeRole(db: Queryable): Promise<void> {
  const row = (await db.query<{ unsafe: boolean; owns: boolean; name: string }>(
    `SELECT r.rolname AS name, r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls AS unsafe,
            ${ownedObjects("r.oid", true)} > 0 AS owns
       FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
  if (!row || row.unsafe || row.owns) throw new Error(`Database role ${row?.name ?? "?"} is not a least-privilege runtime role (RAINVER_DB_REQUIRE_RUNTIME_ROLE=1)`);
  const exceeds = await runtimeRoleSuperset(db, row.name, "app");
  if (exceeds.length) throw new Error(`Database role ${row.name} is not a least-privilege runtime role: ${exceeds.slice(0, 8).join("; ")} (RAINVER_DB_REQUIRE_RUNTIME_ROLE=1)`);
}
