import {useParams,useSearchParams} from 'react-router-dom'
import {useSpace} from '../../contexts/SpaceContext'
import {useSpaceNavigate} from '../../core/spaceNav'
import {ConversationScope} from '../conversation/ConversationScope'
import {TopicCreate} from './topics/TopicCreate'
import {TopicDetail} from './topics/TopicDetail'

/** Personal (`/library/reading/goals/...`) and Project
 * (`/projects/:projectId/sources/goals/...`) topic routes share this page. */
export default function SourceGoalPage(){
 const {activeSpaceId,userId}=useSpace();const {goalId,projectId:routeProjectId}=useParams();const [query]=useSearchParams();const projectId=routeProjectId??query.get('project_id');const navigate=useSpaceNavigate()
 if(!activeSpaceId)return null
 const key=`${activeSpaceId}:${projectId??''}:${goalId??'new'}`
 if(!goalId||goalId==='new')return <TopicCreate key={key} spaceId={activeSpaceId} userId={userId??''} projectId={projectId} legacyChannel={query.get('channel_id')} navigate={navigate}/>
 return <ConversationScope spaceId={activeSpaceId}><TopicDetail key={key} spaceId={activeSpaceId} userId={userId??null} id={goalId} navigate={navigate}/></ConversationScope>
}
