import { Suspense, type ReactNode } from 'react'
import { Skeleton } from '../components/ui/skeleton'
import ErrorBoundary from './ErrorBoundary'

export function PageLoader() {
  return (
    <div className="space-y-3 p-6">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  )
}

/** A lazily loaded page: a failed import shows the update-aware panel. */
export function SuspensePage({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        {children}
      </Suspense>
    </ErrorBoundary>
  )
}
