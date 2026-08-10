/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'

/**
 * The structural answer to the divergence this whole effort existed to fix.
 *
 * A previous plan decided both note surfaces would have an identical editor,
 * action set and linking. Only the editor was made identical, and the Project's
 * own note card quietly stayed a subset — no selection actions, no link panel —
 * so everything the shared editor grew stopped at the Project's edge. The defect
 * was not that someone wrote a worse editor; it was that *there was somewhere to
 * write one*.
 *
 * A source scan rather than a behaviour test, for the same reason the note-role
 * guard is one: a behaviour test only covers the surface someone remembered to
 * write it for, and the failure here is a second surface nobody thought about.
 * Uses `import.meta.glob('?raw')` like the raw-identifier scan, so it needs no
 * Node types in a package that has none.
 */

// Root-absolute so the keys are stable paths rather than relative hops.
const sources = import.meta.glob('/src/modules/**/*.{ts,tsx}', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

const productFiles = Object.entries(sources)
  .filter(([path]) => !path.includes('__tests__'))
  .map(([path, source]) => [path.replace('/src/', ''), source] as const)

function matching(predicate: (source: string) => boolean): string[] {
  return productFiles.filter(([, source]) => predicate(source)).map(([path]) => path).sort()
}

describe('there is one note editor', () => {
  it('has exactly one component that edits a note body', () => {
    // `useAutosave` over a note is what an editor *is* here: it owns the
    // document, the debounce and the optimistic-concurrency save. A second
    // component doing that is a second editor whatever it is called.
    expect(matching(source => source.includes('useAutosave') && /notesApi\.update\(/.test(source)))
      .toEqual(['modules/knowledge/NoteEditor.tsx'])
  })

  it('mounts that editor from the one notes page, and nowhere else', () => {
    expect(matching(source => /from '\.\/NoteEditor'/.test(source)))
      .toEqual(['modules/knowledge/NotesPage.tsx'])
  })

  it('reaches that page from both surfaces', () => {
    // Global Knowledge and the Project both mount `NotesPage` with a scope.
    // If a third surface appears it must do the same rather than grow its own.
    expect(matching(source => /from '[^']*\/NotesPage'|from '\.\/NotesPage'/.test(source)))
      .toEqual([
        'modules/knowledge/KnowledgeModule.tsx',
        'modules/projects/notes/ProjectNotesPage.tsx',
      ])
  })
})
