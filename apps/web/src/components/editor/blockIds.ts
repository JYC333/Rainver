import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

/**
 * Stable identity for a top-level block, mirroring the server's
 * `noteBlockIds.ts`.
 *
 * Two jobs, and the first is the one that is easy to miss: Tiptap parses
 * incoming JSON through its schema and **drops attributes the schema does not
 * declare**. Without this extension, opening a note the server had stamped and
 * saving it again would silently strip every id — so declaring the attribute is
 * a correctness requirement, not just the price of generating ids here.
 *
 * The second job is the split guard below.
 */
export const BLOCK_ID_ATTR = 'blockId'

/** Top-level block types. Ids identify what relocation can extract whole. */
export const BLOCK_ID_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'horizontalRule',
]

/**
 * The attribute declaration on its own, for surfaces that display notes but
 * never write them. A read-only view still has to declare it — otherwise the
 * schema drops the ids from the document it is reasoning about — but has no
 * business minting new ones.
 */
export const BlockIdAttribute = Extension.create({
  name: 'blockIdAttribute',

  addGlobalAttributes() {
    return [{
      types: BLOCK_ID_TYPES,
      attributes: {
        [BLOCK_ID_ATTR]: {
          default: null,
          // Kept out of the DOM: the id lives in the document JSON, which is
          // what gets persisted. Rendering it would put a churning attribute
          // into every copy-paste and every HTML export for no reader's benefit.
          rendered: false,
        },
      },
    }]
  },

})

/** The attribute plus the split guard, for the editable surface. */
/**
 * Strips `blockId: null` from a document produced by the editor.
 *
 * A ProseMirror global attribute attaches to a node *type*, not to a position,
 * so the paragraphs nested inside a list item carry it too. Only top-level
 * blocks are ever stamped, so those nested copies stay `null` — and Tiptap's
 * `getJSON()` serialises an attribute at its default rather than omitting it.
 * Left alone they would settle into every note and every revision as noise, and
 * the editor adapter's "did the document actually change" comparison would find
 * a difference between a server document and the identical editor one on every
 * single load.
 */
export function stripEmptyBlockIds<T>(doc: T): T {
  if (Array.isArray(doc)) return doc.map(entry => stripEmptyBlockIds(entry)) as T
  if (!doc || typeof doc !== 'object') return doc
  const source = doc as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key !== 'attrs') {
      next[key] = stripEmptyBlockIds(value)
      continue
    }
    const attrs = value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : value
    if (attrs && typeof attrs === 'object' && (attrs as Record<string, unknown>)[BLOCK_ID_ATTR] == null) {
      delete (attrs as Record<string, unknown>)[BLOCK_ID_ATTR]
    }
    if (attrs && typeof attrs === 'object' && Object.keys(attrs as Record<string, unknown>).length === 0) continue
    next[key] = attrs
  }
  return next as T
}

export const BlockIds = Extension.create({
  name: 'blockIds',

  addExtensions() {
    return [BlockIdAttribute]
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockIds'),
        /**
         * Pressing Enter splits a block, and ProseMirror copies the original
         * node's attrs onto the new one — so both halves would carry the same
         * id, and relocating "the captured paragraph" would extract two.
         *
         * This runs after every transaction that changed the document and gives
         * a fresh id to any block sharing one with an earlier block, plus one to
         * any block that has none (typed from scratch, or loaded from a note
         * written before ids existed).
         *
         * Which of two claimants keeps the id is decided by content, not by
         * position. Position alone is wrong at the one boundary that matters:
         * putting the cursor at the very start of a captured paragraph and
         * pressing Enter — the ordinary way to open a line above — leaves an
         * empty paragraph first and the captured text second, so a
         * first-wins rule would anchor the capture on the empty block and
         * relocation would extract nothing. A non-empty claimant therefore
         * outranks an empty one; between two non-empty blocks the earlier keeps
         * it, which is the mid-text split the naive rule already handled.
         *
         * The rewrite stays **in** the history, and that is the half of this
         * that is easy to get wrong. Undo reverts a split by merging the two
         * halves back into the *first* one and taking its attrs — so if the
         * guard's attribute change were flagged out of the history, undoing a
         * split-at-start would rejoin into the block the guard had just
         * re-minted and the capture's anchor would be gone from the note with
         * nothing to signal it. Being in the history, the id move is reverted
         * together with the split it answered; ProseMirror folds it into the
         * same history event, so one undo still reverts one user gesture.
         *
         * One accepted consequence: undoing on a note written before ids
         * existed hands the block a *different* fresh id rather than restoring
         * the `null` it had. Nothing anchors on those blocks yet, which is the
         * only reason it is acceptable.
         */
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some(transaction => transaction.docChanged)) return null
          // First pass: where each id is claimed, and whether that claimant has
          // any content. Deciding needs the whole document, so it cannot be
          // folded into a single walk.
          const claims = new Map<string, { pos: number; empty: boolean }>()
          const blocks: { pos: number; id: string | null; empty: boolean }[] = []
          // `descendants`/`forEach` hand back the offset *inside* the parent;
          // at the top level of a doc that is already the child's position, but
          // only because the doc node itself is not counted. Resolving through
          // `child(index)` and accumulating `nodeSize` is the arithmetic that
          // stays correct, and `setNodeMarkup` on a wrong position throws
          // rather than misbehaving quietly — which is how this was caught.
          let pos = 0
          for (let index = 0; index < newState.doc.childCount; index += 1) {
            const node = newState.doc.child(index)
            const at = pos
            pos += node.nodeSize
            if (!BLOCK_ID_TYPES.includes(node.type.name)) continue
            const raw = node.attrs[BLOCK_ID_ATTR]
            const id = typeof raw === 'string' && raw ? raw : null
            const empty = node.content.size === 0
            blocks.push({ pos: at, id, empty })
            if (!id) continue
            const held = claims.get(id)
            // A non-empty claimant takes the id from an empty one; otherwise
            // the earlier block keeps it.
            if (!held || (held.empty && !empty)) claims.set(id, { pos: at, empty })
          }

          const missing: { pos: number; id: string }[] = []
          const taken = new Set(claims.keys())
          for (const block of blocks) {
            if (block.id && claims.get(block.id)?.pos === block.pos) continue
            let next = crypto.randomUUID()
            while (taken.has(next)) next = crypto.randomUUID()
            taken.add(next)
            missing.push({ pos: block.pos, id: next })
          }
          if (missing.length === 0) return null
          const transaction = newState.tr
          for (const entry of missing) {
            const node = newState.doc.nodeAt(entry.pos)
            if (!node || !BLOCK_ID_TYPES.includes(node.type.name)) continue
            // Only reached for top-level blocks; a nested paragraph keeps the
            // attribute at its `null` default and is stripped on the way out.
            // `setNodeAttribute`, not `setNodeMarkup`: the latter rebuilds the
            // node and re-validates its content, so a document the reader can
            // display but the schema considers irregular — markdown that put an
            // image where a paragraph expects inline content, say — would throw
            // here purely because we wanted to add an attribute to it.
            try {
              transaction.setNodeAttribute(entry.pos, BLOCK_ID_ATTR, entry.id)
            } catch {
              // An attribute step revalidates the node's content, so a block
              // the schema considers irregular — markdown that put an image
              // where a paragraph expects inline content — would throw and take
              // the user's whole transaction with it. A block without an id is
              // simply one relocation cannot anchor on; a broken editor is not
              // a trade worth making for it.
            }
          }
          return transaction
        },
      }),
    ]
  },
})
