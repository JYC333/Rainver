import type { OperationOutcome, PluginOperationId, PluginViewOps } from '@rainver/protocol'
import type { FinanceApi } from './host'

const id = (name: string) => `plugin.finance_ledger.${name}` as PluginOperationId

/** A refused or failed operation, with its safe reason code only (never ledger text). */
export class FinanceOperationError extends Error {
  constructor(readonly code: string, readonly reason: string | null) {
    super(reason ?? code)
  }
}

function unwrap<T>(outcome: OperationOutcome<T>): T {
  if ('error' in outcome) {
    const reason = outcome.error.metadata?.reason
    throw new FinanceOperationError(outcome.error.code, typeof reason === 'string' ? reason : null)
  }
  if (outcome.status === 'pending_approval') throw new FinanceOperationError('pending_approval', null)
  return outcome.data
}

/**
 * The Finance page's API over the host's scoped operation port: every read and
 * write is a declared Finance operation through the Operation Core. Writes
 * carry a fresh command key each and are never retried automatically.
 */
export function financeOpsApi(ops: PluginViewOps, newKey: () => string = () => crypto.randomUUID()): FinanceApi {
  const read = async <T,>(name: string, input: Record<string, unknown>) => unwrap(await ops.query<T>(id(name), input))
  const write = async <T,>(name: string, input: Record<string, unknown>) => unwrap(await ops.command<T>(id(name), input, newKey()))
  return {
    listBooks: () => read('book.list', {}),
    createBook: (input) => write('book.create', { ...input }),
    listAccounts: (book_id) => read('account.list', { book_id }),
    createAccount: (book_id, input) => write('account.open', { book_id, ...input }),
    closeAccount: (book_id, account_id, date) => write('account.close', { book_id, account_id, date }),
    setAccountVisibility: (book_id, account_id, visibility) => write('account.set_visibility', { book_id, account_id, visibility }),
    listCommodities: (book_id) => read('commodity.list', { book_id }),
    createCommodity: (book_id, input) => write('commodity.create', { book_id, ...input }),
    listTransactions: (book_id) => read('transaction.list', { book_id }),
    createTransaction: (book_id, input) => write('transaction.create', { book_id, ...input }),
    getAccountLedger: (book_id, account_id) => read('account.ledger', { book_id, account_id }),
    getBalances: (book_id, scope) => read('book.balances', { book_id, ...(scope ? { scope } : {}) }),
    validateBook: (book_id) => read('book.validate', { book_id }),
    importBeancount: (book_id, input) => write('import.beancount', { book_id, ...input }),
    listImports: (book_id) => read('import.list', { book_id }),
    getImport: (book_id, import_source_id) => read('import.get', { book_id, import_source_id }),
    retryImport: (book_id, import_source_id) => write('import.retry', { book_id, import_source_id }),
    mapImportEntry: (book_id, import_source_id, entry_id, account_mapping) => write('import.map_entry', { book_id, import_source_id, entry_id, account_mapping }),
    reviewImportEntries: (book_id, import_source_id, decision, entryIds) => write('import.review', { book_id, import_source_id, decision, ...(entryIds ? { entry_ids: entryIds } : {}) }),
    exportBeancount: (book_id) => write('export.beancount', { book_id }),
  }
}
