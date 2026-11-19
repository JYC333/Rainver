import { useLayoutEffect, useRef, useState } from 'react'
import type { PluginViewContext } from '@rainver/protocol'
import { createDiaryPage } from './DiaryPage'
import { diaryOpsApi } from './opsApi'

/**
 * Bundled view of the Diary package: the global `journal` entry. The page is
 * the existing Diary editor; its reads and writes go through the host's
 * scoped operation port only. The host's i18n sets the document language,
 * which the page's own messages follow.
 */
const useLocale = () => (typeof document !== 'undefined' && document.documentElement.lang) || 'en'

function Journal({ ctx }: { ctx: PluginViewContext<unknown> }) {
  const ops = useRef(ctx.ops)
  useLayoutEffect(() => {
    ops.current = ctx.ops
  }, [ctx.ops])

  // The slot owns the scope lifetime. Refresh the port without resetting the page or its effects.
  const [Page] = useState(() => createDiaryPage({
    api: diaryOpsApi({
      query: (...args) => ops.current.query(...args),
      command: (...args) => ops.current.command(...args),
    }), useLocale,
  }))
  return <Page />
}

export default { journal: Journal }
