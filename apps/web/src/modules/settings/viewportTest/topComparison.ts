import { currentBuild } from '../appVersion'
export const probeRevision = 'TOP-TEST-2'

export const topModes = ['baseline', 'solid', 'text-clip', 'clearance', 'sticky'] as const
export type TopMode = typeof topModes[number]
export type Verdict = 'clear' | 'blurred'
export interface Observation { verdict: Verdict; layout: string; theme: string; standalone: boolean }
export type Observations = Partial<Record<TopMode, Observation>>
export const observationKey = 'rainver:viewport-top-observations'

export function initialTopMode(): TopMode {
  const value = new URLSearchParams(location.search).get('top')
  return topModes.find(mode => mode === value) ?? 'baseline'
}

export function readObservations(): Observations {
  try {
    const saved = JSON.parse(sessionStorage.getItem(observationKey) ?? 'null')
    if (saved?.revision !== probeRevision || saved?.build !== currentBuild.id) return {}
    const result: Observations = {}
    for (const mode of topModes) {
      const value = saved.items?.[mode]
      if (value && ['clear', 'blurred'].includes(value.verdict) && ['fixed', 'flow-dvh', 'flow-vh'].includes(value.layout)
        && ['light', 'dark'].includes(value.theme) && typeof value.standalone === 'boolean') {
        result[mode] = { verdict: value.verdict, layout: value.layout, theme: value.theme, standalone: value.standalone }
      }
    }
    return result
  } catch { return {} }
}
