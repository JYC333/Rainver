import { useCallback, useEffect, useState } from 'react';
import { blank, Field, k, Notice, today, touch, useOperations, type Ctx } from './viewKit';
import { LinkPicker } from './linkPicker';
import { recordName, tabOf, type Application, type Contact, type ContactEvent, type Open } from './records';
import { CONTACT_CHANNELS, CONTACT_DIRECTIONS, CONTACT_RESPONSES, CONTACT_ROLES } from '../../domain';

/**
 * Supervisors, referees and other contacts in the Project, each linked
 * to any number of applications (program or funding) or none (Project level), with the
 * recorded contact history. Contact details are personal data (ADR 0030). A contact whose
 * every linked application is archived is read-only until it is linked to an active one,
 * made Project-level, or an application is restored.
 */
export function ContactsTab({ ctx, focus, onOpen }: { ctx: Ctx; focus: string | null; onOpen: Open }) {
  const canEdit = ctx.projectCanWrite !== false;
  const { ui } = ctx, { Button, Input, Textarea, Select, Badge, t, formatDay } = ui;
  const { query, command, reason } = useOperations(ctx);
  const [contacts, setContacts] = useState<Contact[] | null>(null), [failed, setFailed] = useState(false);
  const [applications, setApplications] = useState<Application[]>([]);
  const empty = { name: '', role: 'supervisor', email: '', affiliation: '', note: '', application_ids: [] as string[] };
  const [adding, setAdding] = useState(false), [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<(typeof empty & { id: string }) | null>(null);
  const [open, setOpen] = useState<string | null>(focus), [events, setEvents] = useState<ContactEvent[]>([]);
  const [entry, setEntry] = useState({ occurred_on: today(), channel: 'email', direction: 'outbound', response: 'awaiting', summary: '', next_step: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try {
      const [list, apps] = await Promise.all([
        query<{ items: Contact[] }>('contact.list', {}),
        query<{ items: Application[] }>('application.list', { include_archived: true }),
      ]);
      setContacts(list.items); setApplications(apps.items); setFailed(false);
    } catch { setFailed(true); }
  }, [query]);
  const loadEvents = useCallback(async (contactId: string) => {
    try { setEvents((await query<{ items: ContactEvent[] }>('contact.list_events', { contact_id: contactId })).items); } catch { setEvents([]); }
  }, [query]);
  useEffect(() => { void load(); }, [load, ctx.projectRevision]);
  // Opened from an application: show that contact's history and bring it into view.
  const loaded = contacts !== null;
  useEffect(() => {
    if (!focus || !loaded) return;
    setOpen(focus);
    document.getElementById(`plugin-phd-application-contact-${focus}`)?.scrollIntoView({ block: 'nearest' });
  }, [focus, loaded]);
  useEffect(() => { if (open) void loadEvents(open); }, [open, loadEvents, ctx.projectRevision]);
  const run = async (name: string, input: Record<string, unknown>) => {
    setBusy(true); setError(''); setNotice('');
    try { await command(name, input); setNotice(t(k('saved'))); await load(); return true; } catch (e) { setError(reason(e)); await load(); return false; } finally { setBusy(false); }
  };
  const byId = new Map(applications.map(x => [x.id, x]));
  const isArchived = (id: string) => byId.get(id)?.archived === true;
  // Read-only while every linked application is archived; a Project-level contact never is.
  const frozen = (ids: string[]) => ids.length > 0 && ids.every(isArchived);
  const details = (value: typeof empty, set: (patch: Partial<typeof empty>) => void) => <>
    <div className="grid gap-3 md:grid-cols-2">
      <Field label={t(k('name'))}><Input className={touch} value={value.name} onChange={e => set({ name: e.target.value })} /></Field>
      <Field label={t(k('role_label'))}><Select ariaLabel={t(k('role_label'))} value={value.role} onChange={v => set({ role: v })} options={CONTACT_ROLES.map(v => ({ value: v, label: t(k(`role.${v}`)) }))} /></Field>
      <Field label={t(k('email'))}><Input className={touch} type="email" value={value.email} onChange={e => set({ email: e.target.value })} /></Field>
      <Field label={t(k('affiliation'))}><Input className={touch} value={value.affiliation} onChange={e => set({ affiliation: e.target.value })} /></Field>
    </div>
    <LinkPicker ctx={ctx} label={t(k('contact_applications'))} hint={t(k('contact_applications_hint'))} options={applications} value={value.application_ids} onChange={ids => set({ application_ids: ids })} emptyText={t(k('no_programs'))} />
    <Field label={t(k('contact_note'))}><Textarea value={value.note} onChange={e => set({ note: e.target.value })} /></Field>
  </>;
  const fields = (value: typeof empty) => ({ name: value.name.trim(), role: value.role, email: blank(value.email), affiliation: blank(value.affiliation), note: blank(value.note), application_ids: value.application_ids });
  return <section className="space-y-3" aria-label={t(k('project_contacts'))}>
    <p className="text-sm text-muted-foreground">{t(k('project_contacts_hint'))}</p>
    <Notice text={notice} /><Notice text={error} tone="alert" />
    {failed ? <Notice text={t(k('load_failed'))} tone="alert" /> : contacts === null ? <p role="status" className="text-sm text-muted-foreground">{t(k('loading'))}</p>
      : contacts.length === 0 ? <p className="text-sm text-muted-foreground">{t(k('no_contacts'))}</p>
      : <ul className="space-y-2">{contacts.map(c => {
        const locked = frozen(c.application_ids);
        return <li key={c.id} id={`plugin-phd-application-contact-${c.id}`} className="space-y-2 rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words"><span className="font-medium">{c.name}</span> <span className="text-xs text-muted-foreground">{t(k(`role.${c.role}`))}{c.affiliation ? ` · ${c.affiliation}` : ''}</span>{c.email && <span className="block text-xs text-muted-foreground">{c.email}</span>}</span>
            <div className="flex flex-wrap items-center gap-2">
              {c.last_event ? <Badge variant={c.last_event.response === 'positive' ? 'success' : c.last_event.response === 'negative' ? 'destructive' : c.last_event.response === 'awaiting' ? 'warning' : 'muted'}>{t(k(`response.${c.last_event.response}`))} · {formatDay(c.last_event.occurred_on)}</Badge> : <Badge variant="muted">{t(k('not_contacted'))}</Badge>}
              {canEdit && <Button className={touch} size="sm" variant="ghost" aria-expanded={editing?.id === c.id} aria-label={t(k('edit_contact'), { name: c.name })} disabled={busy} onClick={() => setEditing(e => e?.id === c.id ? null : { id: c.id, name: c.name, role: c.role, email: c.email ?? '', affiliation: c.affiliation ?? '', note: c.note ?? '', application_ids: c.application_ids })}>{t(k('edit'))}</Button>}
              <Button className={touch} size="sm" variant="ghost" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? t(k('hide_history')) : t(k('history'), { count: c.events })}</Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{c.application_ids.length === 0 ? <span>{t(k('project_level'))}</span>
            : c.application_ids.map(id => { const app = byId.get(id); return app ? <Button key={id} className={touch} size="sm" variant="ghost" onClick={() => onOpen(tabOf(app.track), { id })}>{app.archived ? t(k('archived_suffix'), { name: recordName(app) }) : recordName(app)}</Button> : null; })}</div>
          {c.note && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{c.note}</p>}
          {c.last_event?.next_step && <p className="text-xs text-muted-foreground">{t(k('next_step'))}: {c.last_event.next_step}</p>}
          {locked && <p className="text-xs text-muted-foreground">{t(k('contact_archived'))}</p>}
          {canEdit && editing?.id === c.id && <div className="space-y-3 border-t border-border pt-3">
            {details(editing, patch => setEditing(x => x && { ...x, ...patch }))}
            <div className="flex flex-wrap gap-2">
              <Button className={touch} size="sm" disabled={busy || !editing.name.trim() || frozen(editing.application_ids)} onClick={async () => { if (await run('contact.update', { contact_id: c.id, ...fields(editing) })) setEditing(null); }}>{t(k('save'))}</Button>
              <Button className={touch} size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>{t(k('cancel'))}</Button>
            </div>
          </div>}
          {open === c.id && <div className="space-y-3 border-t border-border pt-3">
            {events.length ? <ol className="space-y-2">{events.map(e => <li key={e.id} className="rounded-md bg-muted p-2 text-xs"><span className="font-medium">{formatDay(e.occurred_on)} · {t(k(`channel.${e.channel}`))} · {t(k(`direction.${e.direction}`))} · {t(k(`response.${e.response}`))}</span><span className="mt-1 block whitespace-pre-wrap break-words text-sm">{e.summary}</span>{e.next_step && <span className="mt-1 block text-muted-foreground">{t(k('next_step'))}: {e.next_step}</span>}</li>)}</ol>
              : <p className="text-xs text-muted-foreground">{t(k('no_events'))}</p>}
            {canEdit && !locked && <>
              <p className="text-xs text-muted-foreground">{t(k('log_hint'))}</p>
              <div className="grid gap-3 md:grid-cols-4">
                <Field label={t(k('occurred_on'))}><Input className={touch} type="date" value={entry.occurred_on} onChange={e => setEntry(v => ({ ...v, occurred_on: e.target.value }))} /></Field>
                <Field label={t(k('channel_label'))}><Select ariaLabel={t(k('channel_label'))} value={entry.channel} onChange={v => setEntry(x => ({ ...x, channel: v }))} options={CONTACT_CHANNELS.map(v => ({ value: v, label: t(k(`channel.${v}`)) }))} /></Field>
                <Field label={t(k('direction_label'))}><Select ariaLabel={t(k('direction_label'))} value={entry.direction} onChange={v => setEntry(x => ({ ...x, direction: v }))} options={CONTACT_DIRECTIONS.map(v => ({ value: v, label: t(k(`direction.${v}`)) }))} /></Field>
                <Field label={t(k('response_label'))}><Select ariaLabel={t(k('response_label'))} value={entry.response} onChange={v => setEntry(x => ({ ...x, response: v }))} options={CONTACT_RESPONSES.map(v => ({ value: v, label: t(k(`response.${v}`)) }))} /></Field>
              </div>
              <Field label={t(k('summary_label'))}><Textarea value={entry.summary} onChange={e => setEntry(v => ({ ...v, summary: e.target.value }))} /></Field>
              <Field label={t(k('next_step'))}><Input className={touch} value={entry.next_step} onChange={e => setEntry(v => ({ ...v, next_step: e.target.value }))} /></Field>
              <Button className={touch} size="sm" variant="outline" disabled={busy || !entry.summary.trim() || !entry.occurred_on} onClick={async () => {
                if (await run('contact.log_event', { contact_id: c.id, occurred_on: entry.occurred_on, channel: entry.channel, direction: entry.direction, response: entry.response, summary: entry.summary.trim(), next_step: blank(entry.next_step) })) {
                  setEntry(v => ({ ...v, summary: '', next_step: '' })); void loadEvents(c.id);
                }
              }}>{t(k('log_event'))}</Button>
            </>}
          </div>}
        </li>;
      })}</ul>}
    {canEdit && (adding ? <div className="space-y-3 rounded-md border border-border p-3">
      {details(form, patch => setForm(f => ({ ...f, ...patch })))}
      <div className="flex flex-wrap gap-2">
        <Button className={touch} size="sm" disabled={busy || !form.name.trim()} onClick={async () => { if (await run('contact.create', fields(form))) { setAdding(false); setForm(empty); } }}>{t(k('save'))}</Button>
        <Button className={touch} size="sm" variant="ghost" onClick={() => setAdding(false)}>{t(k('cancel'))}</Button>
      </div>
    </div> : <Button className={touch} size="sm" variant="outline" onClick={() => { setForm(empty); setAdding(true); }}>{t(k('add_contact'))}</Button>)}
  </section>;
}
