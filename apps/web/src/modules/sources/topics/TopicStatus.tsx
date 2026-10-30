import {RefreshCw} from 'lucide-react'
import type {SourceGoalDetail,SourceGoalFollowState} from '@rainver/protocol'
import {Badge,type BadgeProps} from '../../../components/ui/badge'
import {Button} from '../../../components/ui/button'
import {SpaceLink} from '../../../core/spaceNav'
import {useAppTranslation} from '../../../i18n'
import {formatDateTime} from '../../../i18n/format'
import {sourceGoalErrorKind} from '../sourceGoalErrors'
import {sourceFailureKey} from '../SourceGoalPreviewResult'
import {SourceChangeConfirm} from './SourceChangeConfirm'
import {healthLabel,phaseLabel} from './attention'

type Binding=SourceGoalDetail['bindings'][number]
/** Readable binding details, or undefined when the server redacted them because
 * the viewer can no longer read that Source (never re-exposed here). */
function readable(b:Binding|undefined){return b&&!('unavailable' in b)?b:undefined}
/** Localized, actionable reason for one source; stable codes are never shown raw. */
function sourceNotice(raw:Binding|undefined,error:string|null):string|null{
 if(raw&&'unavailable' in raw)return 'topics.unavailableNotice'
 const b=readable(raw)
 if(b?.collection_error)return ['source_native_runtime_unsupported','source_native_safety_unavailable'].includes(b.collection_error)?'sourceGoals.nativeUnsupported':b.collection_error==='source_authority_revoked'?'sourceGoals.authorityRevoked':b.collection_error==='source_native_cancelled'?'sourceGoals.previewCancelled':b.collection_error==='source_native_deadline_exceeded'?'sourceGoals.previewTimeout':'sourceGoals.nativeFailed'
 if(b?.repair_block_reason)return b.repair_block_reason==='source_repair_calibration_unavailable'?'sourceGoals.calibrationUnavailable':b.repair_block_reason==='source_repair_validation_insufficient'?'sourceGoals.repairInsufficient':'sourceGoals.authorityRevoked'
 if(error)return `sourceGoals.${sourceFailureKey(error)??sourceGoalErrorKind({code:error})}`
 if(b&&['repairing','repair_required'].includes(b.status))return 'sourceGoals.attention'
 return null
}

const PHASE_VARIANT:Record<SourceGoalFollowState['phase'],BadgeProps['variant']>={none:'muted',preparing:'warning',waiting_for_permission:'warning',first_collection:'warning',checking:'warning',scheduled:'success',stopped:'muted',blocked:'destructive'}
const HEALTH_VARIANT:Record<SourceGoalFollowState['health'],BadgeProps['variant']>={unknown:'muted',ok:'success',partial:'warning',needs_permission:'warning',failing:'destructive'}
/** Separate dimensions from the server's follow_state: intent/phase, source
 * health, actual collection queue and results. Missing permission is never
 * shown as "no updates"; partial failure names the affected sources. */
export function TopicStatus({state,bindings,onRefresh,refreshing,goalId,spaceId,act}:{state:SourceGoalFollowState;bindings:SourceGoalDetail['bindings'];onRefresh:()=>void;refreshing:boolean;goalId?:string;spaceId?:string;act?:(action:()=>Promise<unknown>)=>Promise<void>}){
 const {t}=useAppTranslation()
 const r=state.results
 const time=(v:string|null)=>v?formatDateTime(v):t('topics.never')
 const binding=(id:string)=>bindings.find(b=>b.id===id)
 const queued=state.collections?.queued??0,running=state.collections?.running??0
 return <section aria-labelledby="topic-status" className="space-y-3">
  <div className="flex items-center justify-between gap-2"><h2 id="topic-status" className="text-sm font-semibold">{t('topics.status')}</h2><Button size="icon" variant="ghost" aria-label={t('sourceGoals.refreshProgress')} title={t('sourceGoals.refreshProgress')} disabled={refreshing} onClick={onRefresh}><RefreshCw className="size-3.5"/></Button></div>
  <div role="status" aria-live="polite" className="space-y-2">
   <div className="flex flex-wrap gap-2"><Badge variant={PHASE_VARIANT[state.phase]}>{phaseLabel(state,t)}</Badge>{state.intent!=='paused'&&<Badge variant={HEALTH_VARIANT[state.health]}>{healthLabel(state,t)}</Badge>}</div>
   {(queued>0||running>0)&&<p className="text-xs text-muted-foreground">{t('topics.queue',{queued,running})}</p>}
   {state.health==='needs_permission'&&<p className="text-sm">{t(state.sources.some(s=>s.attention==='source_changed')?'topics.sourceChangedNotice':'topics.needsPermission')}</p>}
   {state.phase==='blocked'&&state.blocked_reason&&<p className="text-sm">{t('topics.blocked',{reason:state.blocked_reason})}</p>}
  </div>
  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
   <dt className="text-muted-foreground">{t('topics.lastChecked')}</dt><dd>{time(r.last_checked_at)}</dd>
   <dt className="text-muted-foreground">{t('topics.nextCheck')}</dt><dd>{state.intent==='following'&&r.next_check_at?time(r.next_check_at):t('sourceGoals.notScheduled')}</dd>
  </dl>
  <p className="text-sm">{t(`topics.lastOutcome.${r.last_outcome}`,{count:r.last_new_items??0})}</p>
  {(r.last_new_changes??0)>0&&<p className="text-sm">{t('reading.newChanges',{count:r.last_new_changes})}</p>}
  <p className="text-xs text-muted-foreground">{t('topics.counts',{important:r.important_total,total:r.items_total,changes:r.changes_total})}</p>
  {state.sources.length>0&&<div className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">{t('topics.sources')}</h3><ul className="space-y-2">{state.sources.map(s=><li key={s.binding_id} className="space-y-1 rounded-md border border-border p-2 text-sm">
   <div className="flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-words">{readable(binding(s.binding_id))?.spec_json.reason??t(binding(s.binding_id)?'topics.unavailableSource':'topics.sources')}</span><Badge variant={s.health==='ok'||s.health==='collecting'?'success':s.health==='stopped'?'muted':s.health==='failing'?'destructive':'warning'}>{t(s.attention&&s.health!=='ok'&&s.health!=='collecting'?`topics.attentionBadge.${s.attention}`:`topics.sourceHealth.${s.health}`)}</Badge></div>
   {s.attention?<p className="text-xs text-muted-foreground">{t(`topics.attention.${s.attention}.${s.resolvable_by??'you'}`)}</p>
    :(()=>{const notice=sourceNotice(binding(s.binding_id),s.error);return notice&&<p className="text-xs text-muted-foreground">{t(notice)}</p>})()}
   {s.attention==='source_changed'&&s.resolvable_by==='you'&&goalId&&spaceId&&act&&<SourceChangeConfirm goalId={goalId} bindingId={s.binding_id} spaceId={spaceId} act={act} disabled={refreshing}/>}
   {s.retry_at&&s.health!=='stopped'&&s.health!=='ok'&&<p className="text-xs text-muted-foreground">{t('topics.retryAt',{time:formatDateTime(s.retry_at)})}</p>}
   {(readable(binding(s.binding_id))?.gaps_json.length??0)>0&&<p className="text-xs text-muted-foreground">{t('sourceGoals.gaps')} ({readable(binding(s.binding_id))!.gaps_json.length})</p>}
   {/* The Source page cannot resolve a Source change, a usage limit or the topic's Agent setup (the topic does); it links only for Source-side problems. */}
   {s.health!=='ok'&&s.health!=='collecting'&&(!s.attention||s.attention==='access')&&readable(binding(s.binding_id))&&<SpaceLink className="text-xs underline" to={`/sources/${s.source_connection_id}`}>{t('topics.reviewSource')}</SpaceLink>}
  </li>)}</ul></div>}
 </section>
}
