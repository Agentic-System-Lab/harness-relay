**English** | [繁體中文](sandboxing.zh-TW.md)

# OS sandboxes by platform

Harness Relay does not sandbox anything itself: it starts the real `claude`, `codex` and `grok` CLIs, and each of them brings its own OS sandbox, or none. This page says which of Harness Relay's runs use one today, on which platforms each sandbox works, what it needs there, what happens when it cannot start, and what it does not cover.

Checked on 10 November 2026 with Claude Code 2.1.322, Codex 0.167.0 and Grok 1.0.77. Where this page says something was tried, it was tried on a Mac; everything else, including all of Linux and Windows, comes from each CLI's own documentation (see [Sources](#sources)). The CLIs change quickly, so check again before you rely on a detail.

## What an OS sandbox is

An OS sandbox is a set of limits that the operating system's kernel enforces on a process and on every process it starts: which files it may write (and sometimes read), and whether it may use the network. macOS has Seatbelt (`/usr/bin/sandbox-exec`); Linux has Landlock, seccomp and bubblewrap (which uses user namespaces).

It works at a different point from approvals:

- An **approval** is decided *before* a command runs, from the command's text. Once a command is allowed, nothing checks what it does.
- A **sandbox** applies *while* the command runs. A write or a connection outside its limits fails (a write usually with `Operation not permitted`), also when it comes from code the agent wrote and a test then ran.

That is why the sandbox matters in edit mode too, where tests and builds run code the agent may have just changed; with Grok that code can still reach the network (see [Architecture → Permission mapping](architecture.md#permission-mapping)).

## What Harness Relay's runs use today

| Relay permission | Claude Code | Codex | Grok |
| --- | --- | --- | --- |
| Read-only | its sandbox: writes in the working directory and temp folders, every host asked about | profile `harness-relay-…` from `:read-only` | profile `harness-relay` from `workspace`, network allowed |
| Edit | its sandbox: writes in the working directory and temp folders, every host asked about | profile `harness-relay-…` from `:workspace`, network off | profile `harness-relay` from `workspace`, network allowed |
| Full access | no sandbox | none (`danger-full-access`) | none |

- **Claude Code**'s sandbox covers its Bash tool (the `sandbox` setting). Below full access, Harness Relay turns it on in the turn's `--settings` with `failIfUnavailable` (no sandbox, no run), `autoAllowBashIfSandboxed: false` (the permission still decides what runs without asking) and the ask rule `Bash(dangerouslyDisableSandbox:true)` (every command the model runs outside the sandbox is asked about); on native Windows, where Claude Code has none, it runs without one. Tried on a Mac in both modes: writing in the working directory works (in read-only mode once allowed); writing to the home folder is asked about, marked as running outside the sandbox, and fails when declined; a connection to example.com is asked about and refused when declined.
- **Codex** runs every command in its sandbox below full access, in a permission profile Harness Relay defines in the thread's config (`harness-relay-` and a random part, new for each run, extending `:read-only` or `:workspace`) and names in the thread (`permissions`, an experimental field it opts into), which wins over a `sandbox_mode` in your config. The run fails when Codex does not answer that it applied that profile (an older Codex ignores the field). On native Windows it uses the legacy sandbox mode as before. Tried on a Mac in `workspace-write`: writing in the working directory works; writing to the home folder or `~/.npm` and connecting to github.com are refused; reading the home folder works.
- **Grok** runs in its custom profile `harness-relay` in read-only and edit mode: Grok's `workspace` plus the paths below. Read-only does not use its `read-only` profile, which refuses to start on some machines: on a Mac with OrbStack, `/var/run/docker.sock` is a symlink and Grok stops with `could not apply the 'read-only' sandbox profile … Refusing to start with its protections missing`. Tried on a Mac in both modes: writing in the working directory works, writing to the home folder fails with `Operation not permitted`, and example.com is reached, since `workspace` allows the network (`"restrict_network": false` in `~/.grok/sessions/sandbox-events.jsonl`, with `"enforced": true`). Those tries were in `workspace`, before `harness-relay`; that one applied too (`"enforced": true`, with its `deny_paths`). Harness Relay sets a profile (`GROK_SANDBOX`) only below full access, so with full access a `[sandbox] profile` in Grok's own `config.toml`, or a `GROK_SANDBOX` the server was started with, still applies.

## What agents may not read or write

Below full access, Harness Relay keeps every agent's sandbox out of these places (`src/server/protect.ts`), on macOS and Linux:

- **The browsers' own folders**, where a signed-in browser keeps the key it sends to Harness Relay (and, in some browsers, its cookie) on disk: Chrome, Chromium, Edge, Brave, Arc, Vivaldi, Opera, Firefox, LibreWolf, Zen, Orion, Floorp, Waterfox, Helium, DuckDuckGo and GNOME Web, and Safari's and WebKit's folders (`~/Library/…` on macOS; `~/.config/…` and `$XDG_CONFIG_HOME/…`, `~/.mozilla`, snap and Flatpak folders on Linux). Only those that exist are listed, each also by its real path.
- **Harness Relay's database** (`relay.db` and the files SQLite keeps beside it), also when the working directory holds it.
- **Harness Relay's own temporary folder** (`data/tmp`), where a Claude Code turn's `--settings` and MCP config wait for it. In the system's temporary folder, which every sandbox lets commands write in, another agent's command could change them before Claude Code reads them (turning its sandbox off, or starting a command of its own as an MCP server, outside any sandbox), or read the MCP servers' secret values.

How each CLI takes them:

- **Claude Code**: `sandbox.filesystem.denyRead` and `denyWrite`, and `Read` deny rules for its own file tools, which are outside its sandbox.
- **Codex**: a `deny` entry for each in the thread's `harness-relay-…` permission profile (not on Windows, whose legacy sandbox cannot deny reading everywhere). Its name changes with each run: Codex merges a profile of the same name from its other config files, such as a trusted project's `.codex/config.toml`, into it, and a more specific entry there (`read` for a folder inside a denied one) opens the path again (tried with `codex sandbox`).
- **Grok**: the `deny` list of its custom profile `harness-relay`, which Harness Relay writes into `sandbox.toml` in Grok's home (`~/.grok`, or `grok` in the CLIs' own folder) before each run, between `# >>> harness-relay` and `# <<< harness-relay`, leaving the rest of the file as it is. A custom profile Grok cannot apply makes it refuse to start; on Linux, its `deny` list needs bubblewrap.

Tried on a Mac in edit mode with each CLI: listing `~/Library/Application Support/Firefox` and reading `data/relay.db` with the shell failed with `Operation not permitted`, reading the database with Claude Code's Read tool or Grok's file tool was refused, and writing in the working directory worked.

What this does not cover: a browser whose folder is not on the list (a new one, a portable one, or Chrome with `--user-data-dir` somewhere else); a command the user allows to run outside the sandbox; what a CLI runs outside its sandbox, such as Claude Code's hooks and local MCP servers (see [What the sandboxes do not cover](#what-the-sandboxes-do-not-cover)); a path whose name holds `*`, `?` or `[`, which Grok and Claude Code read as a pattern; full access; native Windows.

Edit mode is also refused in a working directory that holds Harness Relay itself (its folder, or its data folder; the worktrees of parallel mode, inside the data folder, are fine): agents there change files without asking, and could change Harness Relay's code. A conversation is refused when it is created, scheduled or changed so, and a turn when it starts. Read-only stays allowed there, since it asks before writing (and Codex cannot write at all). To work on Harness Relay itself, run the copy you use from another folder.

## Platforms

| | macOS | Linux | Windows | WSL2 |
| --- | --- | --- | --- | --- |
| **Codex** | ✅ Seatbelt | ✅ bubblewrap + seccomp | ✅ its own sandbox (see below) | ✅ the Linux sandbox |
| **Claude Code** | ✅ Seatbelt | ✅ bubblewrap + socat | ❌ commands run without a sandbox | ✅ the Linux sandbox |
| **Grok** | ⚠️ Seatbelt, which cannot block the network | ✅ Landlock + seccomp, and bubblewrap for Harness Relay's runs | ❌ not listed in its docs | not verified |

Harness Relay itself runs on all three, so on native Windows only Codex has a sandbox.

### macOS

- All three use Seatbelt, which is part of macOS: there is nothing to install.
- **Grok cannot block the network on macOS.** Its docs say that blocking the network of the commands it runs is enforced on Linux only (through seccomp) and does nothing on macOS, for every profile, `read-only` and `strict` included. On every platform, what Grok does itself (web search, web fetch, the model's API) is never blocked.
- A runtime socket that is a symlink can stop Grok's `read-only` and `strict` profiles from starting (see above; both tried).
- Claude Code's docs list what fails under its Seatbelt sandbox: `gh`, `gcloud` and `terraform` may fail TLS verification; `open`, `osascript` and sign-ins in the browser are blocked (Apple Events); git over SSH fails (its tunnel through the sandbox's proxy cannot authenticate on macOS); and a command can listen on or connect to a localhost port only with `network.allowLocalBinding`.

### Linux

- **Claude Code** needs `bubblewrap` and `socat` (`sudo apt-get install bubblewrap socat`, or `sudo dnf install bubblewrap socat`). To block Unix sockets as well, it needs the seccomp filter from `npm install -g @anthropic-ai/sandbox-runtime`. Each command gets a localhost of its own, so it cannot reach a server on the computer's localhost.
- **Codex** uses bubblewrap and seccomp. It takes the first `bwrap` on the `PATH` (outside the working directory), or else one it ships with, and warns at start. Its older Landlock code (`features.use_legacy_landlock`) is rejected for policies that restrict files.
- **Grok** uses Landlock and needs kernel 5.13 or later. Before kernel 6.2 (Landlock ABI 3; the default kernels of Ubuntu 22.04 and Debian 12 are older), a command can still shorten a file outside the paths it may write with `truncate`. A custom profile with a `deny` list also needs bubblewrap, so Harness Relay's runs below full access do (theirs always holds its database). Its docs also say that `workspace`, `read-only` and `strict` refuse to start on Linux "without verified read-only mounts" (the mounts that keep Grok's own settings and hooks from being written). Network blocking (`restrict_network`) uses seccomp and works on Linux.
- bubblewrap needs unprivileged user namespaces. Since 23.10, Ubuntu restricts them with AppArmor, which can stop bubblewrap; Claude Code's docs then say to add an AppArmor profile for `/usr/bin/bwrap`, or to lift the restriction with `sysctl` for a `bwrap` anywhere else.

### Docker and dev containers

Containers often keep bubblewrap from working: they may block the user namespaces it needs, or mounting a fresh `/proc`.

- **Claude Code**: `sandbox.enableWeakerNestedSandbox: true` makes it work in an unprivileged container (it reuses the container's `/proc`), with weaker isolation.
- **Codex** warns at start when bubblewrap cannot create user namespaces. Its docs suggest giving the container what bubblewrap needs, or running `codex` with `--sandbox danger-full-access` inside it and letting the container be the sandbox.
- **Grok**: Landlock itself needs no user namespace, but a `deny` list needs bubblewrap, and the read-only mounts of its built-in profiles (see Linux above) may need a mount namespace too (not verified). Not tried in a container.

### Windows

- **Codex** has a sandbox of its own, in three implementations (`[windows] sandbox = "…"` in `config.toml`):
  - `mxc`, the one its docs recommend: no administrator setup, no extra accounts or firewall rules. It needs Windows 11 24H2 (build 26100.9278) or 25H2 (build 26200.9278) or later. Commands can reach services on loopback, and when a command ends, the processes it left running stop too (so a dev server started in the background stops with it).
  - `elevated`, the legacy fallback its docs prefer when `mxc` is not available: an administrator sets it up once (a UAC prompt, local users and groups, firewall rules, logon rights for those users); commands then run as those lower-privilege users, without administrator rights. IT can run `codex sandbox setup --elevated` from an elevated process ahead of time.
  - `unelevated`, a second legacy fallback: a restricted token derived from your account, with file permissions as the boundary, for when the elevated setup is not possible. Its network isolation is weaker, and it cannot deny reading a path.
  - Windows 11 is recommended; Windows 10 is best effort and needs version 1809 or later. Its log is `CODEX_HOME/.sandbox/sandbox.log`.
- **Claude Code** has no sandbox on native Windows: commands run without one. Use WSL2.
- **Grok**: its docs list only macOS and Linux. Whether Grok then runs without a sandbox on Windows (its docs say a built-in profile that cannot be applied only warns, see below) or refuses to start was not verified.

### WSL

- **WSL2**: Codex and Claude Code use their Linux sandbox, with the same requirements (bubblewrap; and `socat` for Claude Code). Whether Grok's Landlock works depends on the WSL2 kernel (not verified).
- **WSL1** cannot create user namespaces. Claude Code's sandbox needs WSL2, and Codex (since 0.115) refuses the sandboxed commands that need bubblewrap.

## Turning each sandbox on

The commands and settings below turn each CLI's sandbox on, platform by platform, and check that it is on. They are for your own use of each CLI; [the next table](#where-harness-relays-runs-read-these-settings) says which of them Harness Relay's runs pick up. Linux commands use `apt-get` (Debian, Ubuntu), with `dnf` (Fedora) beside them.

| | macOS | Linux | Windows | WSL2 | Container |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | settings only | `bubblewrap` and `socat`, then settings | no sandbox: use WSL2 | as on Linux | as on Linux, plus `enableWeakerNestedSandbox` |
| **Codex** | settings only | settings (`bubblewrap` recommended) | `[windows] sandbox` | as on Linux | give the container what bubblewrap needs, or let the container be the sandbox |
| **Grok** | settings only | kernel 5.13+ with Landlock, and `bubblewrap` for Harness Relay's runs, then settings | not in its docs: use WSL2 | as on Linux, if its kernel has Landlock (not verified) | not tried |

### Where Harness Relay's runs read these settings

| | Settings that Harness Relay's runs read | What Harness Relay sets itself |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json`, or `claude/settings.json` in [the CLIs' own folder](user-guide.md#agent-sessions-the-clis-own-folder-and-agentsview); a project's `.claude/settings.json` and `.claude/settings.local.json`; managed settings | below full access (not on native Windows), `sandbox.enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed: false`, the ask rule above and the protected paths (`denyRead`, `denyWrite`, `Read` deny rules, see below); your other `sandbox` keys, such as `network.allowedDomains`, are left as they are (not tried) |
| Codex | `~/.codex/config.toml`, or `codex/config.toml` in the CLIs' own folder | below full access, a `harness-relay-…` permission profile for the thread (so your `sandbox_mode` and `[sandbox_workspace_write]` are not used); on Windows the sandbox mode for the permission, and in edit mode `network_access = false`; not other keys, such as `[windows] sandbox` |
| Grok | `GROK_SANDBOX` in the environment Harness Relay was started with; otherwise `[sandbox] profile` in `~/.grok/config.toml`, or `grok/config.toml` in the CLIs' own folder | `GROK_SANDBOX=harness-relay` in read-only and edit mode (`workspace` on Windows), and the `[profiles.harness-relay]` block in `sandbox.toml` in Grok's home (see below); with full access, what you set applies |

Grok keeps the profile a session started with for the life of that session, and refuses to resume it with a different one (its docs). Harness Relay resumes each agent's session from turn to turn, and starts a fresh one, with the conversation so far, when a resume fails. Read-only and edit share a profile, so only a change to or from full access, or a change to the profile you set, makes that happen (Grok sessions from before `harness-relay` also start fresh once).

### On macOS

There is nothing to install for any of the three.

**Claude Code.** In `~/.claude/settings.json`:

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "network": {
      "allowedDomains": ["github.com", "*.npmjs.org"],
      "allowLocalBinding": true
    }
  }
}
```

- `failIfUnavailable` makes Claude Code stop at start instead of running commands without a sandbox; `allowUnsandboxedCommands: false` takes away the retry outside the sandbox.
- `network.allowedDomains` lists the hosts commands may reach; any other host is asked about or refused (see [What an approval can do](#what-the-sandboxes-do-not-cover)). `network.allowLocalBinding` lets commands listen on and connect to localhost ports, for dev servers and tests.
- For one session only: `claude --settings '{"sandbox": {"enabled": true, "allowUnsandboxedCommands": false}}'`. In a session, `/sandbox` shows and changes it, and saves the change in the project's `.claude/settings.local.json`.
- To check, ask Claude (not the `!` prompt) to run `touch ~/sandbox-probe`, which should fail with `Operation not permitted`, and `curl --noproxy '*' https://example.com`, which should fail with `Could not resolve host`; turn down any retry outside the sandbox.

**Codex.**

```sh
codex --sandbox workspace-write    # this session: read-only, workspace-write or danger-full-access
codex sandbox --permission-profile :workspace -- touch ~/sandbox-probe    # check: Operation not permitted
```

In `~/.codex/config.toml`:

```toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = false
writable_roots = ["/absolute/path/to/another/folder"]
```

- `codex sandbox` runs one command in the sandbox of a built-in profile: `:read-only`, `:workspace` or `:danger-full-access`. In 0.167 it takes no platform name; Codex's docs still write `codex sandbox macos …` (tried: 0.167 takes `macos` as the command to run).

**Grok.**

```sh
grok --sandbox workspace    # this session: workspace, read-only, strict, devbox or a custom profile
GROK_SANDBOX=workspace grok    # the same, from the environment
tail -n 1 ~/.grok/sessions/sandbox-events.jsonl    # check: "enforced": true
```

In `~/.grok/config.toml`:

```toml
[sandbox]
profile = "workspace"
```

A custom profile goes in `~/.grok/sandbox.toml`, or a project's `.grok/sandbox.toml`, and is used with `grok --sandbox project`:

```toml
[profiles.project]
extends = "workspace"
read_only = ["/data"]
deny = ["~/.ssh", "**/.env", "**/*.pem"]
```

- `devbox` is for disposable machines: it writes almost everywhere, the home folder included. `restrict_network = true` does nothing on macOS (see [macOS](#macos)).
- Harness Relay already runs Grok in its own profile `harness-relay`, based on `workspace`, below full access; a `GROK_SANDBOX` it was started with applies to its full-access Grok runs only.

### On Linux

First check what the sandboxes need (these checks are not from the CLIs' docs and were not tried):

```sh
bwrap --ro-bind / / true && echo "bubblewrap works"    # Claude Code, Codex, Grok's deny lists
uname -r    # Grok: 5.13 or later (6.2 or later to stop truncate)
cat /sys/kernel/security/lsm    # Grok: the list includes landlock
sysctl kernel.apparmor_restrict_unprivileged_userns    # Ubuntu 23.10 and later: 1 = restricted
```

When bubblewrap fails on Ubuntu 23.10 or later, Claude Code's docs give an AppArmor profile for `/usr/bin/bwrap`:

```sh
sudo tee /etc/apparmor.d/bwrap > /dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo systemctl reload apparmor
```

It covers only `/usr/bin/bwrap` (see `which bwrap`), not the copy Codex ships with. For a `bwrap` anywhere else, `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` lifts the restriction for every program until the next restart.

**Claude Code.**

```sh
sudo apt-get install bubblewrap socat    # Fedora: sudo dnf install bubblewrap socat
npm install -g @anthropic-ai/sandbox-runtime    # optional: blocks Unix sockets as well
```

Then the same `settings.json` as on macOS; `allowLocalBinding` has no effect on Linux. Restart Claude Code after installing, since it checks at start. To check, the same two commands as on macOS: `touch ~/sandbox-probe` fails with `Read-only file system` here, and `/sandbox` shows whether anything is missing.

**Codex.**

```sh
sudo apt-get install bubblewrap    # Fedora: sudo dnf install bubblewrap
```

Without it, Codex uses the `bwrap` it ships with and warns at start. Then the same `config.toml` and commands as on macOS (`codex sandbox` was tried on a Mac only).

**Grok.** After the checks above, the same `config.toml`, `--sandbox` and `GROK_SANDBOX` as on macOS. On Linux a custom profile can also block the network of the commands Grok runs:

```toml
[profiles.offline]
extends = "workspace"
restrict_network = true
```

A `deny` list needs bubblewrap: `sudo apt-get install bubblewrap`.

### In Docker and dev containers

- **Claude Code**: in an unprivileged container, add `"enableWeakerNestedSandbox": true` under `sandbox`; the isolation is weaker.
- **Codex**: give the container what bubblewrap needs (user namespaces, its own `/proc`, seccomp), or run `codex --sandbox danger-full-access` in it and let the container be the sandbox. Its docs do not give the container's flags.
- **Grok**: not tried; the Linux checks above apply inside the container.

### On Windows

`winver` shows the Windows build (for example `OS Build 26100.9278`).

**Codex**, in `%USERPROFILE%\.codex\config.toml`, one of:

```toml
[windows]
sandbox = "mxc"    # fails where mxc is not available
```

```toml
[features]
prefer_mxc = true    # mxc where Windows has it
```

```toml
[windows]
sandbox = "elevated"    # or "unelevated"
```

- `elevated` needs a one-time setup that an administrator approves (a UAC prompt). IT can do it ahead of time, from an elevated process: `codex sandbox setup --elevated --user 'DOMAIN\alice' --codex-home 'C:\Users\alice\.codex'`.
- To check `mxc`, in PowerShell (expect `MXC_OK`, then `0`):

  ```powershell
  codex -c windows.sandbox=mxc sandbox --include-managed-config --permission-profile :workspace -- cmd.exe /d /c echo MXC_OK
  $LASTEXITCODE
  ```

- `codex sandbox uninstall` removes the legacy sandbox's accounts and network rules. The log is `%USERPROFILE%\.codex\.sandbox\sandbox.log`.

**Claude Code and Grok** have no sandbox on native Windows: run them, and Harness Relay, in WSL2.

### On WSL2

In PowerShell or Windows Terminal, as an administrator:

```powershell
wsl --install    # WSL2 with Ubuntu
wsl -l -v    # VERSION must be 2
wsl --set-version Ubuntu 2    # turns a WSL1 distribution into WSL2
```

Then, inside WSL, install Node.js, the CLIs and Harness Relay, and follow [On Linux](#on-linux) for each CLI. Harness Relay starts the CLIs of the system it runs on: run on Windows, it starts their Windows builds, where Claude Code and Grok have no sandbox. For Grok, `cat /sys/kernel/security/lsm` inside WSL shows whether its kernel has Landlock. WSL2 passes `localhost` through to Windows by default, so the browser on Windows opens Harness Relay as usual (not tried).

## When the sandbox cannot start

Some of these failures are silent: the CLI runs on without a sandbox, and Harness Relay does not show any warning the CLI prints.

| | What happens |
| --- | --- |
| Claude Code | Commands run without a sandbox, unless `sandbox.failIfUnavailable` is `true`; then it exits at start. Harness Relay sets it below full access, so the turn fails with Claude Code's reason and how to fix it. |
| Codex | On WSL1, sandboxed commands are refused. Elsewhere it warns at start (for example bubblewrap without user namespaces); its Linux README calls the alternative "a runtime sandbox failure", so sandboxed commands most likely fail then rather than run without a sandbox (not verified). |
| Grok | A built-in profile: its docs say it warns and carries on without enforcement, but some failures (such as the symlinked socket above, or Linux without the read-only mounts) make it refuse to start instead. A custom profile (`sandbox.toml`) always refuses to start. `"enforced": true` in `sandbox-events.jsonl` in Grok's `sessions` folder (`~/.grok/sessions`, or `grok/sessions` in the CLIs' own folder) shows that a profile was applied. |

When Grok refuses to start because of its sandbox, the turn fails with Grok's reason. Harness Relay does not check whether a sandbox was actually applied.

## What the sandboxes do not cover

- **Reading.** By default all three let commands read almost the whole computer, `~/.ssh` and `~/.aws` included; only Grok's `strict` profile limits reading (to the working directory, system paths and `~/.grok`). Harness Relay keeps them out of the browsers' folders and its own database (see [What agents may not read or write](#what-agents-may-not-read-or-write)), not out of anything else. Keeping secrets from leaving the computer depends on blocking the network, which Grok cannot do on macOS.
- **Harness Relay's own API.** Grok's sandbox lets commands reach localhost (tried on a Mac: `curl http://127.0.0.1:…` from a Grok command in edit mode got its answer), but Harness Relay's API at `127.0.0.1:8787` takes only signed-in browsers: a program without the browser's cookie and key gets 401 (tried with `curl`), so such a command cannot start a turn (see [Architecture → Signing in](architecture.md#signing-in) for what it does not stop). Claude Code's and Codex's sandboxes refused localhost in the same test.
- **Claude Code's own tools.** Its sandbox covers Bash commands and what they start, not its Read, Edit, Write, WebFetch and WebSearch tools (its permission rules govern those), its hooks, local MCP servers (the tool library's included) or LSP servers.
- **Writing outside the working directory and the temp folders fails**, package caches included (`~/.npm`, pip, cargo, Go's build cache). With the network off as well, installing dependencies fails.
- **Git.** Codex's `workspace-write` keeps `.git` read-only: `git add` and `git commit` fail with `.git/index.lock: Operation not permitted` (tried on a Mac). Claude Code keeps `.git/config` and `.git/hooks` from being written. In parallel mode, a worktree's git data lives in the main repository's `.git/worktrees/<name>`, outside the working directory. Harness Relay's snapshots and the commits of worktree results run in the server, outside any sandbox, so they still work.
- **Tools that often break in a sandbox** (from Claude Code's docs): Docker and ssh-agent (Unix sockets), git over SSH and `open` and `osascript` (on macOS), watchman (use `jest --no-watchman`), Chromium on Linux (Playwright, which starts it, was not tried).
- **What an approval can do.** In a sandbox, asking the user means asking whether a command may leave it:
  - Claude Code: the model may run the command again outside the sandbox with `dangerouslyDisableSandbox` (`sandbox.allowUnsandboxedCommands: false` takes that way out away). That retry, and a connection to a host that is not on its network allowlist, are asked about in `manual` and `acceptEdits` and refused in `dontAsk`. In a headless `-p` run they come as `can_use_tool` requests (tried on a Mac): a host as `SandboxNetworkAccess`, which Harness Relay shows as reading a web page from that host; and a command Claude Code asks about because of a path (`blocked_path`) the sandbox cannot write, which would fail in the sandbox even once allowed, so Harness Relay runs it outside the sandbox when the user allows it, and the card says so. With refusing, `acceptEdits` still sends the host request, which Harness Relay refuses.
  - Codex: it asks only when the model requests more than the sandbox allows, as today.
  - Grok: a profile cannot be lifted once applied, so approving a call does not let it write outside the profile's paths.

## What is still missing

Read-only and edit now run in a sandbox with all three CLIs where the platform has one. Full access is meant to run without one: Docker, pushing, installing and writing outside the folder are what it is for. Still missing:

1. **Not taking a setting for a sandbox.** Claude Code and Grok on native Windows, and Grok's network on macOS, can be set but are not enforced. The UI should say whether each agent is really sandboxed on this computer, or refuse a sandboxed mode there.
2. **Checking the requirements on Linux before a run.** When Claude Code's sandbox cannot run, its turn fails and says to install `bubblewrap` and `socat`; Codex's and Grok's requirements (`bwrap`, the kernel version, user namespaces inside a container) are not checked, and nothing says in the user's language what to install for them.
3. **Codex's `elevated` sandbox on Windows** needs its one-time setup, with a UAC prompt; whether a `codex app-server` started in the background can show it was not verified. An administrator can run `codex sandbox setup --elevated` first, or the user can use `mxc` where Windows supports it.

## Sources

- Claude Code: [Sandboxing](https://code.claude.com/docs/en/sandboxing) and [All settings](https://code.claude.com/docs/en/settings-reference).
- Codex: [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security), [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) and the [Linux sandbox README](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md).
- Grok: the sandbox documentation that comes with `grok` 1.0.77 (profiles, platform support, network restrictions).
