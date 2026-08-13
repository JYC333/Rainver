import { describe, expect, it } from 'vitest'
import type {
  InquiryEvidenceSignal, InquiryThreadDetail, InquiryThreadStep, ProjectResearchWorkflow,
} from '../../../../types/api'
import {
  deriveStages, inStageAlternatives, kindsInStage, recommendStep, STAGE_ORDER, type StageInput,
} from '../stages'

const QUESTION: InquiryThreadDetail = {
  id: 'thread-1', space_id: 'space-1', project_id: 'project-1',
  kind: 'question', statement: 'Does caching help?',
  lifecycle_status: 'active', attention_state: 'focused', priority: 1,
  primary_parent_id: null, owner_user_id: null,
  next_focus_kind: null, next_focus_note: null, blocked_reason: null,
  version: 1, created_from: 'user', created_by_user_id: 'user-1',
  created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
  question_state: { current_answer_summary: null, answer_state: 'open', known_gaps: null, answerability: null, resolution_criteria: null },
  hypothesis_state: null,
  relations: [], note_links: [], in_personal_focus: false,
}

const HYPOTHESIS: InquiryThreadDetail = {
  ...QUESTION,
  kind: 'hypothesis',
  question_state: null,
  hypothesis_state: {
    proposed_claim: 'A warm cache halves p95', predictions: null, falsification_criteria: null,
    evaluation_state: 'untested', confidence: null, confidence_method: null,
  },
}

function signal(): InquiryEvidenceSignal {
  return {
    id: 'signal-1', space_id: 'space-1', project_id: 'project-1', thread_id: 'thread-1',
    corpus_item_id: 'corpus-1', classification: 'supports', is_material: true, confidence: 0.8,
    model_version: 'v1', source_provenance: {}, dedupe_key: 'k', producer_idempotency_key: null,
    status: 'auto_attached', candidate_id: null, created_by_user_id: null, created_by_run_id: null,
    created_at: '2026-08-12T00:00:00.000Z',
  }
}

/**
 * A step as it exists inside a live round: open, and not yet stamped with an
 * Iteration. Close-out is the only thing that marks a hand-done step `done`,
 * and it stamps it into the round it ends in the same statement — so a `done`
 * step with `iteration_id: null` is a state the application cannot produce, and
 * a fixture built that way tests nothing real.
 */
function step(overrides: Partial<InquiryThreadStep>): InquiryThreadStep {
  return {
    id: 'step-1', project_id: 'project-1', thread_id: 'thread-1',
    kind: 'read_evidence', status: 'in_progress', slot: 'primary', note: null,
    target_ref_kind: null, target_ref_id: null, iteration_id: null, origin: 'user',
    started_at: '2026-08-12T00:00:00.000Z', completed_at: null,
    created_at: '2026-08-12T00:00:00.000Z',
    ...overrides,
  }
}

function workflow(): ProjectResearchWorkflow {
  return {
    id: 'workflow-1', project_id: 'project-1',
    current_stage: 'screening', status: 'active', mode: 'autonomous',
    state_json: {}, primary_thread_id: 'thread-1',
    started_by_user_id: null, started_run_id: null,
    created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
  } as ProjectResearchWorkflow
}

const base: StageInput = {
  detail: QUESTION, signals: [], pendingCandidateCount: 0,
  startedWorkflow: null, questionRefined: false, roundSteps: [], closedRounds: 0,
  roundStartedAt: null,
}

describe('deriveStages', () => {
  it('starts an unrefined Thread in Clarify, which is the first thing unfinished', () => {
    expect(deriveStages(base).current).toBe('clarify')
  })

  it('moves to Acquire once the wording is settled and no evidence has arrived', () => {
    expect(deriveStages({ ...base, questionRefined: true }).current).toBe('acquire')
  })

  it('keeps a Thread in Acquire while the search runs, because nothing has landed yet', () => {
    // A running search is Acquire still happening. Calling it complete pushed
    // the Thread into Digest with nothing to digest, and produced a
    // recommendation to read evidence that did not exist.
    const running = deriveStages({ ...base, questionRefined: true, startedWorkflow: workflow() })
    expect(running.stages.find(stage => stage.id === 'acquire')?.complete).toBe(false)
    expect(running.current).toBe('acquire')
  })

  it('recommends watching the running search rather than starting a second one', () => {
    const recommendation = recommendStep({ ...base, questionRefined: true, startedWorkflow: workflow() })
    expect(recommendation.kind).toBe('search_acquisition')
    expect(recommendation.reason).toContain('under way')
  })

  it('holds the Thread in Digest while material is waiting, even once evidence exists', () => {
    const input = { ...base, questionRefined: true, signals: [signal()], pendingCandidateCount: 3 }
    expect(deriveStages(input).current).toBe('digest')
  })

  it('puts a written-up Thread back in Digest when new material arrives, without calling it a regression', () => {
    const concluded: StageInput = {
      ...base,
      questionRefined: true,
      signals: [signal()],
      pendingCandidateCount: 2,
      roundSteps: [step({ kind: 'synthesize' })],
    }
    const derived = deriveStages(concluded)
    expect(derived.current).toBe('digest')
    // Conclude un-ticks with it. The write-up did happen, but it no longer
    // covers what is known, so calling it finished while unread material sits
    // in front of it would be the row lying to make a point about history.
    expect(derived.stages.find(stage => stage.id === 'conclude')?.complete).toBe(false)
  })

  it('reaches Land once this round has written up what it found', () => {
    const input: StageInput = {
      ...base,
      questionRefined: true,
      signals: [signal()],
      roundSteps: [step({ kind: 'synthesize' })],
    }
    expect(deriveStages(input).current).toBe('land')
  })

  it('starts the next round over instead of opening it pinned at Land', () => {
    // Every stage but Clarify is measured against this round. Reading all-time
    // state left a Thread that had ever concluded showing Conclude complete
    // forever, so round two opened at Land recommending Knowledge promotion
    // before any new evidence existed — the spiral never came round.
    const roundTwo: StageInput = {
      ...base,
      questionRefined: true,
      closedRounds: 1,
      roundStartedAt: '2026-08-13T00:00:00.000Z',
      // Evidence and the answer both belong to round one.
      signals: [signal()],
      detail: { ...QUESTION, question_state: { ...QUESTION.question_state!, answer_state: 'partial' } },
      roundSteps: [],
    }
    const derived = deriveStages(roundTwo)
    expect(derived.round).toBe(2)
    expect(derived.current).toBe('acquire')
    expect(recommendStep(roundTwo).kind).toBe('search_acquisition')
  })

  it('reaches Land from a write-up still in progress, the only state a live round has', () => {
    // A hand-done step is marked `done` only by close-out, which stamps it out
    // of the round in the same statement. Waiting for `done` left Conclude
    // permanently incomplete, so the promoted close-out never appeared.
    const writing: StageInput = {
      ...base,
      questionRefined: true,
      signals: [signal()],
      roundSteps: [step({ kind: 'synthesize' })],
    }
    const derived = deriveStages(writing)
    expect(derived.stages.find(stage => stage.id === 'conclude')?.complete).toBe(true)
    expect(derived.current).toBe('land')
  })

  it('does not treat a running search as evidence in hand, unlike hand-done work', () => {
    // Acquire is judged on its product; the other stages on the user's
    // attention, because human work has no completion event of its own.
    const searching: StageInput = {
      ...base,
      questionRefined: true,
      roundSteps: [step({ kind: 'search_acquisition', slot: 'background' })],
    }
    expect(deriveStages(searching).current).toBe('acquire')
  })

  it('counts evidence that arrived during this round, not evidence from earlier ones', () => {
    const roundTwo: StageInput = {
      ...base,
      questionRefined: true,
      closedRounds: 1,
      roundStartedAt: '2026-08-13T00:00:00.000Z',
      signals: [{ ...signal(), created_at: '2026-08-13T06:00:00.000Z' }],
    }
    expect(deriveStages(roundTwo).current).toBe('conclude')
  })

  it('counts the round from closed Iterations rather than a separate counter', () => {
    expect(deriveStages(base).round).toBe(1)
    expect(deriveStages({ ...base, closedRounds: 2 }).round).toBe(3)
  })

  it('lets a stage count as done because the user went and did it, not only by state', () => {
    const input = { ...base, roundSteps: [step({ kind: 'clarify_or_decompose' })] }
    expect(deriveStages(input).current).toBe('acquire')
  })

  it('takes a stage back when the user backs out of it', () => {
    // An abandoned step stays in the round, so counting it left a stage the
    // user had merely glanced at marked finished with no way to undo it.
    const input = {
      ...base,
      roundSteps: [step({ kind: 'clarify_or_decompose', status: 'abandoned' as const, completed_at: '2026-08-13T01:00:00.000Z' })],
    }
    expect(deriveStages(input).current).toBe('clarify')
  })

  it('never ticks a later stage while an earlier one is unfinished', () => {
    // One click on a Land action from an untouched Thread satisfies Land's own
    // condition. Showing that as a tick after two blank stages would say the
    // round was finished before it started.
    const input = { ...base, roundSteps: [step({ kind: 'create_decision_case' })] }
    const derived = deriveStages(input)
    expect(derived.current).toBe('clarify')
    expect(derived.stages.map(stage => stage.complete)).toEqual([false, false, false, false, false])
  })
})

describe('recommendStep', () => {
  it('recommends assessing the wording first, naming why', () => {
    const recommendation = recommendStep(base)
    expect(recommendation.kind).toBe('clarify_or_decompose')
    expect(recommendation.reason).toContain('not been assessed')
  })

  it('sends a Question to the literature and a Hypothesis to an experiment', () => {
    expect(recommendStep({ ...base, questionRefined: true }).kind).toBe('search_acquisition')
    expect(recommendStep({ ...base, detail: HYPOTHESIS, questionRefined: true }).kind).toBe('design_run_experiment')
  })

  it('puts the waiting count in the reason so the user can check it on the page', () => {
    const recommendation = recommendStep({
      ...base, questionRefined: true, signals: [signal()], pendingCandidateCount: 2,
    })
    expect(recommendation.kind).toBe('read_evidence')
    expect(recommendation.reason).toContain('2 material changes')
  })

  it('keeps recommending after a step is chosen, which is when the old card fell silent', () => {
    const working: StageInput = {
      ...base,
      questionRefined: true,
      signals: [signal()],
      pendingCandidateCount: 1,
      roundSteps: [step({ kind: 'read_evidence' })],
    }
    expect(recommendStep(working).kind).toBe('read_evidence')
  })
})

describe('grammar of reasons', () => {
  it('agrees in number, since these strings are the whole justification shown', () => {
    expect(recommendStep({ ...base, questionRefined: true, signals: [signal()], pendingCandidateCount: 1 }).reason)
      .toBe('1 material change on this Thread awaits review.')
    expect(recommendStep({ ...base, questionRefined: true, signals: [signal()], pendingCandidateCount: 2 }).reason)
      .toBe('2 material changes on this Thread await review.')
    expect(recommendStep({
      ...base,
      questionRefined: true,
      signals: [signal()],
      detail: { ...QUESTION, question_state: { ...QUESTION.question_state!, answer_state: 'open' } },
    }).reason).toContain('1 piece of evidence is in hand')
  })
})

describe('alternatives', () => {
  it('offers the other path in Acquire, since finding and producing evidence are peers', () => {
    const alternatives = inStageAlternatives({ ...base, questionRefined: true })
    expect(alternatives.map(item => item.kind)).toEqual(['design_run_experiment'])
    expect(alternatives[0]?.reason).not.toBe('')
  })

  it('offers Land’s other two exits without special-casing the stage', () => {
    const input: StageInput = {
      ...base,
      questionRefined: true,
      signals: [signal()],
      roundSteps: [step({ kind: 'synthesize' })],
    }
    expect(inStageAlternatives(input).map(item => item.kind))
      .toEqual(['create_decision_case', 'create_delivery_task'])
  })

  it('never re-offers a step already running', () => {
    const input: StageInput = {
      ...base,
      questionRefined: true,
      roundSteps: [step({ kind: 'design_run_experiment', slot: 'background' })],
    }
    expect(inStageAlternatives(input).map(item => item.kind)).not.toContain('design_run_experiment')
  })

  it('keeps every action reachable through its owning stage', () => {
    const offered = new Set(STAGE_ORDER.flatMap(kindsInStage))
    expect(offered.size).toBe(8)
  })
})

describe('stage membership', () => {
  it('assigns all eight actions, with Acquire and Land holding the branches', () => {
    expect(kindsInStage('clarify')).toEqual(['clarify_or_decompose'])
    expect(kindsInStage('acquire')).toEqual(['search_acquisition', 'design_run_experiment'])
    expect(kindsInStage('digest')).toEqual(['read_evidence'])
    expect(kindsInStage('conclude')).toEqual(['synthesize'])
    expect(kindsInStage('land')).toEqual(['promote_knowledge', 'create_decision_case', 'create_delivery_task'])
  })
})
