import { Archive } from 'lucide-react'
import type { KnowledgeItem } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { ScopeBadge } from '../../components/ScopeBadge'
import { fmt } from './utils'
import { ContentAccessControl } from '../../components/ContentAccessControl'

interface KnowledgeDetailHeaderProps {
  item: KnowledgeItem
  activeSpaceName: string | null
  activeSpaceId: string | null
  archiving: boolean
  onArchive: () => void
}

export function knowledgeProvenance(item: KnowledgeItem): { label: string; value: string | null }[] {
  return [
    { label: 'item_id', value: item.id },
    { label: 'root_item_id', value: item.root_item_id },
    { label: 'supersedes_item_id', value: item.supersedes_item_id },
    { label: 'owner_user_id', value: item.owner_user_id },
    { label: 'created_by_user_id', value: item.created_by_user_id },
    { label: 'created_by_agent_id', value: item.created_by_agent_id },
    { label: 'created_by_run_id', value: item.created_by_run_id },
    { label: 'created_from_proposal_id', value: item.created_from_proposal_id },
    { label: 'approved_by_user_id', value: item.approved_by_user_id },
  ]
}

export default function KnowledgeDetailHeader({
  item,
  activeSpaceName,
  activeSpaceId,
  archiving,
  onArchive,
}: KnowledgeDetailHeaderProps) {
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{item.title}</h1>
          <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ContentAccessControl resourceType="space_object" resourceId={item.id} ownerUserId={item.owner_user_id} />
          <Button size="sm" variant="destructive" onClick={onArchive} disabled={archiving}>
            <Archive className="size-4 mr-1" />Propose archive
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 items-center">
        <Badge variant="secondary">{item.knowledge_kind}</Badge>
        <Badge variant="outline">{item.status}</Badge>
        <ScopeBadge visibility={item.visibility} />
        <Badge variant="muted">{item.verification_status}</Badge>
        <Badge variant="muted">{item.reflection_status}</Badge>
        <Badge variant="outline">v{item.version}</Badge>
        {item.tags.map(tag => <Badge key={tag} variant="outline">{tag}</Badge>)}
      </div>
      <pre className="text-sm whitespace-pre-wrap bg-muted/40 rounded-md p-3 border border-border overflow-auto max-h-[560px]">
        {item.content}
      </pre>
      <div className="grid gap-3 md:grid-cols-2 text-xs text-muted-foreground">
        <p><span className="font-medium text-foreground">format</span> {item.content_format}</p>
        <p><span className="font-medium text-foreground">confidence</span> {item.confidence ?? '-'}</p>
        <p><span className="font-medium text-foreground">created</span> {fmt(item.created_at)}</p>
        <p><span className="font-medium text-foreground">updated</span> {fmt(item.updated_at)}</p>
      </div>
      <details className="rounded-md border border-border bg-muted/20 p-3 text-xs">
        <summary className="cursor-pointer font-medium">Technical provenance</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2 text-muted-foreground">
          {item.source_refs.length > 0 && (
            <pre className="md:col-span-2 whitespace-pre-wrap bg-muted/30 rounded-md p-2 border border-border">
              source_refs {JSON.stringify(item.source_refs, null, 2)}
            </pre>
          )}
          {knowledgeProvenance(item).map(row => (
            <p key={row.label} className="break-all">
              <span className="font-medium text-foreground">{row.label}</span>{' '}
              <span className={row.value ? 'font-mono select-all' : ''}>{row.value ?? '-'}</span>
            </p>
          ))}
        </div>
      </details>
    </Card>
  )
}
