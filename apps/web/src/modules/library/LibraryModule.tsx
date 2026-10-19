import { lazy, Suspense } from 'react'
import { Navigate, Routes, Route } from 'react-router-dom'
import { Skeleton } from '../../components/ui/skeleton'

const LibraryPage = lazy(() => import('./LibraryPage'))
const LibraryItemsPage = lazy(() => import('./LibraryPage').then(module => ({ default: module.LibraryItemsPage })))
const LibraryArticlesPage = lazy(() => import('./LibraryPage').then(module => ({ default: module.LibraryArticlesPage })))
const LibraryEmailsPage = lazy(() => import('./LibraryPage').then(module => ({ default: module.LibraryEmailsPage })))
const LibraryVideosPage = lazy(() => import('./LibraryPage').then(module => ({ default: module.LibraryVideosPage })))
const LibraryPodcastsPage = lazy(() => import('./LibraryPage').then(module => ({ default: module.LibraryPodcastsPage })))
const LibraryPdfsPage = lazy(() => import('./LibraryPage').then(module => ({ default: module.LibraryPdfsPage })))
const LibraryDigestsPage = lazy(() => import('./LibraryPage').then(module => ({ default: module.LibraryDigestsPage })))
const LibraryDetailPage = lazy(() => import('./LibraryDetailPage'))
const LibraryItemReaderPage = lazy(() => import('./LibraryItemReaderPage'))

function PageFallback() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

export default function LibraryModule() {
  return (
    <Routes>
      <Route element={<Suspense fallback={<PageFallback />}><LibraryPage /></Suspense>}>
        <Route index element={<Navigate to="items" replace />} />
        <Route path="items" element={<Suspense fallback={<PageFallback />}><LibraryItemsPage /></Suspense>} />
        <Route path="items/articles" element={<Suspense fallback={<PageFallback />}><LibraryArticlesPage /></Suspense>} />
        <Route path="items/emails" element={<Suspense fallback={<PageFallback />}><LibraryEmailsPage /></Suspense>} />
        <Route path="items/videos" element={<Suspense fallback={<PageFallback />}><LibraryVideosPage /></Suspense>} />
        <Route path="items/podcasts" element={<Suspense fallback={<PageFallback />}><LibraryPodcastsPage /></Suspense>} />
        <Route path="items/pdfs" element={<Suspense fallback={<PageFallback />}><LibraryPdfsPage /></Suspense>} />
        <Route path="digests" element={<Suspense fallback={<PageFallback />}><LibraryDigestsPage /></Suspense>} />
      </Route>
      {/* Standalone reader: items reached outside a day's digest
          (project pages and direct links) have no prev/next. */}
      <Route path="items/:itemId" element={<Suspense fallback={<PageFallback />}><LibraryItemReaderPage /></Suspense>} />
      <Route path="digests/:connectionId/:date" element={<Suspense fallback={<PageFallback />}><LibraryDetailPage /></Suspense>} />
      {/* Day-scoped reader: gains prev/next across that day's briefing items. */}
      <Route path="digests/:connectionId/:date/items/:itemId" element={<Suspense fallback={<PageFallback />}><LibraryItemReaderPage /></Suspense>} />
    </Routes>
  )
}
