import { describe, expect, it } from 'vitest';
import type { AmbientSessionCount } from '@rainver/protocol';
import { importAttention } from '../src/modules/importedSessions/attention.js';
import type { ImportedSessionRow } from '../src/modules/importedSessions/repository.js';

const now = Date.parse('2026-11-12T12:00:00Z');
const source = (id = 'one', time: string | null = '2026-11-12T11:00:00Z') => ({ session_id: id, updated_at: time });
const count = (sessions = [source()]): AmbientSessionCount => ({ location_id: 'location', runtime_key: 'codex_cli', installation: 'own',
  session_count: sessions.length, sessions, observed_at: new Date(now).toISOString(), error: null, oldest_updated_at: null, newest_updated_at: null });
const held = (overrides: Partial<ImportedSessionRow> = {}): ImportedSessionRow => ({ runtime_key: 'codex_cli', installation: 'own', vendor_session_id: 'one',
  vendor_updated_at: '2026-11-12T11:00:00Z', load_state: 'complete', source_state: 'present', ...overrides } as ImportedSessionRow);
const attention = (counts: AmbientSessionCount[], imports: ImportedSessionRow[] = [], excluded = new Set<string>(), online = true) => importAttention(counts, imports, excluded, online, now);

describe('bounded local history attention', () => {
  it('finds updates even when total count is unchanged; does not reoffer a newer import against stale metadata', () => {
    expect(attention([count()], [held()])).toMatchObject({ new_sessions: 0, updated_sessions: 0, incomplete_sessions: 0, uncertain: false });
    expect(attention([count([source('one', '2026-11-12T11:01:00Z')])], [held()]).updated_sessions).toBe(1);
    expect(attention([count()], [held({ vendor_updated_at: new Date(now) })]).updated_sessions).toBe(0);
  });
  it('keeps incomplete history pending, detects remaining/new history and makes deleted imports available again', () => {
    expect(attention([count([source(), source('two')])], [held({ load_state: 'partial' })])).toMatchObject({ new_sessions: 1, incomplete_sessions: 1, updated_sessions: 0 });
    expect(attention([count()]).new_sessions).toBe(1);
    expect(attention([count()], [held({ source_state: 'gone', load_state: 'partial' })]).incomplete_sessions).toBe(0);
  });
  it('never treats missing inventory, stale/disconnected/error discovery or missing timestamps as imported', () => {
    for (const observation of [{ ...count(), sessions: undefined }, { ...count(), observed_at: new Date(now - 31 * 60_000).toISOString() }, { ...count(), error: 'busy' }]) {
      expect(attention([observation])).toMatchObject({ uncertain: true, new_sessions: 0 });
    }
    expect(attention([count()], [], new Set(), false).uncertain).toBe(true);
    expect(attention([count([source('one', null)])], [held()]).uncertain).toBe(true);
  });
  it('excludes Rainver-owned sessions and does not duplicate inventory ids', () => {
    expect(attention([count([source(), source()])]).new_sessions).toBe(1);
    expect(attention([count()], [], new Set([JSON.stringify(['codex_cli', 'own', 'one'])])).new_sessions).toBe(0);
  });
});
