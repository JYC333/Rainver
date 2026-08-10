import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { sourcesApi } from '../../../api/client'
import { Button } from '../../../components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../../components/ui/dialog'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Select } from '../../../components/ui/select'
import { errMsg } from '../../../lib/utils'
import type { ProjectSourceBinding, SourceChannel, SourceItem } from '../../../types/api'

export interface ProjectSourceOption {
  value: string
  label: string
  connectionId: string
}

/** A manually saved URL carries no channel of its own, so its Project source
 *  is reassignable after the fact — unlike an item a monitor collected. */
export function isManualUrlItem(item: SourceItem) {
  return item.item_type === 'external_url' && item.metadata_json?.created_by === 'manual_url'
}

/** The distinct source connections this Project's active bindings reach. */
export function projectSourceOptions(
  bindings: ProjectSourceBinding[],
  channels: SourceChannel[],
): ProjectSourceOption[] {
  const channelById = Object.fromEntries(channels.map(channel => [channel.id, channel])) as Record<string, SourceChannel>
  const linked = bindings
    .map(binding => channelById[binding.source_channel_id])
    .filter((channel): channel is SourceChannel => Boolean(channel))
  return Array.from(
    new Map(linked.map(channel => [
      channel.source_connection_id,
      {
        value: channel.source_connection_id,
        label: `${channel.name} · ${channel.provider.display_name ?? channel.provider.key ?? 'Provider'}`,
        connectionId: channel.source_connection_id,
      },
    ])).values(),
  )
}

export function SaveProjectUrlDialog({
  open,
  onOpenChange,
  sourceOptions,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceOptions: ProjectSourceOption[]
  onSaved: () => void
}) {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [queueContent, setQueueContent] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setUrl('')
    setTitle('')
    setQueueContent(false)
    setConnectionId(sourceOptions[0]?.value ?? '')
  }, [open, sourceOptions])

  async function submit() {
    if (!url.trim()) {
      toast.error('URL is required')
      return
    }
    const selectedSource = sourceOptions.find(option => option.value === connectionId)
    if (!selectedSource) {
      toast.error('Link a source before saving URLs to this project')
      return
    }
    setSaving(true)
    try {
      const row = await sourcesApi.createManualUrl({
        url: url.trim(),
        title: title.trim() || undefined,
        connection_id: selectedSource.connectionId,
        queue_content: queueContent,
      })
      if (row.connection_id !== selectedSource.connectionId) {
        await sourcesApi.updateItem(row.id, { connection_id: selectedSource.connectionId })
      }
      toast.success('URL saved')
      onSaved()
      onOpenChange(false)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save URL</DialogTitle>
          <DialogDescription>
            Save a URL into this project by attaching it to one of the project-linked sources.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Page URL</Label>
            <Input
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder="https://example.com/post"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={event => setTitle(event.target.value)} placeholder="Optional" />
          </div>
          <div className="space-y-1.5">
            <Label>Source</Label>
            {sourceOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">Link a source before saving URLs to this project.</p>
            ) : (
              <Select value={connectionId} options={sourceOptions} onChange={setConnectionId} />
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 rounded border-border"
              checked={queueContent}
              onChange={event => setQueueContent(event.target.checked)}
            />
            Queue extraction
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !url.trim() || !connectionId}>
            {saving ? 'Saving…' : 'Save URL'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
