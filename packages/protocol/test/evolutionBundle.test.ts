import { describe, it, expect } from 'vitest';
import { EvolutionBundleDecisionReceiptSchema } from '../src/evolutionBundle.js';
describe('durable bundle receipt', () => {
  it('represents pending, failed and completed outcomes without domain approval fields', () => {
    for (const status of ['pending', 'applying', 'succeeded', 'failed', 'compensating', 'compensation_failed']) {
      expect(EvolutionBundleDecisionReceiptSchema.parse({
        id: 'decision',
        status,
        job_id: 'job',
        error: null,
        member_ids: ['proposal']
      }).status).toBe(status);
    }
  });
  it('never exposes frozen payloads/preimages or accepts an invented success state', () => {
    const receipt = {
      id: 'decision',
      status: 'pending',
      job_id: 'job',
      error: null,
      member_ids: ['proposal']
    };
    expect(() => EvolutionBundleDecisionReceiptSchema.parse({
      ...receipt,
      preimages: ['secret']
    })).toThrow();
    expect(() => EvolutionBundleDecisionReceiptSchema.parse({
      ...receipt,
      status: 'approved'
    })).toThrow();
  });
});
