# Performance baselines (Project load, Reader, Run I/O, search)

Reproducible measurements behind the changes on top of `1a88e2da7`. All data is
synthetic; no instance, provider or production system is involved. Timings are
from one WSL2 workstation (Node 24, Chromium from Playwright Core 1.57, the shared
`pgvector/pgvector:pg18` test container) and compare builds on the same machine;
they are not device or production numbers. Pure timing checks warn, never fail
(TESTING_STRATEGY "Time Budgets Are Advisory").

The worktree path contains `:`, so `pnpm exec` refuses; run tools through `node`.
Under Node 25, jsdom tests also need `NODE_OPTIONS=--no-experimental-webstorage`.

## ① Project page load (production build, Chromium)

```sh
cd apps/web
ANALYSIS_OUT=/tmp/pb-dist node node_modules/vite/bin/vite.js build --config ../../tools/perf-baselines/analysis.vite.config.mts
PWA_BUILD_DIR=/tmp/pb-dist CHUNKS=/tmp/pb-dist.chunks.json DETAIL=1 SAMPLES=7 node ../../tools/perf-baselines/project-load.mjs
PWA_BUILD_DIR=/tmp/pb-dist THROTTLE=1 SAMPLES=7 node ../../tools/perf-baselines/project-load.mjs   # gzip transfer, 40 ms RTT, ~1.6 MB/s, 4× CPU
PWA_BUILD_DIR=/tmp/pb-dist MOBILE=1 SAMPLES=5 node ../../tools/perf-baselines/project-load.mjs     # 390×844: the sidecar starts closed
node ../../tools/perf-baselines/closure.mjs /tmp/pb-dist.chunks.json /tmp/pb-dist                   # static JS the heading waits for
```

Fixture: `/spaces/space-pwa/projects/project-pwa`, signed in, synthetic APIs
including a mainline Room with one conversation. "Heading" is the first animation
frame with the Project title; "sidecar" is the panel composer present. `DETAIL`
lists each JS request before/after the heading with its largest packages.

| 1280×720 (median of 7) | HEAD | change |
|---|---|---|
| Heading, loopback | 783 ms (775–804) | 564 ms (538–605) |
| Sidecar composer, loopback | 802 ms | 612 ms |
| Heading, throttled | 2,413 ms (2,333–2,525) | 2,254 ms (2,100–2,324) |
| Sidecar composer, throttled | 2,477 ms (2,402–2,575) | 2,519 ms (2,444–2,681) |
| Static JS closure behind the heading | 82 chunks, 3.62 MB raw / 1.10 MB gzip | 45 chunks, 2.08 MB / 614 KB |
| All JS after settling | 83 requests, 1.10 MB gzip | 84 requests, 1.10 MB gzip (prefetched) |

| 390×844 (median of 5) | HEAD | change |
|---|---|---|
| Heading, loopback | 842 ms | 535 ms |
| JS requests / gzip | 83 / 1.10 MB | 46 / 615 KB |

Attribution at HEAD: `ProjectAreaLayout` statically imported the sidecar's
conversation stack — Streamdown/Mermaid/parse5/micromark (151 KB gz), Tiptap/
ProseMirror (124 KB), Framer Motion (58 KB), Shiki (56 KB), the conversation
modules — so every Project page waited for it. The remaining loopback time is
React 19's Suspense reveal throttle (300 ms after any fallback commit): the
layout chunk is ready at ~240 ms but commits at ~490 ms. The second throttle (the
index route's own lazy `ProjectDetailPage`, already in the layout chunk) is
removed; the outer one (the layout's own lazy route) remains.

## ② Reader long document

```sh
cd apps/web && node node_modules/vite/bin/vite.js build
READER_INTERACTION_OUT=/tmp/reader.json node --test --test-name-pattern="drag-selection" src/__tests__/reader-journeys.browser.mjs
READER_PERF_OUT=/tmp/reader-long.json node --test --test-name-pattern="performance on a long synthetic article" src/__tests__/reader-journeys.browser.mjs
```

2,000 mixed zh/en paragraphs (159,830 characters), 200 stored anchors (80 unique,
60 English and 20 Chinese repeated quotes proved by full context, 20 ambiguous,
20 missing), Chromium 1440×900, 4× CPU; 3 runs each.

| | HEAD | change |
|---|---|---|
| 40-step drag (wall) | 11.8–12.2 s | 1.2–1.3 s |
| Long tasks during drag (count / total / longest) | 27–28 / 11.3–11.6 s / 475–508 ms | 0 / 0 / 0 |
| Pointer-up → selection toolbar | 416–440 ms | 28–39 ms |
| Highlight → painted (201 anchors re-placed) | 602–613 ms | 237–337 ms |
| Open → placed annotations | 1.8–2.1 s | 1.8–2.5 s (unchanged within noise) |
| Placements (160 located, 40 not) and created anchor | — | byte-identical in all 6 runs |

Existing long-document budget on a quiet machine (2 runs each): open 1,710–1,908
vs 1,725–1,810 ms, find 239–249 vs 256–270 ms, scroll p95 17 ms both.

Cause: every selection update (one per pointer move) rebuilt the whole document's
position map and collapsed text, and collapsed the normalized text, with a
per-character regex. The index was not reused per version; it is now keyed by
the immutable ProseMirror `doc`. Placement equivalence against the HEAD
implementation was also checked offline on 12 seeded documents with irregular
whitespace (NBSP, ideographic space, tabs, hard breaks), emoji and repeated
quotes: 7,200 placements (3,114 located, 3,762 unlocated incl. 3,044 ambiguous)
and 4,800 selection anchors (1,963 with a provable `text_range`) identical.

## ③ Run I/O (real PostgreSQL)

```sh
cd server
cp ../tools/perf-baselines/runIoPerf.measure.ts test/zzRunIoPerf.tmp.test.ts
RUN_IO_EVENTS=20000 RUN_IO_MIX=uniform     RUN_IO_OUT=/tmp/runio-uniform.json     node node_modules/vitest/vitest.mjs run test/zzRunIoPerf.tmp.test.ts
RUN_IO_EVENTS=20000 RUN_IO_MIX=operational RUN_IO_OUT=/tmp/runio-operational.json node node_modules/vitest/vitest.mjs run test/zzRunIoPerf.tmp.test.ts
RUN_IO_EVENTS=20000 RUN_IO_ARTIFACTS=5     RUN_IO_OUT=/tmp/runio-a5.json          node node_modules/vitest/vitest.mjs run test/zzRunIoPerf.tmp.test.ts
RUN_IO_CAPTURE=1 RUN_IO_SQL_OUT=/tmp/artifact.sql ...   # EXPLAIN ANALYZE of the artifact list statements
rm test/zzRunIoPerf.tmp.test.ts
```

HEAD is measured in a separate `git worktree add --detach <dir> 1a88e2da7` with
the same harness copied in, never by swapping files in the change's tree.

One Run with 20,000 events (~1 KiB metadata each) shared at `summary` level:
the owner reads `full`, another member `summary`. `uniform` = 11 logical : 9
operational types; `operational` = 4 operational per logical. 10 requests per
row after one warm-up, through `buildModuleServer` + `app.inject`; rows and their
JSON lengths describe the rows returned by the driver for `run_events` statements.
The harness uses JavaScript string length for these measurements and response
size, so they count UTF-16 code units and do not measure physical database I/O.

| median of 10 (min–max) | HEAD | change |
|---|---|---|
| `/io` full, uniform: median / events rows / row JSON length | 406 ms (382–577) / 20,000 / 29.2 MB | 136 ms (114–156) / 11,000 / 16.1 MB |
| `/io` full, operational | 369 ms (338–487) / 20,000 / 29.2 MB | 51 ms (40–59) / 4,000 / 5.8 MB |
| `/io` response (uniform / operational) | 16,074,426 / 5,845,754 code units | same sha256 |
| `/io` summary viewer (no events read in either) | 295–305 ms | 4.6–5.7 ms |
| `/io` with 5 Artifacts: full / summary | 476 / 324 ms | 371 / 243 ms |
| Artifact-list statements per `/io` | count + page | probe; + one count+page if any candidate |
| `/trace` full (all 20,000 events, by contract) | 229–242 ms | 239–248 ms |

The summary path already read no events; its cost was the Artifact list: the
read-rule SQL is 241 KB (count) and 438 KB (page) of text, 724 sub-selects,
planning 129 + 176 ms against 11 + 25 ms execution, even with no Artifacts. An
indexed probe now answers the empty case. Otherwise one statement evaluates the
read rules once and returns `total` with the page, so both describe one
snapshot (HEAD ran them as two statements); with 5 Artifacts that statement's
planning still dominates (~240 ms). The read-rule SQL itself is generated by the
shared content-access policy and was not changed here. `/trace` bodies have the
same size in both builds; their hash varies between runs of one build (see the
harness header), so it is not a cross-build comparison.

## ④ Search under sparse visibility (real PostgreSQL + pgvector)

```sh
cd server
cp ../tools/perf-baselines/searchSparse.measure.ts test/zzSearchSparse.tmp.test.ts
SEARCH_DOCS=2000 SEARCH_OUT=/tmp/s.json node node_modules/vitest/vitest.mjs run test/zzSearchSparse.tmp.test.ts   # also 200, 500, 1000
SEARCH_DOCS=40 SEARCH_IDS=1 ...                                       # all-visible control
SEARCH_DOCS=2000 SEARCH_VECTORS=lattice SEARCH_PLANS=1 ...            # distinct equidistant vectors, window plans
SEARCH_DOCS=2000 SEARCH_PLAN=hnsw SEARCH_PLANS=1 ...                  # force the HNSW index (also with lattice)
rm test/zzSearchSparse.tmp.test.ts
```

Five topics, each with an English and a Chinese term. Per topic, 8 documents
the viewer can read (term once in the body, 4 per language) and the rest private
to another member, written as stronger matches (term in title and repeated).
Truth: lexical — the readable documents containing the query's term; hybrid —
the readable documents of the topic in either language. Vectors come from a
deterministic topic embedder (no provider): `onehot` gives every document of a
topic the same vector; `lattice` gives each its own vector at exactly the same
distance from the query. 10 queries per mode, recall@10 = hits / min(10, |truth|)
per repetition (5 each), median latency.

| Hidden stronger matches per topic | 32 | 92 | 192 | 392 |
|---|---|---|---|---|
| Lexical recall HEAD → change | 1 → 1 | 1 → 1 | **0 → 1** | **0 → 1** |
| Lexical median ms | 4.9 → 4.8 | 5.3 → 7.2 | 5.6 → 14.3 | 8.1 → 29.0 |
| Hybrid mean recall (min) | 1 → 1 | 0.95 (0.875) → 1 | 0.725 (0) → 1 | **0 → 0.9 (0.5)**; 0.988 in a second fresh run |
| Hybrid median ms | 7.9 → 12.0 | 10.8 → 28.4 | 15.6 → 54.1 | 9.6 → 87 |
| Vector windows read (chunks) | 50 → 50, 100 | 50 → …150 | 50 → …200 | 50 → 50, 100, 150, 200 |
| Hidden documents returned | 0 | 0 | 0 | 0 |

Every repetition of every query returned the same list in both builds. Control
(all 40 visible): recall 1 in both modes, one 50-chunk window. Cause: arm SQL has
no read rule; a 50-row window full of unreadable rows was discarded by the single
gate. Now the exact and lexical arms page by OFFSET over an id-terminated order,
and the vector arm reads larger windows from the nearest chunk, bounded by four
windows. Past that bound (392 equidistant hidden documents) hybrid recall stays
partial by design.

HNSW trade-off (2000 docs, hybrid). Each vector window is one `ORDER BY distance
LIMIT n` statement, the only order the index serves; adding `id` to the ORDER BY
to break ties would take the index out of the plan, so ties are broken in memory
by (distance, id) after reading a larger window instead of an OFFSET page.

| hybrid, 392 hidden per topic | planner's choice | HNSW forced |
|---|---|---|
| onehot recall HEAD → change | 0 → 0.9–0.988 | 0 → 0.7 (0.5) |
| lattice recall HEAD → change | 0.675 → 0.9 (0.5) | 0.2 → 0.613 (0.5) |
| Window statement execution (50 / 200 chunks) | ~14 ms exact scan each | 1.0–1.4 / 2.6–2.8 ms on the index |
| Hybrid median | 87–101 ms | 53–63 ms |

At this size the planner uses the index for the first window and/or exact scans
for larger ones (observed both ways between fresh fixtures, hence the 0.9 vs
0.988). On the index, strict-order iterative scan over a graph of equidistant
points does not reach every element, so recall is lower than the exact scan but
far above HEAD, and windows are 5–10× cheaper. The index is kept: on real
embeddings exact ties are rare, the cost of an exact scan grows with the corpus,
and ranking is stable for a fixed candidate set. Equal-distance candidates at
the limit can differ across execution plans. Graph and relational arms are unchanged.

## ⑤ PWA on mobile viewports (production builds, Chromium + WebKit)

`pwa-mobile.mjs` serves three production builds (oldest first) from one origin
with synthetic APIs, runs the real `docker/retain-previous-assets.sh` for
release switches, and drives Pixel 7 (Chromium) and iPhone 13 (WebKit)
profiles. The builds must differ in `ProjectFilesPage` and `CodeMirrorEditor`
chunks (append a distinct marker statement to each before each build, then
restore the sources). Every case ends as `passed | limited | failed`, and every run ends
with one `{"terminal": …}` line and a matching exit code. Prefer bounded
split runs, one process per engine and case, over the full matrix:

```bash
cd tools/perf-baselines
B=/tmp/b1,/tmp/b2,/tmp/b3
for kind in chromium webkit; do
  for c in first-release one-switch two-switches network-drop-uncached server-down-uncached; do
    PWA_BUILDS=$B BROWSERS=$kind SAMPLES=0 CASES=$c OUT=/tmp/pwa-$kind-$c.json timeout 300 node pwa-mobile.mjs | tail -1
  done
  PWA_BUILDS=$B BROWSERS=$kind SAMPLES=1 CASES=update OUT=/tmp/pwa-$kind-measure.json timeout 600 node pwa-mobile.mjs | tail -1
done
```

`SAMPLES=0` skips the cold and weak samples. `CASES` lists release cases and
`update` (what an update downloads). Results from 2026-11-22, one sample each,
on the builds of this change (Chromium 143, WebKit 26.0 from Playwright Core):

| Case | Chromium | WebKit |
|---|---|---|
| first-release, one-switch, two-switches | passed | passed |
| network-drop-uncached | passed | limited: the same-tab reload never re-requests the failed chunk (neither the server nor the worker sees it, also after a 200 `fetch(…, {cache: 'reload'})`); a new tab opens the editor |
| server-down-uncached | failed: the Project page shows "Project not found" while the server is unreachable | the same failure, plus the WebKit same-tab limit after the server returns |
| cold login / installed | 150 / 230 ms, 2.25 MB installed | 287 / 353 ms, 4.26 MB installed (2.01 MB fetched twice) |
| weak (150 ms, 200 KB/s) login / installed | 10.2 / 14.2 s | 10.3 / 24.8 s |
| offline reopen of the login page | 170 ms from the worker | `page.goto: WebKit encountered an internal error` (Playwright offline emulation) |
| update download | 1 asset request, 0.98 MB | 1 asset request, 0.98 MB |

The WebKit same-tab result is Playwright's Linux WebKit build and has not been
confirmed on iOS Safari. The panel's interrupted-download text therefore also
says to close and reopen the tab or installed app if a reload does not help.

The first-install cache follow-up kept the Latin Inter subset in the offline
shell and moved six other subsets to the existing first-use cache. A production
build comparison reduced the precache from 21 to 15 entries, saving 170,256
uncompressed bytes. The hashed asset responses already use immutable HTTP cache
headers, and Workbox already uses its default fetch cache mode for those entries.
Deferring first registration until the window load event left roughly 2.01 MB
of duplicate responses in Linux WebKit in both builds (three cold and two
throttled samples each). The registration delay was dropped.
With only the font change, one cold and one throttled WebKit run each
transferred 4,093,178 bytes through installation, down from 4,263,734 bytes
in the baseline. Both runs still transferred 2,013,002 duplicate bytes. The
offline shell opened from the worker with the server disconnected. WebKit's
offline emulation continued to return its internal navigation error.

### Sign-in boot split (2026-11-22, on top of `efcedf296`)

The 2,013,002 duplicate WebKit bytes were the whole precache. With the
`Sec-Fetch-Dest` the harness now records per request (`cold[].duplicates`),
each duplicated file was fetched once by the document (`script`, `style`,
`font`, `manifest`) and once by the worker's precache (`empty`): Linux WebKit's
worker does not reuse the page's HTTP cache, Chromium's does (only the 625-byte
`theme.js` repeats there). So the only lever is what the boot entry statically
imports. The graph behind it comes from a build with
`graph.vite.config.mts` (`<ANALYSIS_OUT>.graph.json`: every module's static
and dynamic imports):

```sh
cd apps/web
ANALYSIS_OUT=/tmp/g node node_modules/vite/bin/vite.js build --config ../../tools/perf-baselines/graph.vite.config.mts
```

| WebKit duplicate, per file (bytes) | HEAD | change |
|---|---|---|
| main entry `app-*.js` | 980,882 | 102,282 |
| shared vendor `index-*.js` | 845,408 | 312,973 |
| `index-*.css` | 137,374 | 137,374 |
| Inter Latin woff2 | 48,256 | 48,256 |
| `theme.js`, manifest | 1,082 | 1,082 |
| total | 2,013,002 | 601,967 |

What HEAD's boot carried for the sign-in page: the authenticated Shell and its
providers (Agent attention, quick capture, Sonner, Radix dialog/tooltip), the
module registry with every official plugin's operation manifest parsed by zod
at load, SecurityPage and the Gmail landing, `@rainver/protocol` (policy,
system actions, host wire… ≈ 0.7 MB of rendered source) and zod, reached because
`api/client.ts` re-exports every API module and the package did not declare
itself side-effect free, and both locales' full string set (546 KB rendered).
Changes: the signed-in routes moved to one lazy `AuthenticatedApp` chunk;
`@rainver/protocol` declares `"sideEffects": false` (its dist has only
declarations at top level); i18next starts with the sign-in subset and the
signed-in chunk installs the full, byte-identical set; `spacePath` moved out of
`navigation.tsx` (whose rail pulled lucide icons into boot).

Static boot JS: 1,826,290 → 415,255 bytes raw, 531,534 → 135,676 gzip;
precache 1966.25 → 588.28 KiB (15 entries both). What stays, and why: React DOM,
the router and i18next render the sign-in page; tailwind-merge is the shared
`cn` behind `Button`; the sign-in strings, the public auth pages, the error,
update and failed-load panels and `appVersion` (the update contract) must work
offline; the single Tailwind stylesheet (137 KB, 24 KB gzip) is shared by every
page and is not split per route.

Mobile profiles, `pwa-mobile.mjs`, `SAMPLES=5` (5 cold, 3 weak) per engine and
build, HEAD (`h1..h3`) and change (`c1..c3`) builds with the usual markers;
medians:

| | Chromium HEAD | Chromium change | WebKit HEAD | WebKit change |
|---|---|---|---|---|
| cold: sign-in visible / installed | 152 / 207 ms | 85 / 112 ms | 267 / 328 ms | 95 / 161 ms |
| cold: bytes at sign-in / through install | 2,040,343 / 2,080,654 | 637,357 / 669,619 | 2,039,283 / 4,093,031 | 628,248 / 1,270,961 |
| duplicate bytes | 625 | 625 | 2,013,002 | 601,967 |
| weak: sign-in visible / installed | 10.2 / 12.5 s | 3.2 / 5.5 s | 10.3 / 23.0 s | 3.3 / 9.0 s |
| server unreachable: sign-in from the worker | 152 ms | 64 ms | 287 ms | 106 ms |
| update download (marker-only release) | 980,882 | 102,282 | 980,882 | 102,282 |

Signed-in pages (Chromium, Service Workers blocked, 7 samples, medians, final
builds `h3` / `c3`; `project-load.mjs` and `sign-in-home.mjs`):

| | loopback HEAD → change | throttled HEAD → change |
|---|---|---|
| Project heading, cold signed-in | 541 → 452 ms | 2,195 → 2,074 ms |
| Home heading, cold signed-in | 490 → 387 ms | 1,340 → 1,325 ms |
| sign-in → Home, 1.5 s between focusing the form and submitting | 415 → 406 ms | 708 → 723 ms |
| sign-in → Home, submitted immediately after filling | 407 → 445 ms | 705 → 1,015 ms |

All signed-in JS together does not grow (Home closure 602,591 → 592,366 bytes
gzip; Project 618,132 → 607,501). The sign-in form starts the signed-in chunk
on focus or press; an instant submit (autofill plus a tap) still waits for
part of that download, which the last row shows. Two loading fallbacks
in a row (the chunk's, then the page's) each paid React's 300 ms reveal
throttle until one boundary that is already on screen held the sign-in page
during the navigation (intermediate builds, loopback sign-in → Home: 685 ms
with the lazy chunk alone, 750 ms with the preload only, 476 ms with the
boundary).

Release and lifecycle checks on the change: `pwa-mobile.mjs` release cases from
a tab on HEAD into the change (`h3,c1,c2`) and within the change (`c1,c2,c3`)
match the table above (first-release, one/two switches pass; WebKit
network-drop is the same-tab limit; server-down still shows "Project not
found"). `pwa-lifecycle.browser.mjs` passed 9/9 with HEAD and with `c1` as the
previous build; its clean-install case now also checks that the signed-in chunk
is neither precached nor requested before sign-in and is cached on first use.

Compression: the production `nginx.conf` in a temporary `nginx:1.27-alpine`
(the image leaves `gzip` commented out) returned every JS and CSS file
uncompressed, also with `Accept-Encoding: gzip, br`. Static gzip is now on
(not for `/api/` or the host WebSocket). Precache transfer through that nginx:
HEAD 2,053,748 bytes uncompressed → change 244,236 bytes with gzip. Chromium and
WebKit installed through it (15 entries) and reopened sign-in from the worker
with the container stopped. No real deployment, reverse proxy or device was
measured; Playwright's WebKit offline emulation still fails navigation in
both builds.
