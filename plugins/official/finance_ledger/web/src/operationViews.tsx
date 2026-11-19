import { useLayoutEffect, useRef, useState } from 'react'
import type { PluginViewContext } from '@rainver/protocol'
import { createFinancePage } from './FinancePage'
import { financeOpsApi } from './opsApi'

/**
 * Bundled view of the Finance ledger package: the global `ledger` entry. The
 * page is the existing ledger page; its reads and writes go through the
 * host's scoped operation port only.
 */
function Ledger({ ctx }: { ctx: PluginViewContext<unknown> }) {
  const ops = useRef(ctx.ops)
  useLayoutEffect(() => {
    ops.current = ctx.ops
  }, [ctx.ops])

  // The slot owns the scope lifetime. Refresh the port without resetting the page or its effects.
  const [Page] = useState(() => createFinancePage({
    api: financeOpsApi({
      query: (...args) => ops.current.query(...args),
      command: (...args) => ops.current.command(...args),
    }),
  }))
  return <Page />
}

export default { ledger: Ledger }
