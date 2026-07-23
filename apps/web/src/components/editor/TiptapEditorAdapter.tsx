import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  Bold,
  Code,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from 'lucide-react'
import { Button } from '../ui/button'
import { Select } from '../ui/select'
import { cn } from '../../lib/utils'
import { richTextSnapshotFromDocument } from './document'
import type { RichTextDocument, RichTextEditorHandle, RichTextEditorProps } from './types'

const BLOCK_OPTIONS = [
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'heading-1', label: 'Heading 1' },
  { value: 'heading-2', label: 'Heading 2' },
  { value: 'heading-3', label: 'Heading 3' },
]

export const TiptapEditorAdapter = forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  function TiptapEditorAdapter({ initialContent, variant = 'default', className, onChange }, ref) {
    const [renderKey, setRenderKey] = useState(0)
    const initialContentKey = useMemo(() => JSON.stringify(initialContent), [initialContent])
    const extensions = useMemo(
      () => [StarterKit.configure({ heading: { levels: [1, 2, 3] } })],
      [],
    )

    // Keep the latest onChange without recreating the editor, and suppress the
    // update that fires while we apply content programmatically (load/reset).
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange
    const applyingExternal = useRef(false)

    const editor = useEditor({
      extensions,
      content: initialContent,
      editorProps: {
        attributes: {
          class: 'rich-text-editor-surface',
        },
      },
      onSelectionUpdate: () => setRenderKey(key => key + 1),
      onTransaction: () => setRenderKey(key => key + 1),
      onUpdate: () => {
        if (applyingExternal.current) return
        onChangeRef.current?.()
      },
    })

    // `initialContent` is a fresh object reference on every parent re-render
    // (each API response rebuilds it), even when the actual content hasn't
    // changed. Depending on it directly here reset the live document — and
    // silently discarded whatever the user was mid-typing — on any unrelated
    // re-render, not just a genuine content change. `initialContentKey` is
    // the value-stable signal for "the content actually changed."
    //
    // Even with that guard, a caller that re-confirms "what's already on
    // screen" after its own save (e.g. re-deriving `initialContent` from the
    // document it just captured via `getSnapshot`) still produces a new
    // `initialContentKey` — same content, but a real value change. Calling
    // `setContent` in that case is a no-op content-wise but still resets the
    // cursor/selection to the document start, which reads as "every save
    // knocks me to the bottom of the note." So compare against what the
    // editor is *actually* showing right now and skip the reset entirely
    // when it already matches — `setContent` should only ever run for a
    // genuinely different document (an external edit landing, or switching
    // documents).
    useEffect(() => {
      if (!editor) return
      if (JSON.stringify(editor.getJSON()) === initialContentKey) return
      applyingExternal.current = true
      editor.commands.setContent(initialContent)
      applyingExternal.current = false
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, initialContentKey])

    useImperativeHandle(
      ref,
      () => ({
        getSnapshot: () => richTextSnapshotFromDocument(
          (editor?.getJSON() as RichTextDocument | undefined) ?? initialContent,
        ),
        focus: () => {
          editor?.commands.focus()
        },
      }),
      [editor, initialContent],
    )

    const isPage = variant === 'page'

    if (!editor) {
      return (
        <div
          className={cn(
            isPage ? 'min-h-[60vh]' : 'rounded-md border border-border bg-input min-h-72',
            className,
          )}
        />
      )
    }

    return (
      <div
        className={cn(
          'rich-text-editor',
          isPage
            ? 'rich-text-page flex flex-col'
            : 'rounded-md border border-border bg-input overflow-hidden',
          className,
        )}
      >
        <TiptapToolbar editor={editor} renderKey={renderKey} variant={variant} />
        <EditorContent
          editor={editor}
          className={cn(
            'rich-text-editor-content',
            isPage ? 'flex-1 min-h-[60vh]' : variant === 'notes' ? 'min-h-[22rem]' : 'min-h-64',
          )}
        />
      </div>
    )
  },
)

interface TiptapToolbarProps {
  editor: NonNullable<ReturnType<typeof useEditor>>
  renderKey: number
  variant?: RichTextEditorProps['variant']
}

function TiptapToolbar({ editor, renderKey, variant }: TiptapToolbarProps) {
  void renderKey
  const isPage = variant === 'page'

  function activeBlock() {
    if (editor.isActive('heading', { level: 1 })) return 'heading-1'
    if (editor.isActive('heading', { level: 2 })) return 'heading-2'
    if (editor.isActive('heading', { level: 3 })) return 'heading-3'
    return 'paragraph'
  }

  function setBlock(value: string) {
    if (value === activeBlock()) return
    if (value === 'paragraph') {
      editor.chain().focus().setParagraph().run()
      return
    }
    const level = Number(value.replace('heading-', '')) as 1 | 2 | 3
    editor.chain().focus().toggleHeading({ level }).run()
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1 border-b border-border',
        isPage ? 'sticky top-0 z-10 bg-background/95 backdrop-blur py-2' : 'bg-card/70 px-2 py-1.5',
      )}
    >
      <Select
        value={activeBlock()}
        onChange={setBlock}
        options={BLOCK_OPTIONS}
        size="sm"
        className="w-32"
      />
      <ToolbarButton label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton label="Strike" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton label="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton label="Ordered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton label="Blockquote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <Quote className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton label="Code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code className="size-3.5" />
      </ToolbarButton>
      <div className="mx-1 h-5 w-px bg-border" />
      <ToolbarButton label="Undo" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
        <Undo2 className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton label="Redo" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
        <Redo2 className="size-3.5" />
      </ToolbarButton>
    </div>
  )
}

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'secondary' : 'ghost'}
      className="h-7 w-7 px-0"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  )
}
