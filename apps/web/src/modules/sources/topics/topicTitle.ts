import type {SourceGoalDetail} from '@rainver/protocol'

/** Only an authored, version-bound label names a topic; conversation text is input. */
export function topicTitle(goal:SourceGoalDetail['goal'],empty=''):string {
 return goal.display?.title?.trim()||empty
}
