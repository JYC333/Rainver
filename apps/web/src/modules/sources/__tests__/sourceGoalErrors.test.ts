// @vitest-environment node
import {it,expect} from 'vitest'
import {sourceGoalErrorKind} from '../sourceGoalErrors'
it('prefers stable codes over conflicting prose and retains old response compatibility',()=>{
 expect(sourceGoalErrorKind({code:'source_goal_stopped',message:'budget exceeded',status:409})).toBe('errorStopped')
 expect(sourceGoalErrorKind({code:'source_goal_exploration_budget_exhausted',message:'Profile missing',status:429})).toBe('errorBudget')
 expect(sourceGoalErrorKind({code:'source_goal_execution_setup_required',message:'stopped'})).toBe('errorSetup')
 expect(sourceGoalErrorKind({message:'use_credential_channel',status:422})).toBe('errorCredentials')
 expect(sourceGoalErrorKind({status:403})).toBe('errorAccess')
 expect(sourceGoalErrorKind({status:503})).toBe('errorHint')
})
