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

SourceItem document reads accept `origin=project` alongside `serendipity` and the
default `library`. Project-origin opens remain private skimmed state and do not
feed the personal interest profile. Completion binds Sources’ retained-body revision. The first extracted body,
metadata rescans and raw snapshot hashes preserve completion; a genuine later
body change invalidates it. Sources database guards keep this meaning for older
writers during rolling upgrades. Unconnected shared saves are readable through
the existing content/Project ACL regardless of who originally saved them.

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
Reader extraction results/failure details fallback, header metadata, Inspector
selection/comments/actions and notebook copy use the shared browser locale catalog.
Annotation/open-thread counts use i18next plural rules (English one/other; Chinese
uses the same count wording for every number). User-authored text and recorded
server error details retain their original content.
The mobile Inspector header reserves room for Shell’s floating capture action
so its close control remains clickable.
