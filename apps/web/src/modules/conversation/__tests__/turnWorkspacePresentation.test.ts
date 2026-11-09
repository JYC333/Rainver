// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Run } from '../../../types/api'
import { planTurnSummaries } from '../turnWorkspacePresentation'
import { run as fixture } from '../../agent_work/fixtures.test-support'
import { workspaceChange } from '../../runs/workspaceFixtures.test-support'

const shared = workspaceChange({ change_set_id: 'shared', state: 'open' })
const turn = (id: string, status: string, changes = [shared]): Run => fixture({ id, status, workspace_changes: changes })
const groups = [{ anchorMessageId: 'one', runIds: ['first'] }, { anchorMessageId: 'two', runIds: ['second'] }]

describe('which request group shows a shared batch', () => {
  it('gives it to the latest settled group, which the earlier one then leaves out', () => {
    const plan = planTurnSummaries(groups, { first: turn('first', 'succeeded'), second: turn('second', 'failed') })
    expect([...plan.get('one')!.exclude]).toEqual(['shared'])
    expect([...plan.get('two')!.exclude]).toEqual([])
  })
  it.each(['waiting_for_review', 'running'])('keeps it in the earlier summary while the later group is %s and cannot carry one', status => {
    const plan = planTurnSummaries(groups, { first: turn('first', 'succeeded'), second: turn('second', status) })
    expect(plan.has('two')).toBe(false)
    expect([...plan.get('one')!.exclude]).toEqual([])
  })
  it('plans no summary for a group whose Run record is not loaded yet', () => {
    expect(planTurnSummaries(groups, { first: turn('first', 'succeeded') }).has('two')).toBe(false)
  })
})
