import {StatusBadge} from '../../components/ui/badge'
import {useEffect,useRef,useState} from 'react'
import type {SourceMaterialProcessingState} from '@rainver/protocol'
import {sourcesApi,proposalsApi} from '../../api/client'
import {useAppTranslation} from '../../i18n'
import {cn,errMsg} from '../../lib/utils'
import {SpaceLink} from '../../core/spaceNav'
import {Button} from '../../components/ui/button'
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '../../components/ui/dialog'
const reasonKey:Record<string,string>={source_material_not_read:'agentContentReason_not_read',source_material_unavailable:'agentContentReason_unavailable',source_material_unsupported:'agentContentReason_unsupported',source_material_access_denied:'agentContentReason_access_denied',source_material_permission_denied:'agentContentReason_access_denied',source_material_failed:'materialRunFailed',source_material_access_changed:'materialAccessChanged',source_material_context_refused:'materialAccessChanged',source_material_deadline_exceeded:'materialDeadline',source_material_submission_missing:'materialMissingSubmission',source_material_run_failed:'materialRunFailed'}
const active=new Set(['queued','running','waiting_for_review','waiting_for_dependency','cancelling'])
/** Existing Run/Source operation is the only progress state. Remount/reload
 * resumes observation; no browser job runner or second local queue. */
export function MaterialProcessingPanel({itemId,spaceId,hasContent,onReady,className}:{itemId:string;spaceId?:string;hasContent:boolean;onReady:()=>Promise<void>;className?:string}){
 const {t}=useAppTranslation();const [state,setState]=useState<SourceMaterialProcessingState>({status:'idle'});const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [review,setReview]=useState(false);const [revision,setRevision]=useState(0);const [confirmAgain,setConfirmAgain]=useState(false);const generation=useRef(0);const ready=useRef(onReady);ready.current=onReady;
 useEffect(()=>{
  const token=++generation.current;let timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{if(token!==generation.current)return;try{
   const next=await sourcesApi.materialProcessing(itemId,{spaceId});if(token!==generation.current)return;setState(next);
   if(next.status==='succeeded')await ready.current();
   else if(active.has(next.status))timer=setTimeout(poll,1200);
  }catch(e){if(token===generation.current)setError(errMsg(e));}};
  void poll();return()=>{generation.current++;if(timer)clearTimeout(timer)};
 },[spaceId,itemId,revision]);
 async function start(allowStorage=false){const token=generation.current;setBusy(true);setError(null);try{
  if(allowStorage){const proposal=await sourcesApi.requestMaterialStorage(itemId,{spaceId});if(token!==generation.current)return;if(proposal.proposal_id)await proposalsApi.accept(proposal.proposal_id,{spaceId});}
  if(token!==generation.current)return;
  const next=await sourcesApi.prepareMaterial(itemId,{}, {spaceId});if(token!==generation.current)return;setState(next);setReview(next.status==='needs_consent');
  if(active.has(next.status))setRevision(n=>n+1);
 }catch(e){if(token===generation.current){setError(errMsg(e));setReview(false)}}finally{setBusy(false);}}
 async function cancel(){setBusy(true);try{setState(await sourcesApi.cancelMaterialProcessing(itemId,{spaceId}));setRevision(n=>n+1)}catch(e){setError(errMsg(e))}finally{setBusy(false)}}

 // With text shown and nothing running, failed or waiting on consent, "read again" is a quiet
 // line, not a card: the reading text, not the management action, leads the first screen.
 const quiet=hasContent&&!active.has(state.status)&&state.status!=='failed'&&!error&&!review
 return <div className={cn(quiet?"flex flex-wrap items-center gap-2 text-sm":"space-y-3 rounded-lg border border-border bg-card p-3 text-sm",className)}>
  <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant={quiet?'ghost':'default'} disabled={state.can_prepare===false||busy||active.has(state.status)} onClick={()=>{if(hasContent)setConfirmAgain(true);else void start()}}>{t(hasContent?'reading.prepareAgain':'reading.prepareMaterial')}</Button>
   {active.has(state.status)&&<><span role="status" aria-live="polite"><StatusBadge status={state.status} label={t('reading.materialState_'+state.status,{defaultValue:state.status})}/></span><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void cancel()}>{t('reading.cancelMaterial')}</Button></>}
   {state.run_id&&<Button size="sm" variant="outline" asChild><SpaceLink to={'/runs/'+state.run_id}>{t('reading.materialRun')}</SpaceLink></Button>}
  </div>
  {state.status==='failed'&&<p role="alert" className="text-destructive">{t('reading.materialFailed')} {state.error&&reasonKey[state.error]?t('reading.'+reasonKey[state.error]):state.reason}</p>}
  {state.status==='cancelled'&&<p role="status" aria-live="polite" className="text-muted-foreground">{t('reading.materialCancelled')}</p>}
  {state.status==='read_only'&&<p>{t('reading.materialReadOnly')}</p>}
  {state.status==='succeeded'&&<p role="status" aria-live="polite" className="text-muted-foreground">{t('reading.materialReady')}</p>}
  {error&&<p role="alert" className="text-destructive">{error}</p>}
  {/* Re-reading replaces what is shown with a new version of this one item: say what that means for its annotations before it starts. */}
  <Dialog open={confirmAgain} onOpenChange={setConfirmAgain}><DialogContent><DialogHeader><DialogTitle>{t('reading.prepareAgainTitle')}</DialogTitle><DialogDescription>{t('reading.prepareAgainImpact')}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" onClick={()=>setConfirmAgain(false)}>{t('reading.prepareAgainKeep')}</Button><Button disabled={busy} onClick={()=>{setConfirmAgain(false);void start()}}>{t('reading.prepareAgainConfirm')}</Button></DialogFooter></DialogContent></Dialog>
  <Dialog open={review} onOpenChange={setReview}><DialogContent><DialogHeader><DialogTitle>{t('reading.materialConsentTitle')}</DialogTitle><DialogDescription>{t('reading.materialConsentDescription',{source:state.source_name??''})}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" onClick={()=>setReview(false)}>{t('reading.materialNotNow')}</Button><Button disabled={busy||!state.can_request_consent} onClick={()=>void start(true)}>{t('reading.materialConsentConfirm')}</Button></DialogFooter></DialogContent></Dialog>
 </div>
}
