import type { InquiryThreadDetail, InquiryThreadStep } from '../../../types/api'
/** Close-out facts own the window; cognitive Iterations never advance it. */
export function inquiryRoundFacts(detail: Pick<InquiryThreadDetail, 'problem_summary'>, steps: InquiryThreadStep[]) {
  const summary = detail.problem_summary
  const round = summary?.round_number ?? 1
  return { round, closedRounds: round - 1, roundStartedAt: summary?.round_started_at ?? null,
    roundSteps: steps.filter(step => summary ? step.round_number === round : (step.round_number ?? 1) === 1) }
}
