import { useMemo, type ReactNode } from 'react'
import { Navigate, Routes, Route } from 'react-router-dom'
import { useSpace } from '../../contexts/SpaceContext'
import { spacePath } from '../../core/navigation'
import { readLastKnowledgeSection } from './utils'
import KnowledgeOverviewPage from './KnowledgeOverviewPage'
import KnowledgeSectionHeader from './KnowledgeSectionHeader'
import NotesPage from './NotesPage'
import type { NotesSurfaceScope } from './notesPageModel'
import KnowledgePage from './KnowledgePage'
import KnowledgeDetailPage from './KnowledgeDetailPage'
import SourcesPage from './SourcesPage'
import KnowledgeCardsPanel from './KnowledgeCardsPanel'

/**
 * `/knowledge` is a thin entry point, not a section: it redirects to the
 * last-used Knowledge section (Notes on a fresh client). It never lands on the
 * overview — `home` is an intentional destination reached via the breadcrumb
 * switcher or a direct link.
 */
function KnowledgeIndexRedirect() {
  const { activeSpaceId, preferredSpaceId } = useSpace()
  const section = readLastKnowledgeSection()
  return <Navigate to={spacePath(activeSpaceId ?? preferredSpaceId, `/knowledge/${section}`)} replace />
}

/**
 * The Space-wide notes surface: every note in the Space, headed by the Knowledge
 * section switcher. The Project surface is the same page under a different
 * scope — see `NotesSurfaceScope`.
 */
function GlobalNotesPage() {
  const { activeSpaceId } = useSpace()
  const scope = useMemo<NotesSurfaceScope>(() => ({
    basePath: '/knowledge/notes',
    tabsScopeKey: activeSpaceId ?? 'none',
    renderHeader: (actions: ReactNode) => <KnowledgeSectionHeader section="notes" actions={actions} />,
  }), [activeSpaceId])
  return <NotesPage scope={scope} />
}

/**
 * Knowledge module shell. First-level "Knowledge" replaces the old first-level
 * "Wiki": Notes (working knowledge) and Wiki (canonical knowledge) are peer
 * sub-areas alongside Sources and Cards. Cross-section navigation is the
 * breadcrumb switcher in each page header (KnowledgeSectionHeader) — there is no
 * Knowledge scene sidebar or tab strip. Each section owns its own layout; the
 * Notes section claims `notes/*` so the open note changes the URL without
 * remounting the page, keeping its tree + tabs alive across note switches.
 */
export default function KnowledgeModule() {
  return (
    <Routes>
      <Route index element={<KnowledgeIndexRedirect />} />
      <Route path="home" element={<KnowledgeOverviewPage />} />
      <Route path="notes/*" element={<GlobalNotesPage />} />
      <Route path="wiki" element={<KnowledgePage />} />
      <Route path="wiki/:itemId" element={<KnowledgeDetailPage />} />
      <Route path="sources" element={<SourcesPage />} />
      <Route path="cards" element={<KnowledgeCardsPanel />} />
    </Routes>
  )
}
