import { skillReferenceRanges, SkillMenuEmptyHint, useAvailableSkills } from '../conversation/conversationSkills'
import { useAppTranslation } from '../../i18n'
import type { ConversationInputSkillPart } from '@rainver/protocol'
import { useConversationScope } from '../conversation/ConversationScope'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Node, mergeAttributes, type JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Bot, FileText, Loader2 } from 'lucide-react'
import type { ConversationInputFileReferencePart, ConversationInputPart } from '@rainver/protocol'
import {
  CONVERSATION_MAX_FILE_REFERENCES,
  CONVERSATION_MAX_FILE_SNAPSHOT_BYTES,
  agentMentionRoute,
  normalizeMentionText,
  parseAgentMentions,
  renderMentionTokens,
  type AgentMentionRoute,
  type AgentMentionToken,
} from '@rainver/protocol'
import { conversationInputApi, projectFoldersApi } from '../../api/client'
import type { FileNode } from '../../types/api'
import { errMsg } from '../../lib/utils'
import { useConversationInputSendGuard, type ConversationInputFileSource } from '../conversation/ConversationInputComposer'

export type RoomRoutingMode = 'direct' | 'agent_coordination'

export interface RoomMessageComposerValue {
  text: string
  mentionIds: string[]
  /** Where the mentions send the message by default: an opening `@` addresses, any other refers. */
  mentionRoute: AgentMentionRoute
  /** The person's choice of route for this draft; it holds while the mentions (`mentionRoute.key`) stay the same. */
  routeChoice: RoomRoutingMode | null
}

/** Where a draft goes: the person's choice, else what its mentions say, else the manager. */
export interface RoomMessageRoute {
  routing_mode: RoomRoutingMode
  /** Direct sends only: who receives which part. Empty means the manager. */
  recipient_segments: RoomMessageRoutingSegment[]
  /** Coordination only: the Agents the manager is asked to arrange the work with. */
  coordination_target_agent_ids: string[]
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
  | { type: 'skill'; skill: ConversationInputSkillPart }

interface RoomMessageRoutingSegment {
  recipient_agent_ids: string[]
  content: string
}

interface MentionRange {
  trigger: '@' | '/'
  from: number
  to: number
  query: string
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

/**
 * A selected Skill, shown inline like an Agent mention and removed as one
 * token. Its text is the visible `/Name`; the input part carries the package.
 */
const SkillReferenceNode = Node.create({
  name: 'skillReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      skillPackageId: {
        default: '',
        parseHTML: element => element.getAttribute('data-skill-package-id') ?? '',
        renderHTML: attributes => ({ 'data-skill-package-id': attributes.skillPackageId }),
      },
      label: {
        default: '',
        parseHTML: element => element.getAttribute('data-label') ?? '',
        renderHTML: attributes => ({ 'data-label': attributes.label }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-skill-reference]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-skill-reference': 'true',
        class: 'inline-flex items-center rounded bg-primary/15 px-1.5 py-0.5 font-medium text-primary',
      }),
      `/${node.attrs.label}`,
    ]
  },

  renderText({ node }) {
    return `/${node.attrs.label}`
  },

  // Browsers differ on deleting an inline atom; remove the whole reference
  // explicitly, so its selection ends with it.
  addKeyboardShortcuts() {
    const remove = (direction: 'backward' | 'forward') => this.editor.commands.command(({ state, tr }) => {
      const { selection } = state
      if (!selection.empty) return false
      const node = direction === 'backward' ? selection.$from.nodeBefore : selection.$from.nodeAfter
      if (node?.type.name !== this.name) return false
      const from = direction === 'backward' ? selection.from - node.nodeSize : selection.from
      tr.delete(from, from + node.nodeSize)
      return true
    })
    return { Backspace: () => remove('backward'), Delete: () => remove('forward') }
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
  return { text: '', mentionIds: [], mentionRoute: agentMentionRoute([]), routeChoice: null }
}

export function roomMessageRoute(value: RoomMessageComposerValue, managerAgentId?: string | null): RoomMessageRoute {
  const mode = value.routeChoice ?? value.mentionRoute.default_route ?? 'direct'
  return mode === 'agent_coordination'
    ? {
        routing_mode: mode,
        recipient_segments: [],
        coordination_target_agent_ids: value.mentionRoute.mentioned_agent_ids.filter(id => id !== managerAgentId),
      }
    : { routing_mode: 'direct', recipient_segments: value.mentionRoute.direct_segments, coordination_target_agent_ids: [] }
}

/** Who a draft reaches: the named Agents of a direct send, otherwise the manager. */
export function roomMessageRecipientIds(route: RoomMessageRoute, managerAgentId?: string | null): string[] {
  return route.recipient_segments.length > 0
    ? uniqueIds(route.recipient_segments.flatMap(segment => segment.recipient_agent_ids))
    : managerAgentId ? [managerAgentId] : []
}

export function RoomMessageComposer({
  value,
  onChange,
  agents,
  members,
  disabled,
  resetToken,
  restore,
  onSubmit,
  embedded = false,
  projectId,
  projectFolderId,
  fileSources,
  sessionId,
  inputParts = [],
  onInputPartsChange,
  recipientAgentIds,
  managerAgentId,
}: {
  value: RoomMessageComposerValue
  onChange: (value: RoomMessageComposerValue) => void
  agents: Array<{ id: string; name: string; status?: string }>
  members: Array<{ agent_id: string; status: string }>
  disabled: boolean
  resetToken: number
  /** A saved draft to put back in the editor; a new `token` applies it, with the route the person chose for it. */
  restore?: { token: number; text: string; routeChoice?: RoomRoutingMode | null } | null
  onSubmit: () => void
  /** The shared conversation frame owns the border and focus treatment. */
  embedded?: boolean
  projectId?: string | null
  projectFolderId?: string | null
  fileSources?: ConversationInputFileSource[]
  sessionId?: string | null
  inputParts?: ConversationInputPart[]
  onInputPartsChange?: (parts: ConversationInputPart[]) => void
  /** Who the next message reaches; the Skill menu offers only Skills enabled for all of them. Defaults to the named Agents, else the manager. */
  recipientAgentIds?: readonly string[]
  /** The Room's manager: who a coordinated or unaddressed message reaches. */
  managerAgentId?: string | null
}) {
  const scope = useConversationScope()
  const { t } = useAppTranslation()
  const [mentionRange, setMentionRange] = useState<MentionRange | null>(null)
  const route = roomMessageRoute(value, managerAgentId)
  const skillCatalog = useAvailableSkills({
    sessionId, projectId, enabled: !!mentionRange && !!onInputPartsChange,
    recipientAgentIds: recipientAgentIds ?? roomMessageRecipientIds(route, managerAgentId),
  })
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
  // The editor's callbacks are bound once; a route choice is carried
  // forward from the latest value, not the one they closed over.
  const valueRef = useRef(value)
  valueRef.current = value
  const canSend = useConversationInputSendGuard()
  const mentionableAgents = useMemo(() => {
    const activeMemberIds = new Set(members.filter(member => member.status === 'active').map(member => member.agent_id))
    return agents
      .filter(agent => agent.status === 'active' && activeMemberIds.has(agent.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [agents, members])

  const agentSuggestions = useMemo(() => {
    if (!mentionRange || mentionRange.trigger === '/') return []
    const query = mentionRange.query.trim().toLowerCase()
    return mentionableAgents
      .filter(agent => !query || agent.name.toLowerCase().includes(query) || agent.id.toLowerCase().includes(query))
      .slice(0, 8)
  }, [mentionRange, mentionableAgents])

  const fileSuggestions = useMemo(() => {
    if (!mentionRange || mentionRange.trigger === '/') return []
    const query = mentionRange.query.trim().toLowerCase()
    return fileCandidates
      .filter(file => !query || file.path.toLowerCase().includes(query) || file.name.toLowerCase().includes(query))
      .slice(0, 8)
  }, [fileCandidates, mentionRange])

  const suggestions = useMemo<MentionSuggestion[]>(() => [
    ...agentSuggestions.map(agent => ({ type: 'agent' as const, agent })),
    ...fileSuggestions.map(file => ({ type: 'file' as const, file })),
    ...skillCatalog.skills.filter(skill => skill.display_name.toLowerCase().includes(mentionRange?.query.toLowerCase() ?? '')
      && !inputParts.some(part => part.kind === 'skill' && part.skill_package_id === skill.skill_package_id))
      .slice(0, 8).map(skill => ({ type: 'skill' as const, skill })),
  ], [agentSuggestions, fileSuggestions, skillCatalog.skills, mentionRange, inputParts])
  const noSkills = !!onInputPartsChange && skillCatalog.loaded && skillCatalog.skills.length === 0

  mentionRangeRef.current = mentionRange
  suggestionsRef.current = suggestions
  activeIndexRef.current = activeIndex
  disabledRef.current = disabled
  onSubmitRef.current = onSubmit
  inputPartsRef.current = inputParts

  const fileSourceKey = fileSources == null
    ? `fallback:${projectFolderId ?? ''}`
    : fileSources.map(source => `${source.projectFolderId}:${source.workspaceLocationId ?? ''}:${source.label}`).join('|')
  const mentionQuery = mentionRange?.trigger === '@' ? mentionRange.query : null
  fileSourcesRef.current = fileSources

  function updateMentionRange(next: MentionRange | null) {
    setMentionRange(previous => (
      previous?.from === next?.from
      && previous?.to === next?.to
      && previous?.query === next?.query
      && previous?.trigger === next?.trigger
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
      void conversationInputApi.searchFiles(sessionId, mentionQuery, controller.signal, scope).then(response => {
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
      const tree = await projectFoldersApi.tree(projectId, source.projectFolderId, '.', 0, scope)
      if (source.workspaceLocationId) return { source: { ...source, workspaceLocationId: source.workspaceLocationId }, tree }
      const locations = await projectFoldersApi.locations(projectId, source.projectFolderId, scope)
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
  }, [fileSourceKey, mentionQuery, projectFolderId, projectId, sessionId, scope])

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
      SkillReferenceNode,
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
        const nextValue = serializeComposerValue(nextEditor.getJSON(), valueRef.current.routeChoice, valueRef.current.mentionRoute.key)
        const { fileReferenceKeys, skillPackageIds } = referencedParts(nextEditor.state.doc)
        const nextInputParts = inputPartsRef.current.filter(part => (
          part.kind === 'file_reference' ? fileReferenceKeys.has(fileReferenceKey(part))
            : part.kind !== 'skill' || skillPackageIds.has(part.skill_package_id)
        ))
        if (nextInputParts.length !== inputPartsRef.current.length) {
          inputPartsRef.current = nextInputParts
          onInputPartsChange?.(nextInputParts)
        }
        onChange(nextValue)
        updateMentionRange(activeMentionRange(nextEditor))
      },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      updateMentionRange(activeMentionRange(nextEditor))
    },
  })

  useEffect(() => {
    // Changing editability must not reconcile selections against a draft that
    // has not been restored into the editor yet.
    editor?.setEditable(!disabled, false)
  }, [disabled, editor])

  useEffect(() => {
    if (!editor) return
    editor.commands.setContent(emptyDoc(), { emitUpdate: false })
    setHasEditorContent(false)
    updateMentionRange(null)
    setActiveIndex(0)
    onChange(emptyRoomMessageComposerValue())
    // resetToken intentionally drives clearing the editor after a successful send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, resetToken])

  // A restored draft is text; `@Name` of a roster Agent comes back as a
  // mention, so the message still reaches the Agent it was addressed to. Set
  // without an update event, which would drop the draft's file references
  // before the effect below draws them.
  useEffect(() => {
    if (!editor || !restore) return
    const roster = mentionableAgents.map(agent => ({ agent_id: agent.id, label: agent.name }))
    editor.commands.setContent(docFromText(restore.text, roster), { emitUpdate: false })
    setHasEditorContent(!editor.isEmpty)
    const restored = serializeComposerValue(editor.getJSON())
    onChange(restore.routeChoice && restored.mentionRoute.default_route && restore.routeChoice !== restored.mentionRoute.default_route
      ? { ...restored, routeChoice: restore.routeChoice }
      : restored)
    // Applied once per restore; a roster change must not overwrite later typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, restore?.token])

  useEffect(() => {
    if (!editor) return
    const { fileReferenceKeys, skillPackageIds } = referencedParts(editor.state.doc)
    const missing = inputParts.filter((part): part is ConversationInputFileReferencePart => (
      part.kind === 'file_reference' && !fileReferenceKeys.has(fileReferenceKey(part))
    ))
    const missingSkills = inputParts.filter((part): part is ConversationInputSkillPart => part.kind === 'skill' && !skillPackageIds.has(part.skill_package_id))
    if (!missing.length && !missingSkills.length) return
    // Restore all references in one transaction so onUpdate sees every part.
    const { schema } = editor.state
    const tr = editor.state.tr
    if (missing.length) {
      tr.insert(tr.selection.from, missing.flatMap(part => [
        schema.nodes.fileReference!.create({
          path: part.relative_path,
          projectFolderId: part.project_folder_id,
          workspaceLocationId: part.workspace_location_id,
        }),
        schema.text(' '),
      ]))
    }
    // A restored draft carries the visible `/Name`; turn it back into its
    // reference, and add one at the end for a selection without text.
    for (const skill of missingSkills) {
      const node = schema.nodes.skillReference!.create({ skillPackageId: skill.skill_package_id, label: skill.display_name })
      const found = skillReferenceTextRange(tr.doc, skill)
      if (found) {
        tr.replaceWith(found.from, found.to, node)
        continue
      }
      const end = tr.doc.content.size - 1
      tr.insert(end, [...(tr.doc.textBetween(0, end).trim() ? [schema.text(' ')] : []), node, schema.text(' ')])
    }
    editor.view.dispatch(tr)
    if (missing.length) editor.view.focus()
  }, [editor, inputParts, restore?.token])

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
      const content = await projectFoldersApi.file(projectId, file.projectFolderId, file.path, scope)
      if (scope.signal?.aborted) return
      const bytes = new TextEncoder().encode(content.content)
      if (bytes.byteLength > CONVERSATION_MAX_FILE_SNAPSHOT_BYTES) throw new Error('file is too large to reference')
      // The server admits the decoded body it freezes, so the digest is the
      // body's: `content.sha256` hashes the bytes on disk, a BOM included.
      const sha256 = await digestHex(bytes)
      if (scope.signal?.aborted) return
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

  function insertSkill(skill: ConversationInputSkillPart, range: MentionRange, view?: EditorView) {
    if (disabledRef.current || !onInputPartsChange) return
    if (inputPartsRef.current.filter(part => part.kind === 'skill').length >= 4) { setFileError(t('skill_packages.limit')); return }
    if (inputPartsRef.current.some(part => part.kind === 'skill' && part.skill_package_id === skill.skill_package_id)) return
    const next = [...inputPartsRef.current, skill]
    inputPartsRef.current = next
    onInputPartsChange(next)
    const targetView = view ?? editor?.view
    const skillType = targetView?.state.schema.nodes.skillReference
    if (!targetView || !skillType) return
    const node = skillType.create({ skillPackageId: skill.skill_package_id, label: skill.display_name })
    const { state } = targetView
    const following = state.doc.textBetween(range.to, state.doc.content.size, '\n', '\0')
    const tr = state.tr.replaceWith(range.from, range.to, node)
    if (!/^\s/u.test(following)) tr.insertText(' ', range.from + node.nodeSize)
    targetView.dispatch(tr.scrollIntoView())
    if (!view) targetView.focus()
    updateMentionRange(null)
  }

  function handleComposerKeyDown(event: KeyboardEvent, view?: EditorView) {
    // ProseMirror deliberately leaves native text insertion to the browser;
    // a leading space therefore does not always produce an update event in
    // every browser. The placeholder still represents an empty editor, not
    // an empty trimmed message, so hide it as soon as the person types one.
    if (event.key === ' ' && !disabledRef.current) setHasEditorContent(true)
    if (event.isComposing || event.keyCode === 229) return false
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
      if (!event.shiftKey && (event.key === 'Enter' || event.key === 'Tab')) {
        event.preventDefault()
        const suggestion = currentSuggestions[Math.min(activeIndexRef.current, currentSuggestions.length - 1)] ?? currentSuggestions[0]
        if (suggestion?.type === 'agent') {
          if (view) insertMentionFromView(view, suggestion.agent, range)
          else insertMention(suggestion.agent, range)
        } else if (suggestion?.type === 'skill') {
          insertSkill(suggestion.skill, range, view)
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
            <div className="border-b border-border px-2 py-1 text-[11px] font-medium text-muted-foreground">{mentionRange.trigger === '/' ? t('skill_packages.invoke') : '@ · Agents · Files · Skills'}</div>
            {fileLoading && <p className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Searching authorized files…</p>}
            <div role="listbox" aria-label="Agents and Files" className="max-h-64 overflow-auto p-1">
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.type === 'agent' ? `agent:${suggestion.agent.id}` : suggestion.type === 'skill' ? `skill:${suggestion.skill.skill_package_id}` : `file:${suggestion.file.projectFolderId}:${suggestion.file.path}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => suggestion.type === 'agent' ? insertMention(suggestion.agent, mentionRange) : suggestion.type === 'skill' ? insertSkill(suggestion.skill, mentionRange) : void insertFile(suggestion.file, mentionRange)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${
                    index === activeIndex ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  {suggestion.type === 'agent' ? <Bot className="size-3.5 shrink-0" /> : <FileText className="size-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">
                    <span className="block truncate">{suggestion.type === 'agent' ? `@${suggestion.agent.name}` : suggestion.type === 'skill' ? `/${suggestion.skill.display_name}` : suggestion.file.name}</span>
                    {suggestion.type === 'skill' && <span className="block text-[11px]">Skill · {suggestion.skill.package_hash.slice(0, 8)}</span>}
                    {suggestion.type === 'file' && <span className="block truncate text-[11px] text-muted-foreground">{suggestion.file.source} · {suggestion.file.path}</span>}
                  </span>
                </button>
              ))}
              {skillCatalog.error && <p role="alert" className="p-2 text-xs text-destructive">{skillCatalog.error}</p>}
              {noSkills && <p className="px-2 py-2 text-xs text-muted-foreground"><SkillMenuEmptyHint /></p>}
              {suggestions.length === 0 && !fileLoading && !fileError && !(noSkills && mentionRange.trigger === '/') && (
                <p className="px-2 py-2 text-xs text-muted-foreground">No matching agents or files.</p>
              )}
            </div>
            {fileError && <p className="px-2 pb-2 text-xs text-destructive" role="alert">{fileError}</p>}
          </div>
        )}
      </div>
      {value.mentionRoute.default_route && (
        <RoomMessageRouteLine
          route={route}
          directRecipientIds={uniqueIds(value.mentionRoute.direct_segments.flatMap(segment => segment.recipient_agent_ids))}
          agentName={agentId => agents.find(agent => agent.id === agentId)?.name ?? agentId}
          disabled={disabled}
          embedded={embedded}
          onToggle={() => onChange({
            ...value,
            routeChoice: route.routing_mode === 'direct' ? 'agent_coordination' : 'direct',
          })}
        />
      )}
    </div>
  )
}

/**
 * One line under the editor saying where a message with mentions will go,
 * and the one other place it could go. An opening `@` addresses the Agent
 * directly; a mention inside a sentence is handed to the manager to arrange.
 */
function RoomMessageRouteLine({ route, directRecipientIds, agentName, disabled, embedded, onToggle }: {
  route: RoomMessageRoute
  directRecipientIds: string[]
  agentName: (agentId: string) => string
  disabled: boolean
  embedded: boolean
  onToggle: () => void
}) {
  const { t } = useAppTranslation()
  const names = (ids: readonly string[]) => ids.map(agentName).join(', ')
  const coordinated = route.routing_mode === 'agent_coordination'
  const directIds = coordinated
    ? directRecipientIds
    : uniqueIds(route.recipient_segments.flatMap(segment => segment.recipient_agent_ids))
  return (
    <div className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground ${embedded ? 'px-3' : ''}`}>
      <span aria-live="polite" aria-label={t('conversation_ui.surface.route.label')} data-testid="room-message-route">
        {'→ '}
        {coordinated ? t('conversation_ui.surface.route.manager') : t('conversation_ui.surface.route.direct', { agents: names(directIds) })}
        {coordinated && route.coordination_target_agent_ids.length > 0 && (
          <>{' · '}{t('conversation_ui.surface.route.targets', { agents: names(route.coordination_target_agent_ids) })}</>
        )}
      </span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        className="rounded text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        onMouseDown={event => event.preventDefault()}
        onClick={onToggle}
      >
        {coordinated
          ? t('conversation_ui.surface.route.to_direct', { agents: names(directIds) })
          : t('conversation_ui.surface.route.to_manager')}
      </button>
    </div>
  )
}

function activeMentionRange(editor: NonNullable<ReturnType<typeof useEditor>>): MentionRange | null {
  const { selection } = editor.state
  if (!selection.empty) return null
  const { $from } = selection
  // A hard break is a line start, where an `@` addresses an Agent; other
  // inline nodes (mentions, file chips) are opaque.
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', node => node.type.name === 'hardBreak' ? '\n' : '\0')
  const atIndex = Math.max(textBefore.lastIndexOf('@'), textBefore.lastIndexOf('/'))
  if (atIndex < 0) return null
  if (atIndex > 0 && !/\s/.test(textBefore[atIndex - 1] ?? '')) return null
  const query = textBefore.slice(atIndex + 1)
  if (/[\s@/]/.test(query)) return null
  return {
    trigger: textBefore[atIndex] as '@' | '/',
    from: selection.from - query.length - 1,
    to: selection.from,
    query,
  }
}

function referencedParts(doc: ProseMirrorNode): { fileReferenceKeys: Set<string>; skillPackageIds: Set<string> } {
  const fileReferenceKeys = new Set<string>()
  const skillPackageIds = new Set<string>()
  doc.descendants(node => {
    if (node.type.name === 'skillReference') skillPackageIds.add(String(node.attrs.skillPackageId ?? ''))
    if (node.type.name !== 'fileReference') return
    fileReferenceKeys.add(fileReferenceKey({
      project_folder_id: String(node.attrs.projectFolderId ?? ''),
      workspace_location_id: String(node.attrs.workspaceLocationId ?? ''),
      relative_path: String(node.attrs.path ?? ''),
    }))
  })
  return { fileReferenceKeys, skillPackageIds }
}

/** The first complete `/Name` typed as plain text, as document positions. */
function skillReferenceTextRange(doc: ProseMirrorNode, skill: ConversationInputSkillPart): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (!node.isText) return
    const range = skillReferenceRanges(node.text ?? '', [skill])[0]
    if (range) found = { from: pos + range.from, to: pos + range.to }
  })
  return found
}

function fileReferenceKey(part: Pick<ConversationInputFileReferencePart, 'project_folder_id' | 'workspace_location_id' | 'relative_path'>): string {
  return `${part.project_folder_id}:${part.workspace_location_id}:${part.relative_path}`
}

function flattenFileTree(root: FileNode | null, source: ConversationInputFileSource & { workspaceLocationId: string }): FileCandidate[] {
  if (!root) return []
  // Every file the tree holds (the server bounds the tree itself): the query
  // filters before the menu trims to what it shows, so no file is unreachable.
  const files: FileCandidate[] = []
  const visit = (node: FileNode) => {
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

function docFromText(text: string, roster: Array<{ agent_id: string; label: string }>): JSONContent {
  const paragraphs = text.split('\n').map(line => {
    const content = parseAgentMentions(line, roster).tokens.flatMap((token): JSONContent[] => {
      if (token.type === 'mention') return [{ type: 'agentMention', attrs: { id: token.id, label: token.label } }]
      return token.text ? [{ type: 'text', text: token.text }] : []
    })
    return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
  })
  return { type: 'doc', content: paragraphs }
}

function emptyDoc(): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  }
}

function serializeComposerValue(
  doc: JSONContent,
  routeChoice: RoomRoutingMode | null = null,
  routeKey: string | null = null,
): RoomMessageComposerValue {
  const tokens = tokensFromDoc(doc)
  const mentionIds = uniqueIds(tokens
    .filter((token): token is Extract<AgentMentionToken, { type: 'mention' }> => token.type === 'mention')
    .map(token => token.id)
    .filter(Boolean))
  // The same rule the server applies to an Agent's reply.
  const mentionRoute = agentMentionRoute(tokens)
  return {
    text: normalizeMentionText(renderMentionTokens(tokens, true)),
    mentionIds,
    mentionRoute,
    // A choice made for these mentions; changing them asks again.
    routeChoice: routeChoice && mentionRoute.key === routeKey && mentionRoute.default_route ? routeChoice : null,
  }
}

function tokensFromDoc(doc: JSONContent): AgentMentionToken[] {
  const blocks = doc.content ?? []
  const tokens: AgentMentionToken[] = []
  blocks.forEach((block, index) => {
    if (index > 0) tokens.push({ type: 'text', text: '\n' })
    tokens.push(...tokensFromNode(block))
  })
  return tokens
}

function tokensFromNode(node: JSONContent): AgentMentionToken[] {
  if (node.type === 'text') return [{ type: 'text', text: node.text ?? '' }]
  if (node.type === 'agentMention') {
    const id = stringAttr(node.attrs?.id)
    const label = stringAttr(node.attrs?.label) || id
    return id ? [{ type: 'mention', id, label }] : []
  }
  if (node.type === 'skillReference') return [{ type: 'text', text: `/${stringAttr(node.attrs?.label)}` }]
  if (node.type === 'hardBreak') return [{ type: 'text', text: '\n' }]
  return (node.content ?? []).flatMap(child => tokensFromNode(child))
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))]
}

function stringAttr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
