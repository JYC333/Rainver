import { Archive } from 'lucide-react'
import { toast } from 'sonner'
import { knowledgeApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { KnowledgeRelation, Proposal } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { fmt } from './utils'

interface KnowledgeRelationsPanelProps {
  currentItemId: string
  relations: KnowledgeRelation[]
  loading: boolean
  error: string | null
  onProposalCreated: (proposal: Proposal) => void
}

export default function KnowledgeRelationsPanel({
  currentItemId,
  relations,
  loading,
  error,
  onProposalCreated,
}: KnowledgeRelationsPanelProps) {
  async function proposeArchive(relationId: string) {
    try {
      const p = await knowledgeApi.proposeRelationArchive(relationId)
      onProposalCreated(p)
      toast.success('Relation archive proposal created')
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <Card>
      <CardTitle>Relations ({relations.length})</CardTitle>
      {loading && <p className="text-sm text-muted-foreground py-6 text-center">Loading relations...</p>}
      {!loading && error && (
        <p className="text-sm text-muted-foreground py-6 text-center">Relations unavailable: {error}</p>
      )}
      {!loading && !error && relations.length === 0 && (
        <p className="text-sm text-muted-foreground py-6 text-center">No visible relations.</p>
      )}
      {!loading && !error && relations.length > 0 && (
        <div className="divide-y divide-border mt-3">
          {relations.map(r => {
            const currentSide = r.from_object_id === currentItemId ? 'from' : 'to'
            const otherId = currentSide === 'from' ? r.to_object_id : r.from_object_id
            return (
              <div key={r.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">{r.link_type}</Badge>
                    <Badge variant="outline">{r.status}</Badge>
                    <Badge variant="muted">current is {currentSide}</Badge>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => proposeArchive(r.id)}>
                    <Archive className="size-3.5" />Propose archive relation
                  </Button>
                </div>
                <div className="grid gap-1 mt-2 text-xs text-muted-foreground">
                  <p>relation_id <span className="font-mono select-all text-foreground">{r.id}</span></p>
                  <p>from_object_id <span className="font-mono select-all text-foreground">{r.from_object_id}</span></p>
                  <p>to_object_id <span className="font-mono select-all text-foreground">{r.to_object_id}</span></p>
                  <p>other endpoint <span className="font-mono select-all text-foreground">{otherId}</span></p>
                </div>
                {r.evidence_summary && <p className="text-muted-foreground mt-2">{r.evidence_summary}</p>}
                <p className="text-xs text-muted-foreground mt-1">confidence {r.confidence ?? '-'} · updated {fmt(r.updated_at)}</p>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
