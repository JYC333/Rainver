# Decision 0005: Windows Desktop Is Not a Full Runtime

## Status
Accepted

## Context
Initial design considered a Tauri-based desktop app that would run the full Rainver backend natively on Windows. Technical obstacles:
- Claude Code CLI and Codex CLI require Linux/macOS (or WSL2 on Windows)
- Docker-based sandbox isolation requires Linux kernel features
- Maintaining Windows native + Linux paths doubles complexity
- MVP scope is already large without desktop

## Decision
**Windows desktop is not a full runtime.** The agent loop runs on Linux / WSL2 / server.

Specifically:
- Agent loop, sandbox execution, and API server run on Linux or WSL2
- The browser UI (React SPA) is the primary client — works on any OS
- A desktop app (Tauri), if built later, is only a launcher/control panel — it does not run the backend
- The Tauri scaffolding in `apps/web/src-tauri/` is kept but deferred

## Consequences

- MVP runtime target: Linux/WSL2/server + Docker Compose
- Primary client: browser at localhost:5173
- Windows users access via browser pointing at WSL2 runtime
- No Windows-native agent execution path
- `apps/web/src-tauri/` exists but is not built or maintained in MVP
- Documentation and setup guides target WSL2 + Docker
- Future desktop app scope: launcher, tray icon, auth, notifications — not backend
