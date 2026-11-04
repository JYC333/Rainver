// Map, review and experiment views over the Project's problems.
import {useCallback,useEffect,useState} from 'react'
import {useParams,useSearchParams} from 'react-router-dom'
import {inquiryApi} from '../../api/client'
import type {InquiryCandidate,InquiryThread} from '../../types/api'
import {Button} from '../../components/ui/button'
import {Tabs,TabsList,TabsTrigger,TabsContent} from '../../components/ui/tabs'
import {MapView} from './inquiryArea/MapView'
import {ReviewView} from './inquiryArea/ReviewView'
import {CreateThreadDialog} from './inquiryArea/dialogs'
import KnowledgeReviewPage from './KnowledgeReviewPage'
import ExperimentAreaPage from './ExperimentAreaPage'
import {errMsg} from '../../lib/utils'
export default function InquiryAuxiliaryViews(){
 const {projectId}=useParams();const [params,setParams]=useSearchParams();
 const [threads,setThreads]=useState<InquiryThread[]>([]),[candidates,setCandidates]=useState<InquiryCandidate[]>([]),[deferred,setDeferred]=useState<InquiryCandidate[]>([]);
 const [error,setError]=useState<string|null>(null),[open,setOpen]=useState(false);
 const view=params.get('view')??'map';
 const refresh=useCallback(async()=>{if(!projectId)return;try{const [t,c,d]=await Promise.all([inquiryApi.listThreads(projectId),inquiryApi.listCandidates(projectId),inquiryApi.listCandidates(projectId,'deferred')]);setThreads(t);setCandidates(c);setDeferred(d);setError(null)}catch(e){setError(errMsg(e))}},[projectId]);
 useEffect(()=>{void refresh()},[refresh]);
 const select=(id:string)=>{const next=new URLSearchParams();next.set('thread',id);setParams(next)};
 if(!projectId)return null;
 return <div className="space-y-4"><div className="flex flex-wrap items-center gap-3"><Tabs value={view} onValueChange={v=>{const next=new URLSearchParams(params);next.set('view',v);setParams(next)}}><TabsList><TabsTrigger value="map">Map</TabsTrigger><TabsTrigger value="review">Review</TabsTrigger><TabsTrigger value="experiments">Experiments</TabsTrigger></TabsList></Tabs><Button onClick={()=>setOpen(true)}>New question</Button></div>
 {error&&<p role="alert" className="text-destructive">{error}</p>}
 {view==='map'&&<MapView projectId={projectId} threads={threads} candidates={candidates} selectedId={params.get('thread')} onSelect={select}/>}
 {view==='review'&&<Tabs defaultValue={params.get('tab')==='candidates'?'candidates':'inquiry'}><TabsList><TabsTrigger value="inquiry">Inquiry</TabsTrigger><TabsTrigger value="candidates">Knowledge candidates</TabsTrigger></TabsList><TabsContent value="inquiry"><ReviewView projectId={projectId} threads={threads} candidates={candidates} deferredCandidates={deferred} onOpenThread={select} onChanged={refresh}/></TabsContent><TabsContent value="candidates"><KnowledgeReviewPage embedded/></TabsContent></Tabs>}
 {view==='experiments'&&<ExperimentAreaPage embedded/>}
 <CreateThreadDialog open={open} onOpenChange={setOpen} projectId={projectId} defaultKind="question" onCreated={id=>{void refresh();select(id)}}/>
 </div>
}
