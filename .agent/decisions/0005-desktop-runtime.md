# ADR 0005: The Desktop Is A Client Or An Execution Host, Not The Control Plane

Date: 2026-05 (original)

## Status

Accepted.

## Context

The initial design considered a Tauri desktop app running the full backend
natively on Windows. That was rejected: the coding CLIs require Linux/macOS
or WSL2, sandbox isolation needs Linux kernel features, and maintaining
Windows-native and Linux paths doubled the surface for an MVP.

[ADR 0016](0016-control-plane-execution-hosts.md) later introduced execution
hosts — personal machines, including native Windows and WSL environments,
that run coding agents under a thin daemon. That changes what a desktop
machine may do, not where the control plane lives.

## Decision

1. **The control plane runs on Linux / WSL2 / a server**, deployed with the
   Compose stack in `ops/compose/`. The API server, orchestration, policy,
   memory, and the strictly isolated server-host sandbox (a rootless
   bubblewrap namespace inside the sandbox-runner container) live there.
2. **The browser UI is the primary client** on every OS. Windows users reach
   a WSL2 or remote control plane through the browser.
3. **A personal desktop may be an execution host** (ADR 0016): the
   `rainver-host` daemon pairs with the control plane and runs the machine's
   own natively installed CLIs in trusted-host mode. This is dispatch of work
   to a machine the user owns; it is not a second control plane and holds no
   canonical state.
4. **A native desktop app, if built, is a launcher/control panel** — tray,
   auth, notifications, host-daemon management — never the backend. The Tauri
   scaffolding in `apps/web/src-tauri/` is kept but not built or maintained.

## Consequences

- There is exactly one control plane per instance; a desktop never runs a
  private copy of the server.
- Windows-native agent execution exists only as an ADR 0016 execution host,
  with that ADR's trust model and owner-only rule, not as a server runtime.
- Documentation and setup guides target WSL2 + Compose for the control plane
  and the host daemon for personal machines.
