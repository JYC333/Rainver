import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import { Skeleton } from '../../components/ui/skeleton'

// Each project sub-route pulls in a genuinely separate page (and, for the
// research workspace, its own large dependency tree — notebook, reading
// list, checklist, chat panel). Without per-route lazy loading, opening the
// plain project detail page forced the browser to also fetch and parse
// every other sub-route's modules up front, competing with this page's own
// data requests for the same connection pool.
const ProjectsPage = lazy(() => import('./ProjectsPage'))
const ProjectDetailPage = lazy(() => import('./ProjectDetailPage'))
const ProjectSourcesPage = lazy(() => import('./ProjectSourcesPage'))
const ProjectChatPage = lazy(() => import('./ProjectChatPage'))
const ResearchReportPage = lazy(() => import('./ResearchReportPage'))
const ResearchWorkspacePage = lazy(() => import('./ResearchWorkspacePage'))

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
      <Route path=":projectId/sources" element={<Suspense fallback={<PageFallback />}><ProjectSourcesPage /></Suspense>} />
      <Route path=":projectId/chat" element={<Suspense fallback={<PageFallback />}><ProjectChatPage /></Suspense>} />
      <Route path=":projectId/research/reports/:reportId" element={<Suspense fallback={<PageFallback />}><ResearchReportPage /></Suspense>} />
      <Route path=":projectId/research" element={<Suspense fallback={<PageFallback />}><ResearchWorkspacePage /></Suspense>} />
      <Route path=":projectId" element={<Suspense fallback={<PageFallback />}><ProjectDetailPage /></Suspense>} />
    </Routes>
  )
}
