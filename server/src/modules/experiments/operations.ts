import { PROJECT_EXECUTION_SCHEMAS, type OperationActor, type RegisteredSystemActionDefinition } from '@rainver/protocol';
import type { Queryable } from '../routeUtils/common.js';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { OperationBusinessError, OperationError, hidden } from '../systemActions/operations/errors.js';
import { assertProjectWriter, assertProjectWriterForMutation, lockActiveProjectForMutation, ProjectArchivedMutationError } from '../projects/access.js';
import { contentReadSql } from '../access/contentAccessSql.js';
import { threadReadableSql } from '../inquiry/threadAccess.js';
import { canReadAgent } from '../agents/agentAccess.js';
import { ExperimentDefinitionService } from './definitionService.js';
import { ExperimentRunService } from './runService.js';
import { ExperimentInterpretationService } from './interpretationService.js';
import { ExperimentMutationError } from './operationErrors.js';

type Input = {
  project_id: string; definition_id?: string; version_id?: string; experiment_run_id?: string;
  interpretation_id?: string; primary_hypothesis_thread_id?: string | null; agent_id?: string;
  run_id?: string | null; artifact_ids?: string[]; run_ids?: string[];
  config?: { project_folder_id?: string };
};
const person = (actor: OperationActor) => ({ spaceId: actor.space_id, userId: actor.on_behalf_of_user_id! });

async function definitionId(db: Queryable, input: Input, actor: OperationActor): Promise<string | null> {
  if (!input.interpretation_id) return input.definition_id ?? null;
  const row = (await db.query<{ definition_id: string }>(
    'SELECT definition_id FROM experiment_interpretations WHERE id=$1 AND space_id=$2 AND project_id=$3',
    [input.interpretation_id, actor.space_id, input.project_id],
  )).rows[0];
  if (!row) throw hidden();
  return row.definition_id;
}

export function experimentRegistrations(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration[] {
  return Object.keys(PROJECT_EXECUTION_SCHEMAS).filter(id => id.startsWith('experiment.')).map(id => ({
    definition: definitions.get(id)!,
    successStatus: id === 'experiment.run.launch' ? 202 : ['experiment.definition.create', 'experiment.version.create', 'experiment.run.create', 'experiment.observation.record', 'experiment.interpretation.create', 'experiment.interpretation.convert'].includes(id) ? 201 : 200,
    async resolve(db, raw, actor) {
      const input = raw as Input;
      return { authority: `project:${input.project_id}`, targets: { project_id: input.project_id, definition_id: await definitionId(db, input, actor) }, resourceType: 'project', resourceId: input.project_id };
    },
    async authorize(db, raw, actor, scope) {
      const input = raw as Input, identity = person(actor);
      await assertProjectWriter(db, actor.space_id, input.project_id, identity.userId, { allowArchived: true });
      try { await lockActiveProjectForMutation(db, actor.space_id, input.project_id); }
      catch (error) { if (error instanceof ProjectArchivedMutationError) throw new OperationError('operation_conflict', 409, false, 'experiments'); throw error; }
      await assertProjectWriterForMutation(db, actor.space_id, input.project_id, identity.userId);
      const targetDefinition = (scope.targets as { definition_id: string | null }).definition_id;
      if (targetDefinition !== await definitionId(db, input, actor)) throw new OperationError('operation_conflict', 409);
      const current = targetDefinition ? (await db.query<{ primary_hypothesis_thread_id: string | null }>(
        'SELECT primary_hypothesis_thread_id FROM experiment_definitions WHERE object_id=$1 AND space_id=$2 AND project_id=$3',
        [targetDefinition, actor.space_id, input.project_id],
      )).rows[0] : null;
      if (targetDefinition && !current) throw hidden();
      const threads = [...new Set([input.primary_hypothesis_thread_id, current?.primary_hypothesis_thread_id].filter((value): value is string => !!value))].sort();
      const roots = [...new Set([targetDefinition, ...threads].filter((value): value is string => !!value))].sort();
      if (roots.length) {
        await db.query('SELECT id FROM space_objects WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE', [actor.space_id, roots]);
        await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_id=ANY($2::varchar[]) ORDER BY id FOR SHARE', [actor.space_id, roots]);
      }
      if (targetDefinition) {
        const locked = (await db.query<{ primary_hypothesis_thread_id: string | null }>('SELECT primary_hypothesis_thread_id FROM experiment_definitions WHERE object_id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE', [targetDefinition, actor.space_id, input.project_id])).rows[0];
        if (!locked) throw hidden();
        if (locked.primary_hypothesis_thread_id !== current?.primary_hypothesis_thread_id) throw new OperationError('operation_conflict', 409);
      }
      if (targetDefinition) await new ExperimentDefinitionService(db).requireDefinition(actor.space_id, input.project_id, targetDefinition, identity.userId);
      // Creating/repointing and converting use the stronger Thread change gate.
      const requiredThreads = id === 'experiment.interpretation.convert' ? threads : input.primary_hypothesis_thread_id ? [input.primary_hypothesis_thread_id] : [];
      for (const thread of requiredThreads) {
        if (!(await db.query(`SELECT so.id FROM space_objects so JOIN inquiry_threads t ON t.object_id=so.id AND t.space_id=so.space_id WHERE so.id=$1 AND so.space_id=$2 AND t.project_id=$3 AND t.kind='hypothesis' AND ${threadReadableSql('so', '$4', 'change')}`, [thread, actor.space_id, input.project_id, identity.userId])).rows.length) throw hidden();
      }
      if (input.version_id && !(await db.query('SELECT id FROM experiment_versions WHERE id=$1 AND space_id=$2 AND definition_id=$3 FOR UPDATE', [input.version_id, actor.space_id, targetDefinition])).rows.length) throw hidden();
      const runIds = [...new Set([input.experiment_run_id, ...(input.run_ids ?? [])].filter((value): value is string => !!value))].sort();
      for (const runId of runIds) if (!(await db.query('SELECT r.id FROM experiment_runs r JOIN experiment_versions v ON v.id=r.version_id AND v.space_id=r.space_id WHERE r.id=$1 AND r.space_id=$2 AND v.definition_id=$3 FOR UPDATE OF r', [runId, actor.space_id, targetDefinition])).rows.length) throw hidden();
      if (input.interpretation_id && !(await db.query('SELECT id FROM experiment_interpretations WHERE id=$1 AND space_id=$2 AND project_id=$3 AND definition_id=$4 FOR UPDATE', [input.interpretation_id, actor.space_id, input.project_id, targetDefinition])).rows.length) throw hidden();
      if (input.config?.project_folder_id) await db.query('SELECT id FROM project_folders WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR SHARE', [input.config.project_folder_id, actor.space_id, input.project_id]);
      if (input.agent_id) {
        await db.query('SELECT id FROM agents WHERE id=$1 AND space_id=$2 FOR SHARE', [input.agent_id, actor.space_id]);
        if (!await canReadAgent(db, identity, input.agent_id)) throw hidden();
      }
      if (input.run_id) {
        await db.query('SELECT id FROM runs WHERE id=$1 AND space_id=$2 FOR SHARE', [input.run_id, actor.space_id]);
        await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_id=$2 ORDER BY id FOR SHARE', [actor.space_id, input.run_id]);
        if (!(await db.query(`SELECT r.id FROM runs r WHERE r.id=$1 AND r.space_id=$2 AND r.project_id=$3 AND ${contentReadSql('run', 'r', '$4')}`, [input.run_id, actor.space_id, input.project_id, identity.userId])).rows.length) throw hidden();
      }
      for (const artifact of [...(input.artifact_ids ?? [])].sort()) {
        await db.query('SELECT id FROM artifacts WHERE id=$1 AND space_id=$2 FOR SHARE', [artifact, actor.space_id]);
        await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_id=$2 ORDER BY id FOR SHARE', [actor.space_id, artifact]);
        if (!(await db.query(`SELECT a.id FROM artifacts a WHERE a.id=$1 AND a.space_id=$2 AND a.project_id=$3 AND ${contentReadSql('artifact', 'a', '$4')}`, [artifact, actor.space_id, input.project_id, identity.userId])).rows.length) throw hidden();
      }
    },
    async authorizeResult(db, raw, actor) {
      const result = raw as { space_id: string; project_id: string; definition_id: string };
      if (result.space_id !== actor.space_id) throw hidden();
      await assertProjectWriterForMutation(db, actor.space_id, result.project_id, actor.on_behalf_of_user_id!);
      await new ExperimentDefinitionService(db).requireDefinition(actor.space_id, result.project_id, result.definition_id, actor.on_behalf_of_user_id!);
    },
    async execute(db, raw, actor) {
      const input = raw as Input, body = raw as Record<string, unknown>, identity = person(actor);
      const definitions = new ExperimentDefinitionService(db), runs = new ExperimentRunService(db), interpretations = new ExperimentInterpretationService(db);
      const target = await definitionId(db, input, actor);
      let result: Record<string, unknown>;
      switch (id) {
        case 'experiment.definition.create': result = await definitions.createDefinition(identity, input.project_id, body); break;
        case 'experiment.definition.update': result = await definitions.updateDefinition(identity, input.project_id, target!, body); break;
        case 'experiment.version.create': result = await definitions.createVersion(identity, input.project_id, target!, body); break;
        case 'experiment.version.approve': result = await definitions.approveVersion(identity, input.project_id, target!, input.version_id!); break;
        case 'experiment.run.create': result = await runs.createRun(identity, input.project_id, target!, input.version_id!, body); break;
        case 'experiment.run.launch': result = await runs.launchManagedRun(identity, input.project_id, target!, input.version_id!, body); break;
        case 'experiment.run.complete': result = await runs.completeRun(identity, input.project_id, target!, input.experiment_run_id!, body); break;
        case 'experiment.observation.record': result = await runs.recordObservation(identity, input.project_id, target!, input.experiment_run_id!, body); break;
        case 'experiment.interpretation.create': result = await interpretations.createInterpretation(identity, input.project_id, target!, body); break;
        case 'experiment.interpretation.review': result = await interpretations.markReviewed(identity, input.project_id, input.interpretation_id!); break;
        case 'experiment.interpretation.convert': result = await interpretations.convertToSignal(identity, input.project_id, input.interpretation_id!, body); break;
        default: throw new Error('Unknown Experiment operation');
      }
      return { id: result.id, space_id: actor.space_id, project_id: input.project_id, definition_id: target ?? result.id };
    },
    classifyError(error) {
      if (error instanceof ExperimentMutationError) return new OperationBusinessError(error.statusCode === 409 ? 'operation_conflict' : 'operation_invalid_input', error.statusCode === 409 ? 409 : 422, 'experiments');
      return undefined;
    },
  }));
}
