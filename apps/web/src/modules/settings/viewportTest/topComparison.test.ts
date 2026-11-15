import { afterEach, describe, expect, it } from 'vitest'
import { currentBuild } from '../appVersion'
import { initialTopMode, observationKey, probeRevision, readObservations } from './topComparison'

afterEach(() => { sessionStorage.clear(); history.replaceState(null, '', '/') })
describe('top comparison evidence', () => {
  it('accepts only a known scheme from a reload URL', () => {
    history.replaceState(null, '', '/?top=text-clip')
    expect(initialTopMode()).toBe('text-clip')
    history.replaceState(null, '', '/?top=unknown')
    expect(initialTopMode()).toBe('baseline')
  })
  it('keeps only bounded verdict context and drops stale build evidence', () => {
    const record = { revision: probeRevision, build: currentBuild.id, items: {
      baseline: { verdict: 'blurred', layout: 'flow-vh', theme: 'light', standalone: true, input: 'must not copy' },
      solid: { verdict: 'anything', layout: 'flow-vh', theme: 'light', standalone: true },
      unknown: { verdict: 'clear', layout: 'flow-vh', theme: 'light', standalone: true },
    } }
    sessionStorage.setItem(observationKey, JSON.stringify(record))
    expect(readObservations()).toEqual({ baseline: { verdict: 'blurred', layout: 'flow-vh', theme: 'light', standalone: true } })
    sessionStorage.setItem(observationKey, JSON.stringify({ ...record, build: 'old' }))
    expect(readObservations()).toEqual({})
    sessionStorage.setItem(observationKey, '{broken')
    expect(readObservations()).toEqual({})
  })
})
