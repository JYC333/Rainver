// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { roomLiveRunAnchors } from '../roomTimeline'
import type { RoomMessage } from '../../../types/api'
const request = (id: string, roots: string[], children: string[] = []) => ({ id, role: 'user', metadata_json: { run_ids: roots, delegated_run_ids: children } }) as RoomMessage
const reply = (id: string, run_id: string) => ({ id, role: 'assistant', run_id }) as RoomMessage
const runs = { parent: { parent_run_id: null }, a: { parent_run_id: 'parent' }, b: { parent_run_id: 'parent' }, c: { parent_run_id: 'b' } }
describe('live delegation groups on the visible timeline', () => {
  it('places unfinished siblings and their parent after each new result without moving unrelated work', () => {
    const initial = [request('start', ['parent', 'other'], ['a', 'b'])]
    expect(roomLiveRunAnchors(initial, runs).get('start')).toEqual(['parent', 'other', 'a', 'b'])
    const messages = [...initial, reply('result-a', 'a'), request('interjection', ['separate'])]
    expect([...roomLiveRunAnchors(messages, runs)]).toEqual([
      ['result-a', ['parent', 'b']], ['start', ['other']], ['interjection', ['separate']],
    ])
    const completed = [...messages, reply('result-b', 'b'), reply('final', 'parent')]
    expect([...roomLiveRunAnchors(completed, runs)]).toEqual([['start', ['other']], ['interjection', ['separate']]])
    expect(completed.map(m => m.id)).toEqual(['start', 'result-a', 'interjection', 'result-b', 'final'])
  })
  it('uses explicit edges transitively for delegated work, regardless of which member replies', () => {
    const messages = [request('start', ['parent'], ['a', 'b', 'c']), reply('nested-result', 'c'), reply('parent-result', 'parent')]
    expect([...roomLiveRunAnchors(messages, runs)]).toEqual([['parent-result', ['a', 'b']]])
  })
  it('does not infer delegation from workspace scheduling or co-location on one request', () => {
    expect([...roomLiveRunAnchors([request('start', ['parent', 'a']), reply('a-result', 'a')], runs)])
      .toEqual([['start', ['parent']]])
  })
  it('leaves unknown relationships at their own anchor until Run data arrives', () => {
    const messages = [request('start', ['parent'], ['a', 'b']), reply('a-result', 'a')]
    expect([...roomLiveRunAnchors(messages, {})]).toEqual([['start', ['parent', 'b']]])
    expect([...roomLiveRunAnchors(messages, runs)]).toEqual([['a-result', ['parent', 'b']]])
  })
  it('includes children announced after an earlier result without using stale anchors', () => {
    const messages = [request('start', ['parent'], ['a']), reply('a-result', 'a'), request('next-wave', [], ['b'])]
    expect([...roomLiveRunAnchors(messages, runs)]).toEqual([['next-wave', ['parent', 'b']]])
  })
  it('keeps separate delegation groups independent', () => {
    const messages = [request('one', ['parent'], ['a']), request('two', ['second'], ['d']), reply('a-result', 'a')]
    expect([...roomLiveRunAnchors(messages, { ...runs, d: { parent_run_id: 'second' } })])
      .toEqual([['a-result', ['parent']], ['two', ['second', 'd']]])
  })
  it('only treats an assistant message as the reply of its producing Run', () => {
    const announcement = { ...reply('parent-reply', 'parent'), metadata_json: { delegated_run_ids: ['a', 'b'] } } as RoomMessage
    expect([...roomLiveRunAnchors([request('start', ['parent']), announcement], runs)])
      .toEqual([['parent-reply', ['a', 'b']]])
  })
})
