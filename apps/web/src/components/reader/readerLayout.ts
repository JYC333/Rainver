/**
 * Which Reader panels were open, for this browser (not a person or a
 * document: kept across logout, see sessionResidue's keep-list).
 */
const KEY = 'rainver:reader-layout'

export interface ReaderLayout { outline: boolean; inspector: boolean; outlineWidth: number; inspectorWidth: number }
const DEFAULT: ReaderLayout = { outline: false, inspector: true, outlineWidth: 248, inspectorWidth: 320 }

export function readReaderLayout(): ReaderLayout {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<ReaderLayout> | null
    return { outline: value?.outline === true, inspector: value?.inspector !== false,
      outlineWidth: panelWidth(value?.outlineWidth, 248, 200, 360),
      inspectorWidth: panelWidth(value?.inspectorWidth, 320, 280, 480) }
  } catch {
    return DEFAULT
  }
}

export function writeReaderLayout(change: Partial<ReaderLayout>): void {
  try { window.localStorage.setItem(KEY, JSON.stringify({ ...readReaderLayout(), ...change })) } catch { /* private mode */ }
}

function panelWidth(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback
}
