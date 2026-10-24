import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { MergeView } from '@codemirror/merge'
import {
  bracketMatching,
  HighlightStyle,
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
import { tags } from '@lezer/highlight'
import { loadLanguage, type CodeMirrorLanguage } from './codeMirrorLanguages'

interface CodeMirrorSelection {
  from: number
  to: number
  anchor: number
  head: number
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

interface CodeMirrorEditorProps {
  colorMode?: 'light' | 'dark'
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
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: '13px', lineHeight: '1.5rem' },
  '.cm-content': { padding: '1rem 0' },
  '.cm-line': { padding: '0 1rem' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--muted-foreground)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in oklch, var(--accent) 45%, transparent)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--accent) 25%, transparent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--card)', color: 'var(--foreground)', borderColor: 'var(--border)' },
  '.cm-search input, .cm-search button, .cm-button': { background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklch, var(--warning) 25%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklch, var(--primary) 35%, transparent)' },
  '.cm-selectionBackground': { backgroundColor: 'color-mix(in oklch, var(--primary) 25%, transparent) !important' },
})

const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--accent-foreground)' },
  { tag: [tags.string, tags.regexp], color: 'var(--success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warning)' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.className], color: 'var(--syntax-symbol)' },
  { tag: tags.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--foreground)' },
  { tag: tags.invalid, color: 'var(--destructive)' },
  { tag: tags.heading, color: 'var(--accent-foreground)', fontWeight: '600' },
  { tag: tags.link, color: 'var(--syntax-symbol)', textDecoration: 'underline' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
]))

const modeTheme = (mode: 'light' | 'dark') => EditorView.theme({}, { dark: mode === 'dark' })

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
  colorMode = 'dark',
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
  const themeCompartment = useRef(new Compartment())
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
        themeCompartment.current.of(modeTheme(colorMode)),
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
    // The language arrives asynchronously, so a view rebuilt for a read-only
    // switch starts without it; the language effect below only runs when the
    // language itself changes.
    applyLanguage(view, language)
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // The document and language are intentionally read only during
    // construction. Changes are synchronized below without recreating the
    // view on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, ariaLabel])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.current.reconfigure(modeTheme(colorMode)) })
  }, [colorMode])

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
    const view = viewRef.current
    if (view) applyLanguage(view, language)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language])

  function applyLanguage(view: EditorView, next: CodeMirrorLanguage) {
    void loadLanguage(next).then(extension => {
      // Only the view that asked, and only while it is still the one shown.
      if (viewRef.current === view) view.dispatch({ effects: languageCompartment.current.reconfigure(extension) })
    })
  }

  return <div ref={host} className={['h-full min-h-0 w-full', className].filter(Boolean).join(' ')} />
}

interface CodeMirrorMergeProps {
  colorMode?: 'light' | 'dark'
  original: string
  current: string
  language?: CodeMirrorLanguage
  ariaLabel?: string
  className?: string
}

/** Read-only comparison surface for explicit draft conflicts. */
export function CodeMirrorMerge({ colorMode = 'dark', original, current, language = 'plain', ariaLabel = 'File conflict comparison', className }: CodeMirrorMergeProps) {
  const host = useRef<HTMLDivElement>(null)
  const mergeRef = useRef<MergeView | null>(null)
  const themeA = useRef(new Compartment())
  const themeB = useRef(new Compartment())
  useEffect(() => {
    if (!host.current) return
    let cancelled = false
    const languageA = new Compartment()
    const languageB = new Compartment()
    const baseExtensions = (languageCompartment: Compartment, themeCompartment: Compartment): Extension[] => [
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      highlight,
      editorTheme,
      themeCompartment.of(modeTheme(colorMode)),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
      languageCompartment.of([]),
    ]
    const merge = new MergeView({
      orientation: 'a-b',
      parent: host.current,
      a: { doc: original, extensions: baseExtensions(languageA, themeA.current) },
      b: { doc: current, extensions: baseExtensions(languageB, themeB.current) },
    })
    mergeRef.current = merge
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
      mergeRef.current = null
    }
  }, [original, current, language, ariaLabel])
  useEffect(() => {
    mergeRef.current?.a.dispatch({ effects: themeA.current.reconfigure(modeTheme(colorMode)) })
    mergeRef.current?.b.dispatch({ effects: themeB.current.reconfigure(modeTheme(colorMode)) })
  }, [colorMode])
  return <div ref={host} className={['h-full min-h-0 overflow-auto', className].filter(Boolean).join(' ')} />
}
