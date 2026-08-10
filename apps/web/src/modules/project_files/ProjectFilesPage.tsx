import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Folder, GitBranch, FileDiff, Loader, Plus, RefreshCw, Settings as SettingsIcon, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../core/spaceNav'
import { projectFoldersApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { FileContent, FileNode, GitChangedFile, GitStatus, ProjectFolder } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Select } from '../../components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs'
import { EmptyState } from '../../components/ui/empty-state'
import { Button } from '../../components/ui/button'
import { ConfirmDialog } from '../../components/ui/dialog'
import { CenterEmpty, DiffViewer, FileTreeNode, FileViewer, STATUS_VARIANT } from './ProjectFilesParts'
import { CreateProjectFolderDialog } from './CreateProjectFolderDialog'

type CenterView =
  | { mode: 'empty' }
  | { mode: 'file'; data: FileContent }
  | { mode: 'diff'; diff: string; path: string }

type LeftTab = 'files' | 'changes'

export default function ProjectFilesPage() {
  const { projectId = '' } = useParams<{ projectId: string }>()
  const [searchParams] = useSearchParams()
  const preselectedId = searchParams.get('folder')

  const [folders, setFolders] = useState<ProjectFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState<ProjectFolder | null>(null)
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [folderToUnregister, setFolderToUnregister] = useState<ProjectFolder | null>(null)

  const [fileTree, setFileTree] = useState<FileNode | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [leftTab, setLeftTab] = useState<LeftTab>('files')
  const [treeLoading, setTreeLoading] = useState(false)
  const [gitLoading, setGitLoading] = useState(false)

  const [centerView, setCenterView] = useState<CenterView>({ mode: 'empty' })
  const [centerLoading, setCenterLoading] = useState(false)

  const loadFolders = useCallback(async () => {
    if (!projectId) return
    setFoldersLoading(true)
    try {
      const page = await projectFoldersApi.list(projectId, { limit: '200' })
      setFolders(page.items)
      setSelectedFolder(current => {
        if (current && page.items.some(f => f.id === current.id)) return current
        const target = preselectedId ? page.items.find(f => f.id === preselectedId) : null
        return target ?? page.items[0] ?? null
      })
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setFoldersLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => { void loadFolders() }, [loadFolders])

  async function unregisterFolder(folder: ProjectFolder) {
    try {
      await projectFoldersApi.unregister(projectId, folder.id)
      toast.success('Project Folder unregistered')
      await loadFolders()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const loadTree = useCallback(async (folder: ProjectFolder) => {
    setTreeLoading(true)
    setFileTree(null)
    try {
      setFileTree(await projectFoldersApi.tree(projectId, folder.id))
    } catch {
      // Folder might have no directory yet — silently fail
    } finally {
      setTreeLoading(false)
    }
  }, [projectId])

  const loadGitStatus = useCallback(async (folder: ProjectFolder) => {
    setGitLoading(true)
    try {
      setGitStatus(await projectFoldersApi.gitStatus(projectId, folder.id))
    } catch {
      setGitStatus(null)
    } finally {
      setGitLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (!selectedFolder) return
    setCenterView({ mode: 'empty' })
    setSelectedFilePath(null)
    void loadTree(selectedFolder)
    void loadGitStatus(selectedFolder)
  }, [selectedFolder, loadTree, loadGitStatus])

  async function handleFileSelect(path: string) {
    if (!selectedFolder) return
    setSelectedFilePath(path)
    setCenterLoading(true)
    try {
      const fc = await projectFoldersApi.file(projectId, selectedFolder.id, path)
      setCenterView({ mode: 'file', data: fc })
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCenterLoading(false)
    }
  }

  async function handleDiffSelect(file: GitChangedFile) {
    if (!selectedFolder) return
    setSelectedFilePath(file.path)
    setCenterLoading(true)
    try {
      const { diff } = await projectFoldersApi.gitDiff(projectId, selectedFolder.id, file.path)
      setCenterView({ mode: 'diff', diff, path: file.path })
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCenterLoading(false)
    }
  }

  const gitGroups: Record<string, GitChangedFile[]> = {}
  for (const f of gitStatus?.files ?? []) {
    ;(gitGroups[f.status] ??= []).push(f)
  }
  const gitGroupOrder = ['modified', 'added', 'deleted', 'untracked', 'renamed'] as const

  if (!foldersLoading && folders.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No Project Folders yet"
          description="Create a managed Folder, clone a repository, or connect an allowed existing directory. Chat and non-file workflows remain available without a Folder."
          action={<Button onClick={() => setCreateFolderOpen(true)}>Create or connect Folder</Button>}
        />
        <CreateProjectFolderDialog
          projectId={projectId}
          open={createFolderOpen}
          onOpenChange={setCreateFolderOpen}
          onCreated={() => { void loadFolders() }}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col overflow-hidden" style={{ height: 'calc(100vh - 56px)' }}>
      <CreateProjectFolderDialog
        projectId={projectId}
        open={createFolderOpen}
        onOpenChange={setCreateFolderOpen}
        onCreated={() => { void loadFolders() }}
      />
      {/* This toolbar button acts on whichever Folder is selected rather than
          on one the user pointed at in a list, and unregistering removes the
          registration row outright, so name the target before doing it. */}
      <ConfirmDialog
        open={Boolean(folderToUnregister)}
        onOpenChange={open => { if (!open) setFolderToUnregister(null) }}
        title={`Unregister “${folderToUnregister?.name ?? ''}”?`}
        description="This Project stops tracking the Folder. The directory itself is never deleted, moved, or rewritten."
        confirmLabel="Unregister Folder"
        onConfirm={() => {
          const target = folderToUnregister
          setFolderToUnregister(null)
          if (target) void unregisterFolder(target)
        }}
      />
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b bg-card">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: 'color-mix(in oklch, var(--primary) 12%, transparent)', border: '1px solid color-mix(in oklch, var(--primary) 30%, transparent)' }}
        >
          <Folder className="size-4 text-primary" />
        </div>
        <h1 className="text-sm font-semibold">Files &amp; Code</h1>

        {folders.length > 0 && (
          <div className="flex items-center gap-1.5 ml-2">
            <Select
              size="sm"
              value={selectedFolder?.id ?? ''}
              onChange={id => setSelectedFolder(folders.find(f => f.id === id) ?? null)}
              options={folders.map(f => ({ value: f.id, label: f.name }))}
              className="w-40"
            />
          </div>
        )}

        {selectedFolder?.root_path && (
          <span className="text-[10px] text-muted-foreground font-mono hidden sm:block truncate max-w-[260px]">
            {selectedFolder.root_path}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setCreateFolderOpen(true)}>
            <Plus className="size-3.5" />
            New Folder
          </Button>
          {selectedFolder && (
            <button
              onClick={() => setFolderToUnregister(selectedFolder)}
              title={`Unregister ${selectedFolder.name}`}
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
            >
              <Trash2 className="size-3" />
            </button>
          )}
          {selectedFolder && (
            <Link
              to={`/projects/${projectId}/folders/${selectedFolder.id}`}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <SettingsIcon className="size-3" />
            </Link>
          )}
          {selectedFolder && (
            <button
              onClick={() => { void loadTree(selectedFolder); void loadGitStatus(selectedFolder) }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="size-3" />
            </button>
          )}
          {gitStatus?.branch && (
            <Badge variant="muted" className="text-[10px] px-1.5">
              <GitBranch className="size-2.5 mr-1" />{gitStatus.branch}
            </Badge>
          )}
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="w-64 shrink-0 border-r flex flex-col min-h-0 bg-card/50">
          <Tabs value={leftTab} onValueChange={value => setLeftTab(value as LeftTab)} className="flex flex-col flex-1 min-h-0">
            <div className="shrink-0 px-2 pt-2">
              <TabsList className="w-full grid grid-cols-2 h-7 text-[10px]">
                <TabsTrigger value="files" className="text-[10px] px-1">Files</TabsTrigger>
                <TabsTrigger value="changes" className="text-[10px] px-1">
                  Changes
                  {(gitStatus?.files.length ?? 0) > 0 && (
                    <span className="ml-1 bg-primary/20 text-primary rounded-full px-1 text-[9px]">
                      {gitStatus!.files.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="files" className="flex-1 overflow-y-auto mt-0 px-1 py-1">
              {!selectedFolder ? (
                <p className="text-xs text-muted-foreground p-3">No Folder selected</p>
              ) : treeLoading ? (
                <p className="text-xs text-muted-foreground p-3 flex items-center gap-1.5">
                  <Loader className="size-3 animate-spin" /> Loading…
                </p>
              ) : fileTree ? (
                <FileTreeNode
                  node={fileTree}
                  depth={0}
                  selectedPath={selectedFilePath}
                  onFileSelect={handleFileSelect}
                />
              ) : (
                <p className="text-xs text-muted-foreground p-3">No files found</p>
              )}
            </TabsContent>

            <TabsContent value="changes" className="flex-1 overflow-y-auto mt-0 px-1 py-1">
              {!selectedFolder ? (
                <p className="text-xs text-muted-foreground p-3">No Folder selected</p>
              ) : gitLoading ? (
                <p className="text-xs text-muted-foreground p-3 flex items-center gap-1.5">
                  <Loader className="size-3 animate-spin" /> Loading…
                </p>
              ) : !gitStatus?.is_repo ? (
                <p className="text-xs text-muted-foreground p-3">Not a git repository</p>
              ) : gitStatus.files.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3">Working tree clean</p>
              ) : (
                <div className="space-y-3">
                  {gitGroupOrder.map(grp => {
                    const files = gitGroups[grp]
                    if (!files?.length) return null
                    return (
                      <div key={grp}>
                        <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground px-2 py-1">
                          {grp} · {files.length}
                        </p>
                        {files.map(f => (
                          <button
                            key={f.path}
                            onClick={() => handleDiffSelect(f)}
                            className={[
                              'w-full flex items-center gap-1.5 py-[3px] px-2 text-xs text-left rounded-sm transition-colors',
                              selectedFilePath === f.path
                                ? 'bg-primary/10 text-primary'
                                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                            ].join(' ')}
                          >
                            <span className={`text-[9px] px-1 rounded ${STATUS_VARIANT[f.status] ?? ''}`}>
                              {f.status[0].toUpperCase()}
                            </span>
                            <span className="truncate font-mono text-[10px]">{f.path}</span>
                          </button>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>

        <div className="flex-1 min-w-0 flex flex-col min-h-0 bg-background">
          {centerLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : centerView.mode === 'file' ? (
            <FileViewer file={centerView.data} />
          ) : centerView.mode === 'diff' ? (
            <div className="flex flex-col h-full">
              <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
                <FileDiff className="size-3.5 text-muted-foreground" />
                <span className="text-xs font-mono text-muted-foreground">{centerView.path}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-auto">
                <DiffViewer diff={centerView.diff} />
              </div>
            </div>
          ) : (
            <CenterEmpty />
          )}
        </div>
      </div>
    </div>
  )
}
