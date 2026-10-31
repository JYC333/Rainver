# Shared Reader

The Reader is an independent document interaction domain. It owns generic
document payloads, selection anchors, highlights, comments, bookmarks, comment
threads, keyboard behavior, and the inspector. It does not own source ingestion
or Project Research synthesis.

The server entry points are `/api/v1/reader/*`. Document resolvers are supplied
by Sources for `source_item` and `source_snapshot`, and by Project Research for
`research_report`. `research_notebook` is an ordinary Note: it uses the
`space_object` content-access gate and requires `full` access, the same as
Notes detail. Every resolver applies its domain permission checks before
returning content. Research reference resolution additionally applies source
consent and returns only `unavailable` for inaccessible references.

`reader_annotations` targets `document_type + document_id`; supported types are
`source_item`, `source_snapshot`, `research_report`, and `research_notebook`.
Annotation visibility, ownership, and document access are checked
independently: an annotation takes its document's Project scope, but its
visibility defaults to `private` even on a shared document and may be widened
by its author only as far as the document's own visibility (ADR 0013 decision
5). A viewer whose level on an annotation is `summary` (summary-mode Space
oversight) sees it listed with its quote, anchor, and label withheld; its
comment threads need `full` access, and commenting, evidence, and proposals
from an annotation need `full` access as the person alone, without oversight.
Artifact annotations
and `/api/v1/sources/reader/*` do not exist.

The frontend `ReaderWorkspace` owns the document canvas, annotation layer,
selection toolbar, inspector, comment threads, shortcuts, and interaction
states. Library and Project Research are thin wrappers that supply their own
navigation, metadata, and domain actions.

### Workspace presentation and interaction contract

- Typography: the document pane is a CSS size container. The column is 38em
  wide at 18px (17px when the pane is at most 560px), line-height 1.75, with
  0.9em between top-level blocks, more above headings and a tight join below
  them. Paragraph/list resets use `:where()` and precede the spacing rule so
  they cannot zero it. These values are design starting points to calibrate.
- Lead: a wrapper may pass `lead` (the shared `ReaderDocumentLead`) for the full
  title and source metadata. It renders outside the ProseMirror tree, so
  annotation positions are unaffected. If the body opens with the same title as
  an h1, that heading is the page title and only metadata is shown; if it opens
  with the same title at a lower level, the lead keeps a screen-reader-only h1
  so the Reader always has exactly one main heading. Library passes the article
  title; Research passes the research question.
- Inspector: open by default on wide screens and closed below 769px, where it
  is an on-demand drawer (see the mobile client guide). The Reader also
  measures its own row: below 960px (Shell, Project navigation and side panes
  included) the inspector starts closed and overlays the text when opened
  instead of squeezing the column. Creating a comment opens it and focuses its
  field; a highlight, excerpt or bookmark never opens or selects anything — a
  toast confirms it with a View action that opens it. Wrappers show
  `ReaderPanelToggle`, which marks unsent drafts. Which panels were open is
  kept per browser in `rainver:reader-layout` (two booleans, on the logout
  keep-list); a phone always opens on the text.
- Docked panels: contents and notebook have pointer-captured resize separators
  with labelled vertical-separator semantics, current/min/max values and
  Left/Right/Home/End keyboard controls. Widths persist with panel-open state in
  `rainver:reader-layout`, validated to 200–360px (contents) / 280–480px
  (notebook). The visible maximum also reserves the text column; narrow overlays
  and phone drawers keep their existing sizing and expose no resize handle.
- Annotation lists: wrappers use `useReaderAnnotations` (document and list load
  independently). Only the latest list request for the current Space/document
  answers; a list that was in flight while this tab created or archived an
  annotation is discarded and fetched again. 401/403/404 clear the list and the
  document's drafts; other failures keep the confirmed list and offer a retry.
  A refusal advances an authority epoch, and so does the next successful read.
  Create and archive take the epoch when they start (wrappers pass the hook's
  `authority` as `annotationAuthority`); a response may change the list, select
  the annotation or report success only if the epoch, scope and access are
  unchanged. A create the server accepted before a refusal therefore stays out
  even after access returns; only a new authoritative read shows it. The hook
  itself ignores any list change while access is refused.
- Comment threads (`useCommentThreads`): only the latest request for the
  selected annotation of the current document answers; a list requested before
  a comment or resolve/reopen for that annotation completed is refetched. Each
  write applies only what it changed (a POST adds its comments, a status write
  sets the status), so a late POST snapshot cannot undo a resolve or the
  reverse; overlapping writes end with an authoritative reread. Loading and
  failure (with retry) are shown as such, never as "no comments". One status
  change per thread at a time.
- Access loss: a 401/403/404 for the annotation list or for the selected
  annotation's threads, or an authoritative list in which the selected
  annotation is gone or listed without its body (a summary-level viewer gets an
  empty quote and anchor), drops the selection, its quote and comments, any
  in-flight reads for it, and its draft. An ordinary failure (e.g. 500) keeps
  the selection and the draft for a retry. Summary-only annotations cannot be
  selected.
- Comment drafts (`commentDrafts.ts`) live outside the component lifecycle in
  this tab's memory only, keyed by Space, document and annotation. Leaving the
  Reader by any route (Shell links, browser history, programmatic navigation,
  document switches) keeps them; returning restores them with a visible
  "unsent comments" cue. Sending is claimed in the same store: a comment being
  sent shows as saving after leaving and returning and cannot be posted twice;
  leaving does not cancel it. Success removes the draft only if it still holds
  the sent text; failure keeps it for an explicit retry; when a send started by
  an earlier Reader instance lands, the threads are reread. Only Discard draft
  or a successful send removes a draft otherwise. Drafts and send claims are
  dropped on logout/401/other-tab logout (which also advances a session epoch,
  so a reply from the earlier session changes nothing), when the document or
  annotation becomes unreadable as above, after 24 hours, and beyond 20
  documents (least recently written first). Every removal notifies subscribers;
  reads never modify the store and already treat an expired draft as gone;
  expiry runs on a timer and again when the tab becomes visible or focused. A
  reload or closed tab loses memory, so the browser warns before unload while
  a live draft exists.
- Document versions and anchor placement: the payload carries `content_hash`
  (text) and `structure_hash` (hash of the canonical content tree as returned,
  i.e. after read-time normalization); new anchors record both. Placement
  (`components/reader/anchorResolution.ts`) uses only proofs: (1) the stored
  `tiptap_range` is used only when the anchor's `structure_hash` equals the
  document's and the range still holds the quote — a text hash never proves
  positions, so anchors made before structure hashes always relocate by text;
  (2) a quote that occurs exactly once is placed there; (3) a repeated quote is
  placed only when exactly one occurrence has the whole stored
  `before_context` immediately before it and the whole `after_context`
  immediately after it (an empty stored side means the document edge). A
  partial context match never decides. Anything else is unlocated: not
  painted, listed with quote and comments, with an explanation. Matching is
  whitespace-insensitive; all offsets are UTF-16 code units with no code-point
  conversion. Annotations and stored anchors are never rewritten when a body
  changes; a summary-level annotation (no quote) is never placed.
- Document content: stored documents are read through
  `@rainver/reader-document`'s normalizer, so an unsupported node degrades to
  text instead of hiding the document. The Reader schema shows bold, italic,
  strike, inline code, links, h1–h6, verbatim code blocks, nested lists, tables
  (with spans), block images and rules. Every stored tree is normalized to
  that schema (`readerSchemaValidity.test.ts` checks it with the Reader's own
  extensions, `readerContentExtensions()`): inline code carries no other mark
  (links included), and a list item opens with a paragraph (a heading there
  becomes a paragraph; any other first block gets an empty paragraph in
  front). `image_policy` from the stored document reaches the client; the
  Library Reader loads remote images inline only when it is not `none`
  (Agent-authored reading is `none`). Content and policy are applied in one
  step from the current props: on a policy change the view is first cleared
  under the old policy, then the policy switches, then this render's content
  is drawn. The editor's previous document is never redrawn under a new
  policy, so no image URL is written to an `<img>` under a policy that does
  not belong to its document, in either direction. A policy-only change
  redraws the same document (positions unchanged) and, like a content change,
  clears the selection.
- Late replies: annotation/comment replies for a document the reader has left,
  or from an unmounted workspace, are dropped. Annotation creation is owned per
  call: a document switch releases the pending state at once, and an older
  call's completion cannot release or alter a newer one.
- Creating an anchor (`anchorForSelection` in `anchorResolution.ts`): the quote
  and its `before_context`/`after_context` (80 characters each) are taken from
  the Reader's own whitespace-collapsed text at the selected ProseMirror
  range — the same text the resolver searches — so they describe the
  occurrence actually selected. That collapsed quote is for comparison only:
  "copy" copies the selection as it reads (`TextSelection.selectedText`, line
  breaks, indentation and runs of spaces kept; blocks joined by a line break).
  `text_range` is a place in the server's normalized text, which can differ
  from the tree's text (trimmed code indentation, table `|` and list
  separators); it is set only when the whole normalized text is the Reader's
  text with whitespace collapsed (leading whitespace aside), so offsets
  correspond. A matching number of occurrences is not proof (a table
  separator can remove one match and add another) and is not used. Otherwise
  the range is set just past the end of the normalized text, which the
  server's check never verifies (the annotation is stored `unverified`);
  nothing places annotations by `text_range`. Repeated text whose
  surroundings are identical within the windows is unlocated in another
  version, never placed on the other occurrence. Existing anchors are not
  rewritten.
- Selection toolbar: positioned against the visual viewport, preferring below
  the selection on coarse pointers (native copy menus sit above), re-measured on
  scroll/zoom/resize and docked when no side leaves the selection uncovered. A
  press on it does not let a collapsing browser selection discard the stored one.
- Shortcuts (`readerShortcuts.ts` holds the help table; the handler is in
  `ReaderWorkspace`): ↑/↓, H, N, `[` contents, `]` inspector, `/` find in this
  document, F focus mode, Esc, `?`. Every one has a visible button in the
  Reader's tool row (touch has no keyboard). They are ignored during IME
  composition (`isComposing`/keyCode 229), in editable fields, with
  Ctrl/Meta/Alt, for already-handled events, for targets outside the Reader,
  with focus inside a dialog/menu/listbox, and while an active modal owns the
  page (the app is aria-hidden/inert, or a visible `aria-modal` is open).
  Hidden or unfocused non-modal overlays do not disable them. ↑/↓ act only from
  the page or the text, never with Shift or on inspector controls. Action keys
  ignore auto-repeat. Esc clears the selection/focus first, then closes a
  drawer or overlaid inspector, then an overlaid contents list, then focus mode.
- Transient paragraph selection can be toggled off by clicking/tapping the same
  paragraph, cleared from the document gutter or outside the Reader, or dismissed
  with Escape (including its native browser range). Toolbar and inspector
  pointer actions retain the quote until used; dismissal never archives a saved
  highlight or discards comment drafts.
- Paragraph focus is a quiet neutral wash, with no colored left rail or card
  outline. It identifies the keyboard reading position without changing text
  geometry; native selection uses a separate translucent accent. Saved
  highlights retain their annotation color and a selected highlight strengthens
  its fill rather than outlining each wrapped fragment. Toolbar elevation is
  subtle. Saved highlights use an inline wash and a fine 1px underline, with no
  vertical padding that makes wrapped lines look boxed. These treatments apply
  in both themes; interaction and anchor logic are unchanged. This is an
  adaptation to the user's dislike of side indicators, not a Readwise clone:
  its [public reading screenshots](https://readwise.io/read) show line-shaped
  highlights; its [September 11, 2026 changelog](https://docs.readwise.io/changelog)
  explicitly offers hiding the distracting paragraph indicator. Public marketing
  shots and the older 2022 demo do not establish every current interaction state.
- `MarkdownReader` (digests, summaries) renders the same surface inside cards at
  a fixed 15px; block hover offsets apply only inside the Reader column, and only
  for a fine pointer (`hover: hover`), so a tap never leaves a block lit.

### Retained Source reading versions

The Source Reader header's **Version history** opens a paginated list of retained
extracted snapshots (25 per page, newest first, timestamp with seconds, current
artifact marked). `GET /api/v1/reader/source-items/:itemId/versions` accepts a
nonnegative `offset`; `.../versions/:snapshotId` reads one version. These are
body versions, separate from Reading method/prompt versions. No new storage or
migration is involved. A snapshot must belong to that item, and the parent item,
Source consent, snapshot, Artifact and originating Room gates all still apply;
summary-only or denied versions do not appear. Each request rechecks authority.

Library keeps the selected snapshot in `?version=…`, preserving Project/origin
and return navigation. The retained body uses the shared Reader with its own
snapshot identity, image policy, declared syntax and provenance, a read-only
banner and **Back to latest**. It does not record a current-item open, change
the current Artifact pointer, mark the item read or rewrite annotations.
Current-item annotations/drafts are not shown or copied onto old bodies; new
annotations, Markdown conversion, document-note creation and reprocessing are
not offered there. A private position on the snapshot is independent of the
current item's position. Restoring an old version and visual diffs are not
part of this viewing surface. Missing/denied bodies never fall back to another
version while pretending the requested version was opened.

### Reading position, appearance and reading tools

**First screen of a source item.** The text leads: when the material has text
and nothing is running, failed or waiting on consent, "Read again" is a quiet
line rather than a card; the Agent-provided notice keeps its warning sentence
visible and folds its source links into "Sources (n)"; the literal-Agent-text
choice ("Show as Markdown", see
[Source material processing](SOURCE_MATERIAL_PROCESSING.md)) sits in that
notice. Lists are indented on the reading side (`padding-inline-start`, so
right-to-left text indents on the right); a top-level list keeps its indent on
top of the hover block's inset, so markers stay inside the column on a phone
(checked in pixels at 320/390px by `reader-journeys.browser.mjs`).

**No text, no position.** A document without readable text (metadata only,
not prepared, preparation failed) shows no reading percentage or progress
panel, loads and saves no position and offers no back/reset; when its text
arrives (same document, new version) the position starts. A short real text
that fits on screen is read through (100%) — a different case.

**Scope.** Everything below belongs to `ReaderWorkspace`, so it applies to every
document shown in it: Library source items (`source_item`) and Project research
reports (`research_report`). The position API and its gate also accept
`source_snapshot` and `research_notebook`, and the Source history surface now shows `source_snapshot` with its own
position. No web Reader surface shows `research_notebook` (a Note opens in the
Notes editor), so no position is recorded for it. Reading-list progress, previous/next and "mark read and next" are Library
features over the unified Reading list (source items only).

- **Reading position** (`reader_positions`, `modules/reader/positions.ts`,
  `useReaderPosition`): private per person and document, never shared, never
  read status. `GET/PUT /api/v1/reader/documents/:type/:id/position` pass the
  document's own Reader gate on every call. A report carries the document
  version it was measured on (`content_hash`, `structure_hash`), the place
  (`block_index`, `pm_pos`, `text_offset`, ≤200-char quote, ≤80-char text
  before), its progress fraction and the time it was measured.
- **Server rules.** The server reads the document's current version through
  the Reader resolver without recording an open (`getDocument(…,
  { recordOpen: false })`); a report on any other version is not applied
  (`accepted: false`), however late its time, so a tab left open on an old
  version cannot take the position back or undo a reset. A stored position
  from an earlier version is replaced by the first current-version report.
  Within a version: `current` follows the latest `client_at`; `furthest` grows
  only from a report that `dwelled` (5 s at one place) and never drops on
  rereading; `reset_furthest` sets it to the current place, also backwards,
  and wins over reports measured before it. Concurrent first reports insert
  once (`ON CONFLICT DO NOTHING`, then the same transaction locks the row and
  applies the other). The version check and the write are one transaction
  with a fixed lock order: the document's own content row `FOR SHARE`
  (`source_items`, `source_snapshots`, `project_research_reports` or `notes`),
  then the position row `FOR UPDATE`; the current version is read on that
  transaction after the first lock. Content writers update that row (the
  canonical `saveSourceReadingDocument` locks it `FOR UPDATE`), so a rewrite
  either commits before the check (and the report is judged against it) or
  waits until the position is stored; writers never lock positions, so the
  order has no cycle. Every stored change increments `revision`. `client_at`
  is the clients' own clock: it orders reports of one version, a clock more
  than 5 minutes ahead is refused, and a clock up to 5 minutes fast can still
  outrank a correct one — a tie-breaker, not proof of real order across
  devices. Each write reads the current document once (the cost of a document
  read per save, at most every 1.5 s while reading).
- **Client.** Each measurement is an immutable snapshot of document, version
  and session epoch (`sessionEpoch()` in `lib/sessionResidue.ts`); a send uses
  only the snapshot, so a place measured before a document switch or a new
  version goes out with its own version (and the server then decides). A run
  is per document version: a new version of the same document starts a new
  run. Replies are shown only by increasing `revision`, so out-of-order
  replies cannot roll the display back; a reset the server did not accept is
  reported as not set. A 401/403/404, or the end of the session (logout,
  401, another tab's logout), clears the shown position, disables its
  actions, makes every reply in flight change nothing and sends nothing more —
  including on leaving. An ordinary failure is shown ("position not synced")
  with an explicit retry of the same write — measurement, its time, dwell and
  reset — reported like the original action (a retried reset says whether it
  was set); a pending failed reset is not replaced by a later ordinary
  failure, and the next stop also retries ordinary reports.
  A failed load (not a refusal) shows an error with retry, and nothing is
  saved until the position has loaded. Reports go 1.5 s after scrolling stops,
  again after the dwell, and on `pagehide` / hidden tab / leaving the document
  with `keepalive`: the browser may complete it after the page is gone, but
  that is best effort, not guaranteed. Nothing is reported until the restore
  is decided, so opening never saves "the top".
- **Restore.** After fonts are ready (≤1 s) the saved place is located: same
  version → its `pm_pos`; otherwise its full quote, if it occurs once, or —
  among all occurrences, never a capped list — exactly one with the same text
  before it (a saved context shorter than 40 characters means the place was
  that close to the start, so only the occurrence at that offset counts).
  Within the same version a fraction is a layout aid. Across versions an
  unlocated place does not move the reader: the notice says so and offers
  "go to about the same point" or reading on from where they are. Layout
  changes in the next 4 s (images) keep a restored place in view until the
  person moves; if they move first, nothing jumps and "Back to where I was" is
  offered. The progress bar shows the current place and a furthest marker;
  the progress panel shows sync state and keeps going back and the explicit
  reset separate.
- **Appearance** (Aa): size 14–26 px or automatic, line spacing, column width,
  serif/sans, page colour (app / light / sepia / dark — the reading pane only)
  and Restore defaults. Stored in the person's user settings
  (`reader.appearance`, scope `user`, through `ScopedSettingsStore`;
  `GET/PUT /api/v1/reader/preferences/appearance`), so it follows them across
  devices and Spaces. Applied at once as column custom properties; saved 0.5 s
  after the last change; a failed save says so and keeps what is shown.
- **Contents** (`[`): the document's headings, current section marked, docked
  left when the row is at least 1180 px wide and otherwise laid over the text;
  overlays never stack (opening one closes the other).
- **Find in this document** (`/`): case-insensitive, across marks, never across
  blocks, ≤1000 matches; at most 300 are painted, centred on the current one
  (the count and Enter cover all); Enter / Shift+Enter move;
  Escape closes and returns to where finding started, the close button stays
  at the match. The bar sits above the pane, so it never moves the text. It is
  labelled as distinct from the Reading list search, which searches titles,
  summaries and sources, not full text.
- **Focus mode** (F): hides the Shell, Project navigation and side chat
  (elements marked `data-shell-chrome`) and the wrapper header for this Reader
  only; Esc, the floating exit button or leaving the Reader ends it.
- **Code blocks** have a copy button (a widget outside the document tree: not
  in quotes, anchors or block indexes) that copies the stored text exactly.
- **Images** the document's policy rendered as `<img>` open larger in a dialog
  with the address already loaded; an image shown as a link stays a link, so
  enlarging never requests an image the policy withheld.
- **Annotations**: the selection toolbar and the selected annotation offer
  copy; the notebook filters by type and by "not located"; a jump from the
  notebook flashes the passage (no flash with reduced motion). Removing an
  annotation offers Undo, which is real: the server restores the archived row
  (owner only, `PATCH status: active`, and only while the document is readable
  — creation's rule) with its comment threads; an unsent draft is not
  restored. The restored annotation joins the list only under the authority
  epoch the Undo started in. Evidence and proposal actions keep their meaning:
  evidence is saved directly, proposals wait for review.
- **Motion and focus**: smooth scrolling, flashes and transitions are off under
  `prefers-reduced-motion`; every Reader control has a visible focus ring.
- **Touch and narrow screens**: under `(pointer: coarse), (max-width: 768px)`
  the Reader's tools, header, selection toolbar, find bar, contents,
  inspector, popovers and the Reading list (`.reading-touch`) get 44 CSS-pixel
  hit areas, set in px so a smaller root font cannot shrink them; the shared
  `Button` is unchanged. Popovers (Aa, progress) are placed inside the visual
  viewport, at most 320px wide, and scroll when taller than the room left;
  checked at 320px and at 640 CSS px (a 1280px window at 200% zoom — an
  equivalent layout width, not browser zoom).
- **Performance budget** (low-end phone, emulated as Chromium 390×844 with 4×
  CPU throttle — a proxy, not a device; set before measuring): for a
  2,000-paragraph article, open ≤3 s, scroll frame p95 ≤50 ms, find (~1,000
  matches) ≤400 ms,
  place measurement p95 ≤8 ms. `reader-journeys.browser.mjs` measures it.
  Decorations are rebuilt only when the document or what they show changes,
  not on selection changes.

SourceItem document reads accept `origin=project` alongside `serendipity` and the
default `library`. Project-origin opens remain private skimmed state and do not
feed the personal interest profile. Completion binds Sources’ retained-body revision. The first extracted body,
metadata rescans and raw snapshot hashes preserve completion; a genuine later
body change invalidates it. Sources database guards keep this meaning for older
writers during rolling upgrades. Unconnected shared saves are readable through
the existing content/Project ACL regardless of who originally saved them.

Reading list progress: `ReadingService` attaches the viewer's own
`reading_progress` (current, furthest) to the source items of the page it has
already authorized, read from `reader_positions` through
`ReaderPositionStore.progressForSourceItems` — an explicit Reader → Information
Digest read boundary (B33): only the caller's rows, only for listed items, and
it never changes read state.

Library's wrapper preserves the incoming project/serendipity origin when a
re-extraction reloads the document. Reading navigation allows only local bounded
return destinations: personal reading, Project reading, Sources candidates or
settings, the research reading-list tab, and fixed personal/Project daily editions.
Edition links use the snapshot’s scope/date, not article time or the browser’s
current day. Project edition links carry their actual `projectId` context;
`readingReturnTo` compares it with the destination (not SourceItem ownership).
The whitelist reuses `safeAppPath`, accepts only canonical paths and exact query
shapes with real calendar dates, and rejects extra query, fragments, encoding,
external paths and Project mismatches. Undated legacy edition entries remain
valid. The return label for either edition is Daily editions / 每日版.
The day briefing used for previous/next navigation is reread on a Space change;
old briefing responses cannot restore names or links from the earlier scope.
Initial document reads, like reloads, discard replies from an ended session.
Reader extraction results/failure details fallback, header metadata, Inspector
selection/comments/actions and notebook copy use the shared browser locale catalog.
Annotation/open-thread counts use i18next plural rules (English one/other; Chinese
uses the same count wording for every number). User-authored text and recorded
server error details retain their original content.
The mobile Inspector header reserves room for Shell’s floating capture action
so its close control remains clickable.

Agent-assisted Source collections can supply literal source text or Agent synthesis
with supporting links. Both retain the Agent-provided/unverified label; synthesis
is explicitly distinguished from original text. Repository overviews identify
README/documentation as their basis. These use existing extracted Reader artifacts
and permissions. Link-only results show an explanation and original-source link,
not fabricated content. Existing metadata-only Source policy is not widened.

Reader's Sources wrapper observes the unified [material processing](SOURCE_MATERIAL_PROCESSING.md)
operation instead of invoking extraction jobs itself. Queue/progress/cancel and
Source-wide text-storage review use existing Run/Source authority. New URL saving
and old-link preparation use the same control and writer. The shared execution
picker lives in `apps/web/src/components/agents/AgentExecutionPicker.tsx`.

## Exact topic-update confirmation

The Library SourceItem route may carry `change=<immutable topic change id>`. It
keeps the same canonical Reader document/annotation resolvers and offers an
explicit localized confirmation for that update. The action goes to the existing
Reading state API with `topic_change_id`; the server checks the actual item's
full-content/Source consent and the topic's owner/Project read access atomically
with the per-user acknowledgement. Opening a document, confirming an old update,
or marking its ordinary material state does not acknowledge a different update.
This transport changes neither document content nor its global read/body revision
or annotation anchors. A fabricated/stale/inaccessible change identifier returns
not found and cannot confer access.

批注引用导出由 Reader 工具栏提供：点击后重新读取当前文档的授权批注列表，
只导出 active 且正文可读的引用、类型、标签、颜色及创建时间为 JSON。
不读取评论线程，不使用缓存正文/标题，不导出锚点、成员身份或不可读批注。
切文、卸载、会话变化或批注权限世代失效后，不触发下载；失败可再次点击。
下载动作不表示浏览器已将文件成功写入磁盘，因此不显示虚假的保存成功提示。

Reader 的键盘执行、帮助及已绑定动作的提示共用 readerShortcuts 动作表。
帮助弹窗可在本浏览器重设高亮/评论/目录/批注栏/查找/专注的单键；
只接受无修饰的英文字母和 [ ] / ; , .，按 event.key 遵循当前布局。
重复或无效键拒绝保存，默认键不再执行，可恢复默认；方向键、Esc、? 保留。
输入框、IME、已处理事件和模态保护在改键后仍有效。无新增远端设置或依赖。

可选自动高亮默认关闭、切文关闭；在 Aa 中主动开启，仅对鼠标/触屏结束的
原生非空文本选区创建高亮，不把点击整段或复制本身当成创建动作。
文档必须明确 can_annotate 且批注列表已完成读取；服务端仍执行完整写权限校验。
复用标准创建及归档/恢复生命周期，不引入独立写入接口；自动创建后的撤销
失败保留入口、成功才关闭。默认选择和复制保持无写入。


### Quote range replacement

The inspector can adjust a located quote using two draggable boundary controls,
keyboard arrows and explicit 44px fine-step buttons. These build previews with
Reader's own ProseMirror positions; directional UTF-16 snapping traverses emoji
without splitting surrogate pairs. Until Save, the original annotation remains.
Cancel has no write; once saving begins Cancel/Escape cannot pretend to undo the
accepted request. Errors keep preview and original for retry. Overlap remains
separate annotations, not a merge. Unlocated quotes cannot be guessed.

`PATCH /reader/annotations/:id/range` accepts a strict protocol request naming the
prior quote/anchor and shown content/structure hashes. The shared document-version
lock (also used for reading position) precedes the annotation CAS. Current author,
document readability and active status are required. Stale edits return409; labels,
visibility, threads and annotation identity are not changed. A new anchor remains
unverified until normal actual-tree relocation proves it. Late/unowned responses
never update a new editor; access refusals clear the preview.

### Independent document notes

`GET/POST /reader/documents/:type/:id/note` resolves a private per-user association.
GET creates nothing. Explicit POST is serialized per person/document and reuses
canonical Notes creation with access-owned Personal Space resolution. The note is
private, separate from quote annotations, with no copied article title/text. Its
body, editing, revisions, folders, sharing and deletion remain Notes-owned.
Reader stores only `reader_document_notes` (typed document in its original Space,
owner, Note id and Note Space). Each read checks both current document and Note
access. Rename does not break the association; deleting a document cannot cascade
into the person's note. Deleting the Note root removes only the binding. No
implicit Project sharing or widening of the generic `note_links` endpoint occurs.
The Reader dialog requires confirmation before creation and opens the existing
Notes editor in its actual Personal Space. Lost responses reconcile via a fresh
GET; unmount, scope/ABA and session changes drop stale links.


### Final responsive/interaction acceptance additions

Reading-list article navigation has an optional browser-local swipe preference.
Only top-level prose (paragraphs/headings) accepts short horizontal touch gestures;
vertical pan and pinch remain native. Tables, code, media, links, existing text
selections, long presses, multi-touch/cancel and stale scope/session gestures never
navigate. It follows the existing full-access neighbour/cursor sequence and never
marks read. `useReaderArticleSwipe` owns listeners, not another navigation store.

The position hook keeps a pre-reflow text anchor when the Reader's width changes,
then restores its exact same-structure PM position; a previous pixel offset is not
a reading place after wrapping. Height-only changes do not trigger this restore.
Observers/animation frames are per document/version/session and stop on revoke or
unmount. Portrait/landscape/portrait preserves paragraph and saved annotation.

Extended performance acceptance uses synthetic short20/long2000-paragraph texts
with0/20/200 annotations, three samples per cell, Chromium390×844/4×CPU. Budgets
are declared before measuring: each open<=3000ms, GC-retained JS heap<=128MiB,
10 SPA document replacements after GC grow<=16MiB. JSON reports every sample and
per-cell p50/p95 (3 samples, not a large statistical study). This measures browser
JS heap, not device RAM or physical phone speed. Actual tab zoom200% is tested via
an ephemeral Chromium extension's `chrome.tabs.setZoom`, verified by getZoom=2,
1280→640 CSS width/devicePixelRatio1→2/visualViewport.scale1/CSS zoom1. The profile
and extension are isolated temporary test artifacts, never a user's browser.
Light/dark gallery captures normal, hover, focus, selection, pending/disabled,
failed save and saved highlight. Delayed synthetic image completion after restore
also retains the same text anchor. Native mobile selection/keyboard and assistive
technology still require real-device acceptance; AX/layout proxies are not that.
