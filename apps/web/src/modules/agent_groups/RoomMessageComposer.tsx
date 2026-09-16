import { useEffect, useMemo, useRef, useState } from 'react'
import { Node, mergeAttributes, type JSONContent } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Bot, FileText, Loader2 } from 'lucide-react'
import type { ConversationInputFileReferencePart, ConversationInputPart } from '@rainver/protocol'
import { CONVERSATION_MAX_FILE_REFERENCES, CONVERSATION_MAX_FILE_SNAPSHOT_BYTES } from '@rainver/protocol'
import { conversationInputApi, projectFoldersApi } from '../../api/client'
import type { FileNode } from '../../types/api'
import { errMsg } from '../../lib/utils'
import { useConversationInputSendGuard, type ConversationInputFileSource } from '../conversation/ConversationInputComposer'

export interface RoomMessageComposerValue {
  text: string
  mentionIds: string[]
  routingSegments: RoomMessageRoutingSegment[]
}

type MentionAgent = { id: string; name: string; status?: string }

type FileCandidate = {
  projectFolderId: string
  workspaceLocationId: string
  source: string
  path: string
  name: string
  size: number
}

type MentionSuggestion =
  | { type: 'agent'; agent: MentionAgent }
  | { type: 'file'; file: FileCandidate }

export interface RoomMessageRoutingSegment {
  recipient_agent_ids: string[]
  content: string
}

interface MentionRange {
  from: number
  to: number
  query: string
}

type ComposerToken =
  | { type: 'text'; text: string }
  | { type: 'mention'; id: string; label: string }

interface MentionCluster {
  start: number
  end: number
  recipient_agent_ids: string[]
}

const AgentMentionNode = Node.create({
  name: 'agentMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: element => element.getAttribute('data-agent-id'),
        renderHTML: attributes => ({ 'data-agent-id': attributes.id }),
      },
      label: {
        default: '',
        parseHTML: element => element.getAttribute('data-label') ?? '',
        renderHTML: attributes => ({ 'data-label': attributes.label }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-agent-mention]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-agent-mention': 'true',
        class: 'inline-flex items-center rounded bg-primary/15 px-1.5 py-0.5 font-medium text-primary',
      }),
      `@${node.attrs.label}`,
    ]
  },

  renderText({ node }) {
    return `@${node.attrs.label}`
  },
})

const FileReferenceNode = Node.create({
  name: 'fileReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      path: {
        default: '',
        parseHTML: element => element.getAttribute('data-file-path') ?? '',
        renderHTML: attributes => ({ 'data-file-path': attributes.path }),
      },
      projectFolderId: {
        default: '',
        parseHTML: element => element.getAttribute('data-project-folder-id') ?? '',
        renderHTML: attributes => ({ 'data-project-folder-id': attributes.projectFolderId }),
      },
      workspaceLocationId: {
        default: '',
        parseHTML: element => element.getAttribute('data-workspace-location-id') ?? '',
        renderHTML: attributes => ({ 'data-workspace-location-id': attributes.workspaceLocationId }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-file-reference]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-file-reference': 'true',
        class: 'inline-flex max-w-full items-center rounded border border-border bg-muted/60 px-1.5 py-0.5 align-middle text-xs font-medium text-foreground',
        title: `Referenced file: ${node.attrs.path}`,
      }),
      `▤ ${node.attrs.path}`,
    ]
  },

  renderText() {
    return ''
  },
})

export function emptyRoomMessageComposerValue(): RoomMessageComposerValue {
  return { text: '', mentionIds: [], routingSegments: [] }
}

export function RoomMessageComposer({
  value,
  onChange,
  agents,
  members,
  disabled,
  resetToken,
  onSubmit,
  embedded = false,
  projectId,
  projectFolderId,
  fileSources,
  sessionId,
  inputParts = [],
  onInputPartsChange,
}: {
  value: RoomMessageComposerValue
  onChange: (value: RoomMessageComposerValue) => void
  agents: Array<{ id: string; name: string; status?: string }>
  members: Array<{ agent_id: string; status: string }>
  disabled: boolean
  resetToken: number
  onSubmit: () => void
  /** The shared conversation frame owns the border and focus treatment. */
  embedded?: boolean
  projectId?: string | null
  projectFolderId?: string | null
  fileSources?: ConversationInputFileSource[]
  sessionId?: string | null
  inputParts?: ConversationInputPart[]
  onInputPartsChange?: (parts: ConversationInputPart[]) => void
}) {
  const [mentionRange, setMentionRange] = useState<MentionRange | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [fileCandidates, setFileCandidates] = useState<FileCandidate[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileLoadingPath, setFileLoadingPath] = useState<string | null>(null)
  const [hasEditorContent, setHasEditorContent] = useState(false)
  const mentionRangeRef = useRef<MentionRange | null>(null)
  const fileSourcesRef = useRef(fileSources)
  const suggestionsRef = useRef<MentionSuggestion[]>([])
  const activeIndexRef = useRef(0)
  const disabledRef = useRef(disabled)
  const onSubmitRef = useRef(onSubmit)
  const inputPartsRef = useRef(inputParts)
  const canSend = useConversationInputSendGuard()
  const mentionableAgents = useMemo(() => {
    const activeMemberIds = new Set(members.filter(member => member.status === 'active').map(member => member.agent_id))
    return agents
      .filter(agent => agent.status === 'active' && activeMemberIds.has(agent.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [agents, members])

  const agentSuggestions = useMemo(() => {
    if (!mentionRange) return []
    const query = mentionRange.query.trim().toLowerCase()
    return mentionableAgents
      .filter(agent => !query || agent.name.toLowerCase().includes(query) || agent.id.toLowerCase().includes(query))
      .slice(0, 8)
  }, [mentionRange, mentionableAgents])

  const fileSuggestions = useMemo(() => {
    if (!mentionRange) return []
    const query = mentionRange.query.trim().toLowerCase()
    return fileCandidates
      .filter(file => !query || file.path.toLowerCase().includes(query) || file.name.toLowerCase().includes(query))
      .slice(0, 8)
  }, [fileCandidates, mentionRange])

  const suggestions = useMemo<MentionSuggestion[]>(() => [
    ...agentSuggestions.map(agent => ({ type: 'agent' as const, agent })),
    ...fileSuggestions.map(file => ({ type: 'file' as const, file })),
  ], [agentSuggestions, fileSuggestions])

  mentionRangeRef.current = mentionRange
  suggestionsRef.current = suggestions
  activeIndexRef.current = activeIndex
  disabledRef.current = disabled
  onSubmitRef.current = onSubmit
  inputPartsRef.current = inputParts

  const fileSourceKey = fileSources == null
    ? `fallback:${projectFolderId ?? ''}`
    : fileSources.map(source => `${source.projectFolderId}:${source.workspaceLocationId ?? ''}:${source.label}`).join('|')
  const mentionQuery = mentionRange?.query ?? null
  fileSourcesRef.current = fileSources

  function updateMentionRange(next: MentionRange | null) {
    setMentionRange(previous => (
      previous?.from === next?.from
      && previous?.to === next?.to
      && previous?.query === next?.query
        ? previous
        : next
    ))
  }

  useEffect(() => {
    if (mentionQuery === null || !projectId || (!sessionId && !projectFolderId && !(fileSourcesRef.current?.length))) {
      setFileCandidates([])
      setFileError(null)
      setFileLoading(false)
      return
    }
    let active = true
    setFileLoading(true)
    setFileError(null)
    const sources = fileSourcesRef.current ?? (projectFolderId ? [{ projectFolderId, label: 'Project Folder' }] : [])
    if (sessionId) {
      const controller = new AbortController()
      void conversationInputApi.searchFiles(sessionId, mentionQuery, controller.signal).then(response => {
        if (!active || controller.signal.aborted) return
        setFileCandidates(response.items.map(item => ({
          projectFolderId: item.project_folder_id,
          workspaceLocationId: item.workspace_location_id,
          source: item.source,
          path: item.relative_path,
          name: item.display_name,
          size: item.size_bytes,
        })))
      }).catch(error => {
        if (active && !controller.signal.aborted) {
          setFileCandidates([])
          setFileError(`Files are unavailable: ${errMsg(error)}`)
        }
      }).finally(() => {
        if (active && !controller.signal.aborted) setFileLoading(false)
      })
      return () => {
        active = false
        controller.abort()
      }
    }
    void Promise.all(sources.map(async source => {
      const tree = await projectFoldersApi.tree(projectId, source.projectFolderId)
      if (source.workspaceLocationId) return { source: { ...source, workspaceLocationId: source.workspaceLocationId }, tree }
      const locations = await projectFoldersApi.locations(projectId, source.projectFolderId)
      const location = locations.find(candidate => candidate.status === 'active' && candidate.execution_ready !== false)
        ?? locations.find(candidate => candidate.status === 'active')
      return location ? { source: { ...source, workspaceLocationId: location.id }, tree } : null
    })).then(results => {
      if (!active) return
      const usable = results.filter((item): item is { source: ConversationInputFileSource & { workspaceLocationId: string }; tree: FileNode } => item !== null)
      setFileCandidates(usable.flatMap(item => flattenFileTree(item.tree, item.source)))
      if (usable.length !== results.length) setFileError('One or more Folder Locations are unavailable.')
    }).catch(error => {
      if (active) {
        setFileCandidates([])
        setFileError(`Files are unavailable: ${errMsg(error)}`)
      }
    }).finally(() => {
      if (active) setFileLoading(false)
    })
    return () => { active = false }
  }, [fileSourceKey, mentionQuery, projectFolderId, projectId, sessionId])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
      }),
      AgentMentionNode,
      FileReferenceNode,
    ],
    content: emptyDoc(),
    editable: !disabled,
    editorProps: {
      attributes: {
        class: embedded
          ? 'min-h-[84px] px-3 py-2 text-sm leading-relaxed outline-none'
          : 'min-h-[84px] rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-primary',
        role: 'textbox',
        'aria-label': 'Room message',
      },
      handleKeyDown: (view, event) => handleComposerKeyDown(event, view),
    },
      onUpdate: ({ editor: nextEditor }) => {
        setHasEditorContent(!nextEditor.isEmpty)
        const fileReferenceKeys = new Set<string>()
        nextEditor.state.doc.descendants(node => {
          if (node.type.name !== 'fileReference') return
          fileReferenceKeys.add(fileReferenceKey({
            project_folder_id: String(node.attrs.projectFolderId ?? ''),
            workspace_location_id: String(node.attrs.workspaceLocationId ?? ''),
            relative_path: String(node.attrs.path ?? ''),
          }))
        })
        const nextInputParts = inputPartsRef.current.filter(part => (
          part.kind !== 'file_reference' || fileReferenceKeys.has(fileReferenceKey(part))
        ))
        if (nextInputParts.length !== inputPartsRef.current.length) {
          inputPartsRef.current = nextInputParts
          onInputPartsChange?.(nextInputParts)
        }
        onChange(serializeComposerValue(nextEditor.getJSON()))
        updateMentionRange(activeMentionRange(nextEditor))
      },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      updateMentionRange(activeMentionRange(nextEditor))
    },
  })

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [disabled, editor])

  useEffect(() => {
    if (!editor) return
    editor.commands.setContent(emptyDoc())
    setHasEditorContent(false)
    updateMentionRange(null)
    setActiveIndex(0)
    onChange(emptyRoomMessageComposerValue())
    // resetToken intentionally drives clearing the editor after a successful send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, resetToken])

  useEffect(() => {
    if (!editor) return
    const existingKeys = new Set<string>()
    editor.state.doc.descendants(node => {
      if (node.type.name !== 'fileReference') return
      existingKeys.add(fileReferenceKey({
        project_folder_id: String(node.attrs.projectFolderId ?? ''),
        workspace_location_id: String(node.attrs.workspaceLocationId ?? ''),
        relative_path: String(node.attrs.path ?? ''),
      }))
    })
    const missing = inputParts.filter((part): part is ConversationInputFileReferencePart => (
      part.kind === 'file_reference' && !existingKeys.has(fileReferenceKey(part))
    ))
    if (missing.length === 0) return
    editor.chain().focus().insertContent(missing.flatMap(part => [
      {
        type: 'fileReference',
        attrs: {
          path: part.relative_path,
          projectFolderId: part.project_folder_id,
          workspaceLocationId: part.workspace_location_id,
        },
      },
      { type: 'text', text: ' ' },
    ])).run()
  }, [editor, inputParts])

  useEffect(() => {
    setActiveIndex(0)
  }, [mentionRange?.query])

  function insertMention(agent: MentionAgent, range: MentionRange | null = mentionRange) {
    if (!editor || disabled) return
    const label = agent.name.trim() || agent.id
    const chain = editor.chain().focus()
    if (range) chain.deleteRange({ from: range.from, to: range.to })
    chain
      .insertContent({ type: 'agentMention', attrs: { id: agent.id, label } })
      .insertContent(' ')
      .run()
    updateMentionRange(null)
  }

  function insertMentionFromView(view: EditorView, agent: MentionAgent, range: MentionRange) {
    if (disabledRef.current) return false
    const mentionType = view.state.schema.nodes.agentMention
    if (!mentionType) return false
    const label = agent.name.trim() || agent.id
    const node = mentionType.create({ id: agent.id, label })
    const tr = view.state.tr
      .replaceWith(range.from, range.to, node)
      .insertText(' ', range.from + node.nodeSize)
      .scrollIntoView()
    view.dispatch(tr)
    updateMentionRange(null)
    return true
  }

  async function insertFile(file: FileCandidate, range: MentionRange): Promise<void> {
    if (!editor || disabled || !projectId || fileLoadingPath) return
    if (inputPartsRef.current.filter(part => part.kind === 'file_reference').length >= CONVERSATION_MAX_FILE_REFERENCES) {
      setFileError(`You can reference up to ${CONVERSATION_MAX_FILE_REFERENCES} files.`)
      return
    }
    if (file.size > CONVERSATION_MAX_FILE_SNAPSHOT_BYTES) {
      setFileError(`${file.path} is too large to reference.`)
      return
    }
    setFileLoadingPath(file.path)
    setFileError(null)
    try {
      const content = await projectFoldersApi.file(projectId, file.projectFolderId, file.path)
      const bytes = new TextEncoder().encode(content.content)
      if (bytes.byteLength > CONVERSATION_MAX_FILE_SNAPSHOT_BYTES) throw new Error('file is too large to reference')
      const sha256 = content.sha256 ?? await digestHex(bytes)
      const part: ConversationInputFileReferencePart = {
        kind: 'file_reference',
        project_folder_id: file.projectFolderId,
        workspace_location_id: file.workspaceLocationId,
        relative_path: content.path,
        display_name: file.name,
        media_type: 'text/plain',
        byte_size: bytes.byteLength,
        sha256,
      }
      const currentRange = mentionRangeRef.current
      if (!currentRange || currentRange.from !== range.from || currentRange.to !== range.to) {
        setFileError('File selection expired; type @ again.')
        return
      }
      const nextInputParts = [...inputPartsRef.current, part]
      inputPartsRef.current = nextInputParts
      onInputPartsChange?.(nextInputParts)
      editor.chain().focus()
        .deleteRange({ from: range.from, to: range.to })
        .insertContent({
          type: 'fileReference',
          attrs: {
            path: content.path,
            projectFolderId: part.project_folder_id,
            workspaceLocationId: part.workspace_location_id,
          },
        })
        .insertContent(' ')
        .run()
      updateMentionRange(null)
    } catch (error) {
      setFileError(`Could not reference ${file.path}: ${errMsg(error)}`)
    } finally {
      setFileLoadingPath(null)
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent, view?: EditorView) {
    // ProseMirror deliberately leaves native text insertion to the browser;
    // a leading space therefore does not always produce an update event in
    // every browser. The placeholder still represents an empty editor, not
    // an empty trimmed message, so hide it as soon as the person types one.
    if (event.key === ' ' && !disabledRef.current) setHasEditorContent(true)
    const range = mentionRangeRef.current
    const currentSuggestions = suggestionsRef.current
    if (range && currentSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex(index => {
          const next = (index + 1) % currentSuggestions.length
          activeIndexRef.current = next
          return next
        })
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(index => {
          const next = (index - 1 + currentSuggestions.length) % currentSuggestions.length
          activeIndexRef.current = next
          return next
        })
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const suggestion = currentSuggestions[Math.min(activeIndexRef.current, currentSuggestions.length - 1)] ?? currentSuggestions[0]
        if (suggestion?.type === 'agent') {
          if (view) insertMentionFromView(view, suggestion.agent, range)
          else insertMention(suggestion.agent, range)
        } else if (suggestion?.type === 'file') {
          void insertFile(suggestion.file, range)
        }
        return true
      }
    }
    if (range && event.key === 'Escape') {
      event.preventDefault()
      updateMentionRange(null)
      return true
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      if (canSend()) onSubmitRef.current()
      return true
    }
    return false
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        {!hasEditorContent && (
          <div className="pointer-events-none absolute left-3 top-2 z-10 text-sm text-muted-foreground">
            Message...
          </div>
        )}
        <EditorContent editor={editor} />
        {mentionRange && (
          <div className="absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
            <div className="border-b border-border px-2 py-1 text-[11px] font-medium text-muted-foreground">@ menu · Agents and Files</div>
            {fileLoading && <p className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Searching authorized files…</p>}
            <div role="listbox" aria-label="Agents and Files" className="max-h-64 overflow-auto p-1">
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.type === 'agent' ? `agent:${suggestion.agent.id}` : `file:${suggestion.file.projectFolderId}:${suggestion.file.path}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => suggestion.type === 'agent' ? insertMention(suggestion.agent, mentionRange) : void insertFile(suggestion.file, mentionRange)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${
                    index === activeIndex ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  {suggestion.type === 'agent' ? <Bot className="size-3.5 shrink-0" /> : <FileText className="size-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">
                    <span className="block truncate">{suggestion.type === 'agent' ? `@${suggestion.agent.name}` : suggestion.file.name}</span>
                    {suggestion.type === 'file' && <span className="block truncate text-[11px] text-muted-foreground">{suggestion.file.source} · {suggestion.file.path}</span>}
                  </span>
                </button>
              ))}
              {suggestions.length === 0 && !fileLoading && !fileError && (
                <p className="px-2 py-2 text-xs text-muted-foreground">No matching agents or files.</p>
              )}
            </div>
            {fileError && <p className="px-2 pb-2 text-xs text-destructive" role="alert">{fileError}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

function activeMentionRange(editor: NonNullable<ReturnType<typeof useEditor>>): MentionRange | null {
  const { selection } = editor.state
  if (!selection.empty) return null
  const { $from } = selection
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '\0')
  const atIndex = textBefore.lastIndexOf('@')
  if (atIndex < 0) return null
  if (atIndex > 0 && !/\s/.test(textBefore[atIndex - 1] ?? '')) return null
  const query = textBefore.slice(atIndex + 1)
  if (/[\s@]/.test(query)) return null
  return {
    from: selection.from - query.length - 1,
    to: selection.from,
    query,
  }
}

function fileReferenceKey(part: Pick<ConversationInputFileReferencePart, 'project_folder_id' | 'workspace_location_id' | 'relative_path'>): string {
  return `${part.project_folder_id}:${part.workspace_location_id}:${part.relative_path}`
}

function flattenFileTree(root: FileNode | null, source: ConversationInputFileSource & { workspaceLocationId: string }): FileCandidate[] {
  if (!root) return []
  const files: FileCandidate[] = []
  const visit = (node: FileNode) => {
    if (files.length >= 200) return
    if (node.type === 'file' && node.path !== '.') files.push({
      projectFolderId: source.projectFolderId,
      workspaceLocationId: source.workspaceLocationId,
      source: source.label,
      path: node.path,
      name: node.name,
      size: node.size ?? 0,
    })
    node.children?.forEach(visit)
  }
  visit(root)
  return files
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function emptyDoc(): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  }
}

function serializeComposerValue(doc: JSONContent): RoomMessageComposerValue {
  const tokens = tokensFromDoc(doc)
  const mentionIds = uniqueIds(tokens
    .filter((token): token is Extract<ComposerToken, { type: 'mention' }> => token.type === 'mention')
    .map(token => token.id)
    .filter(Boolean))
  return {
    text: normalizeMessageText(renderTokens(tokens, { includeMentions: true })),
    mentionIds,
    routingSegments: routingSegmentsFromTokens(tokens),
  }
}

function tokensFromDoc(doc: JSONContent): ComposerToken[] {
  const blocks = doc.content ?? []
  const tokens: ComposerToken[] = []
  blocks.forEach((block, index) => {
    if (index > 0) tokens.push({ type: 'text', text: '\n' })
    tokens.push(...tokensFromNode(block))
  })
  return tokens
}

function tokensFromNode(node: JSONContent): ComposerToken[] {
  if (node.type === 'text') return [{ type: 'text', text: node.text ?? '' }]
  if (node.type === 'agentMention') {
    const id = stringAttr(node.attrs?.id)
    const label = stringAttr(node.attrs?.label) || id
    return id ? [{ type: 'mention', id, label }] : []
  }
  if (node.type === 'hardBreak') return [{ type: 'text', text: '\n' }]
  return (node.content ?? []).flatMap(child => tokensFromNode(child))
}

function routingSegmentsFromTokens(tokens: ComposerToken[]): RoomMessageRoutingSegment[] {
  const clusters = mentionClusters(tokens)
  if (clusters.length === 0) return []

  if (clusters.length === 1) {
    const cluster = clusters[0]!
    const content = normalizeMessageText([
      renderTokens(tokens.slice(0, cluster.start), { includeMentions: false }),
      renderTokens(tokens.slice(cluster.end), { includeMentions: false }),
    ].filter(Boolean).join(' '))
    return [{
      recipient_agent_ids: cluster.recipient_agent_ids,
      content,
    }]
  }

  return clusters.map((cluster, index) => {
    const nextCluster = clusters[index + 1] ?? null
    const prefix = index === 0
      ? renderTokens(tokens.slice(0, cluster.start), { includeMentions: false })
      : ''
    let content = normalizeMessageText([
      prefix,
      renderTokens(tokens.slice(cluster.end, nextCluster?.start ?? tokens.length), { includeMentions: false }),
    ].filter(Boolean).join(' '))
    return {
      recipient_agent_ids: cluster.recipient_agent_ids,
      content,
    }
  })
}

function mentionClusters(tokens: ComposerToken[]): MentionCluster[] {
  const clusters: MentionCluster[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (token?.type !== 'mention') {
      index += 1
      continue
    }

    const recipientAgentIds = [token.id]
    const start = index
    let end = index + 1
    let cursor = end
    while (cursor < tokens.length) {
      let next = cursor
      while (tokens[next]?.type === 'text') {
        const textToken = tokens[next] as Extract<ComposerToken, { type: 'text' }>
        if (!isWhitespace(textToken.text)) break
        next += 1
      }
      if (tokens[next]?.type !== 'mention') break
      recipientAgentIds.push((tokens[next] as Extract<ComposerToken, { type: 'mention' }>).id)
      cursor = next + 1
      end = cursor
    }

    clusters.push({ start, end, recipient_agent_ids: uniqueIds(recipientAgentIds) })
    index = end
  }
  return clusters
}

function renderTokens(tokens: ComposerToken[], options: { includeMentions: boolean }): string {
  return tokens.map(token => {
    if (token.type === 'text') return token.text
    return options.includeMentions ? `@${token.label}` : ''
  }).join('')
}

function normalizeMessageText(value: string): string {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))]
}

function isWhitespace(value: string): boolean {
  return value.trim().length === 0
}

function stringAttr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
