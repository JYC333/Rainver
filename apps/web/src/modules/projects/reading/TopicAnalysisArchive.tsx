import {projectReadingApi} from '../../../api/client'
import {spacePath} from '../../../core/navigation'
import {BriefingView} from '../../library/briefing/BriefingView'
import {projectReaderHref} from '../../library/readingLinks'
import {useReadingResource} from './useReadingResource'
import {ReadingFeedback} from './ReadingFeedback'
/** An independently published topic analysis can be read before its edition is assembled. */
export function TopicAnalysisArchive({space,project,id}:{space:string;project:string;id:string}){
 const read=useReadingResource(`${space}:${project}:${id}`,signal=>projectReadingApi.archivedTheme(space,project,id,{signal}))
 return <div className="space-y-4"><ReadingFeedback loading={read.loading} error={read.error} retry={read.reload}/>{read.data&&<BriefingView briefing={read.data} evidenceHref={e=>spacePath(space,projectReaderHref(project,e.source_item_id,`/projects/${project}/sources?tab=overview&archive=theme&briefing=${encodeURIComponent(id)}`,e.original_snapshot_id))}/>}</div>
}
