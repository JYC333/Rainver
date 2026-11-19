import type { MaterialRow } from './materialNotes';

/** Records as the package's operations return them (see operationManifest.ts outputs). */
export interface Application {
  id: string; track: string; institution: string; program: string; department: string | null; intake: string | null; submission: string | null; status: string; result_note: string | null;
  source: { label: string | null; url: string | null } | null; archived: boolean; revision: number; updated_at: string;
  next_deadline: { kind: string; label: string | null; due_on: string } | null; deadlines: number; materials: { done: number; total: number };
  funding_ids: string[]; applies_to: string[];
}
export interface Detail {
  application: Application & { notes: string | null; created_at: string };
  deadlines: { id: string; kind: string; label: string | null; due_on: string; task_id: string | null }[];
  materials: MaterialRow[];
  funding: Application[];
  applies_to: Application[];
}
export interface Contact {
  id: string; application_ids: string[]; name: string; role: string; email: string | null; affiliation: string | null; note: string | null; events: number;
  last_event: { occurred_on: string; channel: string; direction: string; response: string; next_step: string | null } | null;
}
export interface ContactEvent { id: string; occurred_on: string; channel: string; direction: string; summary: string; response: string; next_step: string | null }
export interface LibraryItem {
  id: string; kind: string; label: string | null; created_at: string;
  note: { note_id: string; title: string | null; current_version: number | null; available: boolean };
  uses: { material_id: string; application_id: string; track: string; institution: string; program: string; archived: boolean; material_kind: string; material_label: string | null; relation: 'source' | 'linked'; note_version: number | null; updated: boolean }[];
}

/** The module's tabs; `programs` (institution applications) is the default. */
export type Tab = 'programs' | 'funding' | 'library' | 'contacts';
/** Opens a record in its tab: an application or funding record, a contact, or a new funding form pre-linked to an application. */
export type Focus = { tab: Tab; id?: string; createFor?: string; seq: number };
export type Open = (tab: Tab, target: { id?: string; createFor?: string }) => void;
export const tabOf = (track: string): Tab => track === 'funding' ? 'funding' : 'programs';

export function statusVariant(status: string): 'default' | 'success' | 'warning' | 'destructive' | 'muted' {
  if (status === 'offer' || status === 'accepted') return 'success';
  if (status === 'waitlisted' || status === 'interview') return 'warning';
  if (status === 'rejected' || status === 'declined') return 'destructive';
  if (status === 'planning' || status === 'preparing' || status === 'withdrawn') return 'muted';
  return 'default';
}
/** How a record is named in lists and links: a program at its institution, a funding record by its name and funder. */
export const recordName = (a: Pick<Application, 'track' | 'institution' | 'program'>) => a.track === 'funding' ? `${a.program} · ${a.institution}` : `${a.institution} · ${a.program}`;
