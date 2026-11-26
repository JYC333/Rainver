import { useCallback, useEffect, useRef, useState } from 'react';
import { blank, Field, k, Notice, touch, useOperations, type Ctx } from './viewKit';
import { MaterialNotes } from './materialNotes';
import { LinkPicker } from './linkPicker';
import { recordName, statusVariant, tabOf, type Application, type Contact, type Detail, type Open } from './records';
import { DEADLINE_KINDS, DECISION_STATUSES, FUNDING_SUBMISSIONS, MATERIAL_KINDS, MATERIAL_STATUSES, PROGRESS_STATUSES } from '../../domain';

/**
 * One program application or funding record, created and read the same way from
 * either tab: a funding record linked to a program application is the very record
 * the funding tab lists. Every read and write is a declared operation through the
 * Operation Core, exactly what an authorized Agent calls.
 */
/** A new program application, or (track `funding`) a scholarship or grant, optionally applying to program applications from the start. */
export function NewApplication({ ctx, track, programs = [], appliesTo = [], onCreated, onCancel }: { ctx: Ctx; track: 'phd' | 'funding'; programs?: Application[]; appliesTo?: string[]; onCreated: (id: string) => void; onCancel: () => void }) {
  const { ui } = ctx, { Button, Input, Select, Card, CardContent, t } = ui;
  const { command, reason } = useOperations(ctx);
  const funding = track === 'funding';
  const [form, setForm] = useState({ institution: '', program: '', department: '', intake: '', source_label: '', source_url: '', kind: funding ? 'funding' : 'application', due_on: '', create_tasks: false, submission: 'separate' });
  const [links, setLinks] = useState<string[]>(appliesTo);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const set = (key: keyof typeof form) => (value: string | boolean) => setForm(f => ({ ...f, [key]: value }));
  const submit = async () => {
    if (!form.institution.trim() || !form.program.trim()) { setError(t(k(funding ? 'errors.required_funding' : 'errors.required'))); return; }
    setBusy(true); setError('');
    try {
      const source = blank(form.source_label) || blank(form.source_url) ? { label: blank(form.source_label), url: blank(form.source_url) } : null;
      const result = await command<{ application_id: string }>('application.create', {
        track, institution: form.institution.trim(), program: form.program.trim(), department: funding ? null : blank(form.department), intake: blank(form.intake), source,
        deadlines: form.due_on ? [{ kind: form.kind, due_on: form.due_on }] : [], create_tasks: form.create_tasks,
        ...(funding ? { submission: form.submission, applies_to: links } : {}),
      });
      if ('status' in result && result.status === 'succeeded') onCreated(result.data.application_id);
    } catch (e) { setError(reason(e)); } finally { setBusy(false); }
  };
  return <Card className="mb-0"><CardContent className="space-y-4">
    <div className="space-y-1"><h3 className="text-sm font-semibold">{t(k(funding ? 'new_funding_title' : 'new_title'))}</h3><p className="text-xs text-muted-foreground">{t(k(funding ? 'submission_hint' : 'track_phd_hint'))}</p></div>
    <div className="grid gap-3 md:grid-cols-2">
      <Field label={t(k(funding ? 'funding_name' : 'institution'))}><Input className={touch} value={funding ? form.program : form.institution} onChange={e => set(funding ? 'program' : 'institution')(e.target.value)} /></Field>
      <Field label={t(k(funding ? 'funder' : 'program'))}><Input className={touch} value={funding ? form.institution : form.program} onChange={e => set(funding ? 'institution' : 'program')(e.target.value)} /></Field>
      {funding ? <Field label={t(k('submission_label'))}><Select ariaLabel={t(k('submission_label'))} value={form.submission} onChange={set('submission')} options={FUNDING_SUBMISSIONS.map(v => ({ value: v, label: t(k(`submission.${v}`)) }))} /></Field>
        : <Field label={t(k('department'))}><Input className={touch} value={form.department} onChange={e => set('department')(e.target.value)} /></Field>}
      <Field label={t(k('intake'))}><Input className={touch} value={form.intake} placeholder={t(k('intake_placeholder'))} onChange={e => set('intake')(e.target.value)} /></Field>
      <Field label={t(k('source_label'))}><Input className={touch} value={form.source_label} onChange={e => set('source_label')(e.target.value)} /></Field>
      <Field label={t(k('source_url'))}><Input className={touch} type="url" inputMode="url" value={form.source_url} placeholder="https://" onChange={e => set('source_url')(e.target.value)} /></Field>
      <Field label={t(k('first_deadline'))}><Select ariaLabel={t(k('deadline_kind_label'))} value={form.kind} onChange={set('kind')} options={DEADLINE_KINDS.map(v => ({ value: v, label: t(k(`deadline_kind.${v}`)) }))} /></Field>
      <Field label={t(k('due_on'))}><Input className={touch} type="date" value={form.due_on} onChange={e => set('due_on')(e.target.value)} /></Field>
    </div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={form.create_tasks} onChange={e => set('create_tasks')(e.target.checked)} />{t(k('create_task'))}</label>
    {funding && <LinkPicker ctx={ctx} label={t(k('applies_to'))} hint={t(k('applies_to_hint'))} options={programs.filter(a => !a.archived)} value={links} onChange={setLinks} emptyText={t(k('no_programs'))} />}
    <Notice text={error} tone="alert" />
    <div className="flex flex-wrap gap-2"><Button className={touch} disabled={busy} onClick={() => void submit()}>{busy ? t(k('saving')) : t(k('create'))}</Button><Button className={touch} variant="ghost" disabled={busy} onClick={onCancel}>{t(k('cancel'))}</Button></div>
  </CardContent></Card>;
}

export function ApplicationDetail({ ctx, applicationId, onOpen }: { ctx: Ctx; applicationId: string; onOpen: Open }) {
  const { ui } = ctx, { Button, Input, Textarea, Select, Badge, t, formatDay, ProposalLink } = ui;
  const { query, command, reason } = useOperations(ctx);
  const [detail, setDetail] = useState<Detail | null>(null), [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [proposal, setProposal] = useState(''), [busy, setBusy] = useState(false);
  const [facts, setFacts] = useState({ institution: '', program: '', department: '', intake: '', notes: '', source_label: '', source_url: '' });
  const [progress, setProgress] = useState('preparing'), [decision, setDecision] = useState('submitted'), [resultNote, setResultNote] = useState('');
  const [deadline, setDeadline] = useState({ kind: 'application', label: '', due_on: '', create_task: false });
  const [material, setMaterial] = useState({ kind: 'other', label: '' });
  const [linking, setLinking] = useState<{ id: string; type: string; ref: string } | null>(null);
  const [notesOpen, setNotesOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; kind: string; label: string; due_on: string } | null>(null);
  const [submission, setSubmission] = useState('separate'), [linkTarget, setLinkTarget] = useState('');
  const [candidates, setCandidates] = useState<Application[]>([]);
  const lastRead = useRef(0);
  const baseline = useRef<{ facts: typeof facts; progress: string; submission: string } | null>(null);
  const load = useCallback(async (resetDrafts = false) => {
    const read = ++lastRead.current;
    try {
      const data = await query<Detail>('application.get', { application_id: applicationId });
      if (read !== lastRead.current) return;
      setDetail(data); setState('ready');
      const a = data.application;
      const next = {
        facts: { institution: a.institution, program: a.program, department: a.department ?? '', intake: a.intake ?? '', notes: a.notes ?? '', source_label: a.source?.label ?? '', source_url: a.source?.url ?? '' },
        progress: (PROGRESS_STATUSES as readonly string[]).includes(a.status) ? a.status : 'preparing',
        submission: a.submission ?? 'separate',
      };
      const previous = baseline.current;
      baseline.current = next;
      setFacts(draft => !resetDrafts && previous && JSON.stringify(draft) !== JSON.stringify(previous.facts) ? draft : next.facts);
      setProgress(draft => !resetDrafts && previous && draft !== previous.progress ? draft : next.progress);
      setSubmission(draft => !resetDrafts && previous && draft !== previous.submission ? draft : next.submission);
      // The records on the other side of a funding link that this one could still be linked to.
      const other = await query<{ items: Application[] }>('application.list', { track: a.track === 'funding' ? 'phd' : 'funding' });
      const linked = new Set(a.track === 'funding' ? a.applies_to : a.funding_ids);
      if (read !== lastRead.current) return;
      setCandidates(other.items.filter(x => !linked.has(x.id)));
      if (resetDrafts) setLinkTarget('');
      // An archived application is read-only: an editor opened before archiving closes.
      if (a.archived) { setEditing(null); setLinking(null); }
    } catch { if (read === lastRead.current) setState('error'); }
  }, [query, applicationId]);
  useEffect(() => { void load(); }, [load, ctx.projectRevision]);
  const run = async (name: string, input: Record<string, unknown>, done: string) => {
    setBusy(true); setNotice(''); setError('');
    try {
      const result = await command(name, input);
      if ('status' in result && result.status === 'pending_approval') { setProposal(result.proposal_id); setNotice(t(k('pending'))); }
      else setNotice(t(k(done)));
      await load(true);
      return true;
    } catch (e) { setError(reason(e)); await load(); return false; } finally { setBusy(false); }
  };
  if (state === 'loading' && !detail) return <p role="status" className="text-sm text-muted-foreground">{t(k('loading'))}</p>;
  if (state === 'error' || !detail) return <div className="space-y-2"><Notice text={t(k('load_failed'))} tone="alert" /><Button className={touch} variant="outline" size="sm" onClick={() => void load()}>{t(k('retry'))}</Button></div>;
  const a = detail.application;
  const canEdit = ctx.projectCanWrite !== false;
  const editable = canEdit && !a.archived;
  const funding = a.track === 'funding', automatic = a.submission === 'automatic';
  const decisions = DECISION_STATUSES.filter(v => !(automatic && v === 'submitted'));
  const sourceUrl = a.source?.url && /^https?:\/\//i.test(a.source.url) ? a.source.url : null;
  return <div className="space-y-4">
    <header><h3 className="break-words text-xl font-semibold">{a.program}</h3><p className="text-sm text-muted-foreground">{a.institution}</p></header>
    <Notice text={notice} />{proposal && <ProposalLink id={proposal} />}<Notice text={error} tone="alert" />
    <section className="space-y-3" aria-label={t(k('status_section'))}>
      <h4 className="text-sm font-semibold">{t(k('status_section'))}</h4>
      <p className="text-sm">{t(k('current_status'))}: <Badge variant={statusVariant(a.status)}>{t(k(`status.${a.status}`))}</Badge>{a.result_note && <span className="ml-2 text-xs text-muted-foreground">{a.result_note}</span>}</p>
      <Field label={t(k('result_note'))}><Input className={touch} disabled={!editable} value={resultNote} onChange={e => setResultNote(e.target.value)} /></Field>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2"><Field label={t(k('progress_label'))}><Select ariaLabel={t(k('progress_label'))} disabled={!editable} value={progress} onChange={setProgress} options={PROGRESS_STATUSES.map(v => ({ value: v, label: t(k(`status.${v}`)) }))} /></Field>
          <Button className={touch} size="sm" variant="outline" disabled={busy || !editable} onClick={() => void run('application.update_status', { application_id: a.id, status: progress, ...(resultNote.trim() ? { result_note: resultNote.trim() } : {}) }, 'saved')}>{t(k('record_progress'))}</Button></div>
        <div className="space-y-2"><Field label={t(k('decision_label'))} hint={t(k('decision_hint'))}><Select ariaLabel={t(k('decision_label'))} disabled={!editable} value={decisions.includes(decision as never) ? decision : decisions[0]!} onChange={setDecision} options={decisions.map(v => ({ value: v, label: t(k(`status.${v}`)) }))} /></Field>
          <Button className={touch} size="sm" variant="outline" disabled={busy || !editable} onClick={() => void run('application.propose_status', { application_id: a.id, status: decisions.includes(decision as never) ? decision : decisions[0]!, ...(resultNote.trim() ? { result_note: resultNote.trim() } : {}) }, 'saved')}>{t(k('propose_decision'))}</Button></div>
      </div>
    </section>
    <LinkedRecords ctx={ctx} detail={detail} candidates={candidates} target={linkTarget} setTarget={setLinkTarget} busy={busy} onOpen={onOpen}
      onLink={id => run('funding.link', funding ? { funding_id: a.id, application_id: id } : { funding_id: id, application_id: a.id }, 'saved')}
      onUnlink={id => run('funding.unlink', funding ? { funding_id: a.id, application_id: id } : { funding_id: id, application_id: a.id }, 'saved')} />
    <section className="space-y-3 border-t border-border pt-4" aria-label={t(k('deadlines'))}>
      <h4 className="text-sm font-semibold">{t(k('deadlines'))}</h4>
      {detail.deadlines.length ? <ul className="space-y-2">{detail.deadlines.map(d => {
        const name = d.label || t(k(`deadline_kind.${d.kind}`));
        return <li key={d.id} className="space-y-3 rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words"><span className="font-medium">{formatDay(d.due_on)}</span> · {name}{d.task_id && <span className="ml-2 text-xs text-muted-foreground">{t(k('task_linked'))}</span>}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Button className={touch} size="sm" variant="ghost" disabled={busy || !editable} aria-expanded={editing?.id === d.id} aria-label={t(k('edit_deadline'), { label: name })} onClick={() => setEditing(e => e?.id === d.id ? null : { id: d.id, kind: d.kind, label: d.label ?? '', due_on: d.due_on })}>{t(k('edit'))}</Button>
              <Button className={touch} size="sm" variant="ghost" disabled={busy || !editable} aria-label={t(k('remove_deadline'), { label: name })} onClick={() => void run('deadline.remove', { deadline_id: d.id }, 'saved')}>{t(k('remove'))}</Button>
            </div>
          </div>
          {editable && editing?.id === d.id && <div className="space-y-3 border-t border-border pt-3">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label={t(k('deadline_kind_label'))}><Select ariaLabel={t(k('deadline_kind_label'))} value={editing.kind} onChange={v => setEditing(x => x && { ...x, kind: v })} options={DEADLINE_KINDS.map(v => ({ value: v, label: t(k(`deadline_kind.${v}`)) }))} /></Field>
              <Field label={t(k('deadline_label'))}><Input className={touch} value={editing.label} onChange={e => setEditing(x => x && { ...x, label: e.target.value })} /></Field>
              <Field label={t(k('due_on'))}><Input className={touch} type="date" value={editing.due_on} onChange={e => setEditing(x => x && { ...x, due_on: e.target.value })} /></Field>
            </div>
            {d.task_id && <p className="text-xs text-muted-foreground">{t(k('deadline_task_kept'))}</p>}
            <div className="flex flex-wrap gap-2">
              <Button className={touch} size="sm" disabled={busy || !editing.due_on} onClick={async () => { if (await run('deadline.update', { deadline_id: d.id, kind: editing.kind, label: blank(editing.label), due_on: editing.due_on }, 'saved')) setEditing(null); }}>{t(k('save'))}</Button>
              <Button className={touch} size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>{t(k('cancel'))}</Button>
            </div>
          </div>}
        </li>;
      })}</ul>
        : <p className="text-sm text-muted-foreground">{t(k('no_deadlines'))}</p>}
      <div className="grid gap-3 md:grid-cols-3">
        <Field label={t(k('deadline_kind_label'))}><Select ariaLabel={t(k('deadline_kind_label'))} disabled={!editable} value={deadline.kind} onChange={v => setDeadline(d => ({ ...d, kind: v }))} options={DEADLINE_KINDS.map(v => ({ value: v, label: t(k(`deadline_kind.${v}`)) }))} /></Field>
        <Field label={t(k('deadline_label'))}><Input className={touch} disabled={!editable} value={deadline.label} onChange={e => setDeadline(d => ({ ...d, label: e.target.value }))} /></Field>
        <Field label={t(k('due_on'))}><Input className={touch} type="date" disabled={!editable} value={deadline.due_on} onChange={e => setDeadline(d => ({ ...d, due_on: e.target.value }))} /></Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" disabled={!editable} checked={deadline.create_task} onChange={e => setDeadline(d => ({ ...d, create_task: e.target.checked }))} />{t(k('create_task'))}</label>
        <Button className={touch} size="sm" variant="outline" disabled={busy || !deadline.due_on || !editable} onClick={async () => { if (await run('deadline.add', { application_id: a.id, kind: deadline.kind, label: blank(deadline.label), due_on: deadline.due_on, create_task: deadline.create_task }, 'saved')) setDeadline({ kind: 'application', label: '', due_on: '', create_task: false }); }}>{t(k('add_deadline'))}</Button>
      </div>
    </section>
    {automatic ? <section className="space-y-2 border-t border-border pt-4" aria-label={t(k('materials'))}>
      <h4 className="text-sm font-semibold">{t(k('materials'))}</h4>
      <p className="text-sm text-muted-foreground">{t(k('automatic_no_checklist'))}</p>
    </section> : <section className="space-y-3 border-t border-border pt-4" aria-label={t(k('materials'))}>
      <h4 className="text-sm font-semibold">{t(k('materials'))} <span className="font-normal text-muted-foreground">{t(k('materials_progress'), a.materials)}</span></h4>
      <ul className="space-y-2">{detail.materials.map(m => {
        const name = m.label || t(k(`material_kind.${m.kind}`));
        return <li key={m.id} className="space-y-2 rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words font-medium">{name}{!m.required && <span className="ml-2 text-xs font-normal text-muted-foreground">{t(k('optional'))}</span>}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Select size="sm" ariaLabel={t(k('material_status_label'), { name })} value={m.status} disabled={busy || !editable} onChange={v => void run('material.update', { material_id: m.id, status: v }, 'saved')} options={MATERIAL_STATUSES.map(v => ({ value: v, label: t(k(`material_status.${v}`)) }))} />
              <Button className={touch} size="sm" variant="outline" aria-expanded={notesOpen === m.id} aria-label={t(k('notes_and_drafts_for'), { name })} onClick={() => setNotesOpen(o => o === m.id ? null : m.id)}>{t(k('notes_and_drafts'))}</Button>
              <Button className={touch} size="sm" variant="ghost" disabled={busy || !editable} onClick={() => setLinking({ id: m.id, type: m.reference?.type ?? 'artifact', ref: m.reference?.id ?? '' })}>{m.reference ? t(k('change_reference')) : t(k('link_reference'))}</Button>
              <Button className={touch} size="sm" variant="ghost" disabled={busy || !editable} aria-label={t(k('remove_material'), { name })} onClick={() => void run('material.remove', { material_id: m.id }, 'saved')}>{t(k('remove'))}</Button>
            </div>
          </div>
          {m.reference && <p className="text-xs text-muted-foreground">{t(k(`reference_${m.reference.type}`))}: {m.reference.available ? m.reference.title || t(k('untitled')) : t(k('reference_unavailable'))}</p>}
          {m.note && notesOpen !== m.id && <p className="text-xs text-muted-foreground">{t(k('note_summary'), { title: m.note.available ? m.note.title || t(k('untitled')) : t(k('note_unavailable')) })}{m.sources.some(x => x.updated) ? ` · ${t(k('sources_updated'))}` : ''}</p>}
          {notesOpen === m.id && <MaterialNotes ctx={ctx} material={m} archived={!editable} onChanged={async () => { await load(); }} />}
          {editable && linking?.id === m.id && <div className="grid gap-2 md:grid-cols-[10rem_1fr_auto_auto] md:items-end">
            <Field label={t(k('reference_type'))}><Select ariaLabel={t(k('reference_type'))} value={linking.type} onChange={v => setLinking(l => l && { ...l, type: v })} options={[{ value: 'artifact', label: t(k('reference_artifact')) }, { value: 'task', label: t(k('reference_task')) }]} /></Field>
            <Field label={t(k('reference_id'))}><Input className={touch} value={linking.ref} onChange={e => setLinking(l => l && { ...l, ref: e.target.value })} /></Field>
            <Button className={touch} size="sm" disabled={busy || !linking.ref.trim()} onClick={async () => { if (await run('material.update', { material_id: m.id, reference: { type: linking.type, id: linking.ref.trim() } }, 'saved')) setLinking(null); }}>{t(k('save'))}</Button>
            {m.reference ? <Button className={touch} size="sm" variant="ghost" disabled={busy} onClick={async () => { if (await run('material.update', { material_id: m.id, reference: null }, 'saved')) setLinking(null); }}>{t(k('unlink'))}</Button>
              : <Button className={touch} size="sm" variant="ghost" onClick={() => setLinking(null)}>{t(k('cancel'))}</Button>}
          </div>}
        </li>;
      })}</ul>
      <div className="grid gap-3 md:grid-cols-[12rem_1fr_auto] md:items-end">
        <Field label={t(k('material_kind_label'))}><Select ariaLabel={t(k('material_kind_label'))} disabled={!editable} value={material.kind} onChange={v => setMaterial(m => ({ ...m, kind: v }))} options={MATERIAL_KINDS.map(v => ({ value: v, label: t(k(`material_kind.${v}`)) }))} /></Field>
        <Field label={t(k('material_label'))}><Input className={touch} disabled={!editable} value={material.label} onChange={e => setMaterial(m => ({ ...m, label: e.target.value }))} /></Field>
        <Button className={touch} size="sm" variant="outline" disabled={busy || !editable} onClick={async () => { if (await run('material.add', { application_id: a.id, kind: material.kind, label: blank(material.label) }, 'saved')) setMaterial({ kind: 'other', label: '' }); }}>{t(k('add_material'))}</Button>
      </div>
    </section>}
    <RelatedContacts ctx={ctx} applicationId={a.id} onOpen={onOpen} />
    <section className="space-y-3 border-t border-border pt-4" aria-label={t(k('facts'))}>
      <h4 className="text-sm font-semibold">{t(k('facts'))}</h4>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t(k(funding ? 'funder' : 'institution'))}><Input className={touch} disabled={!editable} value={facts.institution} onChange={e => setFacts(f => ({ ...f, institution: e.target.value }))} /></Field>
        <Field label={t(k(funding ? 'funding_name' : 'program'))}><Input className={touch} disabled={!editable} value={facts.program} onChange={e => setFacts(f => ({ ...f, program: e.target.value }))} /></Field>
        {funding ? <Field label={t(k('submission_label'))} hint={t(k('submission_hint'))}><Select ariaLabel={t(k('submission_label'))} disabled={!editable} value={submission} onChange={setSubmission} options={FUNDING_SUBMISSIONS.map(v => ({ value: v, label: t(k(`submission.${v}`)) }))} /></Field>
          : <Field label={t(k('department'))}><Input className={touch} disabled={!editable} value={facts.department} onChange={e => setFacts(f => ({ ...f, department: e.target.value }))} /></Field>}
        <Field label={t(k('intake'))}><Input className={touch} disabled={!editable} value={facts.intake} onChange={e => setFacts(f => ({ ...f, intake: e.target.value }))} /></Field>
        <Field label={t(k('source_label'))}><Input className={touch} disabled={!editable} value={facts.source_label} onChange={e => setFacts(f => ({ ...f, source_label: e.target.value }))} /></Field>
        <Field label={t(k('source_url'))}><Input className={touch} type="url" disabled={!editable} value={facts.source_url} onChange={e => setFacts(f => ({ ...f, source_url: e.target.value }))} /></Field>
      </div>
      <Field label={t(k('notes'))}><Textarea disabled={!editable} value={facts.notes} onChange={e => setFacts(f => ({ ...f, notes: e.target.value }))} /></Field>
      {sourceUrl && <p className="text-xs text-muted-foreground">{t(k('source'))}: <a className="underline underline-offset-2" href={sourceUrl} target="_blank" rel="noopener noreferrer">{a.source?.label || sourceUrl}</a></p>}
      {a.archived && <p className="text-xs text-muted-foreground">{t(k('application_archived_hint'))}</p>}
      <div className="flex flex-wrap gap-2">
        {editable && <Button className={touch} size="sm" disabled={busy || !facts.institution.trim() || !facts.program.trim()} onClick={() => void run('application.update', {
          application_id: a.id, revision: a.revision, institution: facts.institution.trim(), program: facts.program.trim(), intake: blank(facts.intake), notes: blank(facts.notes),
          ...(funding ? (submission !== a.submission ? { submission } : {}) : { department: blank(facts.department) }),
          source: blank(facts.source_label) || blank(facts.source_url) ? { label: blank(facts.source_label), url: blank(facts.source_url) } : null,
        }, 'saved')}>{t(k('save'))}</Button>}
        <Button className={touch} size="sm" variant="outline" disabled={busy || !canEdit} onClick={() => void run('application.update', { application_id: a.id, revision: a.revision, archived: !a.archived }, a.archived ? 'restored' : 'archived_done')}>{a.archived ? t(k('restore')) : t(k('archive'))}</Button>
      </div>
    </section>
  </div>;
}

/**
 * The other side of the funding links: a program application's funding records or a
 * funding record's program applications, each opened in its own tab (the same record),
 * plus linking another active one and unlinking.
 */
function LinkedRecords({ ctx, detail, candidates, target, setTarget, busy, onOpen, onLink, onUnlink }: {
  ctx: Ctx; detail: Detail; candidates: Application[]; target: string; setTarget: (id: string) => void; busy: boolean; onOpen: Open;
  onLink: (id: string) => Promise<boolean>; onUnlink: (id: string) => Promise<boolean>;
}) {
  const { Button, Badge, Select, t, formatDay } = ctx.ui;
  const a = detail.application, funding = a.track === 'funding';
  const rows = funding ? detail.applies_to : detail.funding;
  const canEdit = ctx.projectCanWrite !== false;
  const options = candidates.filter(c => !c.archived);
  return <section className="space-y-3 border-t border-border pt-4" aria-label={t(k(funding ? 'linked_applications' : 'linked_funding'))}>
    <div className="space-y-1"><h4 className="text-sm font-semibold">{t(k(funding ? 'linked_applications' : 'linked_funding'))}</h4><p className="text-xs text-muted-foreground">{t(k(funding ? 'linked_applications_hint' : 'linked_funding_hint'))}</p></div>
    {rows.length ? <ul className="space-y-2">{rows.map(r => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
      <span className="min-w-0 space-y-1 break-words">
        <span className="block font-medium">{recordName(r)}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={statusVariant(r.status)}>{t(k(`status.${r.status}`))}</Badge>
          {r.submission && <span>{t(k(`submission.${r.submission}`))}</span>}
          {r.archived && <Badge variant="outline">{t(k('archived'))}</Badge>}
          <span>{r.next_deadline ? `${formatDay(r.next_deadline.due_on)} · ${r.next_deadline.label || t(k(`deadline_kind.${r.next_deadline.kind}`))}` : t(k('no_deadline'))}</span>
          {r.submission !== 'automatic' && <span>{t(k('materials_progress'), r.materials)}</span>}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <Button className={touch} size="sm" variant="outline" onClick={() => onOpen(tabOf(r.track), { id: r.id })}>{t(k('open_record'))}</Button>
        <Button className={touch} size="sm" variant="ghost" disabled={busy || !canEdit || (funding ? a.archived : r.archived)} aria-label={t(k('unlink_record'), { name: recordName(r) })} onClick={() => void onUnlink(r.id)}>{t(k('unlink'))}</Button>
      </span>
    </li>)}</ul> : <p className="text-sm text-muted-foreground">{t(k(funding ? 'no_linked_applications' : 'no_linked_funding'))}</p>}
    {canEdit && !a.archived && <div className="flex flex-wrap items-end gap-2">
      {options.length > 0 && <>
        <Field label={t(k(funding ? 'link_application_label' : 'link_funding_label'))}><Select ariaLabel={t(k(funding ? 'link_application_label' : 'link_funding_label'))} value={target || options[0]!.id} onChange={setTarget} options={options.map(o => ({ value: o.id, label: recordName(o) }))} /></Field>
        <Button className={touch} size="sm" variant="outline" disabled={busy} onClick={() => void onLink(target || options[0]!.id)}>{t(k('link'))}</Button>
      </>}
      {!funding && <Button className={touch} size="sm" variant="ghost" onClick={() => onOpen('funding', { createFor: a.id })}>{t(k('create_linked_funding'))}</Button>}
    </div>}
  </section>;
}

/** Contacts involved in this record, kept in the contacts tab (one supervisor may be linked to several applications). */
function RelatedContacts({ ctx, applicationId, onOpen }: { ctx: Ctx; applicationId: string; onOpen: Open }) {
  const { Button, Badge, t, formatDay } = ctx.ui;
  const { query } = useOperations(ctx);
  const [items, setItems] = useState<Contact[] | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => { void query<{ items: Contact[] }>('contact.list', { application_id: applicationId }).then(r => { setItems(r.items); setFailed(false); }, () => setFailed(true)); }, [query, applicationId, ctx.projectRevision]);
  return <section className="space-y-3 border-t border-border pt-4" aria-label={t(k('related_contacts'))}>
    <div className="space-y-1"><h4 className="text-sm font-semibold">{t(k('related_contacts'))}</h4><p className="text-xs text-muted-foreground">{t(k('related_contacts_hint'))}</p></div>
    {failed ? <Notice text={t(k('contacts_unavailable'))} /> : items === null ? <p role="status" className="text-sm text-muted-foreground">{t(k('loading'))}</p>
      : items.length === 0 ? <p className="text-sm text-muted-foreground">{t(k('no_related_contacts'))}</p>
      : <ul className="space-y-2">{items.map(c => <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
        <span className="min-w-0 break-words"><span className="font-medium">{c.name}</span> <span className="text-xs text-muted-foreground">{t(k(`role.${c.role}`))}{c.affiliation ? ` · ${c.affiliation}` : ''}</span></span>
        <span className="flex flex-wrap items-center gap-2">
          {c.last_event ? <Badge variant={c.last_event.response === 'positive' ? 'success' : c.last_event.response === 'negative' ? 'destructive' : c.last_event.response === 'awaiting' ? 'warning' : 'muted'}>{t(k(`response.${c.last_event.response}`))} · {formatDay(c.last_event.occurred_on)}</Badge> : <Badge variant="muted">{t(k('not_contacted'))}</Badge>}
          <Button className={touch} size="sm" variant="outline" onClick={() => onOpen('contacts', { id: c.id })}>{t(k('open_contact'))}</Button>
        </span>
      </li>)}</ul>}
    <Button className={touch} size="sm" variant="ghost" onClick={() => onOpen('contacts', {})}>{t(k('manage_contacts'))}</Button>
  </section>;
}
