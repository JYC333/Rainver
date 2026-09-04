# Rainver Host (Linux)

`rainver-host` connects a machine you own to a Rainver control plane and runs
as a systemd user service. The release archive includes its own Node runtime;
the target machine does not need this repository, pnpm, or Node.js.

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

Successful registration enables and starts the systemd user service. There is
no need to keep the terminal open or run `rainver-host run` yourself.

Automatic updates are opt-in. They check the selected release channel every
six hours, verify its SHA-256 checksum, switch the installed version atomically,
and ask the daemon to restart only after all launching, running, and uploading
Runs have finished.
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
user's `PATH` on first installation so it can discover the same `git` and
agent CLI executables after the terminal closes. Edit
`~/.config/rainver-host/service.env` and restart the service if those paths
later change.

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
