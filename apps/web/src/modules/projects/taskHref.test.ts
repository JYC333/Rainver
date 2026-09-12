import { describe, expect, it } from 'vitest'
import { inProjectHref, projectTaskHref } from './taskHref'

describe('inProjectHref', () => {
  it('rewrites a top-level task path into the Project shell', () => {
    expect(inProjectHref('proj-1', '/tasks/task-9')).toBe(projectTaskHref('proj-1', 'task-9'))
  })

  it('passes through other same-origin paths', () => {
    expect(inProjectHref('proj-1', '/projects/proj-1/inquiry?candidate=c1')).toBe(
      '/projects/proj-1/inquiry?candidate=c1',
    )
  })

  it('drops protocol-relative and scheme hrefs', () => {
    expect(inProjectHref('proj-1', '//evil.example/x')).toBeNull()
    expect(inProjectHref('proj-1', 'https://evil.example/x')).toBeNull()
    expect(inProjectHref('proj-1', 'javascript:alert(1)')).toBeNull()
  })
})
