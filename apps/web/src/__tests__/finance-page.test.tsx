import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  createFinancePage,
  validateTransactionForm,
} from '../../../../plugins/official/finance_ledger/web/src/FinancePage'
import type {
  FinanceApi,
  FinanceWebHost,
} from '../../../../plugins/official/finance_ledger/web/src/host'

const book = {
  id: 'book-1', space_id: 'space-1', name: 'Household', base_currency: 'USD',
  operating_currency: 'USD', status: 'active', created_at: '', updated_at: '',
}

const accounts = [
  {
    id: 'acc-1', name: 'Assets:Bank:Checking', display_name: '招商银行', root_type: 'assets',
    parent_account_id: null, commodity_constraints: null, opened_at: '2026-01-01',
    closed_at: null, booking_method: null,
    default_commodity: null, owner_user_id: null, visibility: 'space' as const,
  },
  {
    id: 'acc-2', name: 'Expenses:Food', display_name: null, root_type: 'expenses',
    parent_account_id: null, commodity_constraints: null, opened_at: '2026-01-01',
    closed_at: null, booking_method: null,
    default_commodity: 'EUR', owner_user_id: 'user-1', visibility: 'private' as const,
  },
]

function fakeApi(overrides: Partial<FinanceApi> = {}): FinanceApi {
  return {
    listBooks: vi.fn().mockResolvedValue({ books: [book] }),
    createBook: vi.fn().mockResolvedValue({ book }),
    listAccounts: vi.fn().mockResolvedValue({ accounts }),
    createAccount: vi.fn().mockResolvedValue({ account: accounts[0] }),
    closeAccount: vi.fn().mockResolvedValue({ account: accounts[0] }),
    setAccountVisibility: vi.fn().mockResolvedValue({ account: accounts[1] }),
    listCommodities: vi.fn().mockResolvedValue({
      commodities: [{ id: 'com-1', symbol: 'USD', commodity_type: 'currency', name: null }],
    }),
    createCommodity: vi.fn().mockResolvedValue({
      commodity: { id: 'com-2', symbol: 'EUR', commodity_type: 'currency', name: null },
    }),
    listTransactions: vi.fn().mockResolvedValue({
      transactions: [
        {
          directive_id: 'dir-1', flag: '*', payee: 'Grocer', narration: 'Weekly shop',
          tags: ['food'], links: [],
          directive: { id: 'dir-1', directive_type: 'transaction', date: '2026-06-01', sequence: 0, status: 'posted' },
        },
      ],
    }),
    createTransaction: vi.fn().mockResolvedValue({
      directive: { id: 'dir-2', directive_type: 'transaction', date: '2026-06-02', sequence: 0, status: 'posted' },
    }),
    getAccountLedger: vi.fn().mockResolvedValue({ postings: [] }),
    getBalances: vi.fn().mockResolvedValue({
      balances: [{ accountId: 'acc-1', accountName: 'Assets:Bank:Checking', positions: ['120.50 USD'] }],
    }),
    validateBook: vi.fn().mockResolvedValue({ errors: [] }),
    importBeancount: vi.fn().mockResolvedValue({
      import_source_id: 'imp-1', deduplicated: false, created_directives: 2, errors: [],
    }),
    exportBeancount: vi.fn().mockResolvedValue({
      export_id: 'exp-1', content: '2026-01-01 open Assets:Bank:Checking\n', content_hash: 'abc', errors: [],
    }),
    ...overrides,
  }
}

function makeHost(api: FinanceApi, enabled = true): FinanceWebHost {
  return {
    api,
    Link: ({ to, style, children }) => <a href={to} style={style}>{children}</a>,
    usePluginState: () => ({ loading: false, enabled }),
  }
}

describe('FinancePage', () => {
  it('shows the enable/install path when the plugin is disabled', () => {
    const Page = createFinancePage(makeHost(fakeApi(), false))
    render(<Page />)
    const link = screen.getByText('Install or enable in Optional Modules')
    expect(link).toBeInTheDocument()
    expect(link.closest('a')?.getAttribute('href')).toBe('/plugins')
  })

  it('renders books, accounts, commodities, transactions, and balances', async () => {
    const Page = createFinancePage(makeHost(fakeApi()))
    render(<Page />)

    expect(await screen.findByText('Household (USD)')).toBeInTheDocument()
    // Accounts with a display name show it; others fall back to the leaf segment.
    expect(await screen.findByText('招商银行')).toBeInTheDocument()
    expect(screen.getByText('Food')).toBeInTheDocument()
    expect(screen.getByText('USD')).toBeInTheDocument()
    expect(screen.getByText('Grocer')).toBeInTheDocument()
    expect(screen.getByText('Weekly shop')).toBeInTheDocument()
    expect(screen.getByText('#food')).toBeInTheDocument()
    expect(screen.getByText('120.50 USD')).toBeInTheDocument()
  })

  it('blocks obviously invalid transaction submissions in the posting editor', async () => {
    const api = fakeApi()
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    await screen.findByText('Household (USD)')

    fireEvent.click(screen.getByText('+ Transaction'))
    fireEvent.click(screen.getByText('Post transaction'))
    expect(await screen.findByText('A transaction needs at least two postings')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Posting 1 account'), { target: { value: 'acc-1' } })
    fireEvent.change(screen.getByLabelText('Posting 2 account'), { target: { value: 'acc-2' } })
    fireEvent.change(screen.getByLabelText('Posting 1 amount'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByText('Post transaction'))
    expect(await screen.findByText('Invalid amount: abc')).toBeInTheDocument()

    expect(api.createTransaction).not.toHaveBeenCalled()
  })

  it('submits a balanced transaction with one interpolated posting', async () => {
    const api = fakeApi()
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    await screen.findByText('Household (USD)')

    fireEvent.click(screen.getByText('+ Transaction'))
    fireEvent.change(screen.getByLabelText('Posting 1 account'), { target: { value: 'acc-2' } })
    fireEvent.change(screen.getByLabelText('Posting 1 amount'), { target: { value: '42.10' } })
    fireEvent.change(screen.getByLabelText('Posting 2 account'), { target: { value: 'acc-1' } })
    fireEvent.click(screen.getByText('Post transaction'))

    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledTimes(1))
    // Selecting acc-2 auto-switches the row to the account's default commodity (EUR).
    expect(api.createTransaction).toHaveBeenCalledWith('book-1', expect.objectContaining({
      post: true,
      postings: [
        { account_id: 'acc-2', amount: { number: '42.10', commodity: 'EUR' } },
        { account_id: 'acc-1', amount: null },
      ],
    }))
  })

  it('renders structured validation errors in the validation panel', async () => {
    const api = fakeApi({
      validateBook: vi.fn().mockResolvedValue({
        errors: [
          { code: 'transaction_unbalanced', message: 'Transaction does not balance for USD: 5.00 USD', directiveId: 'dir-1' },
        ],
      }),
    })
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    await screen.findByText('Household (USD)')

    expect(screen.getByText('Not checked yet')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Run checks'))
    expect(await screen.findByText('transaction_unbalanced')).toBeInTheDocument()
    expect(screen.getByText('Transaction does not balance for USD: 5.00 USD')).toBeInTheDocument()
  })

  it('imports beancount text and reports the result', async () => {
    const api = fakeApi()
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    await screen.findByText('Household (USD)')

    fireEvent.click(screen.getByText('Import'))
    fireEvent.change(screen.getByLabelText('Beancount text'), {
      target: { value: '2026-01-01 open Assets:Bank:Checking USD' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run import' }))

    expect(await screen.findByText('Imported 2 directives.')).toBeInTheDocument()
    expect(api.importBeancount).toHaveBeenCalledWith('book-1', {
      text: '2026-01-01 open Assets:Bank:Checking USD',
      post_directly: false,
    })
  })

  it('prompts to create the first book when none exist', async () => {
    const api = fakeApi({ listBooks: vi.fn().mockResolvedValue({ books: [] }) })
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    expect(await screen.findByText('Create your first book to start recording accounts and transactions.')).toBeInTheDocument()
    expect(screen.getByText('+ New book')).toBeInTheDocument()
  })

  it('creates a book with a selected currency and auto-registers it as a commodity', async () => {
    const api = fakeApi({ listBooks: vi.fn().mockResolvedValue({ books: [] }) })
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    await screen.findByText('+ New book')

    fireEvent.click(screen.getByText('+ New book'))
    fireEvent.change(screen.getByLabelText('Book name'), { target: { value: 'Household' } })
    fireEvent.change(screen.getByLabelText('Default currency'), { target: { value: 'CNY' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => expect(api.createBook).toHaveBeenCalledWith({ name: 'Household', base_currency: 'CNY' }))
    expect(api.createCommodity).toHaveBeenCalledWith('book-1', { symbol: 'CNY', commodity_type: 'currency' })
  })

  it('opens a shared account from the guided type/group/name form', async () => {
    const api = fakeApi()
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    await screen.findByText('Household (USD)')

    fireEvent.click(screen.getByText('+ Open'))
    fireEvent.change(screen.getByLabelText('Account type'), { target: { value: 'Assets' } })
    fireEvent.change(screen.getByLabelText('Account group'), { target: { value: 'Bank' } })
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'ICBC' } })
    fireEvent.click(screen.getByText('Open account'))

    await waitFor(() => expect(api.createAccount).toHaveBeenCalledTimes(1))
    expect(api.createAccount).toHaveBeenCalledWith('book-1', expect.objectContaining({
      root_type: 'Assets', group: 'Bank', leaf: 'ICBC', owner: 'shared', visible_to_space: true,
      default_currency: 'USD',
    }))
  })

  it('preselects the posting commodity from the account default currency', async () => {
    const api = fakeApi()
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    await screen.findByText('Household (USD)')

    fireEvent.click(screen.getByText('+ Transaction'))
    const commoditySelect = screen.getByLabelText('Posting 1 commodity') as HTMLSelectElement
    expect(commoditySelect.value).toBe('USD')

    fireEvent.change(screen.getByLabelText('Posting 1 account'), { target: { value: 'acc-2' } })
    expect(commoditySelect.value).toBe('EUR')

    fireEvent.change(screen.getByLabelText('Posting 1 account'), { target: { value: 'acc-1' } })
    expect(commoditySelect.value).toBe('EUR')
  })

  it('opens a private personal account', async () => {
    const api = fakeApi()
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    await screen.findByText('Household (USD)')

    fireEvent.click(screen.getByText('+ Open'))
    fireEvent.change(screen.getByLabelText('Account group'), { target: { value: 'Bank' } })
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Secret' } })
    fireEvent.change(screen.getByLabelText('Account owner'), { target: { value: 'personal' } })
    fireEvent.click(screen.getByLabelText(/Visible to other space members/))
    fireEvent.click(screen.getByText('Open account'))

    await waitFor(() => expect(api.createAccount).toHaveBeenCalledTimes(1))
    expect(api.createAccount).toHaveBeenCalledWith('book-1', expect.objectContaining({
      owner: 'personal', visible_to_space: false,
    }))
  })

  it('rejects an invalid account segment before calling the API', async () => {
    const api = fakeApi()
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    await screen.findByText('Household (USD)')

    fireEvent.click(screen.getByText('+ Open'))
    fireEvent.change(screen.getByLabelText('Account group'), { target: { value: 'bank card' } })
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'ICBC' } })
    fireEvent.click(screen.getByText('Open account'))

    expect(await screen.findByText(/must start with a capital letter or digit/)).toBeInTheDocument()
    expect(api.createAccount).not.toHaveBeenCalled()
  })

  it('switches balance scope and refetches with the scope', async () => {
    const api = fakeApi()
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    await screen.findByText('Household (USD)')

    await waitFor(() => expect(api.getBalances).toHaveBeenLastCalledWith('book-1', 'all'))
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }))
    await waitFor(() => expect(api.getBalances).toHaveBeenLastCalledWith('book-1', 'personal'))
    fireEvent.click(screen.getByRole('button', { name: 'Shared' }))
    await waitFor(() => expect(api.getBalances).toHaveBeenLastCalledWith('book-1', 'shared'))
  })

  it('marks personal accounts and toggles visibility from the ledger view', async () => {
    const api = fakeApi()
    const Page = createFinancePage(makeHost(api))
    render(<Page />)
    await screen.findByText('Household (USD)')

    expect(await screen.findByText('personal 🔒')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Food'))
    await screen.findByText('Ledger — Expenses:Food')
    fireEvent.click(screen.getByText('Share with space'))
    await waitFor(() =>
      expect(api.setAccountVisibility).toHaveBeenCalledWith('book-1', 'acc-2', 'space'),
    )
  })
})

describe('validateTransactionForm', () => {
  const posting = (accountId: string, amount: string, commodity = 'USD') => ({ accountId, amount, commodity })

  it('accepts two postings with one interpolated amount', () => {
    expect(validateTransactionForm('2026-06-01', [posting('a', '10.00'), posting('b', '')])).toBeNull()
  })

  it('rejects bad dates, single postings, bad decimals, and double blanks', () => {
    expect(validateTransactionForm('June 1', [posting('a', '1'), posting('b', '-1')])).toMatch(/Date/)
    expect(validateTransactionForm('2026-06-01', [posting('a', '1')])).toMatch(/two postings/)
    expect(validateTransactionForm('2026-06-01', [posting('a', '1.2.3'), posting('b', '')])).toMatch(/Invalid amount/)
    expect(validateTransactionForm('2026-06-01', [posting('a', ''), posting('b', '')])).toMatch(/At most one/)
    expect(validateTransactionForm('2026-06-01', [posting('a', '1', 'usd$'), posting('b', '')])).toMatch(/commodity/)
  })
})
