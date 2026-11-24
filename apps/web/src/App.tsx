import { lazy, Suspense } from 'react'
import { createBrowserRouter, createRoutesFromElements, RouterProvider, Outlet, Route, Navigate, useLocation } from 'react-router-dom'
import { SpaceProvider } from './contexts/SpaceContext'
import { AuthProvider } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { UpdateNotAppliedNotice } from './core/UpdateNotAppliedNotice'
import ErrorBoundary from './core/ErrorBoundary'
import { PageLoader } from './core/SuspensePage'
import LoginPage from './pages/LoginPage'
import AcceptInvitationPage from './pages/AcceptInvitationPage'
import RegistrationPage from './pages/RegistrationPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import { useAuth } from './contexts/AuthContext'
import { loadAuthenticatedApp } from './core/loadAuthenticatedApp'
import './i18n'

// The Shell and every signed-in route. Kept out of the boot chunk so the
// sign-in screen, its offline copy and the worker's precache stay small.
const AuthenticatedApp = lazy(loadAuthenticatedApp)

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

// One boundary that is already on screen: signing in navigates in a
// transition, so the sign-in page stays until the signed-in chunk is ready
// instead of committing a second loading fallback (and React's reveal delay)
// before the destination page's own.
function SpaceRoutes() {
  return (
    <SpaceProvider>
      <Suspense fallback={<PageLoader />}>
        <Outlet />
      </Suspense>
    </SpaceProvider>
  )
}

const routes = createRoutesFromElements(
  <Route element={<SpaceRoutes />}>
    {/* Public routes stay outside the Shell. */}
    <Route path="/login" element={<LoginPage />} />
    <Route path="/register" element={<RegistrationPage />} />
    <Route path="/invitations/claim" element={<AcceptInvitationPage />} />
    <Route path="/reset-password" element={<ResetPasswordPage />} />

    {/* AuthenticatedApp matches the rest with its own descendant routes. */}
    <Route path="*" element={<RequireAuth><ErrorBoundary><AuthenticatedApp /></ErrorBoundary></RequireAuth>} />
  </Route>,
)

let browserRouter: ReturnType<typeof createBrowserRouter> | undefined

export default function App() {
  const router = browserRouter ??= createBrowserRouter(routes, { future: { v7_relativeSplatPath: true } })
  return (
    <ThemeProvider>
      <AuthProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
        <UpdateNotAppliedNotice />
      </AuthProvider>
    </ThemeProvider>
  )
}
