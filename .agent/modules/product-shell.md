# Module: Product Shell

## Status
**PLANNED** — scaffold exists (React/Vite SPA), shell structure not yet implemented.

## Purpose
The persistent application frame that wraps every page. The shell is always visible, always space-aware, and provides consistent navigation, search, capture, and status across all product features.

## Owns
- Top-level layout and navigation chrome
- Space switcher (select between personal / household / team spaces)
- Project Folder switcher (select Project Folder within current space)
- Global command / search palette
- Assistant / quick-capture entry point
- Notification and proposal inbox badge
- Connection / runtime status indicator
- User / account / settings access

## Does Not Own
- Page content (owned by individual feature modules)
- Space or user data (space module)
- Proposal logic (proposals module)

## Top-Level Navigation

```
Today               — digest: recent activity, due cards, pending proposals
Assistant           — chat / quick capture
Activity Inbox      — raw activity_records
Memory              — memory review and governance
Knowledge           — Notes, Wiki (KnowledgeItem), Sources, Cards (in-header section switcher)
Cards / Review      — spaced repetition queue
Agents              — agent list, runs, capabilities
Project Folders     — Files & Code browser
Proposals           — pending approvals
Settings            — space config, user prefs, API keys, runtime
```

## Shell Components (Planned)

| Component | Purpose |
|---|---|
| `SpaceSwitcher` | Switch between spaces the user belongs to |
| `ProjectFolderSwitcher` | Switch Project Folder within current space |
| `NavRail` | Primary navigation (collapsible sidebar) |
| `CommandPalette` | Global search / action (keyboard shortcut) |
| `AssistantEntry` | Quick capture / chat input (always accessible) |
| `ProposalInboxBadge` | Count of pending proposals |
| `RuntimeStatusBar` | Server / connection / adapter health |
| `UserMenu` | Account, settings, sign out |

## Invariants
- Every page must operate within a selected `space_id` — never assume a single global user
- `project_folder_id` is optional but must be propagated when selected
- The shell must degrade gracefully when the server is unreachable (show connection status, allow read from cache in future)
- Navigation items that have no data must show empty state, not hide entirely

## Related Files
- `apps/web/src/App.tsx` — current top-level app
- `apps/web/src/modules/` — module page components (each needs space awareness)
- `apps/web/src/components/` — reusable component library

## Related Decisions
- [0001-space-model.md](../decisions/0001-space-model.md)
- [0005-desktop-runtime.md](../decisions/0005-desktop-runtime.md)
