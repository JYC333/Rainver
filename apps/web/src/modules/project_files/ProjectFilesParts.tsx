import { useState } from 'react'
import { ChevronDown, ChevronRight, FileCode, FileText, Folder } from 'lucide-react'
import type { FileContent, FileNode } from '../../types/api'

export const STATUS_VARIANT: Record<string, string> = {
  modified:  'bg-amber-500/15 text-amber-600',
  added:     'bg-emerald-500/15 text-emerald-600',
  deleted:   'bg-red-500/15 text-red-600',
  untracked: 'bg-blue-500/15 text-blue-600',
  renamed:   'bg-purple-500/15 text-purple-600',
}

export function FileTreeNode({
  node, depth, selectedPath, onFileSelect,
}: {
  node: FileNode
  depth: number
  selectedPath: string | null
  onFileSelect: (path: string) => void
}) {
  const [open, setOpen] = useState(depth < 2)
  const pl = depth * 12 + 8

  if (node.type === 'file') {
    const active = selectedPath === node.path
    return (
      <button
        onClick={() => onFileSelect(node.path)}
        className={[
          'w-full flex items-center gap-1.5 py-[3px] text-xs text-left transition-colors rounded-sm',
          active
            ? 'bg-primary/10 text-primary font-medium'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
        ].join(' ')}
        style={{ paddingLeft: pl }}
      >
        <FileCode className="size-3 shrink-0 opacity-60" />
        <span className="truncate">{node.name}</span>
        {node.size !== undefined && (
          <span className="ml-auto pr-2 text-[10px] opacity-40">
            {node.size < 1024 ? `${node.size}B` : `${(node.size / 1024).toFixed(0)}k`}
          </span>
        )}
      </button>
    )
  }

  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-1 py-[3px] text-xs text-left text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors rounded-sm"
        style={{ paddingLeft: pl }}
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <Folder className="size-3 shrink-0 text-primary/60" />
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

export function FileViewer({ file }: { file: FileContent }) {
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
        <FileCode className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-mono text-muted-foreground">{file.path}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {file.line_count} lines · {file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`}
        </span>
      </div>
      <pre className="flex-1 overflow-auto text-xs font-mono leading-5 p-4 text-foreground/90">
        {file.content}
      </pre>
    </div>
  )
}

export function CenterEmpty() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
      <FileText className="size-8 opacity-30" />
      <p className="text-sm">Select a file or changed file</p>
    </div>
  )
}
