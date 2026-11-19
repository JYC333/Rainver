import type { OperationOutcome, PluginOperationId, PluginViewOps } from '@rainver/protocol'
import type { DiaryApi } from './host'

const id = (name: string) => `plugin.diary.${name}` as PluginOperationId

/** A refused or failed operation, with its safe error code only (never record text). */
export class DiaryOperationError extends Error {
  constructor(readonly code: string, readonly reason: string | null) {
    super(reason ?? code)
  }
}

function unwrap<T>(outcome: OperationOutcome<T>): T {
  if ('error' in outcome) {
    const reason = outcome.error.metadata?.reason
    throw new DiaryOperationError(outcome.error.code, typeof reason === 'string' ? reason : null)
  }
  if (outcome.status === 'pending_approval') throw new DiaryOperationError('pending_approval', null)
  return outcome.data
}

/**
 * The Diary page's API over the host's scoped operation port: every read and
 * write is a declared Diary operation through the Operation Core. Writes carry
 * a fresh command key each and are never retried automatically.
 */
export function diaryOpsApi(ops: PluginViewOps, newKey: () => string = () => crypto.randomUUID()): DiaryApi {
  const read = async <T,>(name: string, input: Record<string, unknown>) => unwrap(await ops.query<T>(id(name), input))
  const write = async <T,>(name: string, input: Record<string, unknown>) => unwrap(await ops.command<T>(id(name), input, newKey()))
  return {
    listEntries: ({ limit, before } = {}) => read('entry.list', { ...(limit ? { limit } : {}), ...(before ? { before } : {}) }),
    saveEntry: (date, content) => write('entry.save', { date, content }),
    deleteEntry: (date) => write('entry.delete', { date }),
    onThisDay: async (date) => {
      // The selected day's own entry and the same day of earlier years, as the page shows them.
      const [own, earlier] = await Promise.all([
        read<{ entry: Awaited<ReturnType<DiaryApi['onThisDay']>>['entries'][number] | null }>('entry.get', { date }),
        read<Awaited<ReturnType<DiaryApi['onThisDay']>>>('entry.on_this_day', { date }),
      ])
      return { date, entries: own.entry ? [own.entry, ...earlier.entries] : earlier.entries }
    },
    reflections: (date) => read('reflection.list', { date }),
  }
}
