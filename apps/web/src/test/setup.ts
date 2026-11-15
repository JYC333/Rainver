// Node files must not evaluate Testing Library, React or jest-dom.
// Vitest awaits this import before collecting DOM tests.
if (typeof document !== 'undefined') {
  await import('./setupDom')
}

export {}
