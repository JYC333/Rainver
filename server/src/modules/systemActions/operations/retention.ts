import type { Pool } from '../../../db/pool.js';
import { withTransaction } from '../../../db/tx.js';
import { reserve, reconcile, type RequestRow } from './repository.js';
import { OperationError } from './errors.js';
interface Candidate extends RequestRow {
  principal_kind: string;
  principal_id: string;
  on_behalf: string;
  authority_scope_id: string;
  idempotency_key: string;
}
/** Content-free host maintenance. Same non-waiting key/Proposal/request lock order as execution. */
export async function pruneOperationRequests(pool: Pool, limit = 100): Promise<{
  deleted: number;
  inconsistent: number;
}> {
  const bounded = [Math.min(100, Math.max(1, limit))];
  // Separate budgets: corrupt pending evidence cannot starve terminal deletion or valid reconciliation.
  const terminal = await pool.query<Candidate>(`SELECT r.* FROM operation_idempotency r WHERE r.state<>'pending_approval' AND r.terminal_at<now()-interval '7 days' ORDER BY r.terminal_at,r.id LIMIT $1`, bounded);
  const pending = await pool.query<Candidate>(`SELECT r.* FROM operation_idempotency r JOIN proposals p ON p.id=r.proposal_id AND p.space_id=r.space_id WHERE r.state='pending_approval' AND (p.status IN ('rejected','superseded') OR p.status='pending' AND p.expires_at<=now()) ORDER BY r.created_at,r.id LIMIT $1`, bounded);
  const anomalous = await pool.query<Candidate>(`SELECT r.* FROM operation_idempotency r LEFT JOIN proposals p ON p.id=r.proposal_id AND p.space_id=r.space_id WHERE r.state='pending_approval' AND (p.id IS NULL OR p.status NOT IN ('pending','rejected','superseded')) ORDER BY r.created_at,r.id LIMIT $1`, bounded);
  const rows = [...terminal.rows,...pending.rows,...anomalous.rows];
  let deleted = 0,
    inconsistent = 0;
  for (const candidate of rows) {
    try {
      deleted += await withTransaction(pool, async tx => {
        const row = await reserve(tx, [candidate.space_id, candidate.principal_kind, candidate.principal_id, candidate.on_behalf, candidate.authority_scope_id, candidate.operation_id, candidate.idempotency_key]);
        if (!row) return 0;
        await reconcile(tx, row);
        return (await tx.query("DELETE FROM operation_idempotency WHERE id=$1 AND state<>'pending_approval' AND terminal_at<now()-interval '7 days'", [row.id])).rowCount ?? 0;
      });
    } catch (error) {
      if (error instanceof OperationError && error.code === 'idempotency_in_progress') continue;
      if (error instanceof OperationError && error.code === 'operation_approval_state_inconsistent') {
        inconsistent++;
        continue;
      }
      throw error;
    }
  }
  return {
    deleted,
    inconsistent
  };
}
