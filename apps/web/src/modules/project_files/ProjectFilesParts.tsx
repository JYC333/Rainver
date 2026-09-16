import { useState } from 'react'
import { ChevronDown, ChevronRight, FileCode, FilePlus, FileText, Folder, RotateCcw, Save, X } from 'lucide-react'
import type { FileContent, FileNode, GitChangedFile, ProjectFileRevision } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'

export const STATUS_VARIANT: Record<string, string> = {
  modified:  'bg-amber-500/15 text-amber-600',
  added:     'bg-emerald-500/15 text-emerald-600',
  deleted:   'bg-red-500/15 text-red-600',
  untracked: 'bg-blue-500/15 text-blue-600',
  renamed:   'bg-purple-500/15 text-purple-600',
}

/** Text colour and one-letter marker per Git status, the way an editor's explorer tints changed files. */
const STATUS_TEXT: Record<string, { className: string; letter: string }> = {
  modified:  { className: 'text-amber-600 dark:text-amber-400', letter: 'M' },
  added:     { className: 'text-emerald-600 dark:text-emerald-400', letter: 'A' },
  untracked: { className: 'text-emerald-600 dark:text-emerald-400', letter: 'U' },
  deleted:   { className: 'text-red-600 dark:text-red-400', letter: 'D' },
  renamed:   { className: 'text-purple-600 dark:text-purple-400', letter: 'R' },
}

/** `git status` paths keyed for tree lookup; an untracked directory (`dir/`) covers everything beneath it. */
export function changeIndex(files: readonly GitChangedFile[]): Map<string, GitChangedFile['status']> {
  return new Map(files.map(file => [file.path.replace(/\/$/, ''), file.status]))
}

function changeStatusFor(path: string, changes: Map<string, GitChangedFile['status']> | undefined): GitChangedFile['status'] | null {
  if (!changes || changes.size === 0) return null
  const direct = changes.get(path)
  if (direct) return direct
  for (const [changed, status] of changes) {
    if (path.startsWith(`${changed}/`)) return status
  }
  return null
}

/** A folder takes the colour of what it contains: green when everything under it is new, amber otherwise. */
function folderTint(path: string, changes: Map<string, GitChangedFile['status']> | undefined): string | null {
  if (!changes || changes.size === 0 || path === '.') return null
  let allNew = true
  let any = false
  for (const [changed, status] of changes) {
    if (changed !== path && !changed.startsWith(`${path}/`) && !path.startsWith(`${changed}/`)) continue
    any = true
    if (status !== 'untracked' && status !== 'added') allNew = false
  }
  if (!any) return null
  return allNew ? STATUS_TEXT.untracked!.className : STATUS_TEXT.modified!.className
}

export function FileTreeNode({
  node, depth, selectedPath, onFileSelect, changes,
}: {
  node: FileNode
  depth: number
  selectedPath: string | null
  onFileSelect: (path: string) => void
  /** From `changeIndex`; when given, changed files and their folders are tinted by status. */
  changes?: Map<string, GitChangedFile['status']>
}) {
  const [open, setOpen] = useState(depth < 2)
  const pl = depth * 12 + 8

  if (node.type === 'file') {
    const active = selectedPath === node.path
    const status = changeStatusFor(node.path, changes)
    const tint = status ? STATUS_TEXT[status] : undefined
    return (
      <button
        onClick={() => onFileSelect(node.path)}
        title={status ? `${node.name} · ${status}` : undefined}
        className={[
          'w-full flex items-center gap-1.5 py-[3px] text-xs text-left transition-colors rounded-sm',
          active
            ? 'bg-primary/10 font-medium'
            : 'hover:bg-accent/50',
          tint ? tint.className : active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
        ].join(' ')}
        style={{ paddingLeft: pl }}
      >
        <FileCode className="size-3 shrink-0 opacity-60" />
        <span className="truncate">{node.name}</span>
        <span className="ml-auto pr-2 flex items-center gap-1.5 text-[10px]">
          {node.size !== undefined && (
            <span className="opacity-40">
              {node.size < 1024 ? `${node.size}B` : `${(node.size / 1024).toFixed(0)}k`}
            </span>
          )}
          {tint && <span className="font-semibold" aria-label={status ?? undefined}>{tint.letter}</span>}
        </span>
      </button>
    )
  }

  const dirty = folderTint(node.path, changes)
  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        className={[
          'w-full flex items-center gap-1 py-[3px] text-xs text-left hover:bg-accent/50 transition-colors rounded-sm',
          dirty ?? 'text-foreground/80 hover:text-foreground',
        ].join(' ')}
        style={{ paddingLeft: pl }}
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <Folder className={`size-3 shrink-0 ${dirty ? 'opacity-80' : 'text-primary/60'}`} />
        <span className="font-medium">{node.name}</span>
      </button>
      {open && node.children && (
        <div>
          {node.children.map(child => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onFileSelect={onFileSelect}
              changes={changes}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function DiffViewer({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  if (!diff.trim()) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No changes to diff
      </div>
    )
  }
  return (
    <pre className="text-xs font-mono leading-5 overflow-auto h-full p-4">
      {lines.map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'bg-emerald-500/10 text-emerald-400'
              : line.startsWith('-') && !line.startsWith('---')
              ? 'bg-red-500/10 text-red-400'
              : line.startsWith('@@')
              ? 'text-blue-400 bg-blue-500/5'
              : line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')
              ? 'text-muted-foreground font-bold'
              : 'text-muted-foreground'
          }
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

export interface FileEditorSaveInput {
  path: string
  content: string
}

export function FileEditor({
  file,
  onSave,
  onCancel,
  saving = false,
}: {
  file: FileContent | null
  onSave: (input: FileEditorSaveInput) => Promise<boolean>
  onCancel: () => void
  saving?: boolean
}) {
  const [path, setPath] = useState(file?.path ?? '')
  const [content, setContent] = useState(file?.content ?? '')

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!path.trim()) return
    await onSave({ path: path.trim(), content })
  }

  return (
    <form className="flex flex-col h-full" onSubmit={event => void submit(event)}>
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
        <FilePlus className="size-3.5 text-muted-foreground" />
        <Input
          aria-label="File path"
          value={path}
          onChange={event => setPath(event.target.value)}
          placeholder="path/to/file.txt"
          className="h-7 max-w-md font-mono text-xs"
          disabled={saving}
          readOnly={Boolean(file)}
          autoFocus={!file}
        />
        <span className="ml-auto flex items-center gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            <X className="size-3.5" /> Cancel
          </Button>
          <Button type="submit" size="sm" className="gap-1.5" disabled={saving || !path.trim()}>
            <Save className="size-3.5" /> {saving ? 'Saving…' : 'Save directly'}
          </Button>
        </span>
      </div>
      <div className="shrink-0 px-4 py-2 text-[11px] text-muted-foreground border-b">
        Changes are written directly to this Project Folder. The previous version is kept for rollback.
      </div>
      <textarea
        aria-label="File content"
        value={content}
        onChange={event => setContent(event.target.value)}
        className="flex-1 min-h-0 w-full resize-none overflow-auto bg-background p-4 text-xs font-mono leading-5 text-foreground/90 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring"
        disabled={saving}
        spellCheck={false}
      />
    </form>
  )
}

export function FileViewer({
  file,
  revision,
  onSave,
  onRollback,
  saving = false,
}: {
  file: FileContent
  revision?: ProjectFileRevision | null
  onSave?: (input: FileEditorSaveInput) => Promise<boolean>
  onRollback?: (revision: ProjectFileRevision) => void
  saving?: boolean
}) {
  const [editing, setEditing] = useState(false)
  if (editing && onSave) {
    return (
      <FileEditor
        file={file}
        saving={saving}
        onSave={async input => {
          const saved = await onSave(input)
          if (saved) setEditing(false)
          return saved
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
        <FileCode className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-mono text-muted-foreground">{file.path}</span>
        <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{file.line_count} lines · {file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`}</span>
          {onSave && <Button type="button" size="sm" variant="outline" className="h-6 gap-1 px-2 text-[10px]" onClick={() => setEditing(true)}>
            Edit
          </Button>}
          {revision && onRollback && <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[10px]" onClick={() => onRollback(revision)}>
            <RotateCcw className="size-3" /> Rollback
          </Button>}
        </span>
      </div>
      <pre className="flex-1 overflow-auto text-xs font-mono leading-5 p-4 text-foreground/90">
        {file.content}
      </pre>
    </div>
  )
}

export function CenterEmpty({ message, action }: { message?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
      <FileText className="size-8 opacity-30" />
      <p className="text-sm text-center px-4">{message ?? 'Select a file or changed file'}</p>
      {action}
    </div>
  )
}
