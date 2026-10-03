import MarkdownIt from 'markdown-it'

/**
 * Converts markdown into the Tiptap/ProseMirror JSON tree consumed by
 * `ReadOnlyTiptapReader` (see components/editor/ReadOnlyTiptapReader.tsx).
 *
 * This purposely does not go through `prosemirror-markdown`'s `MarkdownParser`:
 * that API resolves tokens against a live ProseMirror `Schema` instance, but
 * `ReadOnlyTiptapReader` only ever receives a plain JSON tree (Tiptap builds
 * the real schema/doc at mount time) and the reader's table nodes
 * (table/tableRow/tableCell/tableHeader) are a small custom shape, not the
 * standard `prosemirror-tables` schema. A direct token-tree → JSON walk is
 * simpler and matches the reader's actual node/mark names exactly.
 *
 * One parser instance is reused across calls; markdown-it instances are
 * stateless per parse() call (no per-render config toggling here).
 */
const parser = new MarkdownIt('default', { html: false, linkify: false, breaks: false })

/** markdown-it's own token type, derived from the parser instance to avoid depending
 *  on a re-exported type name (@types/markdown-it nests it under a namespace that isn't
 *  reachable from a plain default import without esModuleInterop). */
type Token = ReturnType<typeof parser.parse>[number]

interface ProseMirrorJsonNode {
  type: string
  attrs?: Record<string, unknown>
  content?: ProseMirrorJsonNode[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

type MarkFrame = { type: string; attrs?: Record<string, unknown> }

/** Converts a markdown string into a Tiptap-shaped `{ type: 'doc', content: [...] }` tree. */
export function markdownToProseMirrorJson(markdown: string): ProseMirrorJsonNode {
  const tokens = parser.parse(markdown ?? '', {})
  const content = blocksFromTokens(tokens, { index: 0 }, null)
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] }
}

/** Best-effort plain text extraction, used only for the reader's `normalizedText` prop
 *  (context slicing for selection features). Brief/Artifacts markdown rendering does not
 *  wire annotations yet, so this does not need to match the server's exact normalization. */
export function markdownToPlainText(doc: ProseMirrorJsonNode): string {
  const parts: string[] = []
  const walk = (node: ProseMirrorJsonNode) => {
    if (node.type === 'text' && node.text) parts.push(node.text)
    for (const child of node.content ?? []) walk(child)
    if (isBlockType(node.type)) parts.push('\n\n')
  }
  walk(doc)
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}

function isBlockType(type: string): boolean {
  return type !== 'text' && type !== 'doc'
}

interface Cursor { index: number }

/** Consumes tokens from `cursor.index` until the matching close for `stopTag`, returning child nodes. */
function blocksFromTokens(tokens: Token[], cursor: Cursor, stopType: string | null): ProseMirrorJsonNode[] {
  const nodes: ProseMirrorJsonNode[] = []
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index]!
    if (stopType && token.type === stopType) {
      cursor.index += 1
      return nodes
    }
    const node = blockNodeFromToken(tokens, cursor)
    if (node) nodes.push(node)
    else cursor.index += 1
  }
  return nodes
}

function blockNodeFromToken(tokens: Token[], cursor: Cursor): ProseMirrorJsonNode | null {
  const token = tokens[cursor.index]!
  switch (token.type) {
    case 'heading_open': {
      const level = Number(token.tag.replace('h', '')) || 1
      cursor.index += 1
      const inline = tokens[cursor.index]
      cursor.index += 1 // consume the inline token
      cursor.index += 1 // consume heading_close
      return { type: 'heading', attrs: { level: Math.min(6, Math.max(1, level)) }, content: inlineFromToken(inline) }
    }
    case 'paragraph_open': {
      cursor.index += 1
      const inline = tokens[cursor.index]
      cursor.index += 1
      cursor.index += 1 // paragraph_close
      const inlineContent = inlineFromToken(inline)
      return { type: 'paragraph', ...(inlineContent.length > 0 ? { content: inlineContent } : {}) }
    }
    case 'bullet_list_open': {
      cursor.index += 1
      const content = listItemsFromTokens(tokens, cursor, 'bullet_list_close')
      return { type: 'bulletList', content }
    }
    case 'ordered_list_open': {
      const start = Number(token.attrGet('start') ?? '1') || 1
      cursor.index += 1
      const content = listItemsFromTokens(tokens, cursor, 'ordered_list_close')
      return { type: 'orderedList', ...(start !== 1 ? { attrs: { start } } : {}), content }
    }
    case 'blockquote_open': {
      cursor.index += 1
      const content = blocksFromTokens(tokens, cursor, 'blockquote_close')
      return { type: 'blockquote', content: content.length > 0 ? content : [{ type: 'paragraph' }] }
    }
    case 'code_block':
    case 'fence': {
      cursor.index += 1
      const text = token.content.replace(/\n$/, '')
      const language = token.info?.trim() || null
      return {
        type: 'codeBlock',
        ...(language ? { attrs: { language } } : {}),
        ...(text ? { content: [{ type: 'text', text }] } : {}),
      }
    }
    case 'hr': {
      cursor.index += 1
      return { type: 'horizontalRule' }
    }
    case 'table_open': {
      cursor.index += 1
      const rows = tableRowsFromTokens(tokens, cursor)
      return { type: 'table', content: rows }
    }
    default:
      return null
  }
}

function listItemsFromTokens(tokens: Token[], cursor: Cursor, stopType: string): ProseMirrorJsonNode[] {
  const items: ProseMirrorJsonNode[] = []
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index]!
    if (token.type === stopType) {
      cursor.index += 1
      return items
    }
    if (token.type === 'list_item_open') {
      cursor.index += 1
      const content = blocksFromTokens(tokens, cursor, 'list_item_close')
      items.push({ type: 'listItem', content: content.length > 0 ? content : [{ type: 'paragraph' }] })
      continue
    }
    cursor.index += 1
  }
  return items
}

/** Table rows/cells: markdown-it emits thead/tbody wrappers we flatten away; header cells
 *  (`th`) map to our `tableHeader` node, body cells (`td`) to `tableCell`. */
function tableRowsFromTokens(tokens: Token[], cursor: Cursor): ProseMirrorJsonNode[] {
  const rows: ProseMirrorJsonNode[] = []
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index]!
    if (token.type === 'table_close') {
      cursor.index += 1
      return rows
    }
    if (token.type === 'thead_open' || token.type === 'thead_close' || token.type === 'tbody_open' || token.type === 'tbody_close') {
      cursor.index += 1
      continue
    }
    if (token.type === 'tr_open') {
      cursor.index += 1
      const cells = tableCellsFromTokens(tokens, cursor)
      rows.push({ type: 'tableRow', content: cells })
      continue
    }
    cursor.index += 1
  }
  return rows
}

function tableCellsFromTokens(tokens: Token[], cursor: Cursor): ProseMirrorJsonNode[] {
  const cells: ProseMirrorJsonNode[] = []
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index]!
    if (token.type === 'tr_close') {
      cursor.index += 1
      return cells
    }
    if (token.type === 'th_open' || token.type === 'td_open') {
      const nodeType = token.type === 'th_open' ? 'tableHeader' : 'tableCell'
      cursor.index += 1
      const inline = tokens[cursor.index]
      cursor.index += 1 // consume inline
      cursor.index += 1 // consume th_close/td_close
      const inlineContent = inlineFromToken(inline)
      cells.push({
        type: nodeType,
        content: [{ type: 'paragraph', ...(inlineContent.length > 0 ? { content: inlineContent } : {}) }],
      })
      continue
    }
    cursor.index += 1
  }
  return cells
}

function inlineFromToken(token: Token | undefined): ProseMirrorJsonNode[] {
  if (!token?.children) return []
  const nodes: ProseMirrorJsonNode[] = []
  const markStack: MarkFrame[] = []

  const pushText = (text: string) => {
    if (!text) return
    nodes.push({ type: 'text', text, ...(markStack.length > 0 ? { marks: markStack.map(m => ({ type: m.type, ...(m.attrs ? { attrs: m.attrs } : {}) })) } : {}) })
  }

  for (const child of token.children) {
    switch (child.type) {
      case 'text':
        pushText(child.content)
        break
      case 'softbreak':
        pushText(' ')
        break
      case 'hardbreak':
        nodes.push({ type: 'hardBreak' })
        break
      case 'strong_open':
        markStack.push({ type: 'bold' })
        break
      case 'strong_close':
        popMark(markStack, 'bold')
        break
      case 'em_open':
        markStack.push({ type: 'italic' })
        break
      case 'em_close':
        popMark(markStack, 'italic')
        break
      case 's_open':
        markStack.push({ type: 'strike' })
        break
      case 's_close':
        popMark(markStack, 'strike')
        break
      case 'code_inline':
        markStack.push({ type: 'code' })
        pushText(child.content)
        popMark(markStack, 'code')
        break
      case 'link_open': {
        const href = child.attrGet('href')
        markStack.push({ type: 'link', attrs: { href: href ?? null } })
        break
      }
      case 'link_close':
        popMark(markStack, 'link')
        break
      case 'image': {
        const src = child.attrGet('src')
        const alt = child.content || null
        const title = child.attrGet('title')
        nodes.push({ type: 'image', attrs: { src: src ?? null, alt, title: title ?? null } })
        break
      }
      default:
        break
    }
  }
  return nodes
}

function popMark(stack: MarkFrame[], type: string): void {
  const index = stack.map(m => m.type).lastIndexOf(type)
  if (index >= 0) stack.splice(index, 1)
}
