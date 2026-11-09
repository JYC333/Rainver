import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject} from './support/domainSeeds.js';
import {createLifecycleProbe} from './fixtures/pluginOperation/lifecycleRuntime.js';
import {reconcileOperationPlugins, migrateOperationPlugin} from '../src/modules/plugins/operationMigrations.js';
import {withTransaction} from '../src/db/tx.js';
import {operationTransaction} from '../src/db/operationTransaction.js';
import {withPluginDb} from '../src/modules/plugins/operationDb.js';
import {sessionActor} from '../src/modules/systemActions/operations/actor.js';
const db=useTestDatabase(import.meta.filename,{max:1});
const plugin=createLifecycleProbe(),space=randomUUID(),user=randomUUID();
  it('denies session residues and reuses the same backend safely across two people', async () => {
    await seedSpaceOwnerProject(db.pool,{space,owner:user,project:randomUUID()});
    await migrateOperationPlugin(db.pool,plugin);
    const pool = db.pool;
    let pid: number;
    let originalApp: string;
    try {
      await withTransaction(pool, async tx => {
        pid = (await tx.query('SELECT pg_backend_pid() AS id')).rows[0].id;
        originalApp = (await tx.query("SELECT current_setting('application_name') AS v")).rows[0].v;
        // Prove these are valid PostgreSQL statements, not merely guard-rejected pseudo-SQL.
        await tx.query('SAVEPOINT syntax_probe');
        for (const alias of ['insert', 'update', 'delete', '"insert"', '中文', 'x$as', '中文$as$', '"中文"']) {
          await tx.query(`SELECT 1 AS ${alias} INTO TEMP leak`);
          await tx.query('DROP TABLE pg_temp.leak');
        }
        await tx.query('EXPLAIN ANALYZE CREATE TEMP TABLE leak AS SELECT 1 AS v');
        await tx.query('DROP TABLE pg_temp.leak');
        const sessionControls = [
          `UPDATE pg_settings SET setting='plugin-residue' WHERE name='application_name'`,
          `UPDATE pg_catalog."pg_settings" SET setting='plugin-residue' WHERE name='application_name'`,
          String.raw`SELECT pg_catalog.U&"set\005fconfig"('application_name','plugin-residue',false)`,
          String.raw`SELECT pg_catalog.U&"set!005fconfig" UESCAPE '!'('application_name','plugin-residue',false)`,
          `SELECT query_to_xml($sql$SELECT set_config('application_name','plugin-residue',false)$sql$,true,false,'')`,
          `SELECT * FROM ts_stat($sql$SELECT to_tsvector(set_config('application_name','plugin-residue',false))$sql$)`,
          `SELECT ts_rewrite('probe'::tsquery,$sql$SELECT 'probe'::tsquery,'safe'::tsquery WHERE set_config('application_name','plugin-residue',false) IS NOT NULL$sql$)`,
        ];
        for (const sql of sessionControls) {
          await tx.query(sql);
          expect((await tx.query("SELECT current_setting('application_name') AS v")).rows[0].v).toBe('plugin-residue');
        }
        const lockControls = [
          'SELECT pg_try_advisory_lock(123)',
          'SELECT pg_try_advisory_lock_shared(123)',
          String.raw`SELECT pg_catalog.U&"pg\005fadvisory\005flock"(123)`,
        ];
        try {
          for (const sql of lockControls) await tx.query(sql);
          expect(Number((await tx.query("SELECT count(*) AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'")).rows[0].n)).toBeGreaterThan(0);
        } finally {
          await tx.query('SELECT pg_advisory_unlock_all()');
        }
        await tx.query('ROLLBACK TO SAVEPOINT syntax_probe');
        await tx.query('RELEASE SAVEPOINT syntax_probe');
        const port = operationTransaction(tx);
        try {
          await withPluginDb(port.db, plugin.id, sessionActor({
            spaceId: space,
            userId: user
          }), async scoped => {
            for (const sql of [
              'EXPLAIN ANALYZE CREATE TEMP TABLE leak AS SELECT 1 AS v',
              'EXPLAIN (ANALYZE true) CREATE TEMP TABLE leak AS SELECT 1 AS v',
              ...sessionControls,
              ...lockControls,
              'SELECT setseed(0.5)',
              'SELECT pg_catalog."setseed"(0.5)',
              `WITH settings AS (UPDATE pg_settings SET setting='on' WHERE name='default_transaction_read_only') SELECT 1`,
              `UPDATE pg_catalog.pg_settings SET setting='plugin_operation_probe,public' WHERE name='search_path'`,
              `SELECT lo_from_bytea(0,decode('78','hex'))`,
              `SELECT lo_create(0)`,
              `SELECT pg_catalog."lo_put"(1,0,decode('78','hex'))`,
              `SELECT lowrite(1,decode('78','hex'))`,
              `SELECT query_to_xmlschema('SELECT 1',true,false,'')`,
              `SELECT query_to_xml_and_xmlschema('SELECT 1',true,false,'')`,
            ]) await expect(scoped.query(sql)).rejects.toThrow(/refused/);
            expect((await scoped.query('SELECT 1 AS lo_limit, 2 AS "lo_create", 3 AS "lo_from_bytea"')).rows[0]).toEqual({lo_limit:1,lo_create:2,lo_from_bytea:3});
            expect((await scoped.query('SELECT lo_limit FROM (VALUES (7)) AS limits(lo_limit)')).rows[0]).toEqual({lo_limit:7});
            expect((await scoped.query("SELECT 'lo_create(0)' AS example")).rows[0]).toEqual({example:'lo_create(0)'});
            expect((await scoped.query("SELECT current_setting('rainver.user_id') AS person,current_setting('application_name') AS app")).rows[0]).toEqual({person:user,app:originalApp});
            expect((await scoped.query(`SELECT 'U&"set\\005fconfig"; query_to_xml' AS example`)).rows[0].example).toContain('query_to_xml');
            await scoped.query("WITH value AS (SELECT 'safe' AS v) INSERT INTO records(space_id,user_id,key,value) SELECT current_setting('rainver.space_id'),current_setting('rainver.user_id'),'cte',v FROM value");
            expect((await scoped.query('SELECT 1 AS "into", 2 AS "select"')).rows[0]).toEqual({into:1,select:2});
            expect((await scoped.query('SELECT 1 AS into')).rows[0]).toEqual({into:1});
            expect((await scoped.query("SELECT 'ok' AS 中文, 'safe' AS x$as, 3 AS 中文$as$")).rows[0]).toEqual({'中文':'ok','x$as':'safe','中文$as$':3});
            await scoped.query("WITH 中文 AS /* AS into */ (SELECT 'safe' AS x$as) INSERT INTO records(space_id,user_id,key,value) SELECT current_setting('rainver.space_id'),current_setting('rainver.user_id'),'unicode',x$as FROM 中文");
            expect((await scoped.query('SELECT $中文$AS INTO TEMP leak$中文$ AS x$as')).rows[0]).toEqual({'x$as':'AS INTO TEMP leak'});
            for (const alias of ['中文','x$as','中文$as$','"中文"']) {
              await expect(scoped.query(`SELECT $中文$private$中文$ AS ${alias} INTO TEMP leak`)).rejects.toThrow('SELECT INTO refused');
              await expect(scoped.query(`SELECT 'AS insert INTO' AS /* comment */ ${alias} INTO TEMPORARY leak`)).rejects.toThrow('SELECT INTO refused');
            }
            for (const sql of ['SELECT 1 AS insert INTO TEMP leak', 'SELECT 1 AS update INTO TEMP leak', 'SELECT 1 AS delete INTO TEMP leak', 'SELECT 1 AS "insert" INTO TEMP leak', 'SELECT 1 INTO TEMP leak', 'SELECT 1 INTO TEMPORARY leak', 'SELECT (SELECT 1) INTO TEMP leak', 'LISTEN leak', 'PREPARE leak AS SELECT 1', 'DECLARE leak CURSOR WITH HOLD FOR SELECT 1']) await expect(scoped.query(sql)).rejects.toThrow();
          });
        } finally {
          port.close();
        }
      });
      await reconcileOperationPlugins(db.pool,[plugin]);
      const nextUser = randomUUID();
      await withTransaction(pool, async tx => {
        expect((await tx.query('SELECT pg_backend_pid() AS id')).rows[0].id).toBe(pid!);
        const port = operationTransaction(tx);
        try {
          await withPluginDb(port.db, plugin.id, sessionActor({
            spaceId: space,
            userId: nextUser
          }), async scoped => {
            expect((await scoped.query("SELECT to_regclass('pg_temp.leak') AS temp")).rows[0]).toEqual({temp:null});
            await expect(scoped.transaction({spaceId:space,userId:nextUser}, nested=>nested.query('SELECT * FROM pg_temp.leak'))).rejects.toMatchObject({code:'42P01'});
          });
        } finally {
          port.close();
        }
        expect((await tx.query("SELECT to_regclass('pg_temp.leak') AS temp,(SELECT count(*) FROM pg_prepared_statements WHERE name='leak') AS prepared,(SELECT count(*) FROM pg_cursors WHERE name='leak') AS cursors,(SELECT count(*) FROM pg_listening_channels()) AS listeners")).rows[0]).toMatchObject({
          temp: null,
          prepared: '0',
          cursors: '0',
          listeners: '0'
        });
        expect((await tx.query("SELECT count(*) AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n).toBe('0');
      });
    } finally {
      // Shared fixture owns teardown.
    }
  });
