import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { knowledgeApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg, isNotFoundError } from '../../lib/utils'
import type { KnowledgeItem, KnowledgeRelation, Proposal } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import KnowledgeDetailHeader from './KnowledgeDetailHeader'
import { FocusAreaField } from '../focusAreas/FocusAreaField'
import KnowledgeProposalNotice from './KnowledgeProposalNotice'
import KnowledgeRelationProposalForm from './KnowledgeRelationProposalForm'
import KnowledgeRelationsPanel from './KnowledgeRelationsPanel'
import KnowledgeUpdateProposalForm from './KnowledgeUpdateProposalForm'

export default function KnowledgeDetailPage() {
  const { itemId = '' } = useParams()
  const { activeSpaceId, activeSpaceName, userId } = useSpace()
  const [item, setItem] = useState<KnowledgeItem | null>(null)
  const [relations, setRelations] = useState<KnowledgeRelation[]>([])
  const [loadingItem, setLoadingItem] = useState(true)
  const [loadingRelations, setLoadingRelations] = useState(false)
  const [relationsError, setRelationsError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [lastProposal, setLastProposal] = useState<Proposal | null>(null)
  const [archiving, setArchiving] = useState(false)

  const loadRelations = useCallback(async (knowledgeItemId: string) => {
    setLoadingRelations(true)
    setRelationsError(null)
    try {
      setRelations(await knowledgeApi.relations(knowledgeItemId))
    } catch (e) {
      setRelations([])
      setRelationsError(errMsg(e))
    } finally {
      setLoadingRelations(false)
    }
  }, [])

  const loadItem = useCallback(async () => {
    if (!itemId || !activeSpaceId) {
      setItem(null)
      setRelations([])
      setLoadingItem(false)
      return
    }
    setLoadingItem(true)
    setNotFound(false)
    setRelations([])
    setRelationsError(null)
    try {
      const nextItem = await knowledgeApi.get(itemId)
      setItem(nextItem)
      await loadRelations(nextItem.id)
    } catch (e) {
      if (isNotFoundError(e)) setNotFound(true)
      else toast.error(errMsg(e))
      setItem(null)
      setRelations([])
    } finally {
      setLoadingItem(false)
    }
  }, [activeSpaceId, itemId, loadRelations])

  useEffect(() => { loadItem() }, [loadItem])

  async function submitArchiveProposal() {
    if (!item) return
    setArchiving(true)
    try {
      const p = await knowledgeApi.proposeArchive(item.id)
      setLastProposal(p)
      toast.success('Archive proposal created')
    } catch (e) {
      if (isNotFoundError(e)) setNotFound(true)
      toast.error(errMsg(e))
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <Button variant="ghost" size="sm" asChild>
        <Link to="/knowledge/wiki"><ArrowLeft className="size-4 mr-1" />Wiki</Link>
      </Button>

      {loadingItem && <Skeleton className="h-48 w-full" />}

      {!loadingItem && (!activeSpaceId || notFound || !item) && (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {activeSpaceId
            ? 'Knowledge item not found or not authorized.'
            : 'Select an operational space to inspect this knowledge item.'}
        </Card>
      )}

      {!loadingItem && item && (
        <>
          <KnowledgeDetailHeader
            item={item}
            activeSpaceName={activeSpaceName}
            activeSpaceId={activeSpaceId}
            archiving={archiving}
            onArchive={submitArchiveProposal}
          />
          <FocusAreaField
            targetKind="object"
            targetId={item.id}
            focusAreaId={item.focus_area_id}
            canEdit={Boolean(userId) && (item.owner_user_id === null || item.owner_user_id === userId)}
            onChanged={(focusAreaId) => setItem((current) => current?.id === item.id
              ? { ...current, focus_area_id: focusAreaId }
              : current)}
          />
          {lastProposal && <KnowledgeProposalNotice proposal={lastProposal} />}
          <KnowledgeUpdateProposalForm item={item} onProposalCreated={setLastProposal} />
          <KnowledgeRelationsPanel
            currentItemId={item.id}
            relations={relations}
            loading={loadingRelations}
            error={relationsError}
            onProposalCreated={setLastProposal}
          />
          <KnowledgeRelationProposalForm currentItemId={item.id} onProposalCreated={setLastProposal} />
        </>
      )}
    </div>
  )
}
