import {Badge} from '../../components/ui/badge'
import {useEffect,useState} from 'react'
import type {SourceGoalDetail} from '@rainver/protocol'
import {sourceGoalsApi} from '../../api/client'
import {SpaceLink} from '../../core/spaceNav'
import {Button} from '../../components/ui/button'
import {useAppTranslation} from '../../i18n'
import {readingGoalsPath} from '../sources/sourceGoalNavigation'
type Goal=SourceGoalDetail['goal']
export type ScopeTopics={goals:Goal[]|null;error:boolean;retry:()=>void}
/** Topics of exactly this personal/Project Reading scope, refreshed while
 * background preparation or collection is in flight. */
export function useScopeTopics(spaceId:string,projectId?:string):ScopeTopics{
 const [goals,setGoals]=useState<Goal[]|null>(null);const [error,setError]=useState(false);const [attempt,setAttempt]=useState(0)
 useEffect(()=>{const c=new AbortController();setError(false);void sourceGoalsApi.list({spaceId,signal:c.signal}).then(data=>{if(!c.signal.aborted)setGoals(data.goals.filter(g=>g.status!=='deleted'&&g.project_id===(projectId??null)))}).catch(()=>{if(!c.signal.aborted)setError(true)});return()=>c.abort()},[spaceId,projectId,attempt])
 const hasActiveGoals=goals?.some(g=>['preparing','first_collection','checking'].includes(g.follow_state?.phase??'')||g.status==='exploring'||['queued','working','waiting_for_approval'].includes(g.execution?.phase??''))??false
 useEffect(()=>{if(!hasActiveGoals)return;const timer=setInterval(()=>setAttempt(n=>n+1),5000);return()=>clearInterval(timer)},[hasActiveGoals])
 return {goals,error,retry:()=>setAttempt(n=>n+1)}
}
/** Scoped toolbar destination. The badge counts confirmed following
 * (including background preparation) — never drafts, paused topics or
 * manual-save-only goals. */
export function ReadingGoals({projectId,topics}:{projectId?:string;topics:ScopeTopics}){
 const {t}=useAppTranslation();const {goals,error,retry}=topics
 const following=goals?.filter(g=>g.compatibility_json?.execution_mode!=='manual'&&(g.follow_state?g.follow_state.intent==='following':g.status==='running')).length??0
 return <><Button size="sm" variant="ghost" asChild><SpaceLink aria-label={goals?t('sourceGoals.followingCount',{count:following}):t('sourceGoals.following')} to={readingGoalsPath(projectId)}>{t('sourceGoals.following')}{goals&&<Badge aria-hidden="true" variant="muted" className="ml-1">{following}</Badge>}</SpaceLink></Button>{error&&<Button size="sm" variant="ghost" onClick={retry}>{t('sourceGoals.retry')}</Button>}</>
}
