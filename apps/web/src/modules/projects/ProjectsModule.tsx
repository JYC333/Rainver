import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import { Skeleton } from '../../components/ui/skeleton'

// Each project sub-route pulls in a genuinely separate page (and, for the
// research Area, its own large dependency tree — notebook, reading
// list, checklist, chat panel). Without per-route lazy loading, opening the
// plain project detail page forced the browser to also fetch and parse
// every other sub-route's modules up front, competing with this page's own
// data requests for the same connection pool.
const ProjectsPage = lazy(() => import('./ProjectsPage'))
const ProjectDetailPage = lazy(() => import('./ProjectDetailPage'))
const ProjectSourcesPage = lazy(() => import('./ProjectSourcesPage'))
const ProjectDigestPage = lazy(() => import('./ProjectDigestPage'))
const ProjectFilesPage = lazy(() => import('../project_files/ProjectFilesPage'))
const ProjectFolderSettingsPage = lazy(() => import('../project_files/ProjectFolderSettingsPage'))
const InquiryAreaPage = lazy(() => import('./InquiryAreaPage'))
const QuestionAssessmentPage = lazy(() => import('./QuestionAssessmentPage'))
const ExperimentAreaPage = lazy(() => import('./ExperimentAreaPage'))
const DecisionAreaPage = lazy(() => import('./DecisionAreaPage'))
const LearningAreaPage = lazy(() => import('./LearningAreaPage'))
const KnowledgeReviewPage = lazy(() => import('./KnowledgeReviewPage'))
const ResearchReportPage = lazy(() => import('./ResearchReportPage'))
const ResearchAreaPage = lazy(() => import('./ResearchAreaPage'))
const ProjectAreaLayout = lazy(() => import('./ProjectAreaLayout'))
const DeliveryAreaPage = lazy(() => import('./DeliveryAreaPage'))
const OperationsAreaPage = lazy(() => import('./OperationsAreaPage'))
const ProjectRoomsPage = lazy(() => import('../agent_groups/AgentGroupsPage'))
const ProjectNotesPage = lazy(() => import('./notes/ProjectNotesPage'))
const ProjectRawMaterialPage = lazy(() => import('./ProjectRawMaterialPage'))

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
        <Route path="sources" element={<Suspense fallback={<PageFallback />}><ProjectSourcesPage /></Suspense>} />
        <Route path="digest" element={<Suspense fallback={<PageFallback />}><ProjectDigestPage /></Suspense>} />
        <Route path="files" element={<Suspense fallback={<PageFallback />}><ProjectFilesPage /></Suspense>} />
        <Route path="folders/:folderId" element={<Suspense fallback={<PageFallback />}><ProjectFolderSettingsPage /></Suspense>} />
        <Route path="inquiry" element={<Suspense fallback={<PageFallback />}><InquiryAreaPage /></Suspense>} />
        <Route path="inquiry/:threadId/assess" element={<Suspense fallback={<PageFallback />}><QuestionAssessmentPage /></Suspense>} />
        <Route path="experiments" element={<Suspense fallback={<PageFallback />}><ExperimentAreaPage /></Suspense>} />
        <Route path="decisions" element={<Suspense fallback={<PageFallback />}><DecisionAreaPage /></Suspense>} />
        <Route path="learning" element={<Suspense fallback={<PageFallback />}><LearningAreaPage /></Suspense>} />
        <Route path="knowledge-review" element={<Suspense fallback={<PageFallback />}><KnowledgeReviewPage /></Suspense>} />
        <Route path="delivery" element={<Suspense fallback={<PageFallback />}><DeliveryAreaPage /></Suspense>} />
        <Route path="operations" element={<Suspense fallback={<PageFallback />}><OperationsAreaPage /></Suspense>} />
        <Route path="rooms" element={<Suspense fallback={<PageFallback />}><ProjectRoomsPage /></Suspense>} />
        {/* Splat, like /knowledge/notes: the open note changes the URL without
            remounting the surface, so its tree and tabs stay alive. */}
        <Route path="notes/*" element={<Suspense fallback={<PageFallback />}><ProjectNotesPage /></Suspense>} />
        <Route path="raw" element={<Suspense fallback={<PageFallback />}><ProjectRawMaterialPage /></Suspense>} />
        <Route path="research/reports/:reportId" element={<Suspense fallback={<PageFallback />}><ResearchReportPage /></Suspense>} />
        <Route path="research" element={<Suspense fallback={<PageFallback />}><ResearchAreaPage /></Suspense>} />
      </Route>
    </Routes>
  )
}
