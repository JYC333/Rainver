# UI visual style and component conventions

## Authority and scope

This is the visual implementation and review guide for new or changed product UI.
Read it with the owning module guide and
[Frontend Information Architecture](FRONTEND_INFORMATION_ARCHITECTURE.md).
[Frontend Layout](../modules/frontend-layout.md) owns Shell and scrolling layout;
[Testing Strategy](TESTING_STRATEGY.md) owns test selection. This guide does not
change navigation, permissions, data visibility or approval contracts.

The source of current visual values is [index.css](../../apps/web/src/index.css),
and reusable controls live in [components/ui](../../apps/web/src/components/ui).
Use those sources; do not create a second palette or component system. Existing
exceptions are not templates for new code. Updating a touched surface does not
authorize restyling unrelated pages.

## 1. Theme, surfaces and typography

- Keep the existing dark and light-purple themes. Use semantic tokens:
  `bg-background`, `bg-card`, `bg-input`, `text-foreground`,
  `text-muted-foreground`, `border-border`, `ring-ring`, and the existing
  primary, destructive, success and warning roles. Do not hardcode white/black,
  a new brand colour or independent light/dark values for ordinary controls.
- Every ordinary border must name its theme colour (`border border-border`),
  or a semantic state colour for a genuine warning/error. A bare `border` can
  inherit foreground colour and produce bright outlines, especially in dark
  mode. Reuse `Card` for card surfaces rather than recreating its appearance.
- Use the configured Inter sans-serif and monospace tokens. Ordinary prose is
  sans-serif; code, hashes and other technical values may use monospace. Do not
  render explanations as code solely for convenient whitespace handling.
- Match neighbouring surfaces: page title `text-xl font-semibold`, ordinary
  body/forms `text-sm`, compact card actions `size="sm"` on the shared Button,
  auxiliary metadata `text-xs text-muted-foreground`. Shared `CardTitle` has
  its own compact heading treatment. A new operation is not a second headline.
- Use existing rounded and spacing utilities; control radii come from the
  shared control. Prefer consistent `gap-2`/`gap-3`/`gap-4` and card `p-3`/`p-4`
  according to the adjacent component density. Avoid one-off pixel dimensions,
  shadows or inline styles for ordinary typography, spacing and control size.
  Runtime measurements, editor positioning and progress values are legitimate
  dynamic styles, not a way to bypass shared control appearance.

## 2. Shared controls are the default

| Purpose | Canonical component | Rule |
| --- | --- | --- |
| Action | `components/ui/button.tsx` | Use supported variants/sizes; do not recreate a button with a bare link or local CSS |
| Navigation styled as an action | `Button asChild` + `SpaceLink`/safe link | Preserve link semantics and scope while matching the action group |
| Dropdown | `components/ui/select.tsx` | Use `options`, `value`, `onChange`, accessible label and disabled state; no bare `<select>` |
| Single/multiline entry | shared `Input` / `Textarea` | Retain token surfaces, border, focus and disabled behaviour |
| Card/dialog/tabs | shared `Card`, dialog and tabs | Keep shared surface, selection, focus and keyboard conventions |

Plain underlined links remain suitable inside prose, citations and back navigation.
They are not substitutes for a compact card action beside styled buttons. Native
form elements are appropriate inside their canonical wrappers, not as page-level
visual shortcuts. A required variant missing from shared controls should be added
at the owning component only when the need is demonstrated; do not build a parallel
control in a feature page.

## 3. Action hierarchy and Reading cards

- Lead with the user's primary action. A reading card opens/continues reading;
  preview, save and improvement are supporting actions. A newly added maintenance
  action must not precede or visually outweigh the reading action.
- Reuse the existing group's sizes, alignment and spacing. Use `outline` or the
  established emphasis for the primary reading action and a compact `ghost`
  treatment for a secondary improvement action. Destructive styling is reserved
  for destructive actions, not generic failures or emphasis.
- Use a short translated visible label. If the surrounding card supplies context,
  the label need not repeat a full sentence. An accessible name or supporting
  description can retain the full meaning. Do not shrink fonts or force a wider
  action column solely to accommodate a verbose new label.
- A link inserted into the action group uses `Button asChild`; it should align
  with neighbouring controls, not appear as a large multiline underlined block.
  Check the group as rendered, including the primary action, not only the new
  component in isolation.
- Preserve the [ReadingCard](../../apps/web/src/modules/library/ReadingCard.tsx)
  layout owner. On narrow screens actions may wrap as complete controls; on
  desktop they follow the existing compact/expanded card arrangement. Keep the
  primary action easy to identify and avoid clipping, collisions and isolated
  oversized rows.
- Touch targets use the existing coarse-pointer/responsive rules in `index.css`
  (including `reading-touch`). Do not globally force every desktop link/button
  to 44px using a page-wide selector or inline height. A different target size
  must be justified by the control/context and verified visually.

## 4. Page headers, forms and states

- Page headers show the user's task/title, meaningful scope/status and one current
  primary next action. Technical IDs, hashes and raw state objects are secondary
  details, not the page's leading explanation. Secondary controls use consistent
  outline/ghost treatment and may live in an existing advanced disclosure/menu.
- Group form labels, explanations, controls and validation with a consistent
  vertical rhythm. Give each control an accessible name; a placeholder is not
  its only label. Use concise error guidance close to the affected action.
- Use the shared translation dictionaries and `useAppTranslation().t`, not
  inline `locale.startsWith` branches for new page/control copy. Both bundled
  locales must have the same keys and placeholders. Format dates/numbers using
  the shared formatting helpers.
- Maintain visible keyboard focus, selected and disabled states in both themes.
  Do not express errors or selection by colour alone. Decorative icons must not
  replace an accessible action name; icon-only actions need names and tooltips
  when their meaning is not obvious.
- Loading, empty, failure, withheld and stale are distinct. Same-scope refresh
  keeps the stable frame with honest progress; do not flash full-page skeletons.
  Never preserve data after a permission refusal merely for visual continuity.
  Scope/session/late-response protections stay in force during presentation work.

## 5. Visual acceptance is not just overflow detection

For changed controls/pages, the implementer and visual reviewer must inspect:

1. The actual entry in its parent card/list/header and its destination, alongside
   neighbouring actions. For a context link, test the click and return path.
2. Dark and light-purple themes, English and Simplified Chinese, at a phone
   width (390px) and desktop width (1280px) or the relevant existing breakpoints.
3. Hierarchy, control consistency, label wrapping, alignment, surface/border
   contrast, spacing, focus, disabled/loading and relevant error states.
4. Keyboard access and usable touch targets without disruptive desktop sizing.
5. No horizontal overflow, clipped text or obstructed controls. These checks
   supplement the visual inspection; they do not by themselves prove good
   design, accessibility conformance or usability.

Use the existing built-app Chromium fixtures with synthetic APIs. Save screenshots
outside the repository (normally `/tmp`), identify which states were actually
inspected, and distinguish direct checks from reused evidence. At least one
screenshot must show the changed entry together with its neighbouring primary
control; a destination-only screenshot is not entry acceptance. Select screenshots
for inspection across the themes/locales, rather than declaring success from file
existence. Reviewers must describe a concrete mismatch and its correction, not
approve solely because an element exists or the test suite is green.

Presentation changes need affected consumer tests where behaviour could regress,
type/build checks and suitable browser evidence; avoid unit tests that merely
assert the exact utility class string. Do not run unrelated server/database suites
for a visual-only change. Full-suite requirements before an authorized commit
remain in [COMMANDS](../COMMANDS.md).
