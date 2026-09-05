# Rainver Host (Linux)

`rainver-host` connects a machine you own to a Rainver control plane and runs
as a systemd user service. The target machine does not need this repository or
pnpm. The installer uses an existing Node.js 24 installation when available;
otherwise it downloads one shared fallback runtime that is not duplicated by
daemon updates.

Vendor runtimes are not bundled: install the official `codex`, `claude`, or
other CLI you intend to use on the host. Rainver checks the host's captured
`PATH` every heartbeat. When Codex or Claude appears later, its small ACP
adapter pack is downloaded, checksum-verified, and enabled automatically
before that runtime is reported as available.

## Install and pair

Install the CLI on the Linux host:

```bash
curl -fsSL https://github.com/JYC333/Rainver/releases/download/host-installer/install-host.sh | bash
```

Then generate a pairing code in Rainver's Hosts panel and register with the
installed CLI:

```bash
rainver-host register --server https://rainver.example.com --code <pairing-code>
```

Successful registration enables and restarts the systemd user service so an
already-running daemon immediately reloads the new server URL, Host id, and
token. There is no need to restart it manually or keep the terminal open; the
daemon entrypoint is private to the installed systemd unit rather than a
public `rainver-host` command. After the WebSocket `hello` succeeds, the
server returns its runtime-probe catalog and the daemon reports every matching
CLI on the service's captured `PATH`.

To disconnect this machine permanently, revoke the server-side credential,
stop the service, and remove the local registration in one command:

```bash
rainver-host unregister
```

Revoking the Host from Rainver's Hosts panel also stops the daemon from
reconnecting and removes its local registration the next time it receives the
revocation or attempts to connect. If the control plane is permanently
unreachable, `rainver-host unregister --local-only` removes only the local
registration; revoke the old Host in the Web UI separately.
Revoked rows remain visible as audit history. Under the current Host-name
uniqueness rule, use a different machine display name if you pair it again.

Automatic updates are opt-in. They check the selected release channel every
six hours. The updater first verifies the channel's small `BUILD_ID` asset and
returns immediately when that build is already active, without downloading the
Node runtime, daemon release archive, or adapter pack. For a new build it
verifies every downloaded asset's SHA-256 checksum, switches the installed
version atomically, and asks the daemon to restart only after all launching,
running, and uploading Runs have finished.
The active and previous builds are retained; older rolling builds are removed.

Without automatic updates, update manually at any time:

```bash
rainver-host update
```

Automatic checks can be toggled later without pairing again:

```bash
rainver-host update --auto-update
rainver-host update --no-auto-update
```

The default channel is `stable`. Switch channel explicitly when needed:

```bash
rainver-host update --channel stable
rainver-host update --channel edge
rainver-host update --channel nightly
```

For a fresh development-channel install:

```bash
curl -fsSL https://github.com/JYC333/Rainver/releases/download/host-installer/install-host.sh | bash -s -- --channel edge
```

Useful commands:

```bash
rainver-host --version
systemctl --user status rainver-host
journalctl --user -u rainver-host -f
systemctl --user list-timers rainver-host-update.timer
```

The service runs as the installing user, never as root. It captures that
user's `PATH` on first installation, and the generated daemon launcher loads
`~/.config/rainver-host/service.env` before Node starts, so discovery does not
depend on systemd's default PATH or its `EnvironmentFile` path parsing. Edit
that file and restart the service if those paths later change.

On a headless machine where the user logs in only over SSH, enable systemd
lingering once if the service must remain alive after the final logout:

```bash
sudo loginctl enable-linger "$USER"
```

## Rolling release model

There are three fixed rolling build tags: `host-stable` from `master`,
`host-edge` from every relevant `dev` push, and `host-nightly` from the nightly
scheduled `dev` build. The channel-neutral `host-installer` bootstrap is
published from `master`; `--channel` selects which build release it downloads.
Publishing moves the selected tag and replaces its assets. Only stable is
marked as GitHub's Latest Release; edge and nightly are prereleases. `BUILD_ID`
contains the source commit, and the daemon reports
`<package-version>+<short-build-id>` to the control plane, so installed builds
remain diagnosable without numbered release tags.

## Development guidance

Before changing this package, follow [repository instructions](../../AGENTS.md)
and read the [Hosts guide](../../.agent/modules/hosts.md), especially its Host
daemon and WebSocket sections. Use the `host-daemon` bundle in
[context-bundles.yaml](../../.agent/context-bundles.yaml), adding the import or
folder-access bundles when relevant; [COMMANDS](../../.agent/COMMANDS.md)
is the command reference. This README describes installation and operation;
command examples do not authorize deploying or changing an existing host.
