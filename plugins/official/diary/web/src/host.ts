import type { CSSProperties, ElementType, ReactNode } from 'react'

export interface DiaryEntry {
  id: string
  user_id: string
  entry_date: string
  content: string
  created_at: string
  updated_at: string
}

export interface DiaryReflection {
  id: string
  entry_id: string
  reflection_date: string
  content: string
  ai_model: string | null
  created_at: string
}

export interface DiaryApi {
  /** Opaque identity for queued writes; changes when authentication or Space changes. */
  saveContextKey?(): string
  today(): Promise<{ date: string; entry: DiaryEntry | null }>
  listEntries(params?: { limit?: number; before?: string }): Promise<{ entries: DiaryEntry[] }>
  saveEntry(date: string, content: string): Promise<{ entry: DiaryEntry }>
  deleteEntry(date: string): Promise<{ deleted: boolean }>
  onThisDay(date: string): Promise<{ date: string; entries: DiaryEntry[] }>
  reflections(date: string): Promise<{ entry_date: string; reflections: DiaryReflection[] }>
}

export interface DiaryPluginState {
  loading: boolean
  enabled: boolean
}

export interface DiaryHostLinkProps {
  to: string
  style?: CSSProperties
  children?: ReactNode
}

export interface DiaryWebHost {
  api: DiaryApi
  Link: ElementType<DiaryHostLinkProps>
  usePluginState(pluginId: string): DiaryPluginState
  /** The UI locale the person reads (e.g. `en`, `zh-CN`), from the host's i18n. */
  useLocale(): string
}
