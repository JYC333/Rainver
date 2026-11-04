import {spacePath} from '../../core/navigation'
import {Navigate,useParams,useSearchParams} from 'react-router-dom'
import {researchPageDestination} from './problemWorkspace/researchLinks'
export default function ResearchAreaPage(){const {projectId='',spaceId}=useParams(),[params]=useSearchParams();return <Navigate to={spacePath(spaceId??null,researchPageDestination(projectId,params))} replace/>}
