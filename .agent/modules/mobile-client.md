# Module: Mobile Client

## Status
The shared web app provides mobile navigation and PWA installation.

The web app ships a PWA manifest. Layout uses a four-entry bottom tab bar
(`MOBILE_TAB_ITEMS`: Home, Agent Work, Projects; followed by More) on narrow
viewports, and Home / Space Today stack to one column below `md`. There
is no offline queue, no swipe card review, and no mobile-only capture
sheet.

The service worker precaches the main HTML entry, its static JavaScript and
stylesheets, the Inter Latin font subset, the early theme script, and
installation icons. The main entry's static JavaScript is the sign-in
screen's: React, the router, i18next with the sign-in strings, the public auth
pages, the error and update panels and the update action. The signed-in app
(`AuthenticatedApp.tsx`: the Shell, the module registry and plugin manifests,
every signed-in route and the full string set) is one lazy chunk loaded once
someone is signed in. The sign-in form starts loading it on first focus or
press, unless the browser reports no network. One Suspense boundary that is
already on screen keeps the sign-in page up during that navigation, so only
the destination page shows a loading state. Other Inter subsets load when the
stylesheet needs them and are cached on first use; the offline shell can use
system fonts for glyphs whose subsets have not been downloaded. Lazy routes,
the signed-in chunk and large feature libraries such as Mermaid, CodeMirror and
xterm download when first needed. The worker stores eligible same-origin hashed
assets in a bounded cache. A clean installation can reopen the sign-in screen
offline; signing in, product data and the signed-in chunk on a clean
installation still use the network. The independent viewport diagnostic is
served separately.

An update can install while tabs are open. It activates automatically when the
last tab controlled by the previous worker closes. Settings can also activate
the waiting worker and reload the requesting tab immediately. Existing tabs
keep their document and input. A still-open tab that requests an uncached
feature from the previous build is served that build's hashed asset: the
frontend container records its own `/assets/` in a volume at start, and nginx
falls back to the one build that ran before it (see
[Deployment](deployment.md)). Two release switches while a tab stays open, or
an instance without the volume, still leave that tab with a failed lazy load.

The build id and time are `rainver-build-id` / `rainver-build-at` meta tags in
the uncached HTML (and `version.json`), never inlined into JavaScript, so a
rebuild of unchanged web source keeps every hashed asset name. A release that
changes no web code therefore leaves open tabs' lazy chunks and the hashed
runtime cache valid without the retained volume. Any web source change still
renames most chunks: they import the entry chunk, whose dependency map names
the changed ones.

A failed lazy import is shown by the route ErrorBoundary as an update-aware
panel instead of the generic error and its "Try again", because the browser
keeps a failed module import for the document's lifetime. The panel runs the
Settings version check once: a different served build offers Settings' "Update
and reload"; the same build offers a reload of this tab; an unreachable server
offers only "Check again". Nothing reloads by itself, and a requested reload
still goes through the page's own `beforeunload` draft guards.

The panel, Settings and the viewport probe share one update action
(`reloadLatestBuild` in `modules/settings/appVersion.ts`). It first asks the
page's own guards with a synthetic, cancelable `beforeunload`. Without unsaved
input it activates the waiting worker and reloads. With unsaved input it does
not activate anything first: it marks the tab in `sessionStorage` and reloads,
so the browser shows its prompt. Staying clears the mark, keeps the input and
the open document, and shows a "reload cancelled" status with the same action
still offered. Leaving loads the tab's own build again; at start, after the
worker registration settles, that document runs an update check, activates
the waiting worker (also offline, when it already installed) and reloads once
more into the new build. Activating before the prompt would have moved the
tab off its own worker and cached build even when the person kept the input.
If that start-up activation times out (20 s) or the worker becomes redundant,
the tab stays on its build and a notice above every page, sign-in included
(`core/UpdateNotAppliedNotice.tsx`), says the update was not applied. It
offers the same explicit update action and Dismiss. Nothing retries or reloads
by itself, so a failing worker cannot cause a reload loop.
Within one document, the update action and the start-up continuation
(`finishUpdateAfterReload`) share a single in-flight run: a request made while
one is in progress (Settings, the panel, the notice or start-up overlapping)
joins it and gets its outcome instead of checking, activating or reloading
again. Outcomes are distinct: nothing to apply (only the start-up
continuation: no mark, no registration or no waiting worker), cancelled
(`'kept'`: the person stayed at the prompt, or the page left into the
back/forward cache and came back), failed (explicit callers reject; the
continuation also raises the notice) and reloaded (explicit callers never
settle). Explicit requests that waited for a continuation with nothing to
apply then run one explicit update together. The run is released only when it
settles, so the action can be retried afterwards; a page hidden into the
back/forward cache during the network check or activation keeps that run in
flight and resumes it on return instead of starting a second one.

These behaviours exist only in documents that loaded this code. A tab already
open with an earlier build keeps that build's JavaScript until it reloads, and
its panel and Settings act as that build did. The first release containing
this code is the boundary. Builds that were never deployed, such as
intermediate development commits, do not count as tabs open in production.

After an interrupted download of the tab's own build, WebKit (as measured with
Playwright's WebKit) keeps the failed module across a same-tab reload and does
not request it again, while a new tab loads it. The panel text says to close
and reopen the tab or installed app if reloading does not help. If the Project
request fails because of a network or server error, the page shows a load error
with a retry action.
Mobile browser measurements are in `tools/perf-baselines/README.md` (⑤ PWA).

On mobile, More exposes the remaining rail destinations and enabled plugin links,
with the same Space/instance admin visibility gates. Review attention remains
visible on More; Agent Work reuses the personal attention badge. The menu uses
the shared accessible dialog, closes on selection, and scrolls within the viewport.

The authenticated Shell is fixed by its four viewport edges with a shrinkable main
scroll area; the document does not scroll behind its bottom navigation. Mobile
Agent Work uses an accessible red dot only when unread/needs-you is nonzero.
Project conversation history contains scroll chaining; mobile conversation cards
use dynamic viewport height instead of the desktop 640px minimum.

Project chat overlays keep a non-shrinking header below the top safe area,
with the original collapse icon and a 44px minimum touch target. The
reopen button sits on the left above bottom navigation and its safe-area inset,
clear of the right-hand quick capture button.

Shell owns all four device safe insets via shared `--app-safe-*` variables.
Its header does not add the top inset again; bottom navigation owns the bottom
inset so its background extends behind the home indicator without a blank strip. Fixed Project
chat overlays use the same inset boundaries, including landscape left/right
insets, rather than extending behind the system status bar.

The shared Reader opens on the text below 769px: its inspector is a bottom drawer
shown only on request (toolbar button, selecting an annotation, a comment, or
`]`/`[`), with a sticky close row, the bottom safe inset, and the soft keyboard's
`visualViewport` overlap applied so the comment field stays reachable. A plain
highlight on a phone does not open the drawer. Physical iOS/Android keyboard and
native selection behavior still need device checks.

Floating quick capture includes the bottom safe inset in its mobile offset,
keeping both its button and composer above bottom navigation.

The fixed Shell and mobile Project overlay rely on top/bottom edges rather than
also setting `100dvh` height. Browser emulation does not reproduce installed
iOS PWA viewport bugs; passing those checks does not establish physical screen
coverage on affected iOS releases.

Exception: narrow installed iPhone PWAs now use the phone-verified C layout
(normal-flow Shell, `100vh` at rest), with one shared geometry decision for
keyboard-sized overlap and conversation overlays. See
[Frontend Layout](frontend-layout.md) for platform gating and inset ownership.
The labelled bottom boundary belongs only to the independent diagnostic probe.

Desktop-request iOS touch UAs are included in that installation check. The Room
drawer avoids search autofocus, retains a focus trap, and has keyboard-adjusted
safe bounds. Its shared dialog backdrop covers the same large height as C.
Narrow coarse-pointer fields use actual 16px focus text independently of the
installation check, including portal searches and ordinary browser tabs.

The installed iOS Shell has no document scroll lock and allows native outer
edge movement; main/Reader/transcript retain their internal scrolling. The old
forced scroll-to-origin correction remains removed. Idle viewport offsets do
not move C, while real keyboard overlap still follows the visible viewport.
The idle CSS lock introduced for jitter was removed after the person reported
that dragging stopped. Formal mobile iOS content retains a separate 10px trial
clearance beyond the dynamic safe inset, without changing bottom C coverage.
