import { Navigate, Routes, Route } from 'react-router-dom'
import AgentFormPage from './AgentFormPage'
import AgentDetailPage from './AgentDetailPage'
import AssistantChatPage from './AssistantChatPage'
import RoleLibraryPage from './RoleLibraryPage'
import RoleDetailPage from './RoleDetailPage'
import CreateFromRolePage from './CreateFromRolePage'

export default function AgentsModule() {
  return (
    <Routes>
      {/* The Agent list is My Agents, across Spaces; an old in-Space link lands there. */}
      <Route index element={<Navigate to="/my-agents" replace />} />
      <Route path="new" element={<AgentFormPage />} />
      <Route path="roles" element={<RoleLibraryPage />} />
      <Route path="roles/:roleId" element={<RoleDetailPage />} />
      <Route path="roles/:roleId/use" element={<CreateFromRolePage />} />
      <Route path=":agentId/chat" element={<AssistantChatPage />} />
      <Route path=":agentId" element={<AgentDetailPage />} />
    </Routes>
  )
}
