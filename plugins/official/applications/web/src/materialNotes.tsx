import { useCallback, useEffect, useState } from 'react';
import { blank, Field, k, Notice, touch, useOperations, type Ctx } from './viewKit';

/**
 * A material's text in Notes: its linked Note (opened in the shared Notes editor),
 * the reviewed versions, the pinned source Notes with stale-version prompts, and
 * private drafts generated from them — started here, previewed with their sources
 * and checks, and saved to Notes only when the person says so.
 */
interface NoteRef { note_id: string; title: string | null; current_version: number | null; available: boolean }
export interface MaterialRow {
  id: string; kind: string; label: string | null; required: boolean; status: string; position: number;
  reference: { type: string; id: string; title: string | null; available: boolean } | null;
  note: NoteRef | null;
  reviews: { id: string; note_id: string; note_version: number; reviewed_at: string }[];
  sources: (NoteRef & { id: string; note_version: number; updated: boolean })[];
  generations: { id: string; requirements: string; created_at: string; applied: { note_id: string; note_version: number; applied_at: string } | null }[];
}
interface Generation {
  generation_id: string; requirements: string; created_at: string; status: string; error_code: string | null; draft: string | null; verify: string[];
  sources: (NoteRef & { note_version: number; used: boolean; updated: boolean })[];
  base: (NoteRef & { note_version: number; changed: boolean }) | null;
  applied: { note_id: string; note_version: number; applied_at: string } | null;
  save_new: boolean;
}
const RUNNING = new Set(['queued', 'running']);
const day = (stamp: string) => stamp.slice(0, 10);

export function MaterialNotes({ ctx, material, archived, onChanged }: { ctx: Ctx; material: MaterialRow; archived: boolean; onChanged: () => Promise<void> }) {
  const { ui } = ctx, { Button, Input, Textarea, Select, Badge, t, formatDay, NoteLink } = ui;
  const { query, command, reason } = useOperations(ctx);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [noteId, setNoteId] = useState(''), [sourceId, setSourceId] = useState('');
  const [library, setLibrary] = useState<{ note_id: string; name: string }[]>([]), [libraryPick, setLibraryPick] = useState('');
  const [request, setRequest] = useState({ requirements: '', length: '', emphasis: '', include_linked: true });
  const [selected, setSelected] = useState<string | null>(material.generations[0]?.id ?? null);
  const [preview, setPreview] = useState<Generation | null>(null), [previewState, setPreviewState] = useState<'idle' | 'loading' | 'error'>('idle');
  const note = material.note;
  const reviewedCurrent = !!note?.current_version && material.reviews.some(r => r.note_id === note.note_id && r.note_version === note.current_version);

  const write = async (name: string, input: Record<string, unknown>, done: string) => {
    setBusy(true); setNotice(''); setError('');
    try {
      const result = await command<Record<string, unknown>>(name, input);
      setNotice(t(k(done)));
      await onChanged();
      return 'status' in result && result.status === 'succeeded' ? result.data : null;
    } catch (e) { setError(reason(e)); await onChanged(); return null; } finally { setBusy(false); }
  };
  const loadPreview = useCallback(async (id: string) => {
    setPreviewState(s => s === 'idle' ? s : 'loading');
    try { setPreview(await query<Generation>('material.get_generation', { generation_id: id })); setPreviewState('idle'); }
    catch { setPreview(null); setPreviewState('error'); }
  }, [query]);
  useEffect(() => { if (selected) { setPreviewState('loading'); void loadPreview(selected); } else setPreview(null); }, [selected, loadPreview]);
  // Library Notes that are not yet a source here, offered instead of pasting a Note id.
  useEffect(() => {
    if (archived) return;
    void query<{ items: { label: string | null; note: NoteRef }[] }>('library.list', {}).then(r => setLibrary(r.items.filter(i => i.note.available).map(i => ({ note_id: i.note.note_id, name: i.label || i.note.title || t(k('untitled')) }))), () => setLibrary([]));
  }, [query, archived, t]);
  const offered = library.filter(l => !material.sources.some(s => s.note_id === l.note_id));
  // A draft being written is polled until its Run settles; nothing else refreshes on a timer.
  useEffect(() => {
    if (!selected || !preview || preview.generation_id !== selected || !RUNNING.has(preview.status)) return;
    const timer = setTimeout(() => void loadPreview(selected), 2000);
    return () => clearTimeout(timer);
  }, [selected, preview, loadPreview]);

  const generate = async () => {
    const length = Number.parseInt(request.length, 10);
    const out = await write('material.generate', {
      material_id: material.id, requirements: request.requirements.trim(), ...(Number.isFinite(length) ? { length_words: length } : {}),
      emphasis: blank(request.emphasis), ...(note ? { include_linked: request.include_linked } : {}),
    }, 'draft_started');
    // The request stays filled in, so a second draft needs only the change.
    if (out && typeof out.generation_id === 'string') setSelected(out.generation_id);
  };
  const save = async (target: 'linked' | 'new') => {
    if (!preview) return;
    if (await write('material.apply_generation', { generation_id: preview.generation_id, target }, 'draft_saved')) await loadPreview(preview.generation_id);
  };
  const noteName = (ref: NoteRef) => ref.available ? ref.title || t(k('untitled')) : t(k('note_unavailable'));

  return <div className="space-y-4 border-t border-border pt-3">
    <Notice text={notice} /><Notice text={error} tone="alert" />
    <section className="space-y-2" aria-label={t(k('material_text'))}>
      <h5 className="text-sm font-semibold">{t(k('material_text'))}</h5>
      {note ? <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words">{noteName(note)}</span>
          {note.available && note.current_version !== null && <span className="text-xs text-muted-foreground">{t(k('version'), { version: note.current_version })}</span>}
          {note.available && <Badge variant={reviewedCurrent ? 'success' : 'warning'}>{reviewedCurrent ? t(k('reviewed')) : t(k('not_reviewed'))}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {note.available && <NoteLink noteId={note.note_id}>{t(k('open_in_notes'))}</NoteLink>}
          {note.available && note.current_version !== null && !reviewedCurrent && <Button className={touch} size="sm" variant="outline" disabled={busy || archived} onClick={() => void write('material.mark_reviewed', { material_id: material.id, note_id: note.note_id, note_version: note.current_version }, 'review_recorded')}>{t(k('mark_reviewed'), { version: note.current_version })}</Button>}
          <Button className={touch} size="sm" variant="ghost" disabled={busy || archived} onClick={() => void write('material.link_note', { material_id: material.id, note_id: null }, 'saved')}>{t(k('unlink_note'))}</Button>
        </div>
      </div> : <p className="text-sm text-muted-foreground">{t(k('no_note'))}</p>}
      {material.reviews.length > 0 && <p className="text-xs text-muted-foreground">{t(k('reviewed_versions'))}: {material.reviews.map(r => t(k('reviewed_version'), { version: r.note_version, date: formatDay(day(r.reviewed_at)) })).join(' · ')}</p>}
      {!archived && <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
        <Field label={note ? t(k('relink_note')) : t(k('link_note_id'))}><Input className={touch} value={noteId} onChange={e => setNoteId(e.target.value)} /></Field>
        <Button className={touch} size="sm" variant="outline" disabled={busy || !noteId.trim()} onClick={async () => { if (await write('material.link_note', { material_id: material.id, note_id: noteId.trim() }, 'saved')) setNoteId(''); }}>{t(k('link_note'))}</Button>
      </div>}
    </section>

    <section className="space-y-2" aria-label={t(k('sources'))}>
      <h5 className="text-sm font-semibold">{t(k('sources'))}</h5>
      <p className="text-xs text-muted-foreground">{t(k('sources_hint'))}</p>
      {material.sources.length ? <ul className="space-y-2">{material.sources.map(s => <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2">
        <span className="min-w-0 break-words">{noteName(s)} <span className="text-xs text-muted-foreground">{t(k('version'), { version: s.note_version })}</span>
          {s.updated && <Badge className="ml-2" variant="warning">{t(k('newer_version'), { version: s.current_version })}</Badge>}</span>
        <span className="flex flex-wrap items-center gap-2">
          {s.updated && s.current_version !== null && <Button className={touch} size="sm" variant="outline" disabled={busy || archived} onClick={() => void write('material.add_source', { material_id: material.id, note_id: s.note_id, note_version: s.current_version }, 'saved')}>{t(k('use_version'), { version: s.current_version })}</Button>}
          <Button className={touch} size="sm" variant="ghost" disabled={busy || archived} aria-label={t(k('remove_source'), { name: noteName(s) })} onClick={() => void write('material.remove_source', { source_id: s.id }, 'saved')}>{t(k('remove'))}</Button>
        </span>
      </li>)}</ul> : <p className="text-sm text-muted-foreground">{t(k('no_sources'))}</p>}
      {!archived && offered.length > 0 && <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
        <Field label={t(k('library_pick'))}><Select ariaLabel={t(k('library_pick'))} value={libraryPick || offered[0]!.note_id} onChange={setLibraryPick} options={offered.map(l => ({ value: l.note_id, label: l.name }))} /></Field>
        <Button className={touch} size="sm" variant="outline" disabled={busy} onClick={async () => { if (await write('material.add_source', { material_id: material.id, note_id: libraryPick || offered[0]!.note_id }, 'saved')) setLibraryPick(''); }}>{t(k('add_source'))}</Button>
      </div>}
      {!archived && <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
        <Field label={t(k('source_note_id'))}><Input className={touch} value={sourceId} onChange={e => setSourceId(e.target.value)} /></Field>
        <Button className={touch} size="sm" variant="outline" disabled={busy || !sourceId.trim()} onClick={async () => { if (await write('material.add_source', { material_id: material.id, note_id: sourceId.trim() }, 'saved')) setSourceId(''); }}>{t(k('add_source'))}</Button>
      </div>}
    </section>

    <section className="space-y-3" aria-label={t(k('drafts'))}>
      <h5 className="text-sm font-semibold">{t(k('drafts'))}</h5>
      {!archived && <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{t(k('drafts_hint'))}</p>
        <Field label={t(k('requirements'))} hint={t(k('requirements_hint'))}><Textarea value={request.requirements} onChange={e => setRequest(r => ({ ...r, requirements: e.target.value }))} /></Field>
        <div className="grid gap-3 md:grid-cols-[10rem_1fr]">
          <Field label={t(k('length_words'))}><Input className={touch} type="number" inputMode="numeric" min={50} max={3000} value={request.length} onChange={e => setRequest(r => ({ ...r, length: e.target.value }))} /></Field>
          <Field label={t(k('emphasis'))}><Input className={touch} value={request.emphasis} onChange={e => setRequest(r => ({ ...r, emphasis: e.target.value }))} /></Field>
        </div>
        {note && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={request.include_linked} onChange={e => setRequest(r => ({ ...r, include_linked: e.target.checked }))} />{t(k('include_linked'))}</label>}
        <Button className={touch} size="sm" disabled={busy || !request.requirements.trim() || (!material.sources.length && !(note && request.include_linked))} onClick={() => void generate()}>{t(k('generate'))}</Button>
      </div>}
      {material.generations.length > 0 && <ul className="space-y-2">{material.generations.map(g => <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2">
        <span className="min-w-0 break-words"><span className="text-xs text-muted-foreground">{formatDay(day(g.created_at))}</span> · {g.requirements.split('\n')[0]!.slice(0, 120)}
          {g.applied && <Badge className="ml-2" variant="success">{t(k('saved_as'), { version: g.applied.note_version })}</Badge>}</span>
        <Button className={touch} size="sm" variant="ghost" aria-expanded={selected === g.id} onClick={() => setSelected(s => s === g.id ? null : g.id)}>{selected === g.id ? t(k('hide_preview')) : t(k('preview'))}</Button>
      </li>)}</ul>}
      {selected && <DraftPreview ctx={ctx} preview={preview?.generation_id === selected ? preview : null} state={previewState} busy={busy} archived={archived} onRetry={() => void loadPreview(selected)} onSave={target => void save(target)} />}
    </section>
  </div>;
}

function DraftPreview({ ctx, preview, state, busy, archived, onRetry, onSave }: { ctx: Ctx; preview: Generation | null; state: 'idle' | 'loading' | 'error'; busy: boolean; archived: boolean; onRetry: () => void; onSave: (target: 'linked' | 'new') => void }) {
  const { Button, Badge, t, NoteLink } = ctx.ui;
  if (state === 'error') return <div className="space-y-2"><Notice text={t(k('preview_failed'))} tone="alert" /><Button className={touch} size="sm" variant="outline" onClick={onRetry}>{t(k('retry'))}</Button></div>;
  if (!preview) return <p role="status" className="text-sm text-muted-foreground">{t(k('loading'))}</p>;
  if (RUNNING.has(preview.status)) return <p role="status" className="text-sm text-muted-foreground">{t(k('draft_running'))}</p>;
  if (!preview.draft) return <Notice text={t(k(`errors.${preview.error_code ?? 'draft_failed'}`), { defaultValue: t(k('errors.draft_failed')) })} tone="alert" />;
  const base = preview.base;
  return <div className="space-y-3 rounded-md border border-border p-3" aria-label={t(k('draft_preview'))}>
    <DraftText text={preview.draft} />
    {preview.verify.length > 0 && <div className="space-y-1">
      <p className="text-sm font-medium">{t(k('verify_title'))}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm">{preview.verify.map((item, i) => <li key={i} className="break-words">{item}</li>)}</ul>
    </div>}
    <div className="space-y-1">
      <p className="text-sm font-medium">{t(k('draft_sources'))}</p>
      <ul className="space-y-1 text-sm">{preview.sources.map(s => <li key={`${s.note_id}@${s.note_version}`} className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words">{s.available ? s.title || t(k('untitled')) : t(k('note_unavailable'))}</span>
        <span className="text-xs text-muted-foreground">{t(k('version'), { version: s.note_version })}</span>
        <Badge variant={s.used ? 'secondary' : 'muted'}>{s.used ? t(k('source_used')) : t(k('source_not_used'))}</Badge>
        {s.updated && <Badge variant="warning">{t(k('newer_version'), { version: s.current_version })}</Badge>}
      </li>)}</ul>
    </div>
    {preview.applied ? <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm">{t(k('draft_saved_version'), { version: preview.applied.note_version })}</p>
      <NoteLink noteId={preview.applied.note_id}>{t(k('open_in_notes'))}</NoteLink>
    </div> : !archived && <div className="space-y-2">
      {base?.changed && <p className="text-sm text-warning">{t(k('base_changed'))}</p>}
      <div className="flex flex-wrap gap-2">
        {base && !base.changed && <Button className={touch} size="sm" disabled={busy} onClick={() => onSave('linked')}>{t(k('save_to_linked'), { version: (base.note_version ?? 0) + 1 })}</Button>}
        {preview.save_new && <Button className={touch} size="sm" variant={base && !base.changed ? 'outline' : 'default'} disabled={busy} onClick={() => onSave('new')}>{t(k('save_as_new'))}</Button>}
      </div>
      <p className="text-xs text-muted-foreground">{t(k(preview.save_new ? 'save_hint' : 'save_new_unavailable'))}</p>
    </div>}
  </div>;
}

/**
 * The draft as it will read in Notes: headings, lists and paragraphs (the subset the
 * host's Markdown-to-Note conversion keeps), as plain React text — never HTML.
 */
function DraftText({ text }: { text: string }) {
  const blocks: { kind: 'heading' | 'paragraph' | 'bullets' | 'numbers'; lines: string[] }[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    const last = blocks[blocks.length - 1];
    if (!line) { blocks.push({ kind: 'paragraph', lines: [] }); continue; }
    const heading = /^#{1,3}\s+(.+)$/.exec(line), bullet = /^[-*+]\s+(.+)$/.exec(line), number = /^\d+[.)]\s+(.+)$/.exec(line);
    if (heading) blocks.push({ kind: 'heading', lines: [heading[1]!] });
    else if (bullet || number) {
      const kind = bullet ? 'bullets' : 'numbers', item = (bullet ?? number)![1]!;
      if (last?.kind === kind) last.lines.push(item); else blocks.push({ kind, lines: [item] });
    } else if (last?.kind === 'paragraph') last.lines.push(line);
    else blocks.push({ kind: 'paragraph', lines: [line] });
  }
  return <div className="max-h-96 space-y-2 overflow-y-auto break-words rounded-md bg-background p-3 text-sm">{blocks.filter(b => b.lines.length).map((b, i) =>
    b.kind === 'heading' ? <p key={i} className="font-semibold">{b.lines[0]}</p>
      : b.kind === 'bullets' ? <ul key={i} className="list-disc space-y-1 pl-5">{b.lines.map((l, j) => <li key={j}>{l}</li>)}</ul>
        : b.kind === 'numbers' ? <ol key={i} className="list-decimal space-y-1 pl-5">{b.lines.map((l, j) => <li key={j}>{l}</li>)}</ol>
          : <p key={i}>{b.lines.join(' ')}</p>)}</div>;
}
