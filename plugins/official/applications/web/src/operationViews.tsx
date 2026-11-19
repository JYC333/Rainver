import { useCallback, useEffect, useState } from 'react';
import { k, Notice, touch, useOperations, type Ctx } from './viewKit';
import { ApplicationDetail, NewApplication } from './applicationDetail';
import { ContactsTab } from './contactsTab';
import { LibraryTab } from './libraryTab';
import { recordName, statusVariant, type Application, type Focus, type Open, type Tab } from './records';
import { CLOSED_STATUSES } from '../../domain';

/**
 * Bundled views of the application management package: one Project entry with four
 * tabs (institution applications by default, funding, the material library, contacts).
 * They use only the host's scoped operation port and shared controls; every read and
 * write is a declared operation through the Operation Core, exactly what an authorized
 * Agent calls.
 */
interface Summary {
  total: number; open: number; by_status: Record<string, number>; materials: { done: number; total: number }; funding: { total: number; open: number };
  upcoming: { application_id: string; track: string; institution: string; program: string; kind: string; label: string | null; due_on: string }[];
}
const TABS: Tab[] = ['programs', 'funding', 'library', 'contacts'];
type FundingFilter = 'all' | 'linked' | 'independent';

function Board({ ctx }: { ctx: Ctx }) {
  const { ui } = ctx, { Tabs, TabsList, TabsTrigger, TabsContent, t } = ui;
  const [tab, setTab] = useState<Tab>('programs');
  const [focus, setFocus] = useState<Focus | null>(null);
  // Opening a linked record shows it in its own tab: the funding page and an application's detail read the same record.
  const open: Open = useCallback((target, how) => { setFocus(f => ({ tab: target, ...how, seq: (f?.seq ?? 0) + 1 })); setTab(target); }, []);
  const mine = (target: Tab) => focus?.tab === target ? focus : null;
  return <div className="flex flex-col gap-4">
    <p className="max-w-2xl text-sm text-muted-foreground">{t(k('area_hint'))}</p>
    <Tabs value={tab} onValueChange={v => setTab(v as Tab)} className="flex flex-col gap-4">
      <TabsList aria-label={t(k('tabs_label'))} className="h-auto max-w-full flex-wrap justify-start self-start">
        {TABS.map(id => <TabsTrigger key={id} value={id} className={touch}>{t(k(`tab.${id}`))}</TabsTrigger>)}
      </TabsList>
      <TabsContent value="programs" className="mt-0"><RecordList ctx={ctx} track="phd" focus={mine('programs')} onOpen={open} /></TabsContent>
      <TabsContent value="funding" className="mt-0"><RecordList ctx={ctx} track="funding" focus={mine('funding')} onOpen={open} /></TabsContent>
      <TabsContent value="library" className="mt-0"><LibraryTab ctx={ctx} onOpen={open} /></TabsContent>
      <TabsContent value="contacts" className="mt-0"><ContactsTab key={mine('contacts')?.seq ?? 0} ctx={ctx} focus={mine('contacts')?.id ?? null} onOpen={open} /></TabsContent>
    </Tabs>
  </div>;
}

/**
 * Program applications grouped by institution (each program stays its own application),
 * or funding records filtered by whether they apply to a program application yet.
 */
function RecordList({ ctx, track, focus, onOpen }: { ctx: Ctx; track: 'phd' | 'funding'; focus: Focus | null; onOpen: Open }) {
  const { ui } = ctx, { Button, Badge, Card, CardContent, Select, t, formatDay } = ui;
  const { query } = useOperations(ctx);
  const funding = track === 'funding';
  const [items, setItems] = useState<Application[] | null>(null), [programs, setPrograms] = useState<Application[]>([]), [failed, setFailed] = useState(false);
  const [archived, setArchived] = useState(false), [creating, setCreating] = useState<{ appliesTo: string[] } | null>(null), [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<FundingFilter>('all');
  const load = useCallback(async () => {
    try {
      const [list, others] = await Promise.all([
        query<{ items: Application[] }>('application.list', { include_archived: true, track }),
        funding ? query<{ items: Application[] }>('application.list', { include_archived: true, track: 'phd' }) : Promise.resolve(null),
      ]);
      setItems(list.items); if (others) setPrograms(others.items); setFailed(false);
    } catch { setFailed(true); }
  }, [query, track, funding]);
  useEffect(() => { void load(); }, [load]);
  // A record opened from another tab: show it, archived included; or start a funding record for an application.
  useEffect(() => {
    if (!focus) return;
    if (focus.createFor) { setCreating({ appliesTo: [focus.createFor] }); setSelected(null); return; }
    if (focus.id) { setSelected(focus.id); setCreating(null); }
  }, [focus]);
  const focusedArchived = !!selected && items?.find(a => a.id === selected)?.archived === true;
  useEffect(() => { if (focusedArchived) setArchived(true); }, [focusedArchived]);
  const ready = items !== null;
  useEffect(() => { if (selected && ready) document.getElementById(`plugin-applications-record-${selected}`)?.scrollIntoView({ block: 'nearest' }); }, [selected, ready]);

  const byId = new Map(programs.map(p => [p.id, p]));
  const groupOf = (a: Application) => funding ? '' : a.institution.trim().toLowerCase();
  // The open record stays where it was opened until it is closed: an edit that moves it to another
  // institution or out of the funding filter must not unmount its detail and the save feedback in it.
  const [pinned, setPinned] = useState<{ id: string; group: string; label: string } | null>(null);
  const opened = selected ? items?.find(x => x.id === selected) : undefined;
  useEffect(() => {
    if (!selected) setPinned(null);
    else if (opened) setPinned(p => p?.id === selected ? p : { id: selected, group: funding ? '' : opened.institution.trim().toLowerCase(), label: opened.institution });
  }, [selected, opened, funding]);
  const matches = (a: Application) => (archived || !a.archived) && (!funding || filter === 'all' || (filter === 'linked') === a.applies_to.length > 0);
  const visible = (items ?? []).filter(a => a.id === selected || matches(a));
  // Institutions as groups, in the order of their most urgent application.
  const groups: { name: string; rows: Application[] }[] = [];
  for (const a of visible) {
    const key = pinned?.id === a.id ? pinned.group : groupOf(a);
    const group = groups.find(g => g.name === key);
    if (group) group.rows.push(a); else groups.push({ name: key, rows: [a] });
  }
  // A group is named after its other records; one holding only the open record keeps the name it was opened under.
  const groupLabel = (g: { rows: Application[] }) => g.rows.find(r => r.id !== pinned?.id)?.institution ?? (pinned?.id === g.rows[0]!.id ? pinned.label : g.rows[0]!.institution);
  const card = (a: Application) => <li key={a.id} id={`plugin-applications-record-${a.id}`}><Card className="mb-0 p-4"><CardContent className="space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h3 className="break-words text-sm font-semibold">{a.program}</h3>
        <p className="break-words text-xs text-muted-foreground">{funding ? [a.institution, a.intake].filter(Boolean).join(' · ') : [a.department, a.intake].filter(Boolean).join(' · ') || t(k('track_phd'))}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {a.archived && <Badge variant="outline">{t(k('archived'))}</Badge>}
        {a.submission && <Badge variant="secondary">{t(k(`submission.${a.submission}`))}</Badge>}
        <Badge variant={statusVariant(a.status)}>{t(k(`status.${a.status}`))}</Badge>
      </div>
    </div>
    <dl className="grid gap-2 text-sm sm:grid-cols-3">
      <div><dt className="text-xs text-muted-foreground">{t(k('next_deadline'))}</dt><dd>{a.next_deadline ? `${formatDay(a.next_deadline.due_on)} · ${a.next_deadline.label || t(k(`deadline_kind.${a.next_deadline.kind}`))}` : t(k('no_deadline'))}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t(k('materials'))}</dt><dd>{a.submission === 'automatic' ? t(k('no_checklist')) : t(k('materials_progress'), a.materials)}</dd></div>
      {funding ? <div><dt className="text-xs text-muted-foreground">{t(k('applies_to'))}</dt><dd className="break-words">{a.applies_to.length ? a.applies_to.map(id => byId.get(id)).filter(Boolean).map(p => recordName(p!)).join('; ') : t(k('independent'))}</dd></div>
        : <div><dt className="text-xs text-muted-foreground">{t(k('linked_funding'))}</dt><dd>{a.funding_ids.length}</dd></div>}
    </dl>
    <Button className={touch} size="sm" variant="outline" aria-expanded={selected === a.id} onClick={() => setSelected(s => s === a.id ? null : a.id)}>{selected === a.id ? t(k('close')) : t(k('open'))}</Button>
    {selected === a.id && <ApplicationDetail ctx={ctx} applicationId={a.id} onChanged={() => void load()} onOpen={onOpen} />}
  </CardContent></Card></li>;

  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-2xl text-sm text-muted-foreground">{t(k(funding ? 'funding_hint' : 'programs_hint'))}</p>
      <div className="flex flex-wrap items-center gap-2">
        {funding && <Select size="sm" ariaLabel={t(k('funding_filter_label'))} value={filter} onChange={v => setFilter(v as FundingFilter)} options={(['all', 'linked', 'independent'] as const).map(v => ({ value: v, label: t(k(`funding_filter.${v}`)) }))} />}
        {!creating && <Button className={touch} onClick={() => setCreating({ appliesTo: [] })}>{t(k(funding ? 'new_funding' : 'new'))}</Button>}
        <Button className={touch} variant="ghost" aria-pressed={archived} onClick={() => setArchived(v => !v)}>{archived ? t(k('hide_archived')) : t(k('show_archived'))}</Button>
      </div>
    </div>
    {creating && <NewApplication key={creating.appliesTo.join()} ctx={ctx} track={track} programs={programs} appliesTo={creating.appliesTo} onCancel={() => setCreating(null)} onCreated={id => { setCreating(null); setSelected(id); void load(); }} />}
    {failed ? <div className="space-y-2"><Notice text={t(k('load_failed'))} tone="alert" /><Button className={touch} variant="outline" size="sm" onClick={() => void load()}>{t(k('retry'))}</Button></div>
      : items === null ? <p role="status" className="text-sm text-muted-foreground">{t(k('loading'))}</p>
      : visible.length === 0 ? <Card className="mb-0"><CardContent className="space-y-1"><p className="text-sm font-medium">{t(k(funding ? 'funding_empty' : 'empty'))}</p><p className="text-sm text-muted-foreground">{t(k(funding ? 'funding_empty_hint' : 'empty_hint'))}</p></CardContent></Card>
      : funding ? <ul className="space-y-3">{visible.map(card)}</ul>
      : <div className="space-y-5">{groups.map(g => <section key={g.name} className="space-y-2" aria-label={groupLabel(g)}>
        <h3 className="flex flex-wrap items-baseline gap-2 text-sm font-semibold"><span className="break-words">{groupLabel(g)}</span><span className="text-xs font-normal text-muted-foreground">{t(k('group_count'), { count: g.rows.length })}</span></h3>
        <ul className="space-y-3">{g.rows.map(card)}</ul>
      </section>)}</div>}
  </div>;
}

function SummaryCard({ ctx }: { ctx: Ctx }) {
  const { ui } = ctx, { Card, CardHeader, CardTitle, CardContent, EntryLink, t, formatDay } = ui;
  const { query } = useOperations(ctx);
  const [summary, setSummary] = useState<Summary | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => { void query<Summary>('application.summary', {}).then(s => { setSummary(s); setFailed(false); }, () => setFailed(true)); }, [query]);
  const decided = summary ? CLOSED_STATUSES.reduce((n, s) => n + (summary.by_status[s] ?? 0), 0) : 0;
  return <Card className="mb-0"><CardHeader className="mb-2"><CardTitle>{t(k('summary_title'))}</CardTitle></CardHeader><CardContent className="space-y-3">
    {failed ? <Notice text={t(k('load_failed'))} tone="alert" /> : !summary ? <p role="status" className="text-sm text-muted-foreground">{t(k('loading'))}</p>
      : summary.total === 0 && summary.funding.total === 0 ? <p className="text-sm text-muted-foreground">{t(k('summary_empty'))}</p>
      : <>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">{t(k('summary_open'))}</dt><dd className="text-lg font-semibold">{summary.open}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t(k('summary_closed'))}</dt><dd className="text-lg font-semibold">{decided}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t(k('materials'))}</dt><dd className="text-lg font-semibold">{t(k('materials_ratio'), summary.materials)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t(k('summary_funding'))}</dt><dd className="text-lg font-semibold">{summary.funding.open}</dd></div>
        </dl>
        <div className="space-y-1"><h3 className="text-xs text-muted-foreground">{t(k('upcoming'))}</h3>
          {summary.upcoming.length ? <ul className="space-y-1 text-sm">{summary.upcoming.map((u, i) => <li key={`${u.application_id}:${i}`} className="break-words"><span className="font-medium">{formatDay(u.due_on)}</span> · {u.track === 'funding' ? u.program : u.institution} · {u.label || t(k(`deadline_kind.${u.kind}`))}</li>)}</ul>
            : <p className="text-sm text-muted-foreground">{t(k('no_upcoming'))}</p>}</div>
      </>}
    {!failed && summary && <EntryLink entry="board">{t(k('open_board'))}</EntryLink>}
  </CardContent></Card>;
}

export default { board: Board, summary: SummaryCard };
