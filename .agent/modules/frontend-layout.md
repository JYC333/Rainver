# Module: Frontend Layout

## Status
**IMPLEMENTED** — rail + optional scene sidebar + main outlet. Not a
generic three-panel `PanelLayout`.

## Purpose
Describe the layout the web app actually uses. Visual styling and review follow
[UI Style Guide](../architecture/UI_STYLE_GUIDE.md), including shared controls,
card action hierarchy, theme tokens and entry-level browser acceptance.

## Current pattern

```
┌─────────────────────────────────────────────────────────────┐
│  Shell: SpaceSwitcher · theme · user menu                   │
├────────┬────────────────────────────────────────────────────┤
│ Global │  Scene sidebar (some routes) · main <Outlet>       │
│ Rail   │  Project sidecar chat on Project routes (≥ lg)     │
│        │  Floating capture                                   │
├────────┴────────────────────────────────────────────────────┤
│  Mobile: bottom tab bar + scene tab strip                   │
└─────────────────────────────────────────────────────────────┘
```

Below the `md` rail breakpoint, Home and Space Today stack their
300px aside under the main column (`.page-dashboard`). The bottom tab
bar is Home · Agent Work · Projects · More. Command Center remains on the desktop rail and is available in mobile More.

Home is user-scoped (`/home`). Space routes are
`/spaces/:spaceId/<module>`. Admin-only modules are wrapped at the route.

From `md` up, floating capture sits 1.25rem inside the lower right of a
Project's middle content, outside the docked Project chat. `ProjectAreaLayout`
publishes that content's right edge as `--project-content-right-inset`
(`useProjectContentEdge`), so the control follows the chat opening, closing and
resizing. When the middle column is too narrow for the open capture form,
the form can extend over the chat to keep the left navigation clear. The chat keeps no empty band under its "Open in Room" footer, and its
reopen button sits on the same row, left of the control. Phone placement is
unchanged, and the full-screen mobile conversation still hides it.

The user menu (avatar) is the shared Radix `DropdownMenu`: a named menu
button with keyboard, Escape and focus return. It lists this browser's other
signed-in accounts to switch to, with distinct loading and failure states;
opens "Add another account" (password or Google, shared Dialog, mounted only
while open); and signs out — "Sign out" for a single account, "Sign out of all
accounts" otherwise. It reads the account list each time it opens. Switching
reloads every tab as the new account
([auth guide](auth.md#several-accounts-in-one-browser)).

There is no app-level right inspector, bottom log panel, or shared
`EntityCard` / `ReviewCard` primitive set. Per-page inspectors (Run
detail, Room sidecar) are owned by those pages.

## Related Files
- `apps/web/src/core/Shell.tsx`
- `apps/web/src/core/navigation.tsx`
- `apps/web/src/components/shell/`

## Related Modules
- [product-shell.md](product-shell.md)


Agent Work owns a list/detail grid at user-level `/agent-work`. Below `md`, opening
a detail hides the mounted list, and Back preserves local filters and list scroll.
It adds no app-level inspector. Command Center's Hosts use the same page-owned
list/detail, with the selected Host in `?host=` (see `modules/hosts.md`,
"Command Center layout").

The Project Room page stacks navigation, conversation and Project state below
`lg` in an explicit `minmax(0, 1fr)` grid column. This prevents a long truncated
workspace name in navigation from widening the conversation behind Shell's
scrolling viewport. At `lg` and `xl` it uses its existing two/three columns.

Notes and Files & Code share `components/ui/document-tab.tsx` for the curved
tab silhouette and active/hover/close treatment. CodeMirror stays specific to
Files & Code, with global theme tokens and live light/dark reconfiguration.

On mobile, More exposes the remaining rail destinations and enabled plugin links,
with the same Space/instance admin visibility gates. Review attention remains
visible on More; Agent Work reuses the personal attention badge. The menu uses
the shared accessible dialog, closes on selection, and scrolls within the viewport.

The authenticated Shell is fixed to the dynamic viewport with a shrinkable main
scroll area; the document does not scroll behind its bottom navigation. Mobile
Agent Work uses an accessible red dot only when unread/needs-you is nonzero,
on both the desktop rail (collapsed or expanded) and mobile bottom navigation.
Project conversation history contains scroll chaining; mobile conversation cards
use dynamic viewport height instead of the desktop 640px minimum.

At `lg` and above, ProjectAreaLayout fills the Shell content height: its Project
navigation and Area content each own a bounded, contained vertical scroller.
Scrolling Area content does not move the Project navigation, and long navigation
remains independently reachable. Below `lg`, Project navigation starts as a compact expandable row so Area content appears first; the full navigation remains reachable and collapses after selecting a destination.
Project navigation and Files & Code separators explicitly use `border-border`
rather than inheriting the text color.

The Project Board fills the available Area height on desktop and mobile. Each
lane scrolls its card list independently while its controls and completed-task
expansion stay visible. Horizontal lane scrolling stays at the bottom of the
visible Board. A portalled drag overlay keeps card and column previews outside
the scroll clips. Mobile Project navigation has its own bounded expansion.


## Topic (goal) routes

Personal topics live at `/library/reading/goals[/new|/:goalId]` and Project
topics at `/projects/:projectId/sources/goals[/new|/:goalId]` inside the Project
layout; `/sources/access` remains the dedicated credential route (it also holds
the person's own Gmail connections; the unscoped `/sources` route only forwards
the Gmail OAuth result there, see [Sources](sources.md)). Source
list/detail and Project Sources/settings links carry scope into the same page.
The create page is a single centered form (topic, frequency, effort, folded
Advanced). Each topic detail is a single-column management page at every width:
status and current checks, the effective direction, Sources and their execution
state, recent collection audits, a scoped Reading link and management. It does
not repeat the article stream. The Project's existing navigation/chat sidecar
may still surround it; the topic itself never adds another side column.

One Adjust following button opens a wide shared dialog (full-screen on phones).
Direct edit and Discuss changes are tabs in the same single-column surface.
Both stay mounted while switching tabs, so an unsaved form and a conversation
draft are retained. This dialog opts into the shared draft hook’s guarded
unmount flush, so closing within its 250ms debounce retains the last input;
a changed session epoch prevents a post-logout flush. The form freezes its original expected revision; polling
cannot silently rebase it. Conversation tools, plan details and optional trials
are folded above the flex-bounded conversation, whose composer stays visible.
Pending-plan confirmation moves into the dialog while it is open, preserving
the same explicit follow action and Project analysis consent. Closing returns
keyboard focus and neither applies a draft nor cancels a running operation.
Status remains a polite live region; Source change confirmation still uses its
existing exact-revision dialog. No new chat engine or route is introduced.

Goal composer draft persistence is an opt-in predicate on the shared draft hook:
recognized secret patterns clear older session storage before another write.
Other conversation consumers keep their existing persistence behavior. Topic
creation keeps only its idempotency key and created id in session storage, never
the topic text. Legacy channel deep links first resolve existing mappings
read-only. Owned source list/detail controls route to topic management. Error
guidance is categorized and localized; budget/credentials/stopped errors do not
suggest blind Agent retries.

## Problem workspace

Project navigation labels the Inquiry route as Problems / 问题推进 and removes
the duplicate Research sidebar entry. `problemWorkspace/ProblemAreaPage.tsx`
composes purpose-specific definition/work/Task/Research/closeout/history modules;
it does not add another page-wide orchestrator. Shared controls and theme tokens
are reused. Stage/section navigation preserves browser history without writes.
Legacy Research routes canonicalize via `researchPageDestination` before the
old navigation is removed; records and report object context stay reachable.
See [domain guide](../architecture/INQUIRY_PROBLEM_ENGINE.md#project-local-workspace-p5).

The Problems header also opens the existing Project Standing panel at
`section=standing`; old `research?tab=standing` links resolve there. Budget,
source inflow, advice and retry remain reachable without creating a Thread.

Only settings child pages have a compact, wrapping navigation row within the
main scroller, before the page. It contains only the shared Button link back to
the settings parent, without an additional icon or breadcrumb trail. The three settings
roots have no extra navigation row or Home button.
The mobile row remains available when Global Rail is hidden; desktop and mobile
More use the same settings ownership/highlight rules.

On desktop, the open Room conversation fills its Project Area height, without a
fixed chat height ceiling. Its Room summary and conversation-list heading stay
above a shrinkable, internally scrolling list; the transcript owns its separate
scroller. Long conversation lists do not extend the Area or document. On smaller
screens the stacked navigation keeps a bounded conversation-list scroller.

The desktop Project chat sidecar uses one compact header aligned with the
Files & Code toolbar. The conversation title opens a bounded popover above the transcript, with equal
top and side insets from the sidebar. The second line
shows the Room and the current conversation audience, and the new and close
buttons share the same header. A check mark identifies the current Room and
conversation in the switcher. Hovering the trigger or a row shows the pointer cursor.

Panel conversation setup has its own scroller capped at half the available conversation
height, keeping execution confirmation reachable without pushing the message
composer out of the Project chat sidecar. The composer can also scroll on very
short viewports. Its expanded Runtime & workspace disclosure has a separate bounded
scroller so it cannot consume the whole panel.

Loading: the Project layout's static imports stop at the sidecar shell; its
conversation body (`sidecar/ProjectSidecarConversation.tsx`: composer editor,
message rendering, highlighting) is a separate chunk. From `lg` up it starts
loading when the sidecar module evaluates, otherwise when the panel opens, and
is held in state behind the panel's existing skeleton until both it and the
Room reads are ready — not behind `<Suspense>`, because React holds every
Suspense reveal for 300 ms after any fallback commits. For the same reason the
Project index route renders `ProjectDetailPage` from the layout's outlet context
(the layout already imports it) instead of through a second lazy boundary.
`projectShellBundleBoundary.test.ts` keeps the conversation stack out of the
layout's static import closure.

The iOS PWA entry keeps `viewport-fit=cover` and web-app capability but does not
set the deprecated `apple-mobile-web-app-status-bar-style=black-translucent`.
WebKit recommends removing this key in
https://bugs.webkit.org/show_bug.cgi?id=317153#c2. A matching standalone viewport
report (screen 874, viewport 812, top inset 62, bottom inset 34) is tracked in
https://bugs.webkit.org/show_bug.cgi?id=313800. Keep Shell/navigation safe-area
ownership; do not stretch controls to screen.height or remove the Home indicator
inset to compensate for a region outside the web viewport. Browser emulation
checks layout geometry but cannot establish installed iOS PWA chrome behavior;
verify that separately on the affected phone after deployment.

Below `lg`, an explicitly opened Project Room conversation fills the available
Shell viewport. Shell chrome, Project navigation and the desktop conversation
panels yield to a compact header and a shared Dialog drawer with search, new,
selection and unread/running indicators. The drawer stays within its Room and
names its audience; members and the Room list remain reachable. Project attention
and approval controls remain visible outside the transcript. Ordinary Project
pages retain their navigation. Mobile side chat uses the same full-viewport
presentation over its originating page, preserving the mounted file context and
returning directly to it; it does not transfer references through URL parameters.
Desktop columns and desktop PWA remain unchanged.

`conversation/mobile/useMobileConversation` owns the mobile VisualViewport
subscription (resize and scroll), ignoring pinch zoom as keyboard evidence and
cleaning up on exit. Shell owns safe-area padding exactly once. The transcript
retains its existing scroller and subscriptions; responsive changes never mount
a second ConversationSurface. The drawer uses route query history so browser
Back dismisses it; shared Dialog restores focus. No swipe gesture is installed.

Settings diagnostics report actual DOM meta values, both standalone checks,
viewport-unit probes and root/body/Shell geometry and CSS height constraints.
The optional same-origin manifest read is time/size bounded and returns only
allowlisted display modes. No URL, identity, workspace or body text is collected.
The loaded HTML carries a SHA-256 fingerprint of the existing build-inputs
record, also exposed by version.json; build-id suffixes remain random, not Git.
These measurements cannot locate a region outside the installed iOS web viewport
or establish that the affected phone's bottom blank area has disappeared.

Settings → Application version → Layout diagnostics links to the separate
`/viewport-test/index.html` document. It compares fixed/inset positioning with
normal flow at `100dvh` and `100vh`, with the same safe-area ownership and a
clickable bottom marker. It does not change the product Shell or compensate
using screen height. A separate manifest identity/scope (`/viewport-test/`)
allows installing Rainver Test without replacing the existing app icon. The
page registers no worker and uses no product API. The root worker excludes
this path from SPA navigation fallback. Samples (last 12, memory only) reuse
content-free layout diagnostics and exclude test input. Browser viewport
resizing verifies only the probe; actual keyboard, installation and physical
screen coverage require the affected iPhone. Compare launch method, A/B/C,
keyboard dismissal and a screenshot before selecting a production fix.

The probe now starts with C (`100vh` normal flow), following the affected
phone's successful bottom-boundary result. Its short opaque header owns the
top safe inset; the TOP-TEST-2 comparison below controls additional top treatments. The body scroller starts below the header. Both test and readonly
report textareas use an actual 16px focus size, not `1rem` under the 14px root;
pinch zoom remains allowed. Diagnostics add header geometry and focused textarea
font size without its value. These are probe-only changes: neither native
edge-blur removal nor real iPhone keyboard behavior is established by desktop
browser geometry tests.

The authenticated Shell uses Flow B for narrow installed iPhone PWAs, including
Home, Rooms and Settings. The Shell stays in document flow at `100dvh` while
the keyboard is closed. The existing shared geometry follows the unzoomed
visible rectangle for keyboard-sized overlap (>80px). Room, drawer and Project
chat use the same height and keyboard offset. The root marker and CSS variables
are cleared when leaving the Shell or switching to a wide viewport. Native
edge dragging and inner scrolling remain available.

The Shell and mobile conversation surfaces use the system top safe-area inset.
Bottom navigation owns the bottom inset when visible. The conversation Shell
owns it when navigation is hidden. The Room drawer keeps its keyboard-adjusted
insets and dialog focus behavior. Narrow coarse-pointer input retains the 16px
focus guard. Browser geometry checks cover these bounds and keyboard transitions.
Native iPhone behavior requires an installed-device check.

### TOP-TEST-2 comparison probe

The independent viewport-test page now separates top experiments from the bottom
A/B/C layout, which still defaults to C. Its baseline has only safe-area header
padding, with no fixed backing. Other choices add an independent body-portalled
solid safe-area strip, the 11px empty-text surface used by the product candidate,
an explicit extra 16px content clearance, or a sticky safe-area header. These
are controlled experiments, not five production repairs. A high-contrast ruler
and stationary title expose initial top clarity; controls live in the main
scroller so a large control header does not confound the comparison.

The visible revision TOP-TEST-2, running build, content fingerprint and fresh
version.json check distinguish loaded code from the server's current build.
Check failures do not report currency. The existing update/reload mechanism is
reused; selected top/layout and an explicitly switched probe theme stay in a validated URL query (without changing the product theme preference). This document
still registers no worker or product API. A same-server build is not evidence
of device success or the desired deployment branch.

People can mark clear/still-blurred for each scheme. Only five sanitized latest
verdicts, layout/theme/launch context, build and probe revision are retained in
sessionStorage; old-build verdicts are discarded. Test input and geometry samples
are not persisted. Samples still cap at twelve and include selected scheme,
revision, build fingerprint and verdict context for copyable evidence. Storage
failure is visible. Switching is only preliminary: WebKit may retain compositing
state, so confirm via reload and a full PWA quit/relaunch; the page cannot reset
the native shell or prove that native blur has disappeared.

Reuse / Dependency Check: extends the independent Vite probe, existing theme and
Button/Textarea, bounded layout collector and application-version fetch/reload.
No third-party dependency or alternate app updater is needed for this small
comparison surface. Formal Shell/C/input behavior is unchanged by this work.
