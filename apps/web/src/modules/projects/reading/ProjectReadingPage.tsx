import {useParams,useSearchParams} from 'react-router-dom'
import {useSpace} from '../../../contexts/SpaceContext'
import {useAppTranslation} from '../../../i18n'
import {Tabs,TabsList,TabsTrigger,TabsContent} from '../../../components/ui/tabs'
import {Button} from '../../../components/ui/button'
import {SpaceLink} from '../../../core/spaceNav'
import {sourceGoalsApi} from '../../../api/client'
import {ProjectComposition} from './ProjectComposition'
import {ProjectMaterials} from './ProjectMaterials'
import {DeepReadList} from './DeepReadList'
import SourceGoalsList from '../../sources/SourceGoalsList'
import {useReadingResource} from './useReadingResource'
import {ReadingFeedback} from './ReadingFeedback'
export default function ProjectReadingPage(){const {activeSpaceId,userId}=useSpace();const {projectId=''}=useParams();return activeSpaceId&&userId?<Scoped key={`${activeSpaceId}:${userId}:${projectId}`} space={activeSpaceId} user={userId} project={projectId}/>:null}
function Scoped({space,user,project}:{space:string;user:string;project:string}){
 const {t}=useAppTranslation();const [params,setParams]=useSearchParams();const requested=params.get('tab');const tab=requested==='materials'||requested==='following'||requested==='deep'?requested:!requested&&params.has('view')?'materials':'overview'
 const goals=useReadingResource(`${space}:${project}`,signal=>sourceGoalsApi.list({spaceId:space,signal}));const scoped=goals.data?.goals.filter(g=>g.project_id===project&&g.status!=='deleted')??[]
 if([401,403,404].includes((goals.error as {status?:number})?.status??0))return <div className="p-4"><ReadingFeedback error={goals.error} retry={goals.reload}/></div>
 return <div className="reading-touch min-w-0 space-y-5 p-4 md:p-6"><header className="flex flex-wrap items-start justify-between gap-3"><h1 className="text-xl font-semibold">{t('nav.library')}</h1><Button variant="ghost" size="sm" asChild><SpaceLink to={`/projects/${project}/sources?tab=settings`}>{t('reading.sources')}</SpaceLink></Button></header><ReadingFeedback error={goals.error} retry={goals.reload}/>
 <Tabs value={tab} onValueChange={v=>{const next=new URLSearchParams(params);next.set('tab',v);setParams(next)}}><TabsList className="flex h-auto w-full flex-wrap gap-1">{['overview','materials','following','deep'].map(v=><TabsTrigger key={v} value={v} className="flex-1 basis-40 whitespace-normal">{t(`projectReading.${v}`)}</TabsTrigger>)}</TabsList>
 <TabsContent value="overview"><ProjectComposition key={params.get('composition')??'latest'} space={space} project={project} goals={scoped}/></TabsContent>
 <TabsContent value="materials"><ProjectMaterials key={`${params.get('view')}:${params.get('topic')}:${params.get('favorite')}`} space={space} project={project} user={user} goals={scoped}/></TabsContent>
 <TabsContent value="following"><SourceGoalsList projectId={project} embedded/></TabsContent>
 <TabsContent value="deep"><DeepReadList key={params.get('ops_offset')??'0'} space={space} project={project} user={user}/></TabsContent></Tabs>
 </div>
}
