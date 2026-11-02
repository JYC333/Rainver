import type { ServerConfig } from '../../../config.js';
import type { JobHandlerRegistry } from '../../jobs/handlerRegistry.js';
import { getDbPool } from '../../../db/pool.js';
import { PgRunRepository } from '../../runs/repository.js';
import { registerReadingGenerationSettlement } from './generation.js';
import { registerReadingTrialSettlement } from './trials.js';
import { runFinalizationReconcilerRegistry } from '../../runs/finalizationReconcilerRegistry.js';
export function registerReadingProviderReconciliation(registry: JobHandlerRegistry, config: ServerConfig) {
  registry.register('reading_method_reconcile', async job => {
    if (!config.databaseUrl) throw new Error('Canonical database required');
    const db = getDbPool(config.databaseUrl);
    const run = await new PgRunRepository(db).getRun(job.space_id, String(job.payload.run_id));
    if (!run || !['succeeded', 'failed', 'degraded', 'cancelled', 'orphaned'].includes(run.status)) return {
      skipped: true
    };
    registerReadingGenerationSettlement();
    registerReadingTrialSettlement();
    for (const entry of runFinalizationReconcilerRegistry.entries().filter(e => ['reading_method_generation', 'reading_method_pair'].includes(e.key))) await entry.reconcile(db, run);
    return {
      run_id: run.id
    };
  });
}
