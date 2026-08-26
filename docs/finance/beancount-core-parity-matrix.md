# Beancount Core Parity Matrix

Status: living parity tracker. Phase 0 audit through Phase 8 (validation
rules, DB-backed importer/exporter, proposal appliers, REST API) are
implemented. Re-audited against the upstream master (v3) branch on 2026-07-02:
`core/data.py`, `core/flags.py`, `core/convert.py`, `core/interpolate.py`,
`ops/validation.py`, `ops/balance.py`, `ops/pad.py`.

## Scope

Rainver Finance Ledger targets Beancount v3 core ledger compatibility while
keeping PostgreSQL as the runtime source of truth. Beancount text is an
import/export compatibility format, not primary storage.

The upstream reference is the Beancount repository v3 branch:

- Repository: <https://github.com/beancount/beancount>
- `beancount/core/data.py`
- `beancount/parser/grammar.y`
- `beancount/parser/options.py`
- `beancount/loader.py`
- `beancount/core/amount.py`
- `beancount/core/position.py`
- `beancount/core/inventory.py`
- `beancount/ops/validation.py`
- `beancount/parser/printer.py`

Licensing boundary: Beancount is GPLv2 only. This matrix records public
concepts and compatibility targets. The Rainver implementation must
reimplement behavior in TypeScript and must not copy GPL source into this
repository without an explicit license decision.

## Status Values

- `implemented` - implemented and covered by tests.
- `partial` - implemented for a safe subset, with known gaps listed.
- `stored_export_only` - stored and exportable, but not executed/transformed.
- `deferred` - not implemented yet, intentionally listed.
- `not_applicable` - deliberately outside Rainver's runtime responsibility.

## Phase Mapping

- Phase 1 implements value objects: `Amount`, `Cost`, `CostSpec`, `Position`,
  `Inventory`, and `Booking`.
- Phase 2 implements PostgreSQL storage for the directive stream.
- Phase 3 implements repository/service methods over the stored stream.
- Phase 4 implements the initial engine pipeline: load, normalize, sort,
  interpolate limited incomplete postings, validate, and export domain entries.
- Phase 5 implements the committed-ledger validation set mirroring
  `ops/validation.py` plus weight-based transaction balancing
  (`core/convert.get_weight`), inferred tolerances (`core/interpolate.py`,
  `ops/balance.py`), subtree balance assertions, and pad-at-pad-date
  semantics (`ops/pad.py`).
- Phase 6 implements the DB-backed importer (deduplicated
  `finance_import_sources`, default `proposed` status, full directive-stream
  persistence including cost/price/metadata/tag-meta stacks) and the exporter
  covering every stored core directive with a `finance_exports` audit row.
- Phase 7 implements proposal appliers `finance_ledger.post_directive` and
  `finance_ledger.post_import_batch` with apply-time revalidation.
- Phase 8 implements the `/api/v1/finance` route surface behind
  `ctx.http.pluginGuard()`.

## Matrix

| Beancount concept | Source file | Rainver domain model | PostgreSQL storage | API/export support | Tests | Status |
|---|---|---|---|---|---|---|
| Directive stream / entries | `core/data.py`, `loader.py` | `LedgerEntry` union sorted by Beancount-compatible entry key | `finance_directives` plus directive-specific tables | Engine loads from text or DB; exporter renders the stored stream; REST routes list directives | `financeLedgerEngine.test.ts`, `financeLedgerImportExport.test.ts` | implemented |
| Source metadata: filename / lineno | `core/data.py`, `loader.py`, `parser/grammar.y` | `SourceLocation` on directives and imports | `finance_directives.source_filename`, `source_lineno`, `source_hash`, `finance_import_sources` | Importer persists source locations; validation errors carry them | `financeLedgerImportExport.test.ts` | implemented |
| Metadata key-value values | `core/data.py`, `parser/grammar.y` | `EntryMetadata` scalar union (string/number/boolean/null) | `metadata_json` on directives/transactions/postings; normalized metadata tables reserved | Importer parses `key: value` lines; exporter prints them | `financeLedgerEngine.test.ts` roundtrip | partial |
| `Open` directive | `core/data.py`, `parser/grammar.y`, `ops/validation.py` | `OpenEntry`, `FinanceAccount` active interval | `finance_accounts`, `finance_directives` | Service/routes/import open accounts; exporter emits `open` with currencies/booking | `financeLedgerService.test.ts`, `financeLedgerRoutes.test.ts` | implemented |
| `Close` directive | `core/data.py`, `ops/validation.py` | `CloseEntry`, account `closed_at` | `finance_accounts.closed_at`, `finance_directives` | Service/routes/import close accounts; exporter emits `close` | `financeLedgerService.test.ts`, `financeLedgerRoutes.test.ts` | implemented |
| `Commodity` directive | `core/data.py`, `parser/grammar.y`, `ops/validation.py` | `CommodityEntry`, `FinanceCommodity` (declared_date preserved) | `finance_commodities`, `finance_directives` | Service/routes/import create commodities; exporter emits `commodity` | `financeLedgerService.test.ts`, `financeLedgerImportExport.test.ts` | implemented |
| `Pad` directive | `core/data.py`, `parser/grammar.y`, `ops/pad.py` | `PadEntry`; synthetic `P` transaction at the pad's own date | `finance_pad_directives`, `finance_directives` | Engine pads subtree balances before assertions; exporter emits the raw `pad` directive | `financeLedgerEngine.test.ts`, `financeLedgerImportExport.test.ts` | partial |
| `Balance` directive | `core/data.py`, `ops/balance.py` | `BalanceEntry` with amount and optional tolerance | `finance_balance_assertions`, `finance_directives` | Validator checks subtree running balance with explicit or inferred (full last digit) tolerance | `financeLedgerEngine.test.ts` | implemented |
| `Transaction` directive | `core/data.py`, `parser/grammar.y`, `ops/validation.py` | `TransactionEntry` with postings/tags/links | `finance_transactions`, `finance_postings` | Draft/propose/post lifecycle; weight-based balance gate on posting; exporter emits blocks | `financeLedgerService.test.ts`, `financeLedgerRoutes.test.ts` | implemented |
| `Posting` | `core/data.py`, `core/position.py`, `parser/grammar.y` | `PostingEntry` with optional units, cost, price, flag, metadata | `finance_postings` incl. cost/price columns | Full parse/store/export of units, cost, price, flag, metadata | `financeLedgerImportExport.test.ts` | implemented |
| `Note` directive | `core/data.py`, `parser/grammar.y` | `NoteEntry` | `finance_notes`, `finance_directives` | Imported/stored/exported | `financeLedgerImportExport.test.ts` | implemented |
| `Event` directive | `core/data.py`, `parser/grammar.y` | `EventEntry` | `finance_events`, `finance_directives` | Imported/stored/exported | `financeLedgerImportExport.test.ts` | implemented |
| `Query` directive | `core/data.py`, `parser/grammar.y` | `QueryEntry` | `finance_queries`, `finance_directives` | Imported/stored/exported, not executed as BQL | `financeLedgerImportExport.test.ts` | stored_export_only |
| `Price` directive | `core/data.py`, `parser/grammar.y` | `PriceEntry` | `finance_prices`, `finance_directives` | Imported/stored/exported; no realtime fetching | `financeLedgerImportExport.test.ts` | implemented |
| `Document` directive | `core/data.py`, `parser/grammar.y`, `ops/validation.py` | `DocumentEntry` | `finance_documents`, `finance_directives` | Imported/stored/exported; empty paths rejected (absolute-path rule intentionally replaced, see gaps) | `financeLedgerEngine.test.ts` | partial |
| `Custom` directive | `core/data.py`, `parser/grammar.y` | `CustomEntry` with raw value tokens | `finance_custom_directives`, `finance_custom_directive_values` | Imported/stored/exported; values kept as raw tokens | `financeLedgerImportExport.test.ts` | stored_export_only |
| `option` | `parser/options.py`, `parser/grammar.y`, `loader.py` | `OptionEntry` / `LedgerOption` | `finance_ledger_options` | Routes read/write options; import persists; export emits stored options plus book title/operating currency | `financeLedgerRoutes.test.ts`, `financeLedgerImportExport.test.ts` | partial |
| `include` | `parser/grammar.y`, `loader.py` | `IncludeEntry` | `finance_includes` | Imported/stored/exported; external file resolution deferred to safe import bundles | `financeLedgerImportExport.test.ts` | stored_export_only |
| `plugin` directive | `parser/grammar.y`, `loader.py` | `PluginEntry` | `finance_plugin_directives` | Imported/stored/exported; Python plugin execution is not performed | `financeLedgerImportExport.test.ts` | stored_export_only |
| `pushtag` / `poptag` | `parser/grammar.y`, `loader.py` | `TagStackEntry`; active tags applied to parsed transactions | `finance_tag_stack_events` | Parser applies pushed tags to transactions; events stored/exported | `financeLedgerEngine.test.ts`, `financeLedgerImportExport.test.ts` | implemented |
| `pushmeta` / `popmeta` | `parser/grammar.y`, `loader.py` | `MetaStackEntry`; active meta applied to parsed transactions | `finance_meta_stack_events` | Parser applies pushed metadata to transactions; events stored/exported | `financeLedgerImportExport.test.ts` | implemented |
| Transaction flags: `*`, `!`, `txn`, others | `core/data.py`, `core/flags.py`, `parser/grammar.y` | Flag string validated against the `core/flags.py` set; `txn` normalizes to `*` | `finance_transactions.flag` | Invalid flags rejected with `invalid_flag`; no workflow semantics attached | `financeLedgerEngine.test.ts` | implemented |
| Posting flag | `core/data.py`, `parser/grammar.y` | `PostingEntry.flag` validated against the flag set | `finance_postings.flag` | Stored/exported; invalid flags rejected | `financeLedgerEngine.test.ts` | implemented |
| Tags | `core/data.py`, `parser/grammar.y` | `Set<string>` on tag-capable directives | `finance_transactions.tags`, notes/documents `tags` arrays | Exporter emits `#tag`; push-tag inheritance applied | Tag fixtures in import/export tests | implemented |
| Links | `core/data.py`, `parser/grammar.y` | `Set<string>` on tag-capable directives | `finance_transactions.links`, notes/documents `links` arrays | Exporter emits `^link` | Link fixtures in import/export tests | implemented |
| Payee / narration | `core/data.py`, `parser/grammar.y` | `TransactionEntry.payee` / `.narration` | `finance_transactions` | Stored/exported | `financeLedgerService.test.ts` | implemented |
| Price annotation `@` / `@@` | `core/data.py`, `parser/grammar.y`, `core/convert.py` | `PostingEntry.price` + `priceIsTotal` | `finance_postings.price_*`, `price_is_total` | Parsed/stored/exported; enters weight-based balancing per `get_weight` | `financeLedgerEngine.test.ts` | implemented |
| Cost syntax `{}` / `{{}}` | `core/position.py`, `parser/grammar.y` | `Cost` for fully-specified lots; `CostSpec` otherwise | `finance_postings.cost_*` columns | Parsed/stored/exported incl. date/label/merge; weight balancing at cost; lot booking deferred | `financeLedgerEngine.test.ts`, `financeLedgerImportExport.test.ts` | partial |
| Balance tolerance `~` | `core/data.py`, `parser/grammar.y`, `ops/balance.py` | `BalanceEntry.tolerance` | `finance_balance_assertions.tolerance_*` | Explicit tolerance honored; otherwise inferred as one unit of the last digit | `financeLedgerEngine.test.ts` | implemented |
| Transaction balancing tolerance | `core/interpolate.py` | Per-currency inferred tolerance (half last digit, integers excluded) | n/a (computed) | Weight residuals within tolerance balance; cost/price expansion approximated by cost/price number scale | `financeLedgerEngine.test.ts` | partial |
| Incomplete posting | `core/data.py`, `parser/grammar.y`, `core/interpolate.py` | Posting with `units = null` | Nullable amount/commodity fields on `finance_postings` | Engine interpolates exactly one missing posting from residual weights (single weight currency) | `financeLedgerEngine.test.ts` | partial |
| `Amount` | `core/amount.py` | Immutable TypeScript `Amount` using decimal text arithmetic | Numeric plus preserved text/scale in amount-bearing tables | Formatter uses canonical decimal text | `financeLedgerValueObjects.test.ts` | implemented |
| `Cost` | `core/position.py` | Immutable TypeScript `Cost` | `finance_postings.cost_*` | Formatter/exporter emits cost blocks | `financeLedgerValueObjects.test.ts` | implemented |
| `CostSpec` | `core/position.py` | Immutable TypeScript `CostSpec` for unresolved lots | `finance_postings.cost_spec_*` or nullable cost columns | Stored/exported; full booking deferred | `financeLedgerValueObjects.test.ts` | partial |
| `Position` | `core/position.py` | Immutable TypeScript `Position` | Reconstructed from postings | Inventory and formatter use it | `financeLedgerValueObjects.test.ts` | implemented |
| `Inventory` | `core/inventory.py` | TypeScript inventory grouped by unit currency and cost key | Recomputed from directive stream, not primary storage | Balance computation returns inventory summaries | `financeLedgerValueObjects.test.ts` and Phase 4 tests | partial |
| `Booking.STRICT` | `core/data.py`, `core/inventory.py` | Booking enum | `finance_accounts.booking_method` | Stored; strict ambiguity enforcement limited | `financeLedgerValueObjects.test.ts` | partial |
| `Booking.STRICT_WITH_SIZE` | `core/data.py` | Booking enum | `finance_accounts.booking_method` | Stored/exported; full lot matching deferred | `financeLedgerValueObjects.test.ts` | stored_export_only |
| `Booking.NONE` | `core/data.py` | Booking enum | `finance_accounts.booking_method` | Stored/exported; mixed inventory accepted only in explicit paths | `financeLedgerValueObjects.test.ts` | partial |
| `Booking.AVERAGE` | `core/data.py`, `core/inventory.py` | Booking enum | `finance_accounts.booking_method` | Stored/exported; average-cost transformation deferred | Booking fixture records deferred behavior | deferred |
| `Booking.FIFO` | `core/data.py`, `core/inventory.py` | Booking enum | `finance_accounts.booking_method` | Stored/exported; FIFO lot matching deferred | Booking fixture records deferred behavior | deferred |
| `Booking.LIFO` | `core/data.py`, `core/inventory.py` | Booking enum | `finance_accounts.booking_method` | Stored/exported; LIFO lot matching deferred | Booking fixture records deferred behavior | deferred |
| `Booking.HIFO` | `core/data.py`, `core/inventory.py` | Booking enum | `finance_accounts.booking_method` | Stored/exported; HIFO lot matching deferred | Booking fixture records deferred behavior | deferred |
| Entry sort key | `core/data.py`, `loader.py` | `entrySortKey(date, SORT_ORDER, lineno/sequence)`; SORT_ORDER matches upstream (`open:-2, balance:-1, document:1, close:2`) | `finance_directives.date`, `sequence`, `source_lineno` | Engine/exporter sort deterministically | `financeLedgerEngine.test.ts` | implemented |
| Loader pipeline | `loader.py` | `FinanceLedgerEngine.loadFromDb/loadFromText` → normalize → sort → interpolate → pad → validate | Reads full directive stream, options, config directives, import sources | Returns entries/errors/options; DB load restricted to posted directives | `financeLedgerEngine.test.ts`, `financeLedgerImportExport.test.ts` | implemented |
| Built-in validation | `ops/validation.py` | `validateEntries()` mirrors BASIC_VALIDATIONS (open/close, active accounts, currency constraints, duplicate balances/commodities, document paths, transaction balances) | Errors returned as structured values, not stored | `POST /validate` route and import results return structured errors | `financeLedgerEngine.test.ts`, `financeLedgerRoutes.test.ts` | implemented |
| Printer/exporter | `parser/printer.py` | `BeancountExporter` | Reads stored directives | UTF-8 Beancount text; decimal text preserved; `finance_exports` audit row with content hash and validation summary; no column alignment | `financeLedgerImportExport.test.ts` roundtrip | implemented |
| Import dedup / provenance | n/a (Rainver) | `finance_import_sources` content-hash dedup, default `proposed` status | `finance_import_sources`, `finance_directives.import_source_id` | `POST /import/beancount`; `post_directly` requires a clean file | `financeLedgerImportExport.test.ts` | implemented |
| Proposal-gated posting | n/a (Rainver) | `finance_ledger.post_directive`, `finance_ledger.post_import_batch` appliers | `finance_directives.status/proposal_id` | Appliers revalidate at apply time; disabled plugin fails closed via host gating | `financeLedgerImportExport.test.ts`, `pluginHost.test.ts` | implemented |
| External Python plugin execution | `loader.py` | Not executed in Finance Ledger core | Plugin declarations stored only | Explicitly unsupported without future sandbox policy | Negative test for no execution | not_applicable |
| Realtime market prices | Not Beancount core | Future investment plugin concern | No storage in finance core beyond explicit `price` directives | No quote fetching | Boundary tests | not_applicable |

## Known Gaps

Divergences confirmed against upstream during the 2026-07-02 re-audit:

- Grammar: arithmetic number expressions (e.g. `10.00 / 2`), multi-line
  strings, and metadata values typed as dates/amounts/accounts are not parsed;
  metadata values roundtrip as strings.
- Documents: upstream `validate_documents_paths` requires absolute paths; this
  implementation intentionally rejects only empty paths and never touches host
  filesystem paths (`allow_document_paths: false` boundary).
- Pad: `Unused Pad entry` and pad-at-cost errors are not reported; padding is
  same-currency only.
- Transaction tolerance: upstream expands tolerance by `tolerance * cost/price
  number` for converted postings; this implementation approximates with the
  cost/price number's own scale.
- Booking: lot matching (`STRICT`, `STRICT_WITH_SIZE`, `AVERAGE`, `FIFO`,
  `LIFO`, `HIFO`) is stored/exported but not executed; `CostSpec` lots that
  cannot be weighed fail validation with `unsupported_cost_spec`.
- Interpolation: only a single missing posting with a single residual weight
  currency is interpolated; upstream interpolates missing cost/price numbers
  too.
- `validate_data_types` (HARDCORE_VALIDATIONS) is subsumed by TypeScript types
  and parse-time decimal/symbol guards rather than a separate pass.
- Printer output is semantically equivalent but not byte-identical to
  upstream (no currency column alignment).
- `include` resolution and arbitrary Python plugin execution remain
  intentionally unsupported.
- Export artifact persistence uses `finance_exports.artifact_id = null` until
  a host artifact port exists (documented parity gap per plan).
