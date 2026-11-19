import { k, type Ctx } from './viewKit';
import { recordName, type Application } from './records';

/**
 * Chooses any number of applications to link. An archived one appears only while it is
 * already chosen and can then only be cleared: links never newly point at archived work.
 */
export function LinkPicker({ ctx, label, hint, options, value, onChange, emptyText }: {
  ctx: Ctx; label: string; hint?: string; options: Application[]; value: string[]; onChange: (ids: string[]) => void; emptyText: string;
}) {
  const { t } = ctx.ui;
  const shown = options.filter(a => !a.archived || value.includes(a.id));
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter(v => v !== id));
  return <fieldset className="space-y-1.5 text-sm">
    <legend className="font-medium">{label}</legend>
    {shown.length ? <ul className="space-y-1">{shown.map(a => <li key={a.id}>
      <label className="flex min-w-0 items-center gap-2 max-md:min-h-[44px]">
        <input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" checked={value.includes(a.id)} disabled={a.archived && !value.includes(a.id)} onChange={e => toggle(a.id, e.target.checked)} />
        <span className="min-w-0 break-words">{a.archived ? t(k('archived_suffix'), { name: recordName(a) }) : recordName(a)}</span>
      </label>
    </li>)}</ul> : <p className="text-xs text-muted-foreground">{emptyText}</p>}
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </fieldset>;
}
