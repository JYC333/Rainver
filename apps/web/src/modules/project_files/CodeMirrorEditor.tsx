import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { MergeView } from '@codemirror/merge'
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { searchKeymap } from '@codemirror/search'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view'
import { loadLanguage, type CodeMirrorLanguage } from './codeMirrorLanguages'

export interface CodeMirrorSelection {
  from: number
  to: number
  anchor: number
  head: number
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface CodeMirrorEditorProps {
  value: string
  language?: CodeMirrorLanguage
  readOnly?: boolean
  lineSeparator?: '\n' | '\r\n'
  indent?: string
  ariaLabel?: string
  onChange?: (value: string) => void
  onSelectionChange?: (selection: CodeMirrorSelection) => void
  onFocus?: () => void
  onBlur?: () => void
  onSave?: () => void
  className?: string
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', lineHeight: '1.5rem' },
  '.cm-content': { padding: '1rem 0' },
  '.cm-line': { padding: '0 1rem' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'color-mix(in oklch, var(--muted-foreground) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in oklch, var(--accent) 45%, transparent)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--accent) 25%, transparent)' },
  '.cm-selectionBackground': { backgroundColor: 'color-mix(in oklch, var(--primary) 25%, transparent) !important' },
}, { dark: false })

const editorDarkTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'color-mix(in oklch, var(--muted-foreground) 55%, transparent)' },
})

const highlight = syntaxHighlighting(defaultHighlightStyle, { fallback: true })

function selectionFor(view: EditorView): CodeMirrorSelection {
  const range = view.state.selection.main
  const start = view.state.doc.lineAt(range.from)
  const end = view.state.doc.lineAt(range.to)
  return {
    from: range.from,
    to: range.to,
    anchor: range.anchor,
    head: range.head,
    startLine: start.number,
    startColumn: range.from - start.from + 1,
    endLine: end.number,
    endColumn: range.to - end.from + 1,
  }
}

export function CodeMirrorEditor({
  value,
  language = 'plain',
  readOnly = false,
  lineSeparator = '\n',
  indent = '  ',
  ariaLabel = 'File content',
  onChange,
  onSelectionChange,
  onFocus,
  onBlur,
  onSave,
  className,
}: CodeMirrorEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useRef(new Compartment())
  const lineCompartment = useRef(new Compartment())
  const indentCompartment = useRef(new Compartment())
  const callbacks = useRef({ onChange, onSelectionChange, onFocus, onBlur, onSave })
  callbacks.current = { onChange, onSelectionChange, onFocus, onBlur, onSave }

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlight,
        editorTheme,
        editorDarkTheme,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false' }),
        languageCompartment.current.of([]),
        lineCompartment.current.of(EditorState.lineSeparator.of(lineSeparator)),
        indentCompartment.current.of(indentUnit.of(indent)),
        keymap.of([
          { key: 'Mod-s', run: () => { callbacks.current.onSave?.(); return true } },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString())
          if (update.selectionSet) callbacks.current.onSelectionChange?.(selectionFor(update.view))
          if (update.focusChanged) {
            if (update.view.hasFocus) callbacks.current.onFocus?.()
            else callbacks.current.onBlur?.()
          }
        }),
      ],
    })
    const view = new EditorView({ state, parent: host.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // The document is intentionally read only during construction. Changes
    // are synchronized below without recreating the view on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, ariaLabel])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: lineCompartment.current.reconfigure(EditorState.lineSeparator.of(lineSeparator)) })
  }, [lineSeparator])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: indentCompartment.current.reconfigure(indentUnit.of(indent)) })
  }, [indent])

  useEffect(() => {
    let cancelled = false
    const view = viewRef.current
    if (!view) return
    void loadLanguage(language).then(extension => {
      if (!cancelled && viewRef.current === view) {
        view.dispatch({ effects: languageCompartment.current.reconfigure(extension) })
      }
    })
    return () => { cancelled = true }
  }, [language])

  return <div ref={host} className={['h-full min-h-0 w-full', className].filter(Boolean).join(' ')} />
}

export interface CodeMirrorMergeProps {
  original: string
  current: string
  language?: CodeMirrorLanguage
  ariaLabel?: string
  className?: string
}

/** Read-only comparison surface for explicit draft conflicts. */
export function CodeMirrorMerge({ original, current, language = 'plain', ariaLabel = 'File conflict comparison', className }: CodeMirrorMergeProps) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) return
    let cancelled = false
    const languageA = new Compartment()
    const languageB = new Compartment()
    const baseExtensions = (languageCompartment: Compartment): Extension[] => [
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      highlight,
      editorTheme,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
      languageCompartment.of([]),
    ]
    const merge = new MergeView({
      orientation: 'a-b',
      parent: host.current,
      a: { doc: original, extensions: baseExtensions(languageA) },
      b: { doc: current, extensions: baseExtensions(languageB) },
    })
    void loadLanguage(language).then(extension => {
      if (cancelled) return
      // Through a compartment, not a root reconfigure: replacing the whole
      // configuration when the lazy chunk lands would drop the read-only,
      // non-editable comparison surface these extensions establish.
      merge.a.dispatch({ effects: languageA.reconfigure(extension) })
      merge.b.dispatch({ effects: languageB.reconfigure(extension) })
    })
    return () => {
      cancelled = true
      merge.destroy()
    }
  }, [original, current, language, ariaLabel])
  return <div ref={host} className={['h-full min-h-0 overflow-auto', className].filter(Boolean).join(' ')} />
}
