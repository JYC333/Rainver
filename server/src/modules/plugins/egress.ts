import type {RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {hasSensitivePluginRead, readRunContextTaint} from '../runs/contextTaint.js';

/**
 * Writes a Run may still make after reading sensitive plugin data (ADR 0030):
 * asking for authorization and Memory (forced into a gated proposal that
 * inherits the sensitivity). All other side-effecting actions, including
 * sensitive plugin proposals, are outward and refused by
 * `sensitivePluginReadBlocksOutward`.
 */
const TAINTED_RUN_WRITES = new Set(['authorization.request', 'memory.remember', 'memory.revise']);

export function isOutwardAfterSensitiveRead(definition: Pick<RegisteredSystemActionDefinition, 'id' | 'side_effects'>): boolean {
  return definition.side_effects !== 'none' && !TAINTED_RUN_WRITES.has(definition.id);
}

/** Policy-context facts for an Agent action; read from the Run's merge-only taint, never from the call. */
export async function sensitiveTaintEgressContext(db: Queryable, spaceId: string, runId: string | null, definition: Pick<RegisteredSystemActionDefinition, 'id' | 'side_effects'>): Promise<{sensitive_plugin_read_taint: boolean; outward_action: boolean}> {
  const outward = isOutwardAfterSensitiveRead(definition);
  if (!runId) return {sensitive_plugin_read_taint: false, outward_action: outward};
  return {sensitive_plugin_read_taint: hasSensitivePluginRead(await readRunContextTaint(db, spaceId, runId)), outward_action: outward};
}
