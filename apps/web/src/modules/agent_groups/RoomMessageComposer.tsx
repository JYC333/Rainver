import { useEffect, useMemo, useRef, useState } from 'react'
import { Node, mergeAttributes, type JSONContent } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Bot } from 'lucide-react'
import type { AgentOut } from '../../types/api'

export interface RoomMessageComposerValue {
  text: string
  mentionIds: string[]
  routingSegments: RoomMessageRoutingSegment[]
}

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
}: {
  value: RoomMessageComposerValue
  onChange: (value: RoomMessageComposerValue) => void
  agents: AgentOut[]
  members: Array<{ agent_id: string; status: string }>
  disabled: boolean
  resetToken: number
  onSubmit: () => void
}) {
  const [mentionRange, setMentionRange] = useState<MentionRange | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const mentionRangeRef = useRef<MentionRange | null>(null)
  const suggestionsRef = useRef<AgentOut[]>([])
  const activeIndexRef = useRef(0)
  const disabledRef = useRef(disabled)
  const onSubmitRef = useRef(onSubmit)
  const mentionableAgents = useMemo(() => {
    const activeMemberIds = new Set(members.filter(member => member.status === 'active').map(member => member.agent_id))
    return agents
      .filter(agent => agent.status === 'active' && activeMemberIds.has(agent.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [agents, members])

  const suggestions = useMemo(() => {
    if (!mentionRange) return []
    const query = mentionRange.query.trim().toLowerCase()
    return mentionableAgents
      .filter(agent => !query || agent.name.toLowerCase().includes(query) || agent.id.toLowerCase().includes(query))
      .slice(0, 8)
  }, [mentionRange, mentionableAgents])

  mentionRangeRef.current = mentionRange
  suggestionsRef.current = suggestions
  activeIndexRef.current = activeIndex
  disabledRef.current = disabled
  onSubmitRef.current = onSubmit

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
    ],
    content: emptyDoc(),
    editable: !disabled,
    editorProps: {
      attributes: {
        class: 'min-h-[84px] rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-primary',
        role: 'textbox',
        'aria-label': 'Room message',
      },
      handleKeyDown: (view, event) => handleComposerKeyDown(event, view),
    },
    onUpdate: ({ editor: nextEditor }) => {
      onChange(serializeComposerValue(nextEditor.getJSON()))
      setMentionRange(activeMentionRange(nextEditor))
    },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      setMentionRange(activeMentionRange(nextEditor))
    },
  })

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [disabled, editor])

  useEffect(() => {
    if (!editor) return
    editor.commands.setContent(emptyDoc())
    setMentionRange(null)
    setActiveIndex(0)
    onChange(emptyRoomMessageComposerValue())
    // resetToken intentionally drives clearing the editor after a successful send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, resetToken])

  useEffect(() => {
    setActiveIndex(0)
  }, [mentionRange?.query])

  function insertMention(agent: AgentOut, range: MentionRange | null = mentionRange) {
    if (!editor || disabled) return
    const label = agent.name.trim() || agent.id
    const chain = editor.chain().focus()
    if (range) chain.deleteRange({ from: range.from, to: range.to })
    chain
      .insertContent({ type: 'agentMention', attrs: { id: agent.id, label } })
      .insertContent(' ')
      .run()
    setMentionRange(null)
  }

  function insertMentionFromView(view: EditorView, agent: AgentOut, range: MentionRange) {
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
    setMentionRange(null)
    return true
  }

  function handleComposerKeyDown(event: KeyboardEvent, view?: EditorView) {
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
        const agent = currentSuggestions[Math.min(activeIndexRef.current, currentSuggestions.length - 1)] ?? currentSuggestions[0]
        if (agent) {
          if (view) insertMentionFromView(view, agent, range)
          else insertMention(agent, range)
        }
        return true
      }
    }
    if (range && event.key === 'Escape') {
      event.preventDefault()
      setMentionRange(null)
      return true
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onSubmitRef.current()
      return true
    }
    return false
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        {value.text.trim().length === 0 && (
          <div className="pointer-events-none absolute left-3 top-2 z-10 text-sm text-muted-foreground">
            Message...
          </div>
        )}
        <EditorContent editor={editor} />
        {mentionRange && suggestions.length > 0 && (
          <div className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
            <div role="listbox" aria-label="Agent mentions" className="max-h-64 overflow-auto p-1">
              {suggestions.map((agent, index) => (
                <button
                  key={agent.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => insertMention(agent, mentionRange)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${
                    index === activeIndex ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  <Bot className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">@{agent.name}</span>
                </button>
              ))}
            </div>
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
