import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { projectFoldersApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { errMsg } from '../../lib/utils'
import type { ProjectFolder, ProjectFolderScanCandidate } from '../../types/api'

const FOLDER_KINDS = [
  { value: 'code', label: 'Code' },
  { value: 'data', label: 'Data' },
  { value: 'docs', label: 'Docs' },
]

type FolderCreateSource = 'managed' | 'clone' | 'connect'

/** Creating a Folder belongs to Files & Code, which is where a Folder is used.
 *  It used to live on the Project Overview, so the Files Area's own empty
 *  state had to send the user back to the Overview to create one. */
export function CreateProjectFolderDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [source, setSource] = useState<FolderCreateSource>('managed')
  const [name, setName] = useState('')
  const [kind, setKind] = useState('code')
  const [repoUrl, setRepoUrl] = useState('')
  const [candidates, setCandidates] = useState<ProjectFolderScanCandidate[]>([])
  const [selectedCandidatePath, setSelectedCandidatePath] = useState('')
  const [scanning, setScanning] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open) return
    setSource('managed')
    setName('')
    setKind('code')
    setRepoUrl('')
    setCandidates([])
    setSelectedCandidatePath('')
  }, [open])

  useEffect(() => {
    if (!open || source !== 'connect') return
    setScanning(true)
    projectFoldersApi.scan(projectId)
      .then(result => setCandidates(result.items))
      .catch(() => setCandidates([]))
      .finally(() => setScanning(false))
  }, [open, source, projectId])

  async function submit() {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    if (source === 'connect' && !selectedCandidatePath) {
      toast.error('Select a directory to connect')
      return
    }
    setCreating(true)
    try {
      await projectFoldersApi.create(projectId, {
        name: name.trim(),
        kind: kind as ProjectFolder['kind'],
        repo_url: source === 'clone' ? repoUrl.trim() || null : null,
        root_path: source === 'connect' ? selectedCandidatePath : null,
      })
      toast.success('Project Folder created')
      onCreated()
      onOpenChange(false)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setCreating(false)
    }
  }

  const candidateOptions = candidates.map(candidate => ({ value: candidate.path, label: candidate.name }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Project Folder</DialogTitle>
          <DialogDescription>
            Create a managed directory, clone a repository, or connect an existing directory as a Folder owned by this Project.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p role="note" className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            A Project Folder is a shared workspace with no personal area. The whole registered Folder is available to Project members and mounted read-only for CLI runs; keep personal material in database-backed personal content.
          </p>
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select
              value={source}
              options={[
                { value: 'managed', label: 'Create managed Folder' },
                { value: 'clone', label: 'Clone repository' },
                { value: 'connect', label: 'Connect existing Folder' },
              ]}
              onChange={value => setSource(value as FolderCreateSource)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={event => setName(event.target.value)} placeholder="Folder name" />
          </div>
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <Select value={kind} options={FOLDER_KINDS} onChange={setKind} />
          </div>
          {source === 'clone' && (
            <div className="space-y-1.5">
              <Label>Repository URL</Label>
              <Input value={repoUrl} onChange={event => setRepoUrl(event.target.value)} placeholder="https://…" />
            </div>
          )}
          {source === 'connect' && (
            <div className="space-y-1.5">
              <Label>Existing directory</Label>
              {scanning ? (
                <p className="text-xs text-muted-foreground">Scanning…</p>
              ) : candidateOptions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No unregistered directories found.</p>
              ) : (
                <Select
                  value={selectedCandidatePath}
                  options={[{ value: '', label: 'Select a directory…' }, ...candidateOptions]}
                  onChange={setSelectedCandidatePath}
                />
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={creating || !name.trim()}>
            {creating ? 'Creating…' : 'Create Folder'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
