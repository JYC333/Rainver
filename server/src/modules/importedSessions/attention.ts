import type { AmbientImportAttention, AmbientSessionCount } from '@rainver/protocol';
import type { ImportedSessionRow } from './repository.js';

const key = (runtime: string, installation: string, session: string) => JSON.stringify([runtime, installation, session]);
const instant = (value: string | Date | null) => value === null ? NaN : new Date(value).getTime();

/** Discovery is evidence about the bounded ACP window, never about all local history. */
export function importAttention(
  counts: readonly AmbientSessionCount[],
  imported: readonly ImportedSessionRow[],
  excluded: ReadonlySet<string> = new Set(),
  online = true,
  now = Date.now(),
): AmbientImportAttention {
  const result: AmbientImportAttention = { new_sessions: 0, updated_sessions: 0, incomplete_sessions: 0, uncertain: !online || counts.length === 0 };
  const held = new Map(imported.map(session => [key(session.runtime_key, session.installation, session.vendor_session_id), session]));
  const pending = new Set<string>();
  for (const [id, session] of held) {
    if (session.load_state === 'partial' && session.source_state === 'present' && !excluded.has(id)) pending.add(id);
  }
  for (const count of counts) {
    if (count.error === 'unsupported') continue;
    const age = now - instant(count.observed_at ?? null);
    if (!online || count.error || !count.sessions || !Number.isFinite(age) || age < -60_000 || age > 30 * 60_000) {
      result.uncertain = true;
      continue;
    }
    const seen = new Set<string>();
    for (const source of count.sessions) {
      const id = key(count.runtime_key, count.installation, source.session_id);
      if (excluded.has(id) || seen.has(id)) continue;
      seen.add(id);
      if (pending.has(id)) continue;
      const session = held.get(id);
      if (!session) result.new_sessions++;
      else {
        const sourceAt = instant(source.updated_at), importedAt = instant(session.vendor_updated_at);
        if (!Number.isFinite(sourceAt) || !Number.isFinite(importedAt)) result.uncertain = true;
        // An older discovery cache must not reoffer a session just imported.
        else if (sourceAt > importedAt) result.updated_sessions++;
      }
    }
  }
  result.incomplete_sessions = pending.size;
  return result;
}
