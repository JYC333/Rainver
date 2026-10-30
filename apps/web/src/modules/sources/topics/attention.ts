import type {SourceGoalFollowState} from '@rainver/protocol'

type T=(key:string)=>string
/** The source whose problem the topic shows first: a change the owner can confirm, then access, setup, limits. */
const ORDER=['source_changed','access','setup','budget'] as const
export function leadingAttention(state:SourceGoalFollowState){
 return ORDER.map(a=>state.sources.find(s=>s.attention===a)).find(Boolean)??null
}
/** Phase in words: "waiting" names who is waited for when the server says so. */
export function phaseLabel(state:SourceGoalFollowState,t:T){
 const lead=leadingAttention(state)
 return state.phase==='waiting_for_permission'&&lead?.resolvable_by?t(`topics.waitingFor.${lead.attention}.${lead.resolvable_by}`):t(`topics.phase.${state.phase}`)
}
/** Health in words: the problem's category when the server classified it, else the generic health. */
export function healthLabel(state:SourceGoalFollowState,t:T){
 const lead=leadingAttention(state)
 return lead?t(`topics.attentionBadge.${lead.attention}`):t(`topics.health.${state.health}`)
}
