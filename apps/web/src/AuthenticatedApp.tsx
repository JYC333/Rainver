import { lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { TooltipProvider } from './components/ui/tooltip'
import Shell from './core/Shell'
import { SuspensePage } from './core/SuspensePage'
import { MODULE_REGISTRY, type Module } from './modules/registry'
import SecurityPage from './pages/SecurityPage'
import GmailCallbackLanding from './modules/sources/gmail/GmailCallbackLanding'
import { RequireInstanceAdmin, RequireSpaceAdmin } from './core/RequireRole'
import './i18n/authenticated'

// Everything behind sign-in. App.tsx loads this chunk only for a signed-in
// person, so the sign-in screen and the offline shell do not download or
// precache the Shell, the module registry, plugin manifests or their strings.

const HomePage = lazy(() => import('./modules/home/HomePage'))

/** A registered module rendered as a route element. */
function moduleRoute({ path, component: Page, hasSubRoutes, requiresSpaceAdmin, requiresInstanceAdmin }: Module) {
  const routePath = hasSubRoutes ? path.replace(/^\//, '') + '/*' : path.replace(/^\//, '')
  let page = <SuspensePage><Page /></SuspensePage>
  if (requiresInstanceAdmin) page = <RequireInstanceAdmin>{page}</RequireInstanceAdmin>
  else if (requiresSpaceAdmin) page = <RequireSpaceAdmin>{page}</RequireSpaceAdmin>
  return (
    <Route
      key={path}
      path={routePath}
      element={page}
    />
  )
}

// Space-scoped modules live under /spaces/:spaceId/…; neutral system surfaces stay top-level.
const SPACE_MODULES = MODULE_REGISTRY.filter(m => m.perspectiveType === 'space-scoped')
const TOP_LEVEL_MODULES = MODULE_REGISTRY.filter(m => m.perspectiveType !== 'space-scoped')

export default function AuthenticatedApp() {
  return (
    <TooltipProvider delayDuration={400}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/home" replace />} />
          <Route path="home" element={<SuspensePage><HomePage /></SuspensePage>} />

          {TOP_LEVEL_MODULES.map(moduleRoute)}
          <Route path="settings/security" element={<SecurityPage />} />
          {/* The Gmail OAuth callback's fixed landing; forwards to the Space's Access page. */}
          <Route path="sources" element={<GmailCallbackLanding />} />

          <Route path="spaces/:spaceId">
            {/* ADR 0016 D11: the control center is the default home for a Space. */}
            <Route index element={<Navigate to="command-center" replace />} />
            {SPACE_MODULES.map(moduleRoute)}
          </Route>

          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
    </TooltipProvider>
  )
}
