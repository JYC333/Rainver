import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Layers } from 'lucide-react'
import { toast } from 'sonner'
import { contextApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { ContextPackage, Memory } from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Badge } from '../../components/ui/badge'
import { ContextArtifactPicker } from '../artifacts/ContextArtifactPicker'
import { ProjectFolderSelectors } from '../../components/ProjectFolderSelectors'
import { TechnicalIdField } from '../../components/TechnicalIdField'

interface ContextForm {
  project_folder_id: string
  project_id: string
  session_id: string
  capability_id: string
  query: string
}

interface AttachmentPreview {
  attachment_type?: string
  artifact_id?: string
  artifact_type?: string
  label?: string
  domain_label?: string
  approved?: boolean
  resolved_content?: string
  rejection_reason?: string
  policy_snapshot?: Record<string, unknown>
  source_policy_snapshot?: Record<string, unknown>
}

const SUMMARY_ROWS: [string, keyof ContextPackage][] = [
  ['User Memory',       'user_memory'],
  ['Folder Memory',      'project_folder_memory'],
  ['Capability Memory', 'capability_memory'],
  ['Agent Memory',      'agent_memory'],
  ['System Policy',     'system_policy'],
  ['Episodes',          'relevant_episodes'],
  ['Session Summaries', 'recent_session_summary'],
]

export default function ContextPreviewPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [searchParams, setSearchParams] = useSearchParams()
  const [form, setForm] = useState<ContextForm>({
    project_folder_id: searchParams.get('project_folder_id') ?? '',
    project_id: searchParams.get('project_id') ?? '',
    session_id: '',
    capability_id: '',
    query: '',
  })
  const [pkg, setPkg]   = useState<ContextPackage | null>(null)
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>(() => initialArtifactIds(searchParams))
  const [loading, setLoading] = useState(false)

  function setField(k: keyof ContextForm, v: string) { setForm(f => ({ ...f, [k]: v })) }

  useEffect(() => {
    const urlIds = initialArtifactIds(searchParams)
    if (urlIds.length > 0) setSelectedArtifactIds(urlIds.slice(0, 8))
    const projectFolderId = searchParams.get('project_folder_id')
    const projectId = searchParams.get('project_id')
    if (projectFolderId) setForm(current => ({ ...current, project_folder_id: projectFolderId }))
    if (projectId) setForm(current => ({ ...current, project_id: projectId }))
  }, [searchParams])

  function updateSelectedArtifactIds(next: string[]) {
    setSelectedArtifactIds(next)
    setSearchParams(params => {
      if (next.length > 0) params.set('artifact_ids', next.join(','))
      else {
        params.delete('artifact_ids')
        params.delete('artifact_id')
      }
      const projectFolderId = form.project_folder_id.trim()
      const projectId = form.project_id.trim()
      if (projectFolderId) params.set('project_folder_id', projectFolderId)
      else params.delete('project_folder_id')
      if (projectId) params.set('project_id', projectId)
      else params.delete('project_id')
      return params
    })
  }

  async function build() {
    if (!activeSpaceId) {
      toast.error('Select an operational space before building context')
      return
    }
    setLoading(true)
    try {
      setPkg(await contextApi.build({
        project_folder_id:   form.project_folder_id.trim()   || null,
        project_id:     form.project_id.trim()     || null,
        session_id:    form.session_id.trim()    || null,
        capability_id: form.capability_id.trim() || null,
        query:         form.query.trim()          || null,
        context_artifact_ids: selectedArtifactIds,
      }))
    } catch (e) { toast.error(errMsg(e)) }
    finally { setLoading(false) }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Layers className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Context Preview</h1>
          <p className="text-sm text-muted-foreground">Build and inspect context packages assembled for agent runs.</p>
          <p className="text-xs text-muted-foreground">
            Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}
          </p>
        </div>
      </div>

      <Card>
        <CardTitle>Build Context Package</CardTitle>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <ProjectFolderSelectors
            projectId={form.project_id}
            folderId={form.project_folder_id}
            onProjectChange={value => setField('project_id', value)}
            onFolderChange={value => setField('project_folder_id', value)}
          />
          <TechnicalIdField label="Session ID (optional)" value={form.session_id} onChange={value => setField('session_id', value)} />
          <TechnicalIdField label="Capability ID (optional)" value={form.capability_id} onChange={value => setField('capability_id', value)} placeholder="e.g. memory.reflect" />
        </div>
        <div className="mb-3">
          <Label>Query (optional — relevance search)</Label>
          <Input value={form.query} onChange={e => setField('query', e.target.value)} placeholder="What are you building?" />
        </div>
        <Button onClick={build} disabled={loading || !activeSpaceId}>{loading ? 'Building…' : 'Build Context'}</Button>
        {!activeSpaceId && (
          <p className="text-xs text-muted-foreground mt-2">Select an operational space to build a context package.</p>
        )}
      </Card>

      <Card>
        <ContextArtifactPicker
          selectedArtifactIds={selectedArtifactIds}
          onChange={updateSelectedArtifactIds}
          projectFolderId={form.project_folder_id}
          projectId={form.project_id}
        />
      </Card>

      {pkg && (
        <>
          <Card>
            <CardTitle>Summary</CardTitle>
            <div className="flex flex-wrap gap-3">
              {SUMMARY_ROWS.map(([label, key]) => {
                const arr = pkg[key] as Memory[]
                return (
                  <div key={label} className="bg-background border border-border rounded-md p-3 min-w-[110px]">
                    <div className="text-[11px] text-muted-foreground mb-1">{label}</div>
                    <div className={`text-2xl font-bold ${arr.length > 0 ? 'text-accent-foreground' : 'text-muted-foreground'}`}>
                      {arr.length}
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
          <Card>
            <CardTitle>Attachment Preview</CardTitle>
            {pkg.attachments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No artifact attachments were requested.</p>
            ) : (
              <div className="space-y-3">
                {pkg.attachments.map((attachment, index) => (
                  <AttachmentCard key={`${attachmentKey(attachment)}:${index}`} attachment={attachment as AttachmentPreview} />
                ))}
              </div>
            )}
          </Card>
          <Card>
            <CardTitle>Full Package JSON</CardTitle>
            <pre>{JSON.stringify(pkg, null, 2)}</pre>
          </Card>
        </>
      )}
    </div>
  )
}

function initialArtifactIds(params: URLSearchParams): string[] {
  const ids = [
    params.get('artifact_id') ?? '',
    ...((params.get('artifact_ids') ?? '').split(',')),
  ]
  return Array.from(new Set(ids.map(id => id.trim()).filter(Boolean))).slice(0, 8)
}

function attachmentKey(attachment: Record<string, unknown>): string {
  return String(attachment.artifact_id ?? attachment.label ?? 'attachment')
}

function AttachmentCard({ attachment }: { attachment: AttachmentPreview }) {
  const approved = attachment.approved === true
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{attachment.label ?? attachment.artifact_id ?? 'Attachment'}</span>
            {attachment.artifact_type && <Badge variant="secondary">{attachment.artifact_type}</Badge>}
            {attachment.domain_label && <Badge variant="outline">{attachment.domain_label}</Badge>}
          </div>
          {attachment.artifact_id && <p className="mt-1 font-mono text-xs text-muted-foreground">{attachment.artifact_id}</p>}
        </div>
        <Badge variant={approved ? 'success' : 'destructive'}>
          {approved ? <CheckCircle2 className="size-3" /> : <AlertTriangle className="size-3" />}
          {approved ? 'approved' : 'blocked'}
        </Badge>
      </div>
      {!approved && attachment.rejection_reason && (
        <p className="mt-3 rounded-md border border-destructive/25 bg-destructive/10 p-2 text-xs text-destructive">
          {attachment.rejection_reason}
        </p>
      )}
      {attachment.resolved_content && (
        <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs">
          {attachment.resolved_content}
        </pre>
      )}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {attachment.policy_snapshot && (
          <SnapshotBlock title="Policy snapshot" value={attachment.policy_snapshot} />
        )}
        {attachment.source_policy_snapshot && (
          <SnapshotBlock title="Source policy snapshot" value={attachment.source_policy_snapshot} />
        )}
      </div>
    </div>
  )
}

function SnapshotBlock({ title, value }: { title: string; value: Record<string, unknown> }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 text-[11px]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}
