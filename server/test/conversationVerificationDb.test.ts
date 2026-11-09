import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedRun, seedSpaceOwnerProject } from './support/domainSeeds.js';
import { PgRunRepository } from '../src/modules/runs/repository.js';
import { PgVerificationEngine, verifyTaskWorkspace } from '../src/modules/runs/verification/engine.js';
import { PgVerificationRepository } from '../src/modules/runs/verification/repository.js';

const db = useTestDatabase(import.meta.filename);
const space = randomUUID(), owner = randomUUID(), project = randomUUID(), folder = randomUUID();
const runId = randomUUID(), agent = randomUUID(), version = randomUUID(), recipe = randomUUID();

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ['spaces', 'users'], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space, owner, project });
  await seedRun(db.pool, { id: runId, space, owner, agent, version });
  await db.pool.query(`INSERT INTO project_folders (id,space_id,project_id,name,status,kind,protected,system_managed,created_at,updated_at)
    VALUES ($1,$2,$3,'Folder','active','code',false,false,now(),now())`, [folder, space, project]);
  await db.pool.query(`INSERT INTO project_folder_execution_configs (id,space_id,project_folder_id,test_commands_json,build_commands_json,forbidden_paths_json,created_at,updated_at)
    VALUES ($1,$2,$3,'["pnpm test","pnpm lint","pnpm test:unit"]','["pnpm build","pnpm typecheck"]','["secrets/**"]',now(),now())`, [randomUUID(), space, folder]);
  await db.pool.query(`INSERT INTO validation_recipes (id,space_id,project_folder_id,name,commands_json,required_checks_json,created_at,updated_at)
    VALUES ($1,$2,$3,'Explicit check','["node --version"]','[]',now(),now())`, [recipe, space, folder]);
  await db.pool.query(`UPDATE runs SET project_id=$2,project_folder_id=$3,model_override_json='{"chat_turn":{"schema_version":"chat_turn.v1"}}' WHERE id=$1`, [runId, project, folder]);
});

it.for(['conversation', 'folder_recipe', 'task', 'explicit_recipe', 'explicit_contract'] as const)(
  'runs only the checks authorized by this kind of work: %s', async (mode, ctx) => {
    if (!db.available) return ctx.skip();
    if (mode === 'task') await db.pool.query("UPDATE runs SET model_override_json='{}' WHERE id=$1", [runId]);
    if (mode === 'folder_recipe') await db.pool.query('UPDATE project_folder_execution_configs SET validation_recipe_id=$2 WHERE project_folder_id=$1', [folder, recipe]);
    const contract = mode === 'explicit_recipe' ? { route_hints_json: { verification_recipe_refs: [recipe] } }
      : mode === 'explicit_contract' ? { acceptance_criteria_json: { checks: [{ type: 'command', command: ['node', '--version'] }] } } : {};
    await db.pool.query('UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1', [runId, contract]);
    const run = (await new PgRunRepository(db.pool).getRun(space, runId))!;
    const commands: string[][] = [];
    const executor = { async run(input: { command: string[] }) {
      commands.push(input.command); return { returncode: 0, stdout: '', stderr: '', timed_out: false };
    } };
    const engine = new PgVerificationEngine(db.pool, undefined, executor);
    const results = await engine.verify({ run, execution_target: { host_id: 'fixture-host' }, base_commit_sha: null, output_json: {}, materialization_items: [] });
    if (mode === 'conversation' || mode === 'folder_recipe') {
      expect(commands).toEqual([]); expect(results).toEqual([]);
      expect((await db.pool.query('SELECT id FROM verification_results WHERE run_id=$1', [runId])).rowCount).toBe(0);
    } else {
      expect(commands).toHaveLength(mode === 'task' ? 5 : 1);
      expect(results.every(result => result.status === 'passed')).toBe(true);
    }
    const plan = await new PgVerificationRepository(db.pool).getPlan(run, { include_folder_defaults: false });
    expect(plan.forbidden_paths).toEqual(['secrets/**']);
    if (mode === 'conversation') {
      commands.length = 0;
      const merge = await verifyTaskWorkspace(new PgVerificationRepository(db.pool), executor, { run, target: { host_id: 'fixture-host' }, base_commit_sha: 'a'.repeat(40) });
      expect(merge.status).toBe('passed'); expect(commands).toHaveLength(5);
    }
  },
);
