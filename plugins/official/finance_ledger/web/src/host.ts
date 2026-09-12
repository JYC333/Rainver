import type { CSSProperties, ElementType, ReactNode } from 'react'

export interface FinanceBook {
  id: string
  space_id: string
  name: string
  base_currency: string
  operating_currency: string
  status: string
  created_at: string
  updated_at: string
}

export interface FinanceAccount {
  id: string
  name: string
  /** Human-facing label (any language); `name` is the Beancount identifier. */
  display_name: string | null
  root_type: string
  parent_account_id: string | null
  commodity_constraints: string[] | null
  opened_at: string
  closed_at: string | null
  booking_method: string | null
  /** Preselected posting commodity; null falls back to the book operating currency. */
  default_commodity: string | null
  /** Null = jointly owned by the space. */
  owner_user_id: string | null
  /** 'private' personal accounts are hidden from other space members. */
  visibility: 'space' | 'private'
}

export type FinanceBalanceScope = 'all' | 'shared' | 'personal'

export interface CreateFinanceAccountInput {
  root_type: string
  group: string
  leaf: string
  display_name?: string
  opened_at: string
  currencies?: string[]
  default_currency?: string
  owner?: 'shared' | 'personal'
  visible_to_space?: boolean
}

export interface FinanceCommodity {
  id: string
  symbol: string
  commodity_type: string
  name: string | null
}

export interface FinanceDirective {
  id: string
  directive_type: string
  date: string
  sequence: number
  status: string
}

export interface FinanceTransaction {
  directive_id: string
  flag: string
  payee: string | null
  narration: string | null
  tags: string[]
  links: string[]
  directive: FinanceDirective
}

export interface FinancePosting {
  id: string
  transaction_directive_id: string
  account_id: string
  account_name: string
  amount_text: string | null
  commodity_symbol: string | null
  price_number_text: string | null
  price_commodity_symbol: string | null
  price_is_total: boolean
  flag: string | null
  sort_order: number
}

export interface FinanceBalancePosition {
  accountId: string
  accountName: string
  positions: string[]
}

export interface FinanceValidationError {
  code: string
  message: string
  directiveId?: string
}

export interface FinanceLedgerError {
  code: string
  message: string
  source?: { filename: string; lineno: number }
}

export interface FinanceTransactionInput {
  date: string
  payee?: string | null
  narration?: string | null
  post?: boolean
  postings: Array<{
    account_id: string
    amount?: { number: string; commodity: string } | null
  }>
}

export interface FinanceImportResult {
  import_source_id: string | null
  deduplicated: boolean
  created_directives: number
  errors: FinanceLedgerError[]
}

export interface FinanceExportResult {
  export_id: string
  content: string
  content_hash: string
  errors: FinanceLedgerError[]
}

export interface FinanceApi {
  listBooks(): Promise<{ books: FinanceBook[] }>
  createBook(input: { name: string; base_currency: string; operating_currency?: string }): Promise<{ book: FinanceBook }>
  listAccounts(bookId: string): Promise<{ accounts: FinanceAccount[] }>
  createAccount(bookId: string, input: CreateFinanceAccountInput): Promise<{ account: FinanceAccount }>
  closeAccount(bookId: string, accountId: string, date: string): Promise<{ account: FinanceAccount }>
  setAccountVisibility(bookId: string, accountId: string, visibility: 'space' | 'private'): Promise<{ account: FinanceAccount }>
  listCommodities(bookId: string): Promise<{ commodities: FinanceCommodity[] }>
  createCommodity(bookId: string, input: { symbol: string; commodity_type?: string }): Promise<{ commodity: FinanceCommodity }>
  listTransactions(bookId: string): Promise<{ transactions: FinanceTransaction[] }>
  createTransaction(bookId: string, input: FinanceTransactionInput): Promise<{ directive: FinanceDirective }>
  getAccountLedger(bookId: string, accountId: string): Promise<{ postings: FinancePosting[] }>
  getBalances(bookId: string, scope?: FinanceBalanceScope): Promise<{ balances: FinanceBalancePosition[] }>
  validateBook(bookId: string): Promise<{ errors: FinanceValidationError[] }>
  importBeancount(bookId: string, input: { text: string; post_directly?: boolean }): Promise<FinanceImportResult>
  exportBeancount(bookId: string): Promise<FinanceExportResult>
}

export interface FinancePluginState {
  loading: boolean
  enabled: boolean
}

export interface FinanceHostLinkProps {
  to: string
  style?: CSSProperties
  children?: ReactNode
}

export interface FinanceWebHost {
  api: FinanceApi
  Link: ElementType<FinanceHostLinkProps>
  usePluginState(pluginId: string): FinancePluginState
}
