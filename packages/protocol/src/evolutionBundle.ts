import { z } from 'zod';
/** Safe receipt summary; frozen payloads, file preimages and roots stay private. */
export const EvolutionBundleDecisionReceiptSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(['pending', 'applying', 'succeeded', 'failed', 'compensating', 'compensation_failed']),
  job_id: z.string().nullable(),
  error: z.enum(['bundle_decision_failed', 'bundle_decision_compensation_failed']).nullable(),
  member_ids: z.array(z.string().min(1))
});
export type EvolutionBundleDecisionReceipt = z.infer<typeof EvolutionBundleDecisionReceiptSchema>;
