import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { SpaceProvider } from './contexts/SpaceContext'
import { AuthProvider } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { TooltipProvider } from './components/ui/tooltip'
import Shell from './core/Shell'
import ErrorBoundary from './core/ErrorBoundary'
import { MODULE_REGISTRY, type Module } from './modules/registry'
import { Skeleton } from './components/ui/skeleton'
import LoginPage from './pages/LoginPage'
import AcceptInvitationPage from './pages/AcceptInvitationPage'
import { useAuth } from './contexts/AuthContext'

const HomePage = lazy(() => import('./modules/home/HomePage'))

function PageLoader() {
  return (
    <div className="space-y-3 p-6">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  )
}

function SuspensePage({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        {children}
      </Suspense>
    </ErrorBoundary>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { currentUser, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) return <PageLoader />

  // Always redirect to login if user is not authenticated
  if (!currentUser) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <>{children}</>
}

/** A registered module rendered as a route element. */
function moduleRoute({ path, component: Page, hasSubRoutes }: Module) {
  const routePath = hasSubRoutes ? path.replace(/^\//, '') + '/*' : path.replace(/^\//, '')
  return (
    <Route
      key={path}
      path={routePath}
      element={<SuspensePage><Page /></SuspensePage>}
    />
  )
}

// Space-scoped modules live under /spaces/:spaceId/…; neutral system surfaces stay top-level.
const SPACE_MODULES = MODULE_REGISTRY.filter(m => m.perspectiveType === 'space-scoped')
const TOP_LEVEL_MODULES = MODULE_REGISTRY.filter(m => m.perspectiveType !== 'space-scoped')

export default function App() {
  return (
    <ThemeProvider>
    <AuthProvider>
      <BrowserRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <SpaceProvider>
          <TooltipProvider delayDuration={400}>
            <Routes>
              {/* Public routes — outside Shell */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/invitations/:token" element={<AcceptInvitationPage />} />

              <Route path="/" element={<RequireAuth><Shell /></RequireAuth>}>
                {/* Default landing → user-scoped Home (not a Space) */}
                <Route index element={<Navigate to="/home" replace />} />
                <Route path="home" element={<SuspensePage><HomePage /></SuspensePage>} />

                {/* Neutral, user-level system surfaces — never carry a Space in the URL. */}
                {TOP_LEVEL_MODULES.map(moduleRoute)}

                {/* Space-scoped workspace — every module here operates on the URL's Space. */}
                <Route path="spaces/:spaceId">
                  {/* ADR 0016 D11: the control center is the default home for a Space. */}
                  <Route index element={<Navigate to="command-center" replace />} />
                  {SPACE_MODULES.map(moduleRoute)}
                </Route>

                {/* Unknown paths fall back to Home. */}
                <Route path="*" element={<Navigate to="/home" replace />} />
              </Route>
            </Routes>
          </TooltipProvider>
        </SpaceProvider>
      </BrowserRouter>
    </AuthProvider>
    </ThemeProvider>
  )
}
