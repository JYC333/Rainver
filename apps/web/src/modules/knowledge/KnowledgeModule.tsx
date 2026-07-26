import { Navigate, Routes, Route } from 'react-router-dom'
import { useSpace } from '../../contexts/SpaceContext'
import { spacePath } from '../../core/navigation'
import { readLastKnowledgeSection } from './utils'
import KnowledgeOverviewPage from './KnowledgeOverviewPage'
import NotesPage from './NotesPage'
import NoteEditor from './NoteEditor'
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
 * Knowledge module shell. First-level "Knowledge" replaces the old first-level
 * "Wiki": Notes (working knowledge) and Wiki (canonical knowledge) are peer
 * sub-areas alongside Sources and Cards. Cross-section navigation is the
 * breadcrumb switcher in each page header (KnowledgeSectionHeader) — there is no
 * Knowledge scene sidebar or tab strip. Each section owns its own layout; the
 * Notes section nests the open note under `notes/:noteId` so its tree + tabs
 * stay mounted while switching notes.
 */
export default function KnowledgeModule() {
  return (
    <Routes>
      <Route index element={<KnowledgeIndexRedirect />} />
      <Route path="home" element={<KnowledgeOverviewPage />} />
      <Route path="notes" element={<NotesPage />}>
        <Route path=":noteId" element={<NoteEditor />} />
      </Route>
      <Route path="wiki" element={<KnowledgePage />} />
      <Route path="wiki/:itemId" element={<KnowledgeDetailPage />} />
      <Route path="sources" element={<SourcesPage />} />
      <Route path="cards" element={<KnowledgeCardsPanel />} />
    </Routes>
  )
}
