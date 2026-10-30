import type {SourceGoalDetail} from '@rainver/protocol'

/** Existing topics keep their original subject until a planning run supplies a label. */
export function topicTitle(goal:SourceGoalDetail['goal']):string {
 const label=goal.compatibility_json?.display_title
 return typeof label==='string'&&label.trim()?label.trim():String(goal.compatibility_json?.conversation_base_intent??goal.intent_json.intent??'').split('\n')[0].trim()
}
