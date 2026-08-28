import { useState, useEffect, useCallback, type ComponentType, type CSSProperties } from 'react'
import type {
  CreateFinanceAccountInput,
  FinanceAccount,
  FinanceApi,
  FinanceBalancePosition,
  FinanceBalanceScope,
  FinanceBook,
  FinanceCommodity,
  FinanceImportResult,
  FinanceLedgerError,
  FinancePosting,
  FinanceTransaction,
  FinanceValidationError,
  FinanceWebHost,
} from './host'

export type {
  FinanceApi,
  FinanceBook,
  FinanceWebHost,
} from './host'

const PLUGIN_ID = 'finance_ledger'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DECIMAL_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/

/** Default/reporting currency choices for a new book (Beancount operating_currency). */
const COMMON_CURRENCIES = ['USD', 'CNY', 'EUR', 'JPY', 'GBP', 'HKD', 'KRW', 'SGD', 'CAD', 'AUD', 'CHF']

/** The five Beancount account roots. */
const ACCOUNT_ROOTS = ['Assets', 'Liabilities', 'Equity', 'Income', 'Expenses'] as const

const COMMODITY_TYPES = ['currency', 'security', 'crypto', 'custom'] as const

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

// ── Shared styles (quiet operational UI) ─────────────────────────────────────

const panelStyle: CSSProperties = {
  border: '1px solid #e5e5e5', borderRadius: 8, padding: '14px 16px', background: '#fff',
}
const panelTitleStyle: CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase',
  letterSpacing: '0.05em', margin: '0 0 10px',
}
const tableStyle: CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontSize: 13,
}
const thStyle: CSSProperties = {
  textAlign: 'left', padding: '4px 8px', color: '#999', fontWeight: 500,
  borderBottom: '1px solid #eee', fontSize: 12, whiteSpace: 'nowrap',
}
const tdStyle: CSSProperties = {
  padding: '5px 8px', borderBottom: '1px solid #f4f4f4', verticalAlign: 'top',
}
const monoStyle: CSSProperties = { fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }
const inputStyle: CSSProperties = {
  padding: '5px 8px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13,
  fontFamily: 'inherit', boxSizing: 'border-box',
}
const buttonStyle: CSSProperties = {
  padding: '5px 12px', borderRadius: 6, border: '1px solid #ddd', background: '#fff',
  cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
}
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle, background: '#1976d2', borderColor: '#1976d2', color: '#fff', fontWeight: 500,
}
const errorTextStyle: CSSProperties = { color: '#b71c1c', fontSize: 13 }

function statusBadge(status: string): CSSProperties {
  const colors: Record<string, [string, string]> = {
    posted: ['#e8f5e9', '#2e7d32'],
    proposed: ['#fff8e1', '#b28704'],
    draft: ['#f5f5f5', '#777'],
    voided: ['#fbe9e7', '#b71c1c'],
  }
  const [bg, fg] = colors[status] ?? ['#f5f5f5', '#777']
  return {
    background: bg, color: fg, borderRadius: 10, padding: '1px 8px',
    fontSize: 11, fontWeight: 600, display: 'inline-block',
  }
}

// ── Book toolbar ─────────────────────────────────────────────────────────────

function BookToolbar({
  books, activeBookId, onSelect, onCreate,
}: {
  books: FinanceBook[]
  activeBookId: string | null
  onSelect: (bookId: string) => void
  onCreate: (name: string, currency: string) => Promise<void>
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!name.trim()) {
      setError('Book name is required')
      return
    }
    setError(null)
    try {
      await onCreate(name.trim(), currency)
      setCreating(false)
      setName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create book')
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Finance Ledger</h1>
      {books.length > 0 && (
        <select
          aria-label="Select book"
          value={activeBookId ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          style={{ ...inputStyle, minWidth: 160 }}
        >
          {books.map((book) => (
            <option key={book.id} value={book.id}>{book.name} ({book.operating_currency})</option>
          ))}
        </select>
      )}
      {!creating && (
        <button style={buttonStyle} onClick={() => setCreating(true)}>+ New book</button>
      )}
      {creating && (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            aria-label="Book name"
            placeholder="Book name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ ...inputStyle, width: 150 }}
          />
          <select
            aria-label="Default currency"
            title="Default reporting currency — any commodity can still be booked"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            style={{ ...inputStyle, width: 78 }}
          >
            {COMMON_CURRENCIES.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
          <button style={primaryButtonStyle} onClick={() => void submit()}>Create</button>
          <button style={buttonStyle} onClick={() => { setCreating(false); setError(null) }}>Cancel</button>
          {error && <span style={errorTextStyle}>{error}</span>}
        </span>
      )}
    </div>
  )
}

// ── Accounts panel ───────────────────────────────────────────────────────────

const ACCOUNT_SEGMENT_RE = /^[A-Z0-9][A-Za-z0-9-]*$/

function AccountsPanel({
  accounts, commodities, bookCurrency, selectedAccountId, onSelect, onCreate,
}: {
  accounts: FinanceAccount[]
  commodities: FinanceCommodity[]
  bookCurrency: string
  selectedAccountId: string | null
  onSelect: (accountId: string | null) => void
  onCreate: (input: CreateFinanceAccountInput) => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [rootType, setRootType] = useState<string>(ACCOUNT_ROOTS[0])
  const [group, setGroup] = useState('')
  const [leaf, setLeaf] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [openedAt, setOpenedAt] = useState(todayDate())
  const [defaultCurrency, setDefaultCurrency] = useState(bookCurrency)
  const [owner, setOwner] = useState<'shared' | 'personal'>('shared')
  const [visibleToSpace, setVisibleToSpace] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const currencyOptions = [...new Set([bookCurrency, ...commodities.map((commodity) => commodity.symbol)])]

  const submit = async () => {
    if (!ACCOUNT_SEGMENT_RE.test(group.trim()) || !ACCOUNT_SEGMENT_RE.test(leaf.trim())) {
      setError('Group and name must start with a capital letter or digit (e.g. Bank / ICBC)')
      return
    }
    if (!DATE_RE.test(openedAt)) {
      setError('Open date must be YYYY-MM-DD')
      return
    }
    setError(null)
    try {
      await onCreate({
        root_type: rootType,
        group: group.trim(),
        leaf: leaf.trim(),
        display_name: displayName.trim() || undefined,
        opened_at: openedAt,
        default_currency: defaultCurrency,
        owner,
        visible_to_space: owner === 'personal' ? visibleToSpace : true,
      })
      setAdding(false)
      setGroup('')
      setLeaf('')
      setDisplayName('')
      setOwner('shared')
      setVisibleToSpace(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open account')
    }
  }

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h3 style={{ ...panelTitleStyle, flex: 1 }}>Accounts</h3>
        <button style={{ ...buttonStyle, padding: '2px 8px', fontSize: 12 }} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : '+ Open'}
        </button>
      </div>
      {adding && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          <select
            aria-label="Account type"
            value={rootType}
            onChange={(e) => setRootType(e.target.value)}
            style={inputStyle}
          >
            {ACCOUNT_ROOTS.map((root) => (
              <option key={root} value={root}>{root}</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              aria-label="Account group"
              placeholder="Bank"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              style={{ ...inputStyle, width: '50%' }}
            />
            <input
              aria-label="Account name"
              placeholder="ICBC"
              value={leaf}
              onChange={(e) => setLeaf(e.target.value)}
              style={{ ...inputStyle, width: '50%' }}
            />
          </div>
          <input
            aria-label="Display name"
            placeholder="Display name, e.g. 招商银行 (optional)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            style={inputStyle}
          />
          <input
            aria-label="Opened at"
            value={openedAt}
            onChange={(e) => setOpenedAt(e.target.value)}
            style={inputStyle}
          />
          <select
            aria-label="Account default currency"
            title="Preselected when posting to this account — other commodities can still be booked"
            value={defaultCurrency}
            onChange={(e) => setDefaultCurrency(e.target.value)}
            style={inputStyle}
          >
            {currencyOptions.map((symbol) => (
              <option key={symbol} value={symbol}>{symbol}</option>
            ))}
          </select>
          <select
            aria-label="Account owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value as 'shared' | 'personal')}
            style={inputStyle}
          >
            <option value="shared">Shared (whole space)</option>
            <option value="personal">Personal (mine)</option>
          </select>
          {owner === 'personal' && (
            <label style={{ fontSize: 12, color: '#555', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={visibleToSpace}
                onChange={(e) => setVisibleToSpace(e.target.checked)}
              />
              Visible to other space members
            </label>
          )}
          <button style={primaryButtonStyle} onClick={() => void submit()}>Open account</button>
          {error && <span style={errorTextStyle}>{error}</span>}
        </div>
      )}
      {accounts.length === 0 && <div style={{ fontSize: 13, color: '#bbb' }}>No accounts yet</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {accounts.map((account) => {
          const depth = account.name.split(':').length - 1
          const selected = account.id === selectedAccountId
          return (
            <button
              key={account.id}
              onClick={() => onSelect(selected ? null : account.id)}
              title={account.closed_at ? `Closed ${account.closed_at}` : `Opened ${account.opened_at}`}
              style={{
                textAlign: 'left', border: 'none', cursor: 'pointer', fontSize: 13,
                padding: '3px 6px', paddingLeft: 6 + depth * 12, borderRadius: 5,
                background: selected ? '#e8f0fe' : 'transparent',
                color: account.closed_at ? '#bbb' : selected ? '#1565c0' : '#444',
                textDecoration: account.closed_at ? 'line-through' : 'none',
              }}
            >
              {account.display_name ?? account.name.split(':').pop()}
              <span style={{ color: '#ccc', marginLeft: 6, fontSize: 11 }}>
                {account.display_name ? account.name : account.name.split(':')[0]}
              </span>
              {account.owner_user_id && (
                <span
                  title={account.visibility === 'private' ? 'Personal account, hidden from other members' : 'Personal account'}
                  style={{ marginLeft: 6, fontSize: 10, background: '#f0f4ff', color: '#4a68a8', borderRadius: 8, padding: '0 6px', fontWeight: 600 }}
                >
                  {account.visibility === 'private' ? 'personal 🔒' : 'personal'}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Commodities panel ────────────────────────────────────────────────────────

function CommoditiesPanel({
  commodities, onCreate,
}: {
  commodities: FinanceCommodity[]
  onCreate: (symbol: string, commodityType: string) => Promise<void>
}) {
  const [symbol, setSymbol] = useState('')
  const [commodityType, setCommodityType] = useState<string>(COMMODITY_TYPES[0])
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const cleaned = symbol.trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9_-]*$/.test(cleaned)) {
      setError('Symbol must look like USD or GOOG')
      return
    }
    setError(null)
    try {
      await onCreate(cleaned, commodityType)
      setSymbol('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add commodity')
    }
  }

  return (
    <div style={panelStyle}>
      <h3 style={panelTitleStyle}>Commodities</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {commodities.length === 0 && <span style={{ fontSize: 13, color: '#bbb' }}>None yet</span>}
        {commodities.map((commodity) => (
          <span key={commodity.id} style={{ ...monoStyle, fontSize: 12, background: '#f4f4f4', borderRadius: 5, padding: '2px 8px' }}>
            {commodity.symbol}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          aria-label="Commodity symbol"
          placeholder="USD"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          style={{ ...inputStyle, width: 76 }}
        />
        <select
          aria-label="Commodity type"
          value={commodityType}
          onChange={(e) => setCommodityType(e.target.value)}
          style={inputStyle}
        >
          {COMMODITY_TYPES.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
        <button style={buttonStyle} onClick={() => void submit()}>Add</button>
      </div>
      {error && <div style={{ ...errorTextStyle, marginTop: 6 }}>{error}</div>}
    </div>
  )
}

// ── Transaction editor ───────────────────────────────────────────────────────

interface PostingRow {
  accountId: string
  amount: string
  commodity: string
}

const emptyPosting = (): PostingRow => ({ accountId: '', amount: '', commodity: '' })

export function validateTransactionForm(
  date: string,
  postings: PostingRow[],
): string | null {
  if (!DATE_RE.test(date)) return 'Date must be YYYY-MM-DD'
  const filled = postings.filter((posting) => posting.accountId !== '')
  if (filled.length < 2) return 'A transaction needs at least two postings'
  let blankAmounts = 0
  for (const posting of filled) {
    if (posting.amount.trim() === '') {
      blankAmounts += 1
      continue
    }
    if (!DECIMAL_RE.test(posting.amount.trim())) return `Invalid amount: ${posting.amount}`
    if (!/^[A-Z][A-Z0-9_-]*$/.test(posting.commodity.trim().toUpperCase())) {
      return 'Each amount needs a commodity like USD'
    }
  }
  if (blankAmounts > 1) return 'At most one posting may omit its amount (it will be interpolated)'
  return null
}

function TransactionEditor({
  accounts, commodities, defaultCurrency, onSubmit, onCancel,
}: {
  accounts: FinanceAccount[]
  commodities: FinanceCommodity[]
  defaultCurrency: string
  onSubmit: (input: {
    date: string
    payee: string | null
    narration: string | null
    postings: Array<{ account_id: string; amount: { number: string; commodity: string } | null }>
  }) => Promise<void>
  onCancel: () => void
}) {
  const [date, setDate] = useState(todayDate())
  const [payee, setPayee] = useState('')
  const [narration, setNarration] = useState('')
  const [postings, setPostings] = useState<PostingRow[]>([
    { ...emptyPosting(), commodity: defaultCurrency },
    { ...emptyPosting(), commodity: defaultCurrency },
  ])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const updatePosting = (index: number, patch: Partial<PostingRow>) => {
    setPostings((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const submit = async () => {
    const validationError = validateTransactionForm(date, postings)
    if (validationError) {
      setError(validationError)
      return
    }
    setError(null)
    setSaving(true)
    try {
      await onSubmit({
        date,
        payee: payee.trim() || null,
        narration: narration.trim() || null,
        postings: postings
          .filter((posting) => posting.accountId !== '')
          .map((posting) => ({
            account_id: posting.accountId,
            amount: posting.amount.trim() === ''
              ? null
              : { number: posting.amount.trim(), commodity: posting.commodity.trim().toUpperCase() },
          })),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save transaction')
    } finally {
      setSaving(false)
    }
  }

  const openAccounts = accounts.filter((account) => !account.closed_at)
  const commodityOptions = [...new Set([
    defaultCurrency,
    ...commodities.map((commodity) => commodity.symbol),
    ...accounts.map((account) => account.default_commodity).filter((symbol): symbol is string => symbol !== null),
  ])]

  return (
    <div style={{ ...panelStyle, background: '#fafcff', borderColor: '#cfe0f5' }}>
      <h3 style={panelTitleStyle}>New transaction</h3>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <input aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, width: 110 }} />
        <input aria-label="Payee" placeholder="Payee" value={payee} onChange={(e) => setPayee(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        <input aria-label="Narration" placeholder="Narration" value={narration} onChange={(e) => setNarration(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 180 }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {postings.map((posting, index) => (
          <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              aria-label={`Posting ${index + 1} account`}
              value={posting.accountId}
              onChange={(e) => {
                const account = accounts.find((candidate) => candidate.id === e.target.value)
                updatePosting(index, {
                  accountId: e.target.value,
                  commodity: account?.default_commodity ?? posting.commodity,
                })
              }}
              style={{ ...inputStyle, flex: 1, minWidth: 180 }}
            >
              <option value="">— account —</option>
              {openAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.display_name ? `${account.display_name} (${account.name})` : account.name}
                </option>
              ))}
            </select>
            <input
              aria-label={`Posting ${index + 1} amount`}
              placeholder="amount (blank = auto)"
              value={posting.amount}
              onChange={(e) => updatePosting(index, { amount: e.target.value })}
              style={{ ...inputStyle, ...monoStyle, width: 140, textAlign: 'right' }}
            />
            <select
              aria-label={`Posting ${index + 1} commodity`}
              value={posting.commodity}
              onChange={(e) => updatePosting(index, { commodity: e.target.value })}
              style={{ ...inputStyle, ...monoStyle, width: 84 }}
            >
              {commodityOptions.map((symbol) => (
                <option key={symbol} value={symbol}>{symbol}</option>
              ))}
            </select>
            <button
              aria-label={`Remove posting ${index + 1}`}
              style={{ ...buttonStyle, padding: '3px 8px', color: '#999' }}
              onClick={() => setPostings((rows) => rows.filter((_, i) => i !== index))}
              disabled={postings.length <= 2}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <button style={buttonStyle} onClick={() => setPostings((rows) => [...rows, { ...emptyPosting(), commodity: defaultCurrency }])}>
          + Posting
        </button>
        <div style={{ flex: 1 }} />
        {error && <span style={errorTextStyle}>{error}</span>}
        <button style={buttonStyle} onClick={onCancel}>Cancel</button>
        <button style={{ ...primaryButtonStyle, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={() => void submit()}>
          Post transaction
        </button>
      </div>
    </div>
  )
}

// ── Transactions table ───────────────────────────────────────────────────────

function TransactionsTable({ transactions }: { transactions: FinanceTransaction[] }) {
  return (
    <div style={panelStyle}>
      <h3 style={panelTitleStyle}>Transactions</h3>
      {transactions.length === 0 ? (
        <div style={{ fontSize: 13, color: '#bbb' }}>No transactions yet</div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Date</th>
              <th style={thStyle}>Flag</th>
              <th style={thStyle}>Payee</th>
              <th style={thStyle}>Narration</th>
              <th style={thStyle}>Tags</th>
              <th style={thStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((transaction) => (
              <tr key={transaction.directive_id}>
                <td style={{ ...tdStyle, ...monoStyle }}>{transaction.directive.date}</td>
                <td style={{ ...tdStyle, ...monoStyle }}>{transaction.flag}</td>
                <td style={tdStyle}>{transaction.payee ?? ''}</td>
                <td style={tdStyle}>{transaction.narration ?? ''}</td>
                <td style={tdStyle}>{transaction.tags.map((tag) => `#${tag}`).join(' ')}</td>
                <td style={tdStyle}><span style={statusBadge(transaction.directive.status)}>{transaction.directive.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Account ledger ───────────────────────────────────────────────────────────

function AccountLedger({
  account, postings, onClose, onToggleVisibility,
}: {
  account: FinanceAccount
  postings: FinancePosting[]
  onClose: () => void
  onToggleVisibility: (visibility: 'space' | 'private') => Promise<void>
}) {
  const [visibilityError, setVisibilityError] = useState<string | null>(null)
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <h3 style={{ ...panelTitleStyle, flex: 1 }}>Ledger — {account.name}</h3>
        {account.owner_user_id && (
          <button
            style={{ ...buttonStyle, padding: '2px 8px', fontSize: 12 }}
            onClick={() => {
              onToggleVisibility(account.visibility === 'private' ? 'space' : 'private')
                .then(() => setVisibilityError(null))
                .catch((err) => setVisibilityError(err instanceof Error ? err.message : 'Not allowed'))
            }}
          >
            {account.visibility === 'private' ? 'Share with space' : 'Make private'}
          </button>
        )}
        <button style={{ ...buttonStyle, padding: '2px 8px', fontSize: 12 }} onClick={onClose}>Close view</button>
      </div>
      {visibilityError && <div style={{ ...errorTextStyle, marginBottom: 6 }}>{visibilityError}</div>}
      {postings.length === 0 ? (
        <div style={{ fontSize: 13, color: '#bbb' }}>No posted entries</div>
      ) : (
        <table style={tableStyle}>
          <tbody>
            {postings.map((posting) => (
              <tr key={posting.id}>
                <td style={{ ...tdStyle, ...monoStyle, textAlign: 'right' }}>
                  {posting.amount_text ?? '—'} {posting.commodity_symbol ?? ''}
                </td>
                <td style={tdStyle}>{posting.account_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Balances panel ───────────────────────────────────────────────────────────

const BALANCE_SCOPES: Array<{ id: FinanceBalanceScope; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'shared', label: 'Shared' },
  { id: 'personal', label: 'Mine' },
]

function BalancesPanel({
  balances, scope, onScopeChange,
}: {
  balances: FinanceBalancePosition[]
  scope: FinanceBalanceScope
  onScopeChange: (scope: FinanceBalanceScope) => void
}) {
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <h3 style={{ ...panelTitleStyle, flex: 1 }}>Balances</h3>
        {BALANCE_SCOPES.map((candidate) => (
          <button
            key={candidate.id}
            aria-pressed={scope === candidate.id}
            onClick={() => onScopeChange(candidate.id)}
            style={{
              ...buttonStyle, padding: '2px 8px', fontSize: 12,
              background: scope === candidate.id ? '#e8f0fe' : '#fff',
              color: scope === candidate.id ? '#1565c0' : '#555',
              borderColor: scope === candidate.id ? '#a8c4ee' : '#ddd',
            }}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      {balances.length === 0 ? (
        <div style={{ fontSize: 13, color: '#bbb' }}>No posted balances</div>
      ) : (
        <table style={tableStyle}>
          <tbody>
            {balances.map((balance) => (
              <tr key={balance.accountId}>
                <td style={tdStyle}>{balance.accountName}</td>
                <td style={{ ...tdStyle, ...monoStyle, textAlign: 'right' }}>
                  {balance.positions.join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Validation panel ─────────────────────────────────────────────────────────

function ValidationPanel({
  errors, checkedAt, onValidate,
}: {
  errors: FinanceValidationError[]
  checkedAt: string | null
  onValidate: () => void
}) {
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h3 style={{ ...panelTitleStyle, flex: 1 }}>Validation</h3>
        <button style={{ ...buttonStyle, padding: '2px 8px', fontSize: 12 }} onClick={onValidate}>Run checks</button>
      </div>
      {checkedAt === null ? (
        <div style={{ fontSize: 13, color: '#bbb' }}>Not checked yet</div>
      ) : errors.length === 0 ? (
        <div style={{ fontSize: 13, color: '#2e7d32' }}>No validation errors</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {errors.map((error, index) => (
            <li key={index} style={{ ...errorTextStyle, marginBottom: 4 }}>
              <span style={{ ...monoStyle, fontSize: 11, background: '#fdecea', borderRadius: 4, padding: '1px 5px', marginRight: 6 }}>
                {error.code}
              </span>
              {error.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Import / export ──────────────────────────────────────────────────────────

function ImportPanel({
  onImport, onDone,
}: {
  onImport: (text: string, postDirectly: boolean) => Promise<FinanceImportResult>
  onDone: () => void
}) {
  const [text, setText] = useState('')
  const [postDirectly, setPostDirectly] = useState(false)
  const [result, setResult] = useState<FinanceImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!text.trim()) {
      setError('Paste Beancount text first')
      return
    }
    setError(null)
    try {
      setResult(await onImport(text, postDirectly))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    }
  }

  return (
    <div style={{ ...panelStyle, background: '#fafcff', borderColor: '#cfe0f5' }}>
      <h3 style={panelTitleStyle}>Import Beancount</h3>
      <textarea
        aria-label="Beancount text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'2026-01-01 open Assets:Bank:Checking USD\n…'}
        style={{ ...inputStyle, ...monoStyle, width: '100%', minHeight: 140, whiteSpace: 'pre', resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: '#555', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={postDirectly} onChange={(e) => setPostDirectly(e.target.checked)} />
          Post directly (otherwise imported as proposed)
        </label>
        <div style={{ flex: 1 }} />
        <button style={buttonStyle} onClick={onDone}>Close</button>
        <button style={primaryButtonStyle} onClick={() => void submit()}>Run import</button>
      </div>
      {error && <div style={{ ...errorTextStyle, marginTop: 8 }}>{error}</div>}
      {result && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          {result.deduplicated
            ? <span style={{ color: '#b28704' }}>Already imported (same content hash) — nothing created.</span>
            : <span style={{ color: '#2e7d32' }}>Imported {result.created_directives} directives.</span>}
          {result.errors.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {result.errors.map((entryError: FinanceLedgerError, index: number) => (
                <li key={index} style={errorTextStyle}>
                  {entryError.code}: {entryError.message}
                  {entryError.source ? ` (line ${entryError.source.lineno})` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function ExportPanel({ content, onDone }: { content: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ ...panelStyle, background: '#fafcff', borderColor: '#cfe0f5' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h3 style={{ ...panelTitleStyle, flex: 1 }}>Beancount export</h3>
        <button
          style={{ ...buttonStyle, padding: '2px 8px', fontSize: 12, marginRight: 6 }}
          onClick={() => {
            void navigator.clipboard?.writeText(content)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button style={{ ...buttonStyle, padding: '2px 8px', fontSize: 12 }} onClick={onDone}>Close</button>
      </div>
      <pre style={{ ...monoStyle, fontSize: 12, whiteSpace: 'pre-wrap', background: '#f7f7f7', borderRadius: 6, padding: 12, maxHeight: 320, overflow: 'auto', margin: 0 }}>
        {content}
      </pre>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

type ActionPanel = 'none' | 'transaction' | 'import' | 'export'

function FinanceLedgerView({ api, book, books, onSelectBook, onCreateBook }: {
  api: FinanceApi
  book: FinanceBook
  books: FinanceBook[]
  onSelectBook: (bookId: string) => void
  onCreateBook: (name: string, currency: string) => Promise<void>
}) {
  const [accounts, setAccounts] = useState<FinanceAccount[]>([])
  const [commodities, setCommodities] = useState<FinanceCommodity[]>([])
  const [transactions, setTransactions] = useState<FinanceTransaction[]>([])
  const [balances, setBalances] = useState<FinanceBalancePosition[]>([])
  const [validationErrors, setValidationErrors] = useState<FinanceValidationError[]>([])
  const [validatedAt, setValidatedAt] = useState<string | null>(null)
  const [balanceScope, setBalanceScope] = useState<FinanceBalanceScope>('all')
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [ledgerPostings, setLedgerPostings] = useState<FinancePosting[]>([])
  const [panel, setPanel] = useState<ActionPanel>('none')
  const [exportContent, setExportContent] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const reload = useCallback(() => {
    Promise.all([
      api.listAccounts(book.id),
      api.listCommodities(book.id),
      api.listTransactions(book.id),
      api.getBalances(book.id, balanceScope),
    ])
      .then(([accountsResult, commoditiesResult, transactionsResult, balancesResult]) => {
        setAccounts(accountsResult.accounts)
        setCommodities(commoditiesResult.commodities)
        setTransactions(transactionsResult.transactions)
        setBalances(balancesResult.balances)
        setLoadError(null)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load ledger'))
  }, [api, book.id, balanceScope])

  useEffect(() => {
    setValidatedAt(null)
    reload()
  }, [reload])

  useEffect(() => {
    if (!selectedAccountId) {
      setLedgerPostings([])
      return
    }
    api.getAccountLedger(book.id, selectedAccountId)
      .then((result) => setLedgerPostings(result.postings))
      .catch(() => setLedgerPostings([]))
  }, [api, book.id, selectedAccountId])

  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? null

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <BookToolbar books={books} activeBookId={book.id} onSelect={onSelectBook} onCreate={onCreateBook} />
        <div style={{ flex: 1 }} />
        <button style={primaryButtonStyle} onClick={() => setPanel(panel === 'transaction' ? 'none' : 'transaction')}>
          + Transaction
        </button>
        <button style={buttonStyle} onClick={() => setPanel(panel === 'import' ? 'none' : 'import')}>Import</button>
        <button
          style={buttonStyle}
          onClick={() => {
            api.exportBeancount(book.id)
              .then((result) => { setExportContent(result.content); setPanel('export') })
              .catch((err) => setLoadError(err instanceof Error ? err.message : 'Export failed'))
          }}
        >
          Export
        </button>
      </div>

      {loadError && <div style={{ ...errorTextStyle, marginBottom: 12 }}>{loadError}</div>}

      {panel === 'transaction' && (
        <div style={{ marginBottom: 16 }}>
          <TransactionEditor
            accounts={accounts}
            commodities={commodities}
            defaultCurrency={book.operating_currency}
            onCancel={() => setPanel('none')}
            onSubmit={async (input) => {
              await api.createTransaction(book.id, { ...input, post: true })
              setPanel('none')
              reload()
            }}
          />
        </div>
      )}
      {panel === 'import' && (
        <div style={{ marginBottom: 16 }}>
          <ImportPanel
            onImport={async (text, postDirectly) => {
              const result = await api.importBeancount(book.id, { text, post_directly: postDirectly })
              reload()
              return result
            }}
            onDone={() => setPanel('none')}
          />
        </div>
      )}
      {panel === 'export' && (
        <div style={{ marginBottom: 16 }}>
          <ExportPanel content={exportContent} onDone={() => setPanel('none')} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <AccountsPanel
            accounts={accounts}
            commodities={commodities}
            bookCurrency={book.operating_currency}
            selectedAccountId={selectedAccountId}
            onSelect={setSelectedAccountId}
            onCreate={async (input) => {
              await api.createAccount(book.id, input)
              reload()
            }}
          />
          <CommoditiesPanel
            commodities={commodities}
            onCreate={async (symbol, commodityType) => {
              await api.createCommodity(book.id, { symbol, commodity_type: commodityType })
              reload()
            }}
          />
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {selectedAccount && (
            <AccountLedger
              account={selectedAccount}
              postings={ledgerPostings}
              onClose={() => setSelectedAccountId(null)}
              onToggleVisibility={async (visibility) => {
                await api.setAccountVisibility(book.id, selectedAccount.id, visibility)
                reload()
              }}
            />
          )}
          <TransactionsTable transactions={transactions} />
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <BalancesPanel balances={balances} scope={balanceScope} onScopeChange={setBalanceScope} />
            </div>
            <div style={{ flex: 1, minWidth: 260 }}>
              <ValidationPanel
                errors={validationErrors}
                checkedAt={validatedAt}
                onValidate={() => {
                  api.validateBook(book.id)
                    .then((result) => { setValidationErrors(result.errors); setValidatedAt(new Date().toISOString()) })
                    .catch((err) => setLoadError(err instanceof Error ? err.message : 'Validation failed'))
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function FinancePage({ host }: { host: FinanceWebHost }) {
  const { api, Link, usePluginState } = host
  const { enabled, loading: pluginLoading } = usePluginState(PLUGIN_ID)
  const [books, setBooks] = useState<FinanceBook[]>([])
  const [booksLoaded, setBooksLoaded] = useState(false)
  const [activeBookId, setActiveBookId] = useState<string | null>(null)

  const loadBooks = useCallback(() => {
    api.listBooks()
      .then((result) => {
        setBooks(result.books)
        setActiveBookId((current) =>
          current && result.books.some((book) => book.id === current)
            ? current
            : result.books[0]?.id ?? null,
        )
        setBooksLoaded(true)
      })
      .catch(() => setBooksLoaded(true))
  }, [api])

  useEffect(() => {
    if (enabled) loadBooks()
  }, [enabled, loadBooks])

  if (pluginLoading) return null

  if (!enabled) {
    return (
      <div style={{ maxWidth: 520, margin: '80px auto', padding: '0 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>🏦</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Finance Ledger</h1>
        <p style={{ color: '#666', marginBottom: 24 }}>
          Double-entry bookkeeping for this space, compatible with Beancount import and export.
        </p>
        <Link
          to="/plugins"
          style={{ display: 'inline-block', padding: '8px 20px', borderRadius: 8, background: '#1976d2', color: '#fff', textDecoration: 'none', fontSize: 14, fontWeight: 500 }}
        >
          Install or enable in Optional Modules
        </Link>
      </div>
    )
  }

  const createBook = async (name: string, currency: string) => {
    const result = await api.createBook({ name, base_currency: currency })
    try {
      // Register the default currency so postings in it work out of the box.
      await api.createCommodity(result.book.id, { symbol: currency, commodity_type: 'currency' })
    } catch {
      // Commodity can still be added manually from the commodities panel.
    }
    setBooks((current) => [result.book, ...current])
    setActiveBookId(result.book.id)
  }

  const activeBook = books.find((book) => book.id === activeBookId) ?? null

  if (!booksLoaded) {
    return <div style={{ padding: 40, color: '#bbb', fontSize: 14 }}>Loading…</div>
  }

  if (!activeBook) {
    return (
      <div style={{ maxWidth: 560, margin: '60px auto', padding: '0 24px' }}>
        <BookToolbar books={books} activeBookId={null} onSelect={setActiveBookId} onCreate={createBook} />
        <p style={{ color: '#666', fontSize: 14, marginTop: 16 }}>
          Create your first book to start recording accounts and transactions.
        </p>
      </div>
    )
  }

  return (
    // Keyed by the book so switching books gives this view fresh state.
    // It used to reset that state from an effect on `[book.id]`, which also
    // ran on mount — a click that landed between first paint and that effect
    // (opening the transaction panel, selecting an account) was silently
    // undone, and under load the tests caught it.
    <FinanceLedgerView
      key={activeBook.id}
      api={api}
      book={activeBook}
      books={books}
      onSelectBook={setActiveBookId}
      onCreateBook={createBook}
    />
  )
}

export function createFinancePage(host: FinanceWebHost): ComponentType {
  return function FinancePageWithHost() {
    return <FinancePage host={host} />
  }
}
