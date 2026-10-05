import type { DiaryApi, DiaryEntry } from './host'

const writes = new WeakMap<DiaryApi, Map<string, Promise<unknown>>>()

/** All editors of a day share a queue, including saves sent during unmount. */
export function saveDiaryEntry(
  api: DiaryApi, date: string, content: string, scope = api.saveContextKey?.() ?? '',
): Promise<{ entry: DiaryEntry }> {
  const key = `${scope}:${date}`
  let pending = writes.get(api)
  if (!pending) writes.set(api, pending = new Map())
  const queue = pending
  const previous = queue.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(() => {
    if ((api.saveContextKey?.() ?? '') !== scope) throw new Error('Diary save context changed')
    return api.saveEntry(date, content)
  })
  queue.set(key, result)
  const clear = () => { if (queue.get(key) === result) queue.delete(key) }
  void result.then(clear, clear)
  return result
}
