import { useCallback, useEffect, useState } from 'react';
import { blank, Field, k, Notice, touch, useOperations, type Ctx } from './viewKit';
import { recordName, tabOf, type LibraryItem, type Open } from './records';
import { LIBRARY_KINDS } from '../../domain';

/**
 * The person's reusable materials: existing Notes (master CV, experience notes) registered
 * by id. Text, history and access stay with Notes; this view shows each Note's current
 * version and every application material that draws on it, with the pinned or reviewed
 * version, so a newer master CV shows which tailored materials still use an older one.
 * Tailored materials stay in their application.
 */
export function LibraryTab({ ctx, onOpen }: { ctx: Ctx; onOpen: Open }) {
  const canEdit = ctx.projectCanWrite !== false;
  const { ui } = ctx, { Button, Input, Select, Badge, Card, CardContent, t, NoteLink } = ui;
  const { query, command, reason } = useOperations(ctx);
  const [items, setItems] = useState<LibraryItem[] | null>(null), [failed, setFailed] = useState(false);
  const [form, setForm] = useState({ note_id: '', kind: 'cv', label: '' });
  const [editing, setEditing] = useState<{ id: string; kind: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setItems((await query<{ items: LibraryItem[] }>('library.list', {})).items); setFailed(false); } catch { setFailed(true); }
  }, [query]);
  useEffect(() => { void load(); }, [load, ctx.projectRevision]);
  const run = async (name: string, input: Record<string, unknown>) => {
    setBusy(true); setNotice(''); setError('');
    try { await command(name, input); setNotice(t(k('saved'))); await load(); return true; } catch (e) { setError(reason(e)); await load(); return false; } finally { setBusy(false); }
  };
  const kinds = LIBRARY_KINDS.map(v => ({ value: v, label: t(k(`library_kind.${v}`)) }));
  return <div className="space-y-4">
    <p className="max-w-2xl text-sm text-muted-foreground">{t(k('library_hint'))}</p>
    <Notice text={notice} /><Notice text={error} tone="alert" />
    {failed ? <div className="space-y-2"><Notice text={t(k('load_failed'))} tone="alert" /><Button className={touch} variant="outline" size="sm" onClick={() => void load()}>{t(k('retry'))}</Button></div>
      : items === null ? <p role="status" className="text-sm text-muted-foreground">{t(k('loading'))}</p>
      : items.length === 0 ? <p className="text-sm text-muted-foreground">{t(k('library_empty'))}</p>
      : <ul className="space-y-3">{items.map(item => {
        const name = item.note.available ? item.note.title || t(k('untitled')) : t(k('note_unavailable'));
        const stale = item.uses.filter(u => u.updated).length;
        return <li key={item.id}><Card className="mb-0 p-4"><CardContent className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <h3 className="break-words text-sm font-semibold">{item.label || name}</h3>
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{t(k(`library_kind.${item.kind}`))}</Badge>
                {item.label && <span className="break-words">{name}</span>}
                {item.note.available && item.note.current_version !== null && <span>{t(k('library_current'), { version: item.note.current_version })}</span>}
                {stale > 0 && <Badge variant="warning">{t(k('library_stale_count'), { count: stale })}</Badge>}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {item.note.available && <NoteLink noteId={item.note.note_id}>{t(k('open_in_notes'))}</NoteLink>}
              {canEdit && <>
                <Button className={touch} size="sm" variant="ghost" aria-expanded={editing?.id === item.id} disabled={busy} onClick={() => setEditing(e => e?.id === item.id ? null : { id: item.id, kind: item.kind, label: item.label ?? '' })}>{t(k('edit'))}</Button>
                <Button className={touch} size="sm" variant="ghost" disabled={busy} aria-label={t(k('library_remove'), { name: item.label || name })} onClick={() => void run('library.remove', { item_id: item.id })}>{t(k('remove'))}</Button>
              </>}
            </div>
          </div>
          {canEdit && editing?.id === item.id && <div className="grid gap-3 border-t border-border pt-3 md:grid-cols-[12rem_1fr_auto_auto] md:items-end">
            <Field label={t(k('library_kind_label'))}><Select ariaLabel={t(k('library_kind_label'))} value={editing.kind} onChange={v => setEditing(x => x && { ...x, kind: v })} options={kinds} /></Field>
            <Field label={t(k('library_label'))}><Input className={touch} value={editing.label} onChange={e => setEditing(x => x && { ...x, label: e.target.value })} /></Field>
            <Button className={touch} size="sm" disabled={busy} onClick={async () => { if (await run('library.update', { item_id: item.id, kind: editing.kind, label: blank(editing.label) })) setEditing(null); }}>{t(k('save'))}</Button>
            <Button className={touch} size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>{t(k('cancel'))}</Button>
          </div>}
          <div className="space-y-1">
            <h4 className="text-xs text-muted-foreground">{t(k('library_uses'))}</h4>
            {item.uses.length ? <ul className="space-y-1 text-sm">{item.uses.map(u => {
              const material = u.material_label || t(k(`material_kind.${u.material_kind}`));
              const state = u.relation === 'source' ? t(k('library_use_source'), { material, version: u.note_version })
                : `${t(k('library_use_linked'), { material })} · ${u.note_version !== null ? t(k('library_use_reviewed'), { version: u.note_version }) : t(k('library_use_unreviewed'))}`;
              return <li key={`${u.material_id}:${u.relation}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2">
                <span className="min-w-0 break-words">{u.archived ? t(k('archived_suffix'), { name: recordName(u) }) : recordName(u)} — {state}
                  {u.updated && <Badge className="ml-2" variant="warning">{t(k('library_stale'))}</Badge>}</span>
                <Button className={touch} size="sm" variant="ghost" onClick={() => onOpen(tabOf(u.track), { id: u.application_id })}>{t(k('open_record'))}</Button>
              </li>;
            })}</ul> : <p className="text-sm text-muted-foreground">{t(k('library_no_uses'))}</p>}
          </div>
        </CardContent></Card></li>;
      })}</ul>}
    {canEdit && <Card className="mb-0"><CardContent className="space-y-3">
      <h3 className="text-sm font-semibold">{t(k('library_add_title'))}</h3>
      <div className="grid gap-3 md:grid-cols-[1fr_12rem_1fr_auto] md:items-end">
        <Field label={t(k('library_note_id'))}><Input className={touch} value={form.note_id} onChange={e => setForm(f => ({ ...f, note_id: e.target.value }))} /></Field>
        <Field label={t(k('library_kind_label'))}><Select ariaLabel={t(k('library_kind_label'))} value={form.kind} onChange={v => setForm(f => ({ ...f, kind: v }))} options={kinds} /></Field>
        <Field label={t(k('library_label'))}><Input className={touch} value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} /></Field>
        <Button className={touch} size="sm" variant="outline" disabled={busy || !form.note_id.trim()} onClick={async () => { if (await run('library.add', { note_id: form.note_id.trim(), kind: form.kind, label: blank(form.label) })) setForm({ note_id: '', kind: form.kind, label: '' }); }}>{t(k('library_add'))}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t(k('library_add_hint'))}</p>
    </CardContent></Card>}
  </div>;
}
