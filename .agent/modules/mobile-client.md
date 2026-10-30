# Module: Mobile Client

## Status
The shared web app provides mobile navigation and PWA installation.

The web app ships a PWA manifest. Layout uses a four-entry bottom tab bar
(`MOBILE_TAB_ITEMS`: Home, Agent Work, Projects; followed by More) on narrow
viewports, and Home / Space Today stack to one column below `md`. There
is no offline queue, no swipe card review, and no mobile-only capture
sheet.

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
