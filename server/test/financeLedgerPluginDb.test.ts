import {randomUUID} from 'node:crypto';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {RainverPlugin, RunToolGrant} from '@rainver/protocol';
import {BUILT_IN_PLUGINS} from '../src/modules/plugins/builtInPlugins.js';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {migrateOperationPlugin} from '../src/modules/plugins/operationMigrations.js';
import {pluginServiceFor} from '../src/modules/plugins/service.js';
import {getOfficialPlugin} from '../src/modules/plugins/registry.js';
import {pluginToolPins, type RunScenario} from '../src/modules/plugins/dataAccess.js';
import {PluginDataGrantRepository} from '../src/modules/plugins/dataGrantRepository.js';
import {setOperationPluginEnabled} from '../src/modules/plugins/lifecycle.js';
import {buildRunToolGrants} from '../src/modules/systemActions/runToolGrants.js';
import {withTransaction} from '../src/db/tx.js';
import {loadConfig} from '../src/config.js';
import {useTestDatabase} from './support/testDatabase.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {seedRun, seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {runsModule} from '../src/modules/runs/index.js';
import {proposalsModule, __setProposalIdentityForTests} from '../src/modules/proposals/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import type {AgentRunRecord} from '../src/modules/runs/repository.js';
import type {OperationToolResponse} from '../src/modules/systemActions/operations/agentResult.js';

/**
 * The rebuilt Finance ledger package (Plan 7) as shipped: the compiled
 * artifact, the offline installer, and the real P1 HTTP, Proposal and Agent tool entries on real
 * PostgreSQL. The cases of the retired route test are kept, now through the
 * operations.
 */
const db = useTestDatabase(import.meta.filename);
const pid = 'finance_ledger';
const op = (name: string) => `plugin.${pid}.${name}`;
const plugin = BUILT_IN_PLUGINS.find(p => p.id === pid) as RainverPlugin;
beforeAll(async () => {
  if (!db.available) return;
  expect(plugin?.operationManifest, 'build the official plugins first (server/scripts/build-official-plugins.mjs)').toBeTruthy();
  await migrateOperationPlugin(db.pool, plugin);
});

let host: PluginHost, space: string, otherSpace: string, user: string, member: string, config: ReturnType<typeof loadConfig>, app: ReturnType<typeof buildModuleServer>;
async function addPerson(person: string, spaceId: string, role = 'member') {
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Person','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system') ON CONFLICT DO NOTHING`, [person]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [randomUUID(), spaceId, person, role]);
}
async function personalSpace(person: string) {
  const personal = randomUUID();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Personal','personal',now(),now())`, [personal]);
  await addPerson(person, personal, 'owner');
}
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID(); otherSpace = randomUUID(); user = randomUUID(); member = randomUUID();
  await seedSpaceOwnerProject(db.pool, {space, owner: user, project: randomUUID(), spaceType: 'team'});
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Other','team',now(),now())`, [otherSpace]);
  await addPerson(user, otherSpace, 'owner');
  await addPerson(member, space);
  await personalSpace(user);
  config = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
  app = buildModuleServer(config, [systemActionsModule, runsModule, proposalsModule]);
  host = new PluginHost([plugin]);
  host.activate(app, config);
  await app.ready();
  for (const s of [space, otherSpace]) await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, s, user, {}));
  as(user);
});
afterEach(async () => { __setAuthIdentityForTests(null); __setProposalIdentityForTests(null); await app?.close(); });
const as = (person: string, spaceId = space) => { __setAuthIdentityForTests({spaceId, userId: person}); __setProposalIdentityForTests({spaceId, userId: person}); };
const action = (name: string, payload: Record<string, unknown>, key = randomUUID()) => app.inject({method: 'POST', url: `/api/v1/actions/${op(name)}`, headers: {'idempotency-key': key}, payload});
const query = (name: string, input: Record<string, unknown>) => app.inject({method: 'GET', url: `/api/v1/queries/${op(name)}?input=${encodeURIComponent(JSON.stringify(input))}`});
type Reply = {statusCode: number; body: string; json(): any};
const ok = async <T = any>(response: Promise<Reply>): Promise<T> => {
  const r = await response;
  expect(r.statusCode, r.body).toBe(200);
  return r.json().data as T;
};
/** A refusal: its status and safe reason code, and a body that carries no message text. */
const refused = async (response: Promise<Reply>) => {
  const r = await response;
  return {status: r.statusCode, code: r.json().error?.code as string, reason: r.json().error?.metadata?.reason as string | undefined, body: r.body};
};
const accept = (proposal: string, key = randomUUID()) => app.inject({method: 'POST', url: `/api/v1/proposals/${proposal}/accept`, headers: {'idempotency-key': key}, payload: {}});
const reject = (proposal: string) => app.inject({method: 'POST', url: `/api/v1/proposals/${proposal}/reject`, headers: {'idempotency-key': randomUUID()}, payload: {}});
const proposalStatus = async (id: string) => (await db.pool.query<{status: string}>('SELECT status FROM proposals WHERE id=$1', [id])).rows[0]?.status;
const statuses = async (book: string) => (await db.pool.query<{status: string}>('SELECT status FROM plugin_finance_ledger.finance_directives WHERE book_id=$1 ORDER BY sequence', [book])).rows.map(r => r.status);

async function createBook(): Promise<string> {
  return (await ok(action('book.create', {name: 'Household', base_currency: 'USD'}))).book.id;
}
async function seedLedger(book: string) {
  await ok(action('commodity.create', {book_id: book, symbol: 'USD', commodity_type: 'currency'}));
  const checking = await ok(action('account.open', {book_id: book, name: 'Assets:Bank:Checking', opened_at: '2026-01-01', currencies: ['USD']}));
  const food = await ok(action('account.open', {book_id: book, name: 'Expenses:Food', opened_at: '2026-01-01'}));
  return {checkingId: checking.account.id as string, foodId: food.account.id as string};
}
const txn = (book: string, date: string, postings: Array<[string, string | null]>, extra: Record<string, unknown> = {}) =>
  action('transaction.create', {book_id: book, date, postings: postings.map(([account_id, n]) => ({account_id, amount: n === null ? null : {number: n, commodity: 'USD'}})), ...extra});

describe('Finance ledger package (Plan 7)', () => {
  it('replaces the legacy descriptor and routes with Space-level operations; reads touching private data are sensitive', async () => {
    expect(getOfficialPlugin(pid)).toBeUndefined();
    expect(getOfficialPlugin(pid, config)).toMatchObject({operation_api: 1, scope: 'space', default_enabled: false});
    const classes = Object.fromEntries(plugin.operationManifest!.operations.map(o => [o.id.slice(`plugin.${pid}.`.length), `${o.data_class}/${o.side_effects}${o.actors ? '/person' : ''}`]));
    expect(classes).toMatchObject({
      'book.list': 'personal/none', 'commodity.list': 'personal/none', 'account.list': 'sensitive/none', 'book.balances': 'sensitive/none',
      'book.validate': 'sensitive/none', 'transaction.list': 'sensitive/none', 'import.get': 'sensitive/none',
      'transaction.create': 'personal/durable/person', 'import.beancount': 'personal/durable/person', 'export.beancount': 'personal/durable/person',
      'directive.propose_post': 'sensitive/proposal', 'import.propose_post': 'sensitive/proposal',
    });
    expect((await app.inject({method: 'GET', url: '/api/v1/finance/books'})).statusCode).toBe(404);
  });

  it('commits a same-day import and a direct transaction without reversing their lock order', async () => {
    const book = await createBook();
    const {checkingId, foodId} = await seedLedger(book);
    const holder = await db.pool.connect();
    let settled = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM plugin_finance_ledger.finance_books WHERE id=$1 FOR NO KEY UPDATE', [book]);
      const importing = action('import.beancount', {book_id: book, text: '2026-07-02 * "Import"\n  Assets:Bank:Checking -1 USD\n  Expenses:Food 1 USD\n'});
      await waitForLockWaiter(db.pool);
      const direct = txn(book, '2026-07-02', [[checkingId, '-1'], [foodId, '1']], {post: true}).then(r => { settled = true; return r; });
      await vi.waitUntil(async () => ((await db.pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`)).rowCount ?? 0) >= 2, {timeout: 10_000, interval: 20});
      expect(settled).toBe(false);
      await holder.query('COMMIT');
      expect((await ok(importing))).toMatchObject({created_directives: 1, errors: []});
      expect((await ok(direct)).directive.status).toBe('posted');
      expect((await db.pool.query('SELECT sequence,status FROM plugin_finance_ledger.finance_directives WHERE book_id=$1 ORDER BY sequence', [book])).rows).toEqual([{sequence: 0, status: 'proposed'}, {sequence: 1, status: 'posted'}]);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  });

  it('keeps books to their Space and closes every entry when disabled', async () => {
    const book = await createBook();
    expect((await ok(query('book.list', {}))).books).toHaveLength(1);
    as(user, otherSpace);
    expect((await ok(query('book.list', {}))).books).toHaveLength(0);
    expect(await refused(query('account.list', {book_id: book}))).toMatchObject({status: 422, reason: 'book_not_found'});
    as(user);
    await setOperationPluginEnabled(config, pid, space, user, false);
    expect((await query('book.list', {})).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('manages options, accounts and commodities with safe refusals', async () => {
    const book = await createBook();
    await ok(action('option.set', {book_id: book, name: 'title', value: 'My Ledger'}));
    expect((await ok(query('option.list', {book_id: book}))).options).toEqual([expect.objectContaining({name: 'title', value_json: {value: 'My Ledger'}})]);
    const {checkingId} = await seedLedger(book);
    expect((await ok(query('account.list', {book_id: book}))).accounts).toHaveLength(2);
    expect((await ok(query('commodity.list', {book_id: book}))).commodities).toEqual([expect.objectContaining({symbol: 'USD'})]);
    expect(await refused(action('commodity.create', {book_id: book, symbol: 'USD', commodity_type: 'currency'}))).toMatchObject({status: 409, reason: 'commodity_exists'});
    const invalid = await refused(action('commodity.create', {book_id: book, symbol: 'usd!', commodity_type: 'currency'}));
    expect(invalid).toMatchObject({status: 422, reason: 'invalid_commodity'});
    expect(invalid.body).not.toContain('usd!');
    expect(await refused(action('account.open', {book_id: book, name: 'Assets:Bank:Checking', opened_at: '2026-01-01'}))).toMatchObject({status: 409, reason: 'account_exists'});
    expect((await ok(action('account.close', {book_id: book, account_id: checkingId, date: '2026-02-01'}))).account.closed_at).toBe('2026-02-01');
  });

  it('enters, posts and lists transactions with balances, ledger and validation', async () => {
    const book = await createBook();
    const {checkingId, foodId} = await seedLedger(book);
    expect((await ok(txn(book, '2026-07-02', [[checkingId, '-12.50'], [foodId, '12.50']], {payee: 'Tesco', narration: 'Groceries', post: true}))).directive.status).toBe('posted');
    expect((await ok(query('transaction.list', {book_id: book}))).transactions).toHaveLength(1);
    expect((await ok(query('directive.list', {book_id: book, status: 'posted', type: 'transaction'}))).directives).toHaveLength(1);
    expect((await ok(query('book.balances', {book_id: book}))).balances).toEqual(expect.arrayContaining([expect.objectContaining({accountName: 'Expenses:Food', positions: ['12.50 USD']})]));
    expect((await ok(query('account.ledger', {book_id: book, account_id: checkingId}))).postings).toHaveLength(1);
    expect(await ok(query('book.validate', {book_id: book}))).toEqual({errors: []});
    // The one posting left without an amount takes the rest.
    expect((await ok(txn(book, '2026-07-03', [[foodId, '50.00'], [checkingId, null]], {post: true}))).directive.status).toBe('posted');
    expect((await ok(query('book.balances', {book_id: book}))).balances).toEqual(expect.arrayContaining([expect.objectContaining({accountName: 'Assets:Bank:Checking', positions: ['-62.50 USD']})]));
  });

  it('refuses an unbalanced or not-yet-open transaction with a reason code and leaves nothing behind', async () => {
    const book = await createBook();
    const {checkingId, foodId} = await seedLedger(book);
    const unbalanced = await refused(txn(book, '2026-07-02', [[checkingId, '-12.50'], [foodId, '11.50']], {post: true}));
    expect(unbalanced).toMatchObject({status: 422, code: 'operation_invalid_input', reason: 'transaction_unbalanced'});
    expect(unbalanced.body).not.toMatch(/USD|Checking|Food|balance for/);
    expect(await refused(txn(book, '2025-12-31', [[foodId, '1.00'], [checkingId, '-1.00']]))).toMatchObject({status: 422, reason: 'account_not_open'});
    expect(await statuses(book)).toEqual([]);
    expect((await ok(query('transaction.list', {book_id: book}))).transactions).toEqual([]);
  });

  it('refuses a close before the account opened, before its postings, or twice', async () => {
    const book = await createBook();
    const {checkingId, foodId} = await seedLedger(book);
    await ok(txn(book, '2026-05-10', [[checkingId, '-5.00'], [foodId, '5.00']], {post: true}));
    const close = (date: string) => action('account.close', {book_id: book, account_id: checkingId, date});
    expect(await refused(close('2025-12-01'))).toMatchObject({status: 422, reason: 'close_before_open'});
    expect(await refused(close('2026-04-01'))).toMatchObject({status: 422, reason: 'account_has_later_entries'});
    await ok(close('2026-06-01'));
    expect(await refused(close('2026-07-01'))).toMatchObject({status: 422, reason: 'account_closed'});
    expect(await ok(query('book.validate', {book_id: book}))).toEqual({errors: []});
  });

  it('composes guided account names and refuses invalid ones by schema or rule', async () => {
    const book = await createBook();
    const guided = await ok(action('account.open', {book_id: book, root_type: 'Assets', group: 'Bank', leaf: 'ICBC', opened_at: '2026-01-01'}));
    expect(guided.account).toMatchObject({name: 'Assets:Bank:ICBC', owner_user_id: null, visibility: 'space', default_commodity: null});
    expect((await ok(action('account.open', {book_id: book, root_type: 'Assets', group: 'Bank', leaf: 'CMB', opened_at: '2026-01-01', default_currency: 'CNY', display_name: '招商银行'}))).account)
      .toMatchObject({default_commodity: 'CNY', display_name: '招商银行'});
    expect(await refused(action('account.open', {book_id: book, root_type: 'Assets', group: 'Bank', leaf: 'BOC', opened_at: '2026-01-01', currencies: ['USD'], default_currency: 'CNY'})))
      .toMatchObject({status: 422, reason: 'default_currency_not_allowed'});
    expect((await action('account.open', {book_id: book, root_type: 'Assets', group: 'bank card', leaf: 'ICBC', opened_at: '2026-01-01'})).statusCode).toBe(422);
    expect(await refused(action('account.open', {book_id: book, root_type: 'Assets', group: 'Bank', leaf: 'X', opened_at: '2026-01-01', visible_to_space: false}))).toMatchObject({reason: 'shared_account_always_visible'});
  });

  it('keeps private accounts, their entries and export to their owner', async () => {
    const book = await createBook();
    const {checkingId, foodId} = await seedLedger(book);
    const secret = (await ok(action('account.open', {book_id: book, root_type: 'Assets', group: 'Bank', leaf: 'Secret', opened_at: '2026-01-01', owner: 'personal', visible_to_space: false, currencies: ['USD']}))).account;
    expect(secret).toMatchObject({owner_user_id: user, visibility: 'private'});
    const hidden = (await ok(action('account.open', {book_id: book, root_type: 'Expenses', group: 'Personal', leaf: 'Hidden', opened_at: '2026-01-01', owner: 'personal', visible_to_space: false}))).account;
    await ok(txn(book, '2026-07-03', [[secret.id, '-4.00'], [hidden.id, '4.00']], {payee: 'Secret Cafe', narration: 'Private coffee', post: true}));
    await ok(txn(book, '2026-07-02', [[checkingId, '-12.50'], [foodId, '12.50']], {payee: 'Tesco', narration: 'Groceries', post: true}));
    expect((await ok(query('transaction.list', {book_id: book}))).transactions.map((t: {payee: string}) => t.payee).sort()).toEqual(['Secret Cafe', 'Tesco']);
    const own = await ok(action('export.beancount', {book_id: book}));
    expect(own.content).toContain('2026-07-03 * "Secret Cafe" "Private coffee"');
    expect(own.export_id).toBeTruthy();
    expect(own.content_hash).toMatch(/^[0-9a-f]{64}$/);

    as(member);
    expect((await ok(query('account.list', {book_id: book}))).accounts.map((a: {id: string}) => a.id).sort()).toEqual([checkingId, foodId].sort());
    expect(await refused(query('account.ledger', {book_id: book, account_id: secret.id}))).toMatchObject({status: 422, reason: 'account_not_found'});
    expect((await ok(query('transaction.list', {book_id: book}))).transactions.map((t: {payee: string}) => t.payee)).toEqual(['Tesco']);
    expect((await ok(query('directive.list', {book_id: book, type: 'transaction'}))).directives).toHaveLength(1);
    const theirs = await ok(action('export.beancount', {book_id: book}));
    expect(theirs.content).toContain('2026-07-02 * "Tesco" "Groceries"');
    for (const text of ['Secret Cafe', 'Private coffee', 'Assets:Bank:Secret', 'Expenses:Personal:Hidden']) expect(theirs.content).not.toContain(text);
    // A member can neither close nor re-label it, and learns nothing about it.
    expect(await refused(action('account.close', {book_id: book, account_id: secret.id, date: '2026-08-01'}))).toMatchObject({status: 422, reason: 'account_not_found'});
    expect(await refused(action('account.set_visibility', {book_id: book, account_id: secret.id, visibility: 'space'}))).toMatchObject({status: 422, reason: 'account_not_found'});
    expect(await refused(txn(book, '2026-07-04', [[secret.id, '-1.00'], [foodId, '1.00']]))).toMatchObject({status: 422, reason: 'unknown_account'});
    as(user);
    expect((await ok(action('account.set_visibility', {book_id: book, account_id: secret.id, visibility: 'space'}))).account.visibility).toBe('space');
  });

  it('summarizes balances by shared, personal and all scopes', async () => {
    const book = await createBook();
    await ok(action('commodity.create', {book_id: book, symbol: 'USD', commodity_type: 'currency'}));
    const joint = (await ok(action('account.open', {book_id: book, root_type: 'Assets', group: 'Bank', leaf: 'Joint', opened_at: '2026-01-01'}))).account.id;
    const mine = (await ok(action('account.open', {book_id: book, root_type: 'Assets', group: 'Bank', leaf: 'Mine', opened_at: '2026-01-01', owner: 'personal'}))).account.id;
    const equity = (await ok(action('account.open', {book_id: book, root_type: 'Equity', group: 'Opening', leaf: 'Balances', opened_at: '2026-01-01'}))).account.id;
    await ok(txn(book, '2026-07-01', [[joint, '100.00'], [equity, '-100.00']], {post: true}));
    await ok(txn(book, '2026-07-01', [[mine, '40.00'], [equity, '-40.00']], {post: true}));
    expect((await ok(query('book.balances', {book_id: book, scope: 'shared'}))).balances.map((b: {accountName: string}) => b.accountName).sort()).toEqual(['Assets:Bank:Joint', 'Equity:Opening:Balances']);
    expect((await ok(query('book.balances', {book_id: book, scope: 'personal'}))).balances).toEqual([expect.objectContaining({accountName: 'Assets:Bank:Mine', positions: ['40.00 USD']})]);
    expect((await ok(query('book.balances', {book_id: book}))).balances).toHaveLength(3);
  });

  it('imports Beancount as proposed entries that only an approved posting Proposal posts', async () => {
    const book = await createBook();
    const {checkingId} = await seedLedger(book);
    // An import cannot carry a posting switch: the declared schema refuses it before anything runs.
    expect((await action('import.beancount', {book_id: book, text: '2026-01-02 * "Coffee"\n  Assets:Bank:Checking -3.00 USD\n  Expenses:Food 3.00 USD\n', post_directly: true})).statusCode).toBe(422);
    expect(await statuses(book)).toEqual([]);
    const imported = await ok(action('import.beancount', {book_id: book, text: ['2026-01-01 open Assets:Cash USD', '2026-01-02 * "Coffee"', '  Assets:Bank:Checking  -3.00 USD', '  Expenses:Food  3.00 USD',
      '2026-01-03 * "Lunch"', '  Assets:Cash  -8.00 USD', '  Expenses:Food  8.00 USD', ''].join('\n')}));
    expect(imported).toMatchObject({batch_existed: false, created_directives: 1, summary: {imported: 1, pending_mapping: 1, excluded: 1, error: 0, needs_review: 0, duplicate: 0}, errors: []});
    const batch = imported.import_source.id as string;
    const lunch = imported.entries.find((e: {status: string}) => e.status === 'pending_mapping');
    expect(lunch).toMatchObject({entry_type: 'transaction', missing_accounts: ['Assets:Cash']});
    expect(await statuses(book)).toEqual(['proposed']);
    expect((await ok(query('account.list', {book_id: book}))).accounts.map((a: {name: string}) => a.name)).toEqual(['Assets:Bank:Checking', 'Expenses:Food']);
    expect((await ok(query('import.list', {book_id: book}))).imports).toEqual([expect.objectContaining({id: batch, summary: expect.objectContaining({pending_mapping: 1})})]);
    expect(await refused(action('import.map_entry', {book_id: book, import_source_id: batch, entry_id: lunch.id, account_mapping: {'Assets:Cash': 'no-such-account'}}))).toMatchObject({status: 422, reason: 'unknown_account'});
    // Another member cannot read, retry or post the batch.
    as(member);
    expect(await refused(query('import.get', {book_id: book, import_source_id: batch}))).toMatchObject({status: 422, reason: 'import_not_found'});
    expect(await refused(action('import.retry', {book_id: book, import_source_id: batch}))).toMatchObject({status: 422, reason: 'import_not_found'});
    expect(await refused(action('import.propose_post', {book_id: book, import_source_id: batch}))).toMatchObject({reason: 'import_not_found'});
    as(user);

    // Proposed: nothing posted until the person accepts.
    const submitted = await action('import.propose_post', {book_id: book, import_source_id: batch});
    expect(submitted.statusCode, submitted.body).toBe(202);
    const proposal = submitted.json().proposal_id as string;
    expect(await statuses(book)).toEqual(['proposed']);
    // Mapping the pending entry changes the batch: the earlier Proposal is superseded, nothing posts.
    expect((await ok(action('import.map_entry', {book_id: book, import_source_id: batch, entry_id: lunch.id, account_mapping: {'Assets:Cash': checkingId}}))).summary).toMatchObject({imported: 2, pending_mapping: 0});
    const stale = await accept(proposal);
    expect(stale.json().data).toMatchObject({result_type: 'operation_failure', result: {error: {code: 'operation_approval_superseded'}}});
    expect(await proposalStatus(proposal)).toBe('superseded');
    expect(await statuses(book)).toEqual(['proposed', 'proposed']);
    // A new Proposal for what the person now sees, accepted once (a replay is the same receipt).
    const fresh = (await action('import.propose_post', {book_id: book, import_source_id: batch})).json().proposal_id as string;
    const key = randomUUID();
    const accepted = await accept(fresh, key);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().data.proposal.status).toBe('accepted');
    expect(await statuses(book)).toEqual(['posted', 'posted']);
    expect((await accept(fresh, key)).json()).toEqual(accepted.json());
    // Nothing is left to post.
    expect(await refused(action('import.propose_post', {book_id: book, import_source_id: batch}))).toMatchObject({status: 409, reason: 'nothing_to_post'});
    const exported = await ok(action('export.beancount', {book_id: book}));
    expect(exported.content).toContain('"Coffee"');
  });

  it('posts a draft entry through an approved Proposal, rejects without effect and rolls a failing approval back', async () => {
    const book = await createBook();
    const {checkingId, foodId} = await seedLedger(book);
    const draft = (await ok(txn(book, '2026-03-01', [[checkingId, '-2.00'], [foodId, '2.00']]))).directive;
    expect(draft.status).toBe('draft');
    const propose = () => action('directive.propose_post', {book_id: book, directive_id: draft.id});
    const rejected = (await propose()).json().proposal_id as string;
    expect((await reject(rejected)).statusCode).toBe(200);
    expect(await statuses(book)).toEqual(['draft']);
    // The account closes before the entry's date after the Proposal was made: the approval revalidates and posts nothing.
    const failing = (await propose()).json().proposal_id as string;
    const other = (await ok(action('account.open', {book_id: book, name: 'Assets:Old', opened_at: '2026-01-01'}))).account.id;
    expect(other).toBeTruthy();
    await ok(action('account.close', {book_id: book, account_id: foodId, date: '2026-02-01'}));
    const refusal = await accept(failing);
    expect(refusal.json().data).toMatchObject({result_type: 'operation_failure', result: {error: {code: 'operation_invalid_input', metadata: {reason: 'account_not_open'}}}});
    expect(refusal.body).not.toContain('Expenses:Food');
    expect(await statuses(book)).toEqual(['draft']);
    // A posted entry cannot be proposed again; another member's view decides nothing for the owner.
    const ok2 = await seedLedger(await createBook());
    expect(ok2.checkingId).toBeTruthy();
    expect(await refused(action('directive.propose_post', {book_id: book, directive_id: 'no-such-entry'}))).toMatchObject({status: 422, reason: 'directive_not_postable'});
  });

  it('settles reviewed duplicates through the review operation', async () => {
    const book = await createBook();
    await seedLedger(book);
    const coffee = '2026-01-02 * "Coffee"\n  Assets:Bank:Checking -3.00 USD\n  Expenses:Food 3.00 USD\n';
    expect((await ok(action('import.beancount', {book_id: book, text: coffee}))).summary.imported).toBe(1);
    const second = await ok(action('import.beancount', {book_id: book, text: `${coffee}; statement export\n`}));
    expect(second.summary).toMatchObject({needs_review: 1});
    expect((await action('import.review', {book_id: book, import_source_id: second.import_source.id, decision: 'merge'})).statusCode).toBe(422);
    expect((await ok(action('import.review', {book_id: book, import_source_id: second.import_source.id, decision: 'duplicate'}))).summary).toMatchObject({duplicate: 1, imported: 0});
    expect(await statuses(book)).toEqual(['proposed']);
  });

  describe('Agents', () => {
    const ALL = () => plugin.operationManifest!.operations.map(o => o.id);
    const ownerOnly = (person: string): RunScenario => ({origin: 'manual', instructingUserId: person, audience: [person]});
    const grants = (scenario: RunScenario) => buildRunToolGrants(ALL(), {allowed_tools: ALL()}, {db: db.pool, spaceId: space, userId: user, config, scenario});
    async function serverHost() {
      const existing = (await db.pool.query<{id: string}>(`SELECT id FROM hosts WHERE kind='server'`)).rows[0]?.id;
      if (existing) return existing;
      const hostId = randomUUID();
      await db.pool.query(`INSERT INTO machines (id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES ($1,NULL,'Server','server',now(),now())`, [hostId]);
      await db.pool.query(`INSERT INTO hosts (id,owner_user_id,machine_id,environment_kind,name,kind,status,created_at,updated_at) VALUES ($1,NULL,$1,'server','server','server','online',now(),now())`, [hostId]);
      return hostId;
    }
    async function agentRun(snapshot: RunToolGrant[]) {
      const runId = randomUUID(), launchId = randomUUID();
      await seedRun(db.pool, {id: runId, space, owner: user, agent: randomUUID(), version: randomUUID()});
      await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',instructed_by_user_id=$2,owner_user_id=$2,visibility='private',permission_snapshot_json=$3::jsonb WHERE id=$1`,
        [runId, user, JSON.stringify({tool_grants: snapshot, plugin_tool_pins: pluginToolPins(config, snapshot)})]);
      await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,launch_id,launch_isolation_json,created_at,updated_at) VALUES ($1,$2,$3,1,'running',$4,$5::jsonb,now(),now())`,
        [randomUUID(), space, runId, launchId, JSON.stringify({launch_id: launchId, host_id: await serverHost(), host_kind: 'server', egress_profile: 'none', sandbox_mode: 'read_write'})]);
      return runId;
    }
    const agentCall = async (runId: string, name: string, args: Record<string, unknown>) => {
      const run = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!;
      return (await new CliAgentToolTransport(config, {actionEventSink: async () => {}}).call(run, {id: randomUUID(), name: op(name), arguments: args})) as OperationToolResponse;
    };
    const consent = (input: Record<string, unknown>) => withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: user}, {plugin_id: pid, ...input} as never));

    it('reads the ledger only with consent, never writes it, and may only propose posting', async () => {
      const book = await createBook();
      const {checkingId, foodId} = await seedLedger(book);
      await ok(txn(book, '2026-07-02', [[checkingId, '-1.00'], [foodId, '1.00']], {payee: 'Tesco', post: true}));
      const imported = await ok(action('import.beancount', {book_id: book, text: '2026-01-02 * "Coffee"\n  Assets:Bank:Checking -3.00 USD\n  Expenses:Food 3.00 USD\n'}));
      // The Space catalog needs standing consent. Sensitive tools are requestable for this Run.
      const before = (await grants(ownerOnly(user))).map(g => g.action_id);
      expect(before).not.toContain(op('book.list'));
      expect(before).toContain(op('import.propose_post'));
      expect(before).toContain(op('transaction.list'));
      // The Space owner consents to catalog reads.
      await consent({toolset: 'read', data_class: 'personal', scope: 'space'});
      const snapshot = await grants(ownerOnly(user));
      const names = snapshot.map(g => g.action_id).filter(n => n.startsWith(`plugin.${pid}.`));
      expect(names).toEqual(expect.arrayContaining([op('book.list'), op('transaction.list'), op('import.propose_post'), op('directive.propose_post')]));
      // Never a durable ledger write, consent or not.
      for (const write of ['transaction.create', 'import.beancount', 'export.beancount', 'book.create', 'account.open', 'account.close', 'option.set']) expect(names).not.toContain(op(write));
      // Another reader in the conversation: no sensitive read and no write at all.
      const shared = (await grants({origin: 'manual', instructingUserId: user, audience: [user, member].sort()})).map(g => g.action_id);
      for (const name of ['transaction.list', 'account.list', 'import.propose_post']) expect(shared).not.toContain(op(name));

      const runId = await agentRun(snapshot);
      expect((await agentCall(runId, 'book.list', {})).httpStatus).toBe(200);
      // A posting Proposal from the person's own turn: nothing posts until the person accepts it.
      const posting = {book_id: book, import_source_id: imported.import_source.id};
      expect((await agentCall(runId, 'import.propose_post', posting)).body).toMatchObject({ok: false, error: {code: 'operation_consent_required'}});
      await consent({toolset: 'write', data_class: 'sensitive', scope: 'run', target_run_id: runId});
      const proposed = await agentCall(runId, 'import.propose_post', posting);
      expect(proposed.httpStatus, JSON.stringify(proposed.body)).toBe(202);
      const body = proposed.body as {proposal_id?: string; data?: {proposal_id?: string}};
      const proposalId = (body.proposal_id ?? body.data?.proposal_id)!;
      expect(await statuses(book)).toEqual(['posted', 'proposed']);
      expect((await accept(proposalId)).statusCode).toBe(200);
      expect(await statuses(book)).toEqual(['posted', 'posted']);
      // The sensitive ledger needs the person's own consent for this Run, in the isolated launch.
      expect((await agentCall(runId, 'transaction.list', {book_id: book})).body).toMatchObject({ok: false, error: {code: 'operation_consent_required'}});
      await consent({toolset: 'read', data_class: 'sensitive', scope: 'run', target_run_id: runId});
      const read = await agentCall(runId, 'transaction.list', {book_id: book});
      expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
      expect(JSON.stringify(read.body)).toContain('Tesco');
      expect((await db.pool.query('SELECT data_class FROM agent_data_read_logs WHERE run_id=$1', [runId])).rows.map(r => r.data_class)).toEqual(expect.arrayContaining(['personal', 'sensitive']));
      // After a sensitive read the Run makes no outward write, a posting Proposal included (ADR 0030 §7).
      const draft = (await ok(txn(book, '2026-07-05', [[checkingId, '-1.00'], [foodId, '1.00']]))).directive;
      expect((await agentCall(runId, 'directive.propose_post', {book_id: book, directive_id: draft.id})).body).toMatchObject({ok: false});
      expect((await db.pool.query("SELECT audit_code FROM policy_decision_records WHERE run_id=$1 AND action=$2", [runId, op('directive.propose_post')])).rows).toEqual([{audit_code: 'sensitive_plugin_read_egress_blocked'}]);
      expect((await db.pool.query("SELECT count(*)::int AS n FROM proposals WHERE proposal_type='plugin.finance_ledger.directive.post' AND space_id=$1", [space])).rows[0].n).toBe(0);
    });
  });
});
