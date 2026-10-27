// @vitest-environment node
import { expect, it } from 'vitest'
import { readingReturnTo } from '../readingLinks'

it.each([
  '/library/reading', '/projects/project-a/sources',
  '/projects/project-a/sources?tab=candidates', '/projects/project-a/sources?tab=settings',
  '/projects/project-a/research?tab=reading', '/library/digests',
  '/projects/project-a/sources?tab=digest',
])('retains the bounded legacy return %s', value => {
  expect(readingReturnTo(value)).toBe(value)
})

it.each(['2024-02-29', '2026-01-02'])('accepts the exact retained edition date %s in each scope', date => {
  const personal = `/library/digests?date=${date}`
  const project = `/projects/project-a/sources?tab=digest&date=${date}`
  expect(readingReturnTo(personal)).toBe(personal)
  expect(readingReturnTo(project, 'project-a')).toBe(project)
  expect(readingReturnTo(project, 'project-b')).toBeNull()
  expect(readingReturnTo(project)).toBeNull()
  expect(readingReturnTo(personal, 'project-a')).toBeNull()
})

it.each([
  '2026-02-29', '2026-02-31', '2026-04-31', '2026-13-01', '0000-01-01',
  '2026-1-02', '2026-01-2', 'today', '2026-01-02T00:00:00Z', '',
])('rejects a malformed or impossible edition date %s', date => {
  expect(readingReturnTo(`/library/digests?date=${date}`)).toBeNull()
  expect(readingReturnTo(`/projects/project-a/sources?tab=digest&date=${date}`, 'project-a')).toBeNull()
})

it.each([
  '/library/digests?date=2026-01-02&redirect=/home',
  '/library/digests?date=2026-01-02&date=2026-01-03',
  '/projects/project-a/sources?tab=digest&date=2026-01-02&extra=1',
  '/projects/project-a/sources?date=2026-01-02&tab=digest',
  '/projects/project-a/sources?tab=digest#history',
  'https://other.test/library/digests?date=2026-01-02',
  '//other.test/library/digests?date=2026-01-02',
  '/spaces/another-space/library/digests?date=2026-01-02',
  '/projects/project-b/sources?tab=digest&date=2026-01-02',
  '/projects/project-a/../project-b/sources?tab=digest&date=2026-01-02',
  '/projects/%70roject-a/sources?tab=digest&date=2026-01-02',
  '/projects/project-a%2fsources?tab=digest&date=2026-01-02',
  '/projects/project-a\\sources?tab=digest&date=2026-01-02',
  '/projects/project-a/sources?tab=digest&date=2026%2D01%2D02',
  '/projects/project-a/sources?tab=digest&date=2026-01-02%26extra%3D1',
  '/projects/project-a/sources?tab=digest&date=2026-01-02\n',
])('rejects unbounded/encoded edition navigation %s', value => {
  expect(readingReturnTo(value)).toBeNull()
  expect(readingReturnTo(value, 'project-a')).toBeNull()
})
