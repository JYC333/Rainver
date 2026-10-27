import {useEffect,useState} from 'react'
import {useAppTranslation} from '../../i18n'
import {SpaceLink} from '../../core/spaceNav'
import {informationDigestsApi} from '../../api/client'
import {Button} from '../../components/ui/button'
import {Card} from '../../components/ui/card'
import {SaveReadingUrlDialog} from './SaveReadingUrlDialog'
import {ReadingError} from './ReadingError'
/** Empty Reading retains server completion/material counts. Opening setup writes
 * nothing; cancelling a save never invalidates the mounted Reading list. */
export function ReadingStart({spaceId,projectId,view,onChanged}:{spaceId:string;projectId?:string;view:'pending'|'all';onChanged:()=>void}){
 const {t}=useAppTranslation()
 const [save,setSave]=useState(false)
 const [counts,setCounts]=useState<{all:number;read:number}|null>(null)
 const [error,setError]=useState<unknown>(null)
 const [attempt,setAttempt]=useState(0)
 useEffect(()=>{
  const c=new AbortController();setCounts(null);setError(null)
  void Promise.all(['all','read'].map(v=>informationDigestsApi.reading(spaceId,{view:v as 'all'|'read',limit:1},projectId,{spaceId,signal:c.signal})))
   .then(([all,read])=>{if(!c.signal.aborted)setCounts({all:all.total,read:read.total})})
   .catch(e=>{if(!c.signal.aborted)setError(e)})
  return()=>c.abort()
 },[spaceId,projectId,attempt])
 if(error)return <ReadingError error={error} retry={()=>setAttempt(n=>n+1)}/>
 if(!counts)return <p role="status">{t('reading.loading')}</p>
 const phase=view==='pending'&&counts.read>0?'CaughtUp':counts.all>0?'HasMaterials':null
 return <Card className="space-y-4 p-6">
  <h2 className="text-xl font-semibold">{phase?t(`reading.start${phase}`):t('sourceGoals.question')}</h2>
  <p className="text-muted-foreground">{phase?t(`reading.start${phase}Hint`):t('sourceGoals.examples')}</p>
  {phase&&<h3 className="font-medium">{t('sourceGoals.question')}</h3>}
  <div className="flex flex-wrap gap-2">
   <Button asChild><SpaceLink to={`/sources/goals/new${projectId?`?project_id=${projectId}`:''}`}>{t('sourceGoals.begin')}</SpaceLink></Button>
   <Button variant="outline" onClick={()=>setSave(true)}>{t('reading.startSaveArticle')}</Button>
   <Button variant="outline" asChild><SpaceLink to={projectId?`/projects/${projectId}/sources?tab=settings`:'/sources/goals'}>{t('sourceGoals.continue')}</SpaceLink></Button>
  </div>
  {save&&<SaveReadingUrlDialog spaceId={spaceId} projectId={projectId} onClose={changed=>{setSave(false);if(changed){setAttempt(n=>n+1);onChanged()}}}/>}
 </Card>
}
