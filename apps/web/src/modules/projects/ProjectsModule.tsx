import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Skeleton } from '../../components/ui/skeleton'

// Each project sub-route pulls in a genuinely separate page (and, for the
// research Area, its own large dependency tree — notebook, reading
// list, checklist, chat panel). Without per-route lazy loading, opening the
// plain project detail page forced the browser to also fetch and parse
// every other sub-route's modules up front, competing with this page's own
// data requests for the same connection pool.
const ProjectsPage = lazy(() => import('./ProjectsPage'))
const ProjectDetailPage = lazy(() => import('./ProjectDetailPage'))
const SourcesAreaPage = lazy(() => import('./SourcesAreaPage'))
const ProjectFilesPage = lazy(() => import('../project_files/ProjectFilesPage'))
const ProjectFolderSettingsPage = lazy(() => import('../project_files/ProjectFolderSettingsPage'))
const InquiryAreaPage = lazy(() => import('./InquiryAreaPage'))
const QuestionAssessmentPage = lazy(() => import('./QuestionAssessmentPage'))
const DecisionAreaPage = lazy(() => import('./DecisionAreaPage'))
const ResearchReportPage = lazy(() => import('./ResearchReportPage'))
const ResearchAreaPage = lazy(() => import('./ResearchAreaPage'))
const ProjectAreaLayout = lazy(() => import('./ProjectAreaLayout'))
const ProjectBoardPage = lazy(() => import('./board/ProjectBoardPage'))
const ProjectConversationsPage = lazy(() => import('./ProjectConversationsPage'))
const TaskDetailPage = lazy(() => import('../tasks/TaskDetailPage'))
const ProjectUpdatesPage = lazy(() => import('./ProjectUpdatesPage'))
const ProjectRoomsPage = lazy(() => import('../agent_groups/AgentGroupsPage'))
const ProjectNotesPage = lazy(() => import('./notes/ProjectNotesPage'))

function PageFallback() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

export default function ProjectsModule() {
  return (
    <Routes>
      <Route index element={<Suspense fallback={<PageFallback />}><ProjectsPage /></Suspense>} />
      <Route path=":projectId" element={<Suspense fallback={<PageFallback />}><ProjectAreaLayout /></Suspense>}>
        <Route index element={<Suspense fallback={<PageFallback />}><ProjectDetailPage /></Suspense>} />
        <Route path="sources" element={<Suspense fallback={<PageFallback />}><SourcesAreaPage /></Suspense>} />
        {/* Folded into the Sources Area as tabs; the old links keep working. */}
        <Route path="digest" element={<Navigate to="../sources?tab=digest" replace />} />
        <Route path="raw" element={<Navigate to="../sources?tab=raw" replace />} />
        <Route path="files" element={<Suspense fallback={<PageFallback />}><ProjectFilesPage /></Suspense>} />
        <Route path="folders/:folderId" element={<Suspense fallback={<PageFallback />}><ProjectFolderSettingsPage /></Suspense>} />
        <Route path="inquiry" element={<Suspense fallback={<PageFallback />}><InquiryAreaPage /></Suspense>} />
        <Route path="inquiry/:threadId/assess" element={<Suspense fallback={<PageFallback />}><QuestionAssessmentPage /></Suspense>} />
        {/* Folded into Inquiry as views; the old links keep working. */}
        <Route path="experiments" element={<Navigate to="../inquiry?view=experiments" replace />} />
        <Route path="decisions" element={<Suspense fallback={<PageFallback />}><DecisionAreaPage /></Suspense>} />
        {/* Retired from the Project: Learning is a Space-level concern, and
            Operations was Space-level objects filtered to the Project plus the
            research rows that now live on Research's Runs tab. */}
        <Route path="learning" element={<Navigate to=".." replace />} />
        <Route path="knowledge-review" element={<Navigate to="../inquiry?view=review&tab=candidates" replace />} />
        <Route path="board" element={<Suspense fallback={<PageFallback />}><ProjectBoardPage /></Suspense>} />
        {/* A Task belonging to a Project opens inside the Project, so the
            Board, the Areas and the chat panel stay where they were. The
            top-level /tasks/:taskId route still resolves the same page for
            deep links and for the cross-Project Tasks list. */}
        <Route path="tasks/:taskId" element={<Suspense fallback={<PageFallback />}><TaskDetailPage /></Suspense>} />
        <Route path="updates" element={<Suspense fallback={<PageFallback />}><ProjectUpdatesPage /></Suspense>} />
        <Route path="conversations" element={<Suspense fallback={<PageFallback />}><ProjectConversationsPage /></Suspense>} />
        {/* Delivery was a second, flatter task list over the same rows. The
            Board replaced it; the old link keeps working. */}
        <Route path="delivery" element={<Navigate to="../board" replace />} />
        <Route path="operations" element={<Navigate to="../research?tab=runs" replace />} />
        <Route path="rooms" element={<Suspense fallback={<PageFallback />}><ProjectRoomsPage /></Suspense>} />
        {/* Splat, like /knowledge/notes: the open note changes the URL without
            remounting the surface, so its tree and tabs stay alive. */}
        <Route path="notes/*" element={<Suspense fallback={<PageFallback />}><ProjectNotesPage /></Suspense>} />
        <Route path="research/reports/:reportId" element={<Suspense fallback={<PageFallback />}><ResearchReportPage /></Suspense>} />
        <Route path="research" element={<Suspense fallback={<PageFallback />}><ResearchAreaPage /></Suspense>} />
      </Route>
    </Routes>
  )
}
