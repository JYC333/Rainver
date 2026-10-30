import type {SourceGoalFollowRequest} from '@rainver/protocol'
/** Owner-facing frequency and effort choices. Values stay inside the server's
 * SourceGoalBudgetSchema bounds; the server still validates every request. */
export const FREQUENCIES=[21600,43200,86400,259200,604800] as const
export const EFFORTS={light:{requests_per_run:4,items_per_source:10},standard:{requests_per_run:8,items_per_source:20},thorough:{requests_per_run:16,items_per_source:40}} as const
export type Effort=keyof typeof EFFORTS
export type FollowChoice={interval_seconds:number;effort:Effort}
export const DEFAULT_FOLLOW:FollowChoice={interval_seconds:86400,effort:'standard'}
/** Frequency and per-run budget of one confirmation. */
export function followLimits(choice:FollowChoice){return {interval_seconds:choice.interval_seconds,...EFFORTS[choice.effort]}}
export function followRequest(choice:FollowChoice,idempotency_key:string,version_id?:string|null):SourceGoalFollowRequest{
 return {idempotency_key,...(version_id?{version_id}:{}),interval_seconds:choice.interval_seconds,...EFFORTS[choice.effort]}
}
/** Closest preset for a saved budget, so the form reflects the current topic. */
export function choiceFromBudget(budget:{interval_seconds?:number;requests_per_run?:number}|null|undefined):FollowChoice{
 const interval=FREQUENCIES.includes((budget?.interval_seconds??0) as typeof FREQUENCIES[number])?budget!.interval_seconds!:DEFAULT_FOLLOW.interval_seconds
 const requests=budget?.requests_per_run??8
 return {interval_seconds:interval,effort:requests<=4?'light':requests>=16?'thorough':'standard'}
}
/** Stable, bounded feedback idempotency key (the server limit is 128 chars):
 * the same feedback replays as a no-op instead of applying twice. */
export function feedbackKey(kind:string,value:string){
 let h=0x811c9dc5;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0}
 return `${kind}:${h.toString(16)}:${value.length}`
}
type PausableGoal={status:string;active_version_id:string|null;follow_json?:unknown;follow_state?:{intent:string}|null;compatibility_json?:Record<string,unknown>|null}
/** Which canonical lifecycle action applies: confirmed following (including
 * background preparation before any plan is active) can pause; a paused topic
 * resumes only when it was active or confirmed. Manual-save topics have neither. */
export function lifecycleAction(g:PausableGoal):'pause'|'resume'|null{
 if(g.compatibility_json?.execution_mode==='manual'||g.status==='deleted')return null
 const owned=!!g.active_version_id||g.compatibility_json?.scheduler_owner==='legacy'
 if(g.status==='paused')return owned||!!g.follow_json?'resume':null
 return owned||g.follow_state?.intent==='following'?'pause':null
}
