import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import { Skeleton } from '../../components/ui/skeleton'

const AccessPage=lazy(()=>import('./SourceAccessPage'))
const SourcesPage = lazy(() => import('./SourceChannelsPage'))
const SourceDetailPage = lazy(() => import('./SourceChannelDetailPage'))

function PageFallback() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

export default function SourcesModule() {
  return (
    <Routes>
      <Route path="access" element={<Suspense fallback={<PageFallback />}><AccessPage /></Suspense>} />
      <Route index element={<Suspense fallback={<PageFallback />}><SourcesPage /></Suspense>} />
      <Route path=":sourceId" element={<Suspense fallback={<PageFallback />}><SourceDetailPage /></Suspense>} />
    </Routes>
  )
}
