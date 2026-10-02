import { useState, useEffect, useCallback, useRef, type ComponentType } from 'react'
import type { DiaryApi, DiaryEntry, DiaryReflection, DiaryWebHost } from './host'

export type { DiaryApi, DiaryEntry, DiaryReflection, DiaryWebHost } from './host'

const PLUGIN_ID = 'diary'

function formatDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

// ── Entry Editor ──────────────────────────────────────────────────────────────

function EntryEditor({
  api,
  date,
  initial,
  onSaved,
}: {
  api: DiaryApi
  date: string
  initial: string
  onSaved: (entry: DiaryEntry) => void
}) {
  const [content, setContent] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef(initial)

  const save = useCallback(async (text: string) => {
    setSaving(true)
    setError(null)
    try {
      const result = await api.saveEntry(date, text)
      onSaved(result.entry)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [api, date, onSaved])

  const handleChange = (text: string) => {
    setContent(text)
    latestRef.current = text
    setSaved(false)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => void save(text), 1500)
  }

  // Leaving the day (another date, or back to today) unmounts the editor; a
  // pending autosave is sent rather than dropped with its timer.
  useEffect(() => () => {
    if (!timerRef.current) return
    clearTimeout(timerRef.current)
    void api.saveEntry(date, latestRef.current).catch(() => {/* the editor is gone */})
  }, [api, date])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <textarea
        value={content}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={`What's on your mind today?`}
        style={{
          width: '100%', minHeight: 200, padding: '12px 14px',
          borderRadius: 8, border: '1px solid #e0e0e0', fontSize: 15,
          lineHeight: 1.6, resize: 'vertical', fontFamily: 'inherit',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
        {saving && <span style={{ color: '#888' }}>Saving…</span>}
        {saved && !saving && <span style={{ color: '#4caf50' }}>Saved</span>}
        {error && <span style={{ color: '#b71c1c' }}>{error}</span>}
        {!saving && !saved && !error && content.length > 0 && (
          <span style={{ color: '#bbb' }}>Auto-saves after typing pauses</span>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => void save(content)}
          disabled={saving}
          style={{
            padding: '6px 16px', borderRadius: 6, border: 'none',
            background: '#1976d2', color: '#fff', cursor: 'pointer',
            fontSize: 13, fontWeight: 500, opacity: saving ? 0.6 : 1,
          }}
        >
          Save now
        </button>
      </div>
    </div>
  )
}

// ── On-This-Day Panel ─────────────────────────────────────────────────────────

function OnThisDay({ api, date, currentEntryId }: { api: DiaryApi; date: string; currentEntryId?: string }) {
  const [entries, setEntries] = useState<DiaryEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.onThisDay(date)
      .then((r) => { setEntries(r.entries.filter((e) => e.id !== currentEntryId)); setLoading(false) })
      .catch(() => setLoading(false))
  }, [api, date, currentEntryId])

  if (loading || entries.length === 0) return null

  return (
    <div style={{ marginTop: 28 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: '#888', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        On this day in past years
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {entries.map((e) => (
          <div key={e.id} style={{ border: '1px solid #e8e8e8', borderRadius: 8, padding: '14px 16px', background: '#fafafa' }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 6, fontWeight: 500 }}>{formatDate(e.entry_date)}</div>
            <p style={{ margin: 0, fontSize: 14, color: '#444', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {e.content.length > 300 ? e.content.slice(0, 300) + '…' : e.content}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Reflections ───────────────────────────────────────────────────────────────

function Reflections({ api, date }: { api: DiaryApi; date: string }) {
  const [reflections, setReflections] = useState<DiaryReflection[]>([])

  useEffect(() => {
    api.reflections(date)
      .then((r) => setReflections(r.reflections))
      .catch(() => {/* ignore */})
  }, [api, date])

  if (reflections.length === 0) return null

  return (
    <div style={{ marginTop: 20 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Reflections
      </h3>
      {reflections.map((r) => (
        <div key={r.id} style={{ fontSize: 13, color: '#555', lineHeight: 1.6, whiteSpace: 'pre-wrap', padding: '10px 14px', background: '#f0f4ff', borderRadius: 6, marginBottom: 8 }}>
          {r.content}
        </div>
      ))}
    </div>
  )
}

// ── History Sidebar ───────────────────────────────────────────────────────────

function HistorySidebar({ api, selectedDate, onSelect }: { api: DiaryApi; selectedDate: string; onSelect: (date: string) => void }) {
  const [entries, setEntries] = useState<DiaryEntry[]>([])

  useEffect(() => {
    api.listEntries({ limit: 60 })
      .then((r) => setEntries(r.entries))
      .catch(() => {/* ignore */})
  }, [api])

  return (
    <div style={{ width: 180, flexShrink: 0, borderRight: '1px solid #ebebeb', paddingRight: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#999', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>History</div>
      {entries.length === 0 && <div style={{ fontSize: 13, color: '#ccc' }}>No entries yet</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {entries.map((e) => (
          <button
            key={e.id}
            onClick={() => onSelect(e.entry_date)}
            style={{
              textAlign: 'left', padding: '5px 8px', borderRadius: 5, border: 'none',
              background: e.entry_date === selectedDate ? '#e8f0fe' : 'transparent',
              color: e.entry_date === selectedDate ? '#1565c0' : '#555',
              cursor: 'pointer', fontSize: 13,
              fontWeight: e.entry_date === selectedDate ? 600 : 400,
            }}
          >
            {e.entry_date}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

function DiaryPage({ host }: { host: DiaryWebHost }) {
  const { api, Link, usePluginState } = host
  const { enabled, loading: pluginLoading } = usePluginState(PLUGIN_ID)
  const [selectedDate, setSelectedDate] = useState(todayDate())
  const [entry, setEntry] = useState<DiaryEntry | null>(null)
  const [loadingEntry, setLoadingEntry] = useState(true)

  const loadEntry = useCallback((date: string) => {
    setLoadingEntry(true)
    const p = date === todayDate()
      ? api.today().then((r) => r.entry)
      : api.onThisDay(date).then((r) => r.entries.find((e) => e.entry_date === date) ?? null)
    p.then((e) => { setEntry(e); setLoadingEntry(false) }).catch(() => setLoadingEntry(false))
  }, [api])

  useEffect(() => { loadEntry(selectedDate) }, [selectedDate, loadEntry])

  const handleSelect = (date: string) => { setSelectedDate(date); setEntry(null) }

  if (pluginLoading) return null

  if (!enabled) {
    return (
      <div style={{ maxWidth: 520, margin: '80px auto', padding: '0 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>📖</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Diary</h1>
        <p style={{ color: '#666', marginBottom: 24 }}>Write daily — see what you wrote on this day in past years.</p>
        <Link
          to="/plugins"
          style={{ display: 'inline-block', padding: '8px 20px', borderRadius: 8, background: '#1976d2', color: '#fff', textDecoration: 'none', fontSize: 14, fontWeight: 500 }}
        >
          Install or enable in Optional Modules
        </Link>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px', display: 'flex', gap: 24, alignItems: 'flex-start' }}>
      <HistorySidebar api={api} selectedDate={selectedDate} onSelect={handleSelect} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{formatDate(selectedDate)}</h1>
          {selectedDate !== todayDate() && (
            <button
              onClick={() => handleSelect(todayDate())}
              style={{ fontSize: 13, color: '#1976d2', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              → today
            </button>
          )}
        </div>

        {loadingEntry ? (
          <div style={{ color: '#bbb', fontSize: 14 }}>Loading…</div>
        ) : (
          <EntryEditor
            key={selectedDate}
            api={api}
            date={selectedDate}
            initial={entry?.content ?? ''}
            onSaved={(saved) => setEntry(saved)}
          />
        )}

        {!loadingEntry && (
          <>
            <OnThisDay api={api} date={selectedDate} currentEntryId={entry?.id} />
            {entry && <Reflections api={api} date={selectedDate} />}
          </>
        )}
      </div>
    </div>
  )
}

export function createDiaryPage(host: DiaryWebHost): ComponentType {
  return function DiaryPageWithHost() {
    return <DiaryPage host={host} />
  }
}
