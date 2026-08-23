import { Routes, Route } from 'react-router-dom'
import CommandCenterPage from './CommandCenterPage'
import ThreadDetailPage from './ThreadDetailPage'

export default function CommandCenterModule() {
  return (
    <Routes>
      <Route index element={<CommandCenterPage />} />
      <Route path="threads/:threadId" element={<ThreadDetailPage />} />
    </Routes>
  )
}
