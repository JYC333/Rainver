import {z} from 'zod';
import type {PluginOperationManifest} from '@rainver/protocol';

/**
 * Finance ledger: a Space's double-entry books. Browser-safe declaration
 * shared by the server runtime and the bundled view; see
 * OFFICIAL_OPTIONAL_MODULES "Finance ledger package".
 *
 * Data classes (ADR 0030): a read that can show a private account, or a
 * posting, balance, ledger, validation or import touching one, is `sensitive`
 * (only the person the Run acts for can consent, in an isolated Run); the
 * book, option and commodity catalogs are `personal` (a Space owner's
 * consent). An Agent writes only through the two posting proposals, never
 * durably. Posting is separate from import and
 * validation: an import lands entries as `proposed`, validation reads, and
 * only an approved posting proposal (or the person's own direct post of a
 * transaction they enter) makes an entry part of the ledger.
 */
export const PLUGIN_ID = 'finance_ledger';
const id = z.string().trim().min(1).max(64);
const book = {book_id: id};
export const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Invalid date');
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
export const ACCOUNT_ROOTS = ['Assets', 'Liabilities', 'Equity', 'Income', 'Expenses'] as const;
const Segment = z.string().regex(/^[A-Z0-9][A-Za-z0-9-]*$/).max(100);
const Amount = z.object({number: text(64), commodity: text(24)}).strict();
const Posting = z.object({account_id: id, amount: Amount.nullable().optional(), flag: optionalText(1)}).strict();
/** Import text bound (the legacy route had none; 5 MB is a large statement export). */
export const IMPORT_TEXT_MAX = 5_000_000;
export const FINANCE_IMPORT_HISTORY_PAGE_SIZE = 25;

/** Rows are the ledger's own DTOs (books, accounts, directives, ...). */
const Row = z.record(z.string(), z.unknown());
const ImportBatch = z.object({
  import_source: Row, batch_existed: z.boolean(), created_directives: z.number().int(), summary: z.record(z.string(), z.number().int()),
  entries: z.array(Row), errors: z.array(Row),
}).strict();

export const inputs = {
  'book.list': z.object({}).strict(),
  'book.create': z.object({name: text(200), base_currency: text(24), operating_currency: z.string().trim().min(1).max(24).optional()}).strict(),
  'book.balances': z.object({...book, scope: z.enum(['all', 'shared', 'personal']).optional()}).strict(),
  'book.validate': z.object({...book}).strict(),
  'option.list': z.object({...book}).strict(),
  'option.set': z.object({...book, name: text(100), value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])}).strict(),
  'account.list': z.object({...book}).strict(),
  'account.open': z.object({
    ...book,
    /** A full Beancount account name, or the guided root_type + group + leaf. */
    name: z.string().trim().min(1).max(300).optional(), root_type: z.enum(ACCOUNT_ROOTS).optional(), group: Segment.optional(), leaf: Segment.optional(),
    display_name: optionalText(200), opened_at: DaySchema, currencies: z.array(text(24)).max(20).optional(), default_currency: z.string().trim().max(24).optional(),
    booking_method: text(32).optional(), account_role: text(64).optional(),
    owner: z.enum(['shared', 'personal']).optional(), visible_to_space: z.boolean().optional(),
  }).strict().refine(v => !!v.name || (!!v.root_type && !!v.group && !!v.leaf), 'name or root_type, group and leaf'),
  'account.set_visibility': z.object({...book, account_id: id, visibility: z.enum(['space', 'private'])}).strict(),
  'account.close': z.object({...book, account_id: id, date: DaySchema}).strict(),
  'account.ledger': z.object({...book, account_id: id}).strict(),
  'commodity.list': z.object({...book}).strict(),
  'commodity.create': z.object({...book, symbol: text(24), commodity_type: z.enum(['currency', 'security', 'crypto', 'custom']).optional(), name: optionalText(200)}).strict(),
  'transaction.list': z.object({...book}).strict(),
  'transaction.create': z.object({
    ...book, date: DaySchema, flag: z.enum(['*', '!']).optional(), payee: optionalText(500), narration: optionalText(2000),
    tags: z.array(text(100)).max(50).optional(), links: z.array(text(100)).max(50).optional(), postings: z.array(Posting).min(1).max(100),
    /** Post it now (the person's own entry); otherwise it stays a draft. */
    post: z.boolean().optional(),
  }).strict(),
  'directive.list': z.object({
    ...book, status: z.enum(['draft', 'proposed', 'posted', 'voided']).optional(),
    type: z.enum(['open', 'close', 'commodity', 'pad', 'balance', 'transaction', 'note', 'event', 'query', 'price', 'document', 'custom']).optional(),
    import_source_id: id.optional(),
  }).strict(),
  'directive.propose_post': z.object({...book, directive_id: id}).strict(),
  'import.list': z.object({...book, offset: z.number().int().nonnegative()}).strict(),
  'import.get': z.object({...book, import_source_id: id}).strict(),
  /** Lands every dated entry as `proposed`; nothing in a file posts, opens, closes or declares anything. */
  'import.beancount': z.object({...book, text: z.string().min(1).max(IMPORT_TEXT_MAX), source_type: z.string().trim().min(1).max(64).optional()}).strict(),
  'import.retry': z.object({...book, import_source_id: id}).strict(),
  'import.map_entry': z.object({...book, import_source_id: id, entry_id: id, account_mapping: z.record(z.string().min(1).max(300), id)}).strict(),
  'import.review': z.object({...book, import_source_id: id, decision: z.enum(['import', 'duplicate']), entry_ids: z.array(id).min(1).max(1000).optional()}).strict(),
  'import.propose_post': z.object({...book, import_source_id: id}).strict(),
  'export.beancount': z.object({...book}).strict(),
} as const;
export type FinanceOperation = keyof typeof inputs;

export const outputs = {
  'book.list': z.object({books: z.array(Row)}).strict(),
  'book.create': z.object({book: Row}).strict(),
  'book.balances': z.object({balances: z.array(Row)}).strict(),
  /** Codes and directive ids only: the text of a refusal never names an account. */
  'book.validate': z.object({errors: z.array(z.object({code: z.string(), directive_id: z.string().nullable()}).strict())}).strict(),
  'option.list': z.object({options: z.array(Row)}).strict(),
  'option.set': z.object({name: z.string(), value: z.unknown()}).strict(),
  'account.list': z.object({accounts: z.array(Row)}).strict(),
  'account.open': z.object({account: Row}).strict(),
  'account.set_visibility': z.object({account: Row}).strict(),
  'account.close': z.object({account: Row}).strict(),
  'account.ledger': z.object({postings: z.array(Row)}).strict(),
  'commodity.list': z.object({commodities: z.array(Row)}).strict(),
  'commodity.create': z.object({commodity: Row}).strict(),
  'transaction.list': z.object({transactions: z.array(Row)}).strict(),
  'transaction.create': z.object({directive: Row}).strict(),
  'directive.list': z.object({directives: z.array(Row)}).strict(),
  'directive.propose_post': z.object({directive_id: z.string(), status: z.string()}).strict(),
  'import.list': z.object({imports: z.array(Row), next_offset: z.number().int().nonnegative().optional()}).strict(),
  'import.get': ImportBatch,
  'import.beancount': ImportBatch,
  'import.retry': ImportBatch,
  'import.map_entry': ImportBatch,
  'import.review': ImportBatch,
  'import.propose_post': z.object({import_source_id: z.string(), posted: z.number().int()}).strict(),
  'export.beancount': z.object({export_id: z.string(), content: z.string(), content_hash: z.string(), errors: z.array(Row)}).strict(),
} as const;

export const POST_DIRECTIVE_PROPOSAL = `plugin.${PLUGIN_ID}.directive.post`;
export const POST_IMPORT_PROPOSAL = `plugin.${PLUGIN_ID}.import.post`;

type Spec = {title: string; description: string; kind?: 'query'; proposal?: string; person_only?: true; sensitive?: true};
const specs: Record<FinanceOperation, Spec> = {
  'book.list': {kind: 'query', title: 'List finance books', description: 'List this Space\'s finance books'},
  'book.create': {title: 'Create a finance book', description: 'Create a finance book with its base currency'},
  'book.balances': {kind: 'query', sensitive: true, title: 'Account balances', description: 'Posted balances per account, for all, shared or your personal accounts'},
  'book.validate': {kind: 'query', sensitive: true, title: 'Validate a book', description: 'Check that every posted transaction you can see balances; returns problem codes per entry, changes nothing'},
  'option.list': {kind: 'query', title: 'List ledger options', description: 'List a book\'s ledger options'},
  'option.set': {title: 'Set a ledger option', description: 'Set one ledger option of a book'},
  'account.list': {kind: 'query', sensitive: true, title: 'List accounts', description: 'List the accounts of a book you can see'},
  'account.open': {title: 'Open an account', description: 'Open a shared or personal account (a personal one may be private to you)'},
  'account.set_visibility': {title: 'Change account visibility', description: 'Make your personal account private or visible to the Space'},
  'account.close': {title: 'Close an account', description: 'Close an account on a date after its last posted entry'},
  'account.ledger': {kind: 'query', sensitive: true, title: 'Account ledger', description: 'List the posted entries of one account you can see'},
  'commodity.list': {kind: 'query', title: 'List commodities', description: 'List a book\'s currencies and commodities'},
  'commodity.create': {title: 'Add a commodity', description: 'Add a currency or commodity to a book'},
  'transaction.list': {kind: 'query', sensitive: true, title: 'List transactions', description: 'List the transactions of a book you can see'},
  'transaction.create': {person_only: true, title: 'Enter a transaction', description: 'Enter a transaction as a draft, or post it at once; it must balance and use open accounts you can see'},
  'directive.list': {kind: 'query', sensitive: true, title: 'List ledger entries', description: 'List a book\'s entries you can see by status, type or import batch'},
  'directive.propose_post': {sensitive: true, proposal: POST_DIRECTIVE_PROPOSAL, title: 'Propose posting an entry', description: 'Propose posting a draft or proposed entry; it is revalidated and posted only after the person approves it'},
  'import.list': {kind: 'query', sensitive: true, title: 'List your imports', description: 'List a page of the import batches you uploaded to a book, starting at offset zero'},
  'import.get': {kind: 'query', sensitive: true, title: 'Read an import', description: 'Read one of your import batches with its entries and their status'},
  'import.beancount': {person_only: true, title: 'Import Beancount text', description: 'Import a Beancount file as proposed entries; nothing is posted, opened or declared'},
  'import.retry': {person_only: true, title: 'Retry an import', description: 'Retry the unfinished entries of your import batch'},
  'import.map_entry': {person_only: true, title: 'Map an imported account', description: 'Map an account name of an imported entry onto an existing account'},
  'import.review': {person_only: true, title: 'Decide possible duplicates', description: 'Import or settle as duplicate the entries of your batch that match an earlier import'},
  'import.propose_post': {sensitive: true, proposal: POST_IMPORT_PROPOSAL, title: 'Propose posting an import', description: 'Propose posting every proposed entry of your import batch; revalidated and posted together only after the person approves it'},
  'export.beancount': {person_only: true, title: 'Export Beancount', description: 'Export the posted ledger you can see as Beancount text'},
};

const manifest: PluginOperationManifest = {
  id: PLUGIN_ID,
  version: '1.0.0',
  hostApi: 1,
  scope: 'space',
  name: 'Finance Ledger',
  description: 'A Beancount-compatible double-entry finance ledger for this Space, with private personal accounts, import review and approved posting.',
  requires: [],
  permissions: {agent: true},
  data_access: 'caller_owned',
  entities: [
    ...['book', 'option', 'account', 'commodity', 'transaction', 'directive', 'import'].map(name => ({name, data_class: 'personal' as const})),
    {name: 'export', data_class: 'personal' as const, exemption: 'An export is returned once by export.beancount; its record is audit only'},
  ],
  migrations: ['0000_finance_records'],
  proposalTypes: [
    {id: POST_DIRECTIVE_PROPOSAL, operation: `plugin.${PLUGIN_ID}.directive.propose_post`, payload_schema: inputs['directive.propose_post']},
    {id: POST_IMPORT_PROPOSAL, operation: `plugin.${PLUGIN_ID}.import.propose_post`, payload_schema: inputs['import.propose_post']},
  ],
  web: {entries: [{id: 'ledger', title: 'Finance', icon: 'landmark', placements: ['navigation']}]},
  operations: (Object.keys(specs) as FinanceOperation[]).map(key => {
    const spec = specs[key];
    const query = spec.kind === 'query';
    return {
      id: `plugin.${PLUGIN_ID}.${key}`,
      version: 1,
      title: spec.title,
      description: spec.description,
      kind: query ? 'query' as const : 'command' as const,
      side_effects: query ? 'none' as const : spec.proposal ? 'proposal' as const : 'durable' as const,
      data_class: spec.sensitive ? 'sensitive' as const : 'personal' as const,
      input_schema: inputs[key],
      output_schema: outputs[key],
      // Posting makes an entry part of the Space's financial record (ADR 0017 money).
      gate_class: spec.proposal ? 'money' as const : null,
      ...(spec.proposal ? {proposal_type: spec.proposal} : {}),
      ...(spec.person_only ? {actors: ['user'] as ['user']} : {}),
    };
  }),
};
export default manifest;
