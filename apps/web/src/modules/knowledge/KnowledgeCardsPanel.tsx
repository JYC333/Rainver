import { Card } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import KnowledgeSectionHeader from './KnowledgeSectionHeader'

/**
 * Cards sub-area inside the Knowledge module. This page does not schedule
 * reviews.
 */
export default function KnowledgeCardsPanel() {
  return (
    <div className="p-6 space-y-6">
      <KnowledgeSectionHeader
        section="cards"
        description="Review cards derived from Notes, Wiki items, and Sources."
      />
      <Card>
        <EmptyState
          title="Cards are coming soon"
          description="Spaced-repetition review cards generated from your Notes, Wiki, and Sources will appear here."
        />
      </Card>
    </div>
  )
}
