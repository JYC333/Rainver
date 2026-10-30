// @vitest-environment node
import { expect, it } from 'vitest'
import { readingReturnTo,readingHrefReturning } from '../readingLinks'

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

it.each([
  '/library/reading?view=read', '/library/reading?topic=topic-a', '/library/reading?view=all&topic=topic-a&topic_selection=all',
  '/projects/project-a/sources?topic=topic-a', '/library/reading/goals/topic-a', '/library/reading/goals/topic-a?selection=all',
  '/projects/project-a/sources/goals/topic-a',
])('returns to an exact Reading or topic view %s', value => {
  expect(readingReturnTo(value)).toBe(value)
})
it.each([
  '/library/reading?topic_selection=all', '/library/reading?view=read&view=all', '/library/reading?topic=a&redirect=/home',
  '/library/reading?view=unknown', '/library/reading?', '/library/reading/goals/topic-a?selection=all&x=1',
  '/library/reading/goals/../../home', '/library/reading/goals/topic-a/extra', '/projects/project-b/sources/goals/topic-a',
])('rejects an unbounded Reading or topic return %s', value => {
  expect(readingReturnTo(value, value.includes('project-b') ? 'project-a' : undefined)).toBeNull()
})

it('preserves the exact change identity and topic return through Reader',()=>{
 const link=readingHrefReturning({source_item_id:'same-item',reader_origin:'library',topic_change:{id:'change-v2',goal_id:'goal-a',kind:'update',evidence_url:'https://evidence.test/v2'}},'/library/reading?topic=goal-a');
 const query=new URL(link,'https://local.test').searchParams;expect(query.get('change')).toBe('change-v2');expect(query.get('returnTo')).toBe('/library/reading?topic=goal-a');
});

it.each([
  ['/library/reading?q=machine+learning', undefined],
  [`/library/reading?${new URLSearchParams({ view: 'read', q: '机器学习 · “引号” & C++' })}`, undefined],
  [`/library/reading?${new URLSearchParams({ topic: 'topic-a', topic_selection: 'all', q: 'emoji 🙂 50%' })}`, undefined],
  [`/projects/project-a/sources?${new URLSearchParams({ q: 'diffusion/transformer' })}`, 'project-a'],
  [`/library/reading?${new URLSearchParams({ q: 'x'.repeat(500) })}`, undefined],
])('returns to the submitted Reading search %s', (value, projectId) => {
  expect(readingReturnTo(value, projectId)).toBe(value)
})
it.each([
  '/library/reading?q=',
  '/library/reading?q=+leading',
  '/library/reading?q=trailing+',
  `/library/reading?${new URLSearchParams({ q: 'x'.repeat(501) })}`,
  '/library/reading?q=line%0Abreak',
  '/library/reading?q=tab%09',
  '/library/reading?q=%6Dachine',
  '/library/reading?q=a%20b',
  '/library/reading?q=a&q=b',
  '/library/reading?q=a&redirect=%2Fhome',
  '/library/reading?q=a#frag',
  '/library/%72eading?q=a',
  '/library/reading/goals/topic-a?q=a',
  '/projects/project-a/sources?tab=candidates&q=a',
])('rejects a non-canonical or unbounded search return %s', value => {
  expect(readingReturnTo(value)).toBeNull()
  expect(readingReturnTo(value, 'project-a')).toBeNull()
})
