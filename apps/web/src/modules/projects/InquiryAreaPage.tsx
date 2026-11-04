import {lazy,Suspense} from 'react'
import {useSpace} from '../../contexts/SpaceContext'
import {useParams,useSearchParams} from 'react-router-dom'
import ProblemAreaPage from './problemWorkspace/ProblemAreaPage'
const AuxiliaryViews=lazy(()=>import('./InquiryAuxiliaryViews'))
export default function InquiryAreaPage(){const [params]=useSearchParams();const {projectId}=useParams();const {activeSpaceId}=useSpace();return ['map','review','experiments'].includes(params.get('view')??'')?<Suspense fallback={<p>…</p>}><AuxiliaryViews key={`${activeSpaceId}:${projectId}`}/></Suspense>:<ProblemAreaPage key={activeSpaceId??''}/>}
