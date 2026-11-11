**English** | [繁體中文](sandboxing.zh-TW.md)

# OS sandboxes by platform

Harness Relay starts the real `claude`, `codex`, `grok` and `cursor-agent` CLIs, and each of them brings its own OS sandbox, or none (Cursor brings none to Harness Relay's runs, and runs without one). The five open-source agents (OpenCode, Goose, Cline, OpenHands, Pi) bring none either, so Harness Relay sandboxes them itself, with [its own sandbox](#harness-relays-own-sandbox) (the same primitives: Seatbelt on macOS, bubblewrap on Linux, a filtering proxy for the network). This page says which of Harness Relay's runs use one today, on which platforms each sandbox works, what it needs there, what happens when it cannot start, and what it does not cover.

Checked on 10 November 2026, and for Cursor on 11 November 2026. What was tried, on which systems and with which versions, is in [What was tested](#what-was-tested): a Mac (macOS 26.6) and an NVIDIA DGX Spark (Ubuntu 24.04, aarch64); Cursor on the Mac only. Everything else, all of Windows and WSL included, comes from each CLI's own documentation (see [Sources](#sources)). The CLIs change quickly, so check again before you rely on a detail.

## What was tested

On two machines, on 10 November 2026, with the real CLIs run through Harness Relay's own adapters (each in a scratch git folder; the tests' replies, tool rows and files checked), besides the unit tests (`npm test`, which passed on both):

| | Mac | NVIDIA DGX Spark |
| --- | --- | --- |
| System | macOS 26.6.2, arm64 | Ubuntu 24.04.5 LTS, aarch64, kernel 7.0.0-1019-nvidia (AppArmor restricts unprivileged user namespaces) |
| Sandbox | Seatbelt | bubblewrap 0.9.0 and socat 1.8.0, with the AppArmor profile for `/usr/bin/bwrap` from [On Linux](#on-linux) (without it, all three refused to run in a sandbox) |
| CLIs | Claude Code 2.1.322, Codex 0.167.0, Grok 1.0.77; Cursor (`cursor-agent`) 2026.11.11-043ef28, on 11 November | Claude Code 2.1.321, Codex 0.167.0, Grok 1.0.77; Cursor not tried |
| git | 2.50.1 | 2.43.0 |

What each CLI was asked to do, in read-only and in edit mode, on both: write in the working directory, write in the home folder, reach example.com, list a browser's folder, read `data/relay.db` with the shell (and with its own file tool, for Claude Code and Grok). Approvals were allowed except to leave the sandbox or reach a host.

| | Mac | DGX Spark |
| --- | --- | --- |
| Claude Code | Working directory written (in read-only once allowed); home folder asked about as outside the sandbox, not written; example.com asked about, then blocked; Firefox's folder and the database refused (`Operation not permitted`), its Read tool refused too, also on a path with spaces | The same; Chrome's folder showed empty (bubblewrap covers it), the database refused (`Permission denied`) |
| Codex | Working directory written in edit mode only; home folder and example.com refused; Firefox's folder and the database refused | Its profile could not load (above): legacy sandbox; working directory written in edit mode only, home folder and example.com refused, but Chrome's folder and the database readable; it left empty `.agents`, `.aws` and `.codex` folders, and a `.git` where there was none, in the working directory and in `/tmp` (git and Grok take an empty `.git` for no repository) |
| Grok | Working directory written; home folder refused; example.com reached (macOS); Firefox's folder and the database refused, its file tool too; `~/.grok/downloads` and `~/.grok/bin` refused; appending to `~/.grok/config.toml` refused by Grok | Working directory written; home folder refused; example.com reached; Chrome's folder and the database refused (`Permission denied`); `~/.grok/downloads` written (on Linux its program is checked around each turn instead) |

Also tried: Grok's `.git/config` written by its commands (`git config core.fsmonitor …`, on both), which Harness Relay's own git then does not run; on the Mac, `127.0.0.1` refused by Claude Code's and Codex's sandboxes and reached from Grok's, and Harness Relay's API answering 401 to a program not signed in. Not tried: native Windows, WSL, containers, other Linux distributions, other versions of the CLIs.

**Cursor** was added a day later and checked on the Mac only (arm64), with `cursor-agent` 2026.11.11-043ef28: its ACP server and permission layer read in its code, plus real runs through Harness Relay's adapter. Its ACP mode applied no sandbox, whatever `--sandbox` or `sandbox.mode` said, so every shell command it wanted to run came to Harness Relay to ask. The code applies none in ACP mode on any platform; Linux and Windows were not tried with the real CLI.

These runs were started from the sources, as `npm start` runs the server. The [desktop app](user-guide.md#desktop-app) runs the same server, with the same adapters and the same sandbox settings, from its own data folder; the runs above were not repeated under it. On macOS, the privacy permissions you give the desktop app (a folder such as Documents, the microphone) are given to the agents it runs too, since they run inside it; under `npm start` they are the terminal's.

## What an OS sandbox is

An OS sandbox is a set of limits that the operating system's kernel enforces on a process and on every process it starts: which files it may write (and sometimes read), and whether it may use the network. macOS has Seatbelt (`/usr/bin/sandbox-exec`); Linux has Landlock, seccomp and bubblewrap (which uses user namespaces).

It works at a different point from approvals:

- An **approval** is decided *before* a command runs, from the command's text. Once a command is allowed, nothing checks what it does.
- A **sandbox** applies *while* the command runs. A write or a connection outside its limits fails (a write usually with `Operation not permitted`), also when it comes from code the agent wrote and a test then ran.

That is why the sandbox matters in edit mode too, where tests and builds run code the agent may have just changed; with Grok that code can still reach the network, and Cursor has no sandbox at all, so there only asking keeps it in check (see [Architecture → Permission mapping](architecture.md#permission-mapping)).

## What Harness Relay's runs use today

| Relay permission | Claude Code | Codex | Grok | Cursor | Open agents (OpenCode, Goose, Cline, OpenHands, Pi) |
| --- | --- | --- | --- | --- | --- |
| Read-only | its sandbox: writes in the working directory and temp folders, every host asked about | profile `harness-relay-…` from `:read-only` | profile `harness-relay` from `workspace`, network allowed | no sandbox: every command asks (except a Cursor team's allowlist); deny rules keep its own read and write tools from the protected paths (as written, below), and its write tool from writing or deleting | [Harness Relay's own sandbox](#harness-relays-own-sandbox): no writes to the working directory; the run's model hosts reachable, every other host asked about |
| Edit | its sandbox: writes in the working directory and temp folders, every host asked about | profile `harness-relay-…` from `:workspace`, network off | profile `harness-relay` from `workspace`, network allowed | no sandbox: every command asks (except a Cursor team's allowlist), and so does every write Cursor asks about; deny rules keep its own read and write tools from the protected paths (as written, below) | Harness Relay's own sandbox: writes to the working directory too; same network |
| Full access | no sandbox | none (`danger-full-access`) | none | none (`--force`) | none |

- **Claude Code**'s sandbox covers its Bash tool (the `sandbox` setting). Below full access, Harness Relay turns it on in the turn's `--settings` with `failIfUnavailable` (no sandbox, no run), `autoAllowBashIfSandboxed: false` (the permission still decides what runs without asking) and the ask rule `Bash(dangerouslyDisableSandbox:true)` (every command the model runs outside the sandbox is asked about); on native Windows, where Claude Code has none, it runs without one. Tried on a Mac in both modes: writing in the working directory works (in read-only mode once allowed); writing to the home folder is asked about, marked as running outside the sandbox, and fails when declined; a connection to example.com is asked about and refused when declined.
- **Codex** runs every command in its sandbox below full access, in a permission profile Harness Relay defines in the thread's config (`harness-relay-` and a random part, new for each run, extending `:read-only` or `:workspace`) and names in the thread (`permissions`, an experimental field it opts into), which wins over a `sandbox_mode` in your config. The run fails when Codex does not answer that it applied that profile (an older Codex ignores the field). On native Windows it uses the legacy sandbox mode as before. Tried on a Mac in `workspace-write`: writing in the working directory works; writing to the home folder or `~/.npm` and connecting to github.com are refused; reading the home folder works.
- **Grok** runs in its custom profile `harness-relay` in read-only and edit mode: Grok's `workspace` plus the paths below. Read-only does not use its `read-only` profile, which refuses to start on some machines: on a Mac with OrbStack, `/var/run/docker.sock` is a symlink and Grok stops with `could not apply the 'read-only' sandbox profile … Refusing to start with its protections missing`. Tried on a Mac in both modes: writing in the working directory works, writing to the home folder fails with `Operation not permitted`, and example.com is reached, since `workspace` allows the network (`"restrict_network": false` in `~/.grok/sessions/sandbox-events.jsonl`, with `"enforced": true`). Those tries were in `workspace`, before `harness-relay`; that one applied too (`"enforced": true`, with its `deny_paths`). Harness Relay sets a profile (`GROK_SANDBOX`) only below full access, so with full access a `[sandbox] profile` in Grok's own `config.toml`, or a `GROK_SANDBOX` the server was started with, still applies.
- **Cursor** runs over ACP (`cursor-agent acp`), whose permission layer never applies Cursor's sandbox, whatever `--sandbox` or `sandbox.mode` in its settings say, on any platform. So Harness Relay relies on approvals for its commands: below full access none runs without asking (except those on a Cursor team's auto-run allowlist, see [What the sandboxes do not cover](#what-the-sandboxes-do-not-cover)), tests and builds included, and one the user allows runs outside any sandbox, with the user's full rights, network included. Its own tools read anywhere (but the protected paths, below, as far as its deny rules reach them) and, in edit mode, edit inside the working directory without asking, except Cursor's protected files (`.git/hooks/**`, `.git/config`, `.vscode/**`, `.claude/*.json`, `.cursor/*.json`, `*.code-workspace`…): Cursor asks about a write to one, and about any write outside the working directory, and Harness Relay sends every write Cursor asks about to the user (or refuses it), since such a write could make code run later, outside any sandbox; the card says which of the two it is. Cursor asks about every delete; edit mode approves one inside the working directory, a link on the way taken for what it leads to and a path `~/…` for one in the home folder. In read-only mode its write tool can neither write nor delete (`Write(**)`, checked before Cursor would ask). Web fetch and web search run, a subagent's too. Each turn's private config folder has no allow rules, so neither your own Cursor allow rules nor a project's `.cursor/cli.json` (not read: `--disable-project-configs`) lets a command through (see [Architecture → Permission mapping](architecture.md#permission-mapping)).

## Harness Relay's own sandbox

The five open-source agents (OpenCode, Goose, Cline, OpenHands, Pi) have no OS sandbox of their own, so below full access Harness Relay runs each of them, and everything it starts, in a sandbox it builds with [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) (`srt`, Apache-2.0: Seatbelt on macOS, bubblewrap + seccomp on Linux, and a filtering HTTP/SOCKS proxy for the network). It is in `src/server/relaySandbox.ts`; the adapters ask for it through `sandboxCommand()`, and nothing below full access runs outside it.

**One sandbox per run.** Each run gets a host process of its own (`relaySandboxHost.ts`), started like any CLI through `src/server/process.ts` (tracked and killed with the whole process tree on shutdown), with a private control channel on its file descriptor 3. The host runs one sandbox-runtime for that run alone, so runs of different conversations — different working directories, permissions and hosts, at the same time — never see each other's rules: each has its own proxy, which only its own sandbox can reach (on macOS Seatbelt admits a connection to that proxy's port alone; on Linux the sandbox has no network of its own but that proxy's sockets), behind a token only its own sandbox is given. A host no rule decides is asked about over that run's channel, so the approval reaches the right run's **Ask me** and cannot be answered for another; the rules and the command never touch the command line or a shared file a sandboxed process could change. Inside the sandbox the agent starts through a fixed `/bin/sh` script (`SANDBOX_EXEC_SCRIPT`) that takes the program, its arguments and the run's own variables from its environment (`HARNESS_RELAY_SBX_*`, removed before the agent starts), so no value is ever part of a shell's text.

**The host's Node.** The host is a Node.js program. With `npm start` it runs on the server's own Node. The desktop app's Electron may not run as Node (its fuses turn that off), so there it runs on the Node.js 22.12 or later found on the login shell's `PATH` (`hostNode()`), bundled as `relaySandboxHost.mjs` with the sandbox runtime's packages beside it; without such a Node, the open agents are refused below full access with a message that says so.

**Filesystem.**

| | Read | Write |
| --- | --- | --- |
| Read-only | everything except the protected paths below | the run's own temp folder and the agent's state folders (its sessions, logs, caches) only — **not the working directory** |
| Edit | the same | the above plus the working directory and the conversation's attachments folder |

- Never readable **or** writable (`denyRead` + `denyWrite`): the protected paths (`protectedReads()`: the browsers' own folders and Harness Relay's database and temporary folder, the same as the other CLIs, see [What agents may not read or write](#what-agents-may-not-read-or-write)).
- Never writable (`denyWrite`), even where a folder above is: the agent's config paths (everything that changes what the CLI does when it starts — its config, plugins, extensions, hooks, MCP config, instructions files), so a run cannot widen its own next run; in edit mode, the other CLIs' and the open agents' own config inside the working directory (`.claude`, `.codex`, `.grok`, `.cursor` (Cursor, which runs without a sandbox, reads its rules, subagents, skills and MCP servers there), `.mcp.json`, `.opencode`, `opencode.json`, `opencode.jsonc`, `.goose`, `.cline`, `.clinerules` (Cline runs the hooks in `.clinerules/hooks` without asking), `.openhands`, `.pi`, `.agents`), the folders of the programs the sandbox runs, and what sandbox-runtime would otherwise let any command write (`/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug`). sandbox-runtime also keeps `.git/hooks`, `.git/config`, `.gitmodules` and the shell's dotfiles read-only by itself.
- **Each run writes its own, fresh temp folder** (in Harness Relay's data folder, removed when the run ends), not a shared one. sandbox-runtime gives every run the same `TMPDIR` (`/tmp/claude`) by default; Harness Relay overrides it so one run cannot leave a file — a transpile or compile cache, say — that the next run, perhaps in another conversation, loads and runs.
- **The host's own temp folder** (sandbox-runtime's sockets, its CA bundle) is in the data folder too, in `data/srt/<random>`, which no other run can read: never in the system's temporary folder, where another CLI's sandboxed command could replace or remove what is in it. A Unix socket's path must fit in 104 bytes on macOS and 108 on Linux, so a data folder whose path is too long for the sockets (more than 70 bytes on macOS, 61 on Linux, in UTF-8: a character outside ASCII takes 2 to 4) is refused below full access, with a message to set `RELAY_DATA_DIR` to a shorter folder. The desktop app's folder fits unless the user name is very long; a deep checkout (a worktree under `.claude/worktrees/`, say) may not.
- The run does not start when a protected path or a config path has `*`, `?` or `[` in its name (a sandbox would read it as a pattern and might not protect it), when a folder the run may write holds Harness Relay, the home folder or another CLI's own folder (it could then change what runs outside the sandbox), or, in edit mode, when the working directory itself is one of those (`relayFolderRefusal()`, as for the other CLIs).

**Network.** The run reaches the hosts of the model backends it uses (`api.openai.com`, `api.anthropic.com`, `api.x.ai`, and a custom endpoint's `host:port`) and no other without asking. Any other host is asked about through **Ask me** (an approval of kind `fetch`, for that host; "always allow" covers that host on that port only, or on 443 and 80 when the card names the host alone); declined, or in a conversation that refuses automatically, it is denied with a reason the model sees. A host the agent reaches every start but should never block a turn (Goose's `models.dev` catalogue) can be listed as **quietly denied** — refused with a reason, never asked. Harness Relay's own ports (`PORT`, 8787, 8789 and 5173: `npm start`'s and the desktop app's, and `npm run dev`'s API and Vite) are never allowed, directly or through the proxy, and neither is this computer's own address or a link-local or metadata address, however it is written (`127.1`, `2130706433`, `0x7f.0.0.1`, `localhost.` are read as the address the proxy dials). A host name is never looked up by Harness Relay before you allow it (its resolver is outside the sandbox, so looking up every name a command asks about would carry data out in the names): a name that leads to this computer (`localtest.me`, `127.0.0.1.nip.io`) is asked about like any other, and if you allow it, sandbox-runtime refuses it when it dials. A host still waiting to be asked about when the turn ends is refused, never put to the user afterwards. A model backend on this computer must name its port (`localhost:11434`; one on another computer of the local network, such as `192.168.1.20:8000`, need not), and both go through the proxy — Harness Relay keeps only loopback out of the proxy, never the private ranges, so a local backend still reaches the proxy and the allow-list decides (sandbox-runtime's own `NO_PROXY` covers the private ranges, which would send a local backend around the proxy and have it refused; Harness Relay narrows it). When a backend is on loopback itself (Ollama, a local vLLM), `NO_PROXY` lists only the agent's own ports (`localPorts`, below), so the backend and every other loopback port go through the proxy.

**The proxy, per client.** sandbox-runtime routes the network through a local proxy it names in `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`. Harness Relay sets `NODE_USE_ENV_PROXY=1` so Node 22's `fetch` / `http` / `https` honour it (Node 22.21+); Bun, Python's `httpx` and `requests`, Rust's `reqwest`, Go and curl read the proxy variables by themselves. Checked on this Mac and in Docker on Linux: Node 22 `fetch`, Bun, Python `httpx` and `requests`, and curl (a stand-in for a Rust `reqwest` client) all reached an allowed host through the proxy and were refused a host that was not allowed. A client that never sends loopback to a proxy (Cline adds `localhost`, `127.0.0.1` and `::1` to `NO_PROXY` by itself) still reaches a model backend or a server on loopback that the run may reach: on macOS the run may connect to those loopback ports directly (never listen on them), and on Linux, where the sandbox's loopback is its own, `socat` relays each of those ports onto it through the proxy, with the run's own credentials, before the agent starts (`loopbackRelay`, `SANDBOX_EXEC_SCRIPT`). Either way it reaches only what the proxy's allowlist allows.

**Per-adapter opt-ins** (never on by default, each for one CLI that needs it, each documented where it is used):

- **A pseudo-terminal** (`allowPty`), for OpenHands, which runs its commands in one (never in tmux below full access). **What `allowPty` opens on macOS:** sandbox-runtime's rule lets the run open `/dev/ptmx` and **every** `/dev/ttys*` by path, read and write, so a program in the sandbox can open any terminal of the user's that is open at the time: print onto it, read what is typed into it and change its settings, such as turning echo off (the kernel still refuses to push input into a terminal that is not the program's own, `TIOCSTI`). Seatbelt cannot narrow it to the run's own terminals: its rules are fixed when the run starts and name devices by path, and a terminal's number is picked by the kernel only when it is opened (and reused). So on macOS OpenHands runs below full access only once the user turns on its switch in Settings (off by default), which says this. **On Linux** bubblewrap gives the sandbox a `/dev/pts` instance of its own (checked in Docker: only `ptmx` in it, no terminal from outside), so the option opens none of the user's terminals there and needs no switch. **The run's own Unix sockets** (`allowUnixSocketsInTmp`) stay available to adapters (macOS only, inside the run's own temp folder, fresh each run) but no adapter asks for them any more; on Linux sandbox-runtime cannot allow one socket path (its seccomp filter blocks every Unix socket unless all are allowed, which this sandbox never does).
- **Loopback ports the agent only connects to** (`connectPorts`): servers of the user's that the agent does not run itself (Goose's HTTP MCP servers on this computer). They are reached through the proxy, whose allow-list names `127.0.0.1`, `localhost` and `[::1]` at those ports; the sandbox may not listen on them (on macOS), so a command cannot take over the port of one that is down; on Linux it can only listen on its own loopback, which is not this computer's. Never one of Harness Relay's ports.
- **The agent's own loopback ports** (`localPorts`), for a CLI that runs an HTTP server of its own and talks to it (OpenCode's `opencode acp`). On macOS the sandbox may listen on and connect to exactly those ports and no other local port, directly or through the proxy (whose allow-list then has `127.0.0.1`, `localhost` and `[::1]` at those ports alone); on Linux it has a loopback of its own where any port works and none of this computer's is reachable, so the proxy, which is outside it, does not allow them. Next to a backend on loopback, `NO_PROXY` holds just `127.0.0.1:<port>` and `localhost:<port>` for these: Node, Bun and httpx honour a port there and reach the agent's server directly (checked on both platforms), while curl, and Python's requests for an address, ignore it and use the proxy, which reaches the agent's server on macOS only. Never one of Harness Relay's ports, nor the backend's. This is narrower than sandbox-runtime's `allowLocalBinding`, which would open every localhost port (Harness Relay's own API, other local services, other runs' servers).
- **The certificate-trust daemon** (`allowTlsTrustd`), for Goose, whose TLS verification (Rust, through rustls-platform-verifier → the macOS Security framework) needs `com.apple.trustd.agent`, which sandbox-runtime's Seatbelt profile blocks by default. This opens exactly that one mach service (the single service sandbox-runtime's own `enableWeakerNetworkIsolation` opens, named on its own so nothing else is), only on macOS. It is a possible way out of the sandbox, because trustd fetches a certificate's OCSP or CRL from the network itself, outside the proxy, so a program could carry a little data out in what it asks trustd to check; it is off for a CLI whose TLS already goes through the proxy (Node, Bun, Python).

**Fail closed.** When the sandbox cannot start — native Windows (sandbox-runtime's Windows support is alpha; the open agents refuse to run there below full access, as sandbox-runtime itself is refused below full isolation), another platform, a processor sandbox-runtime cannot block Unix sockets on (not x64 or arm64), `bubblewrap` / `socat` / `ripgrep` missing on Linux, or sandbox-runtime failing to apply the rules — the turn fails with a reason in the user's language and how to fix it per platform, unless the permission is full access. Harness Relay checks a real sandbox can start (it runs a trivial command in one) before each run, caching the result briefly; the host itself also fails closed before it starts anything, when sandbox-runtime cannot apply the rules or warns of a hole (no seccomp helper, its own copy writable).

**Leftovers.** When a run ends the host stops the sandbox's whole tree. A process that leaves the host's process group — a command the agent backgrounded, which some CLIs run detached so a double fork re-parents it to `launchd`, a daemon that called `setsid`, or a server such as a tmux — would be missed by a group kill, and macOS has no PID namespace to put the tree in. Two sweeps find such processes on macOS:
- **By their sandbox** (`src/server/sandboxProcs.ts`): every descendant keeps the Seatbelt profile it was started under and cannot drop it, whatever it closed or wherever it was re-parented. For each process of yours, the kernel tells whether its profile lets it write the run's own temporary folder (only that run's profile does) and not the folder around it (a process that may write that too has a wider sandbox, another tool's whose working directory holds Harness Relay's data, say, and is left alone). This reads no environment and no terminal, only the kernel's answer about the policy (libsandbox's `sandbox_check`, called through the system's Python, `/usr/bin/python3`, which comes with the Xcode command line tools). A run's profile lets it remove its own temporary folder or put a link in its place, so the server makes it a real folder again before it asks (the kernel answers by path). The server runs this sweep when it disposes of the run, before the run's folders are removed, and the next server start runs it for every run folder a killed server left.
- **By a marker**: every sandboxed process also inherits a read-only descriptor to a per-run marker file under `data/relay-sandbox/`, and whatever still holds it is found with `lsof` and killed, by the host when the run ends, by the server when it disposes of the run, and at the next start after a server kill. The CLIs close inherited descriptors when they start a command (Node, Bun and Python do; Goose keeps them), so this catches less, and it is all there is when the command line tools are missing. A start then cannot tell the folders of runs a killed server left free of what may still run in them, so it keeps them (below).

Only the run's own profile and its markers are looked at, so a shell of yours that merely has its working directory in the folder, or any process outside the run's sandbox, is left alone. A start removes what killed runs left only when its sweeps found nothing of them still running; otherwise it keeps their folders and markers for a later start, and gives no permission back anywhere (a process still running could swap a folder for a link). On Linux none of this is needed: bubblewrap puts the tree in its own PID namespace, which ends with the sandbox when the host (and so bubblewrap) dies, even on a server kill. What this does **not** catch: without the Xcode command line tools, a process that closed its inherited descriptors and left the host's group. Such a leftover keeps the filesystem rules frozen in its Seatbelt profile — in edit mode it can still write the working directory, the attachments and the run's state folder, and read everything outside the protected paths — but its proxy is gone, so it can reach **no** network host at all (Seatbelt allowed only the proxy's now-closed localhost port), Harness Relay's own API included. Its writes stop when the computer next restarts.

**What it needs installed.** Nothing on macOS (Seatbelt and `sandbox-exec` are part of it). On Linux: `bubblewrap`, `socat` and `ripgrep` (`sudo apt-get install bubblewrap socat ripgrep`, or `sudo dnf install …`), and, on Ubuntu 23.10 or later, the AppArmor profile for `/usr/bin/bwrap` from [On Linux](#on-linux) (bubblewrap needs unprivileged user namespaces). In a container, bubblewrap needs the container to allow user namespaces and a fresh `/proc` (for a throwaway container: `docker run --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined`), or use full access and let the container be the sandbox.

**What it does not cover.** What a program in the sandbox may **read** (it reads almost the whole computer, `~/.ssh` and `~/.aws` included, except the protected paths); keeping secrets on the computer depends on the network block, which holds here on both platforms. A model backend you allow is reachable in full, so a determined agent could use it to carry data out (the allow-list is by host name, not by what the traffic is). On macOS, with `allowTlsTrustd` on, the trustd service as above. A Unix socket the agent needs on Linux (no path-based allow there). **On macOS, the start-up environment of every process above the command**: the agent process (`opencode`, …), the relay sandbox's host, the Harness Relay server, and the shell (or npm) that started the server — with the API keys any of them was started with and, for OpenCode, its local-server password. A command can read an ancestor's environment through the `kern.procargs2` sysctl (an unrelated process's is withheld by macOS, seen outside the sandbox). So keeping a key out of the agent's environment does not keep it from the agent's commands on macOS while the server holds it in its own start-up environment: start the server without API keys in its environment (Harness Relay keeps them in the OS credential store). On Linux the sandbox's PID namespace leaves only the sandboxed tree visible. Denying it would need a Seatbelt rule that also stops `ps` from running at all (procargs2 is the only channel for a process's command line too), which is too costly, so Harness Relay does not; instead an adapter keeps its secrets out of the environment of the commands the agent runs (OpenCode drops its server password there), and the network block stops a secret so read from being sent anywhere. Full access, which runs without a sandbox, as for the other CLIs.

**Checked** on 10 November 2026: on this Mac (macOS 26.6, arm64) with `scripts/sandbox-check.ts`, and on Linux in a throwaway Docker container (`node:22-bookworm`, bubblewrap 0.8, socat, ripgrep) with the same script. Again on 11 November 2026 on a DGX Spark (Ubuntu 24.04, arm64, bubblewrap 0.9) natively and in the same Docker container, with each open agent's real CLI run end to end there too (in read-only and edit, against a scripted endpoint and Ollama on loopback). In read-only and edit, a sandboxed process could not write outside the folders it is allowed (the working directory in read-only, the home folder, an ssh-like folder, the agent's config, any outside folder), could not read the protected paths (stand-ins for a browser folder, a secret file and the database), could not reach a host not allowed (and the approval path worked and was tied to the right run), reached an allowed host through the proxy with each client kind above, could not reach Harness Relay's port or this computer's own address, and could not escape through a child process, a symlink, a hard link, `git -c core.hooksPath` / config tricks, or by rewriting its own config path. Two concurrent runs with different rules stayed apart. A stopped run left no process or temporary folder behind, a detached command that tried to write after the turn ended (re-parented out of the host's group) was swept by the marker; background writers started from Node, Python and Perl that closed every descriptor and left the group were swept by their sandbox when the run ended (each wrote after the turn with that sweep turned off), while a process in a wider sandbox was left alone; and a process standing in for one left by a killed server was swept at the next startup. Every check ran with the private roots real runs have; a run read its own config inside them (Goose's layout), the network worked with the host's temp folder under the hidden folder (a short data path), a connect-only port was reached through the proxy and could not be listened on (macOS), a name that leads to this computer was asked about (never looked up by the server) and refused at dial time when allowed, and a shell whose working directory was in `data/relay-sandbox/` survived the startup sweep. `npm test` runs the offline unit tests (`test/relaySandbox.test.ts`, `test/sandboxProcs.test.ts`); it never starts a real sandbox. The real checks are the separate `scripts/sandbox-check.ts`.

## What agents may not read or write

Below full access, Harness Relay keeps every agent's sandbox (Cursor's own read and write tools, since it has none, as far as its deny rules reach: see below) out of these places (`src/server/protect.ts`), on macOS and Linux:

- **The browsers' own folders**, where a signed-in browser keeps the key it sends to Harness Relay (and, in some browsers, its cookie) on disk: Chrome, Chromium, Edge, Brave, Arc, Vivaldi, Opera, Firefox, LibreWolf, Zen, Orion, Floorp, Waterfox, Helium, DuckDuckGo and GNOME Web, and Safari's and WebKit's folders (`~/Library/…` on macOS; `~/.config/…` and `$XDG_CONFIG_HOME/…`, `~/.mozilla`, snap and Flatpak folders on Linux). Only those that exist are listed, each also by its real path.
- **The desktop app's window's own folder** (`browser/` in the app's folder: `~/Library/Application Support/Harness Relay/browser` on macOS, `~/.config/Harness Relay/browser` on Linux), where its window keeps its cookie and key; the app names it to the server as `RELAY_APP_BROWSER_DIR`.
- **Harness Relay's database** (`relay.db` and the files SQLite keeps beside it, in `data/`, or with the desktop app in the `data` folder of its own folder), also when the working directory holds it.
- **Harness Relay's own temporary folder** (`data/tmp`, or `data/tmp` in the desktop app's folder), where a Claude Code turn's `--settings` and MCP config wait for it, and where each Cursor turn's config folder is. In the system's temporary folder, which every sandbox lets commands write in, another agent's command could change them before Claude Code reads them (turning its sandbox off, or starting a command of its own as an MCP server, outside any sandbox), or read the MCP servers' secret values. A turn removes its folder when it ends; what a turn the server was stopped during left (a Claude Code turn's settings hold an endpoint's key when it runs on one) is removed when the server starts again (`clearRunTmp()`).

How each CLI takes them:

- **Claude Code**: `sandbox.filesystem.denyRead` and `denyWrite`, and `Read` deny rules for its own file tools, which are outside its sandbox. The turn's `--settings` also set `filesystem.disabled: false`, over a user setting that turns file isolation off. `allowRead` / `allowWrite` lists add up across settings files, so a run does not start when your own Claude Code settings (`settings.json` in its home) or managed settings on the computer (`managed-settings.json` and `managed-settings.d`) allow a path that reaches a protected one, a relative entry taken from the settings file's folder; the message names the entry to remove. (Claude Code itself, 2.1.322, ignores a project's `allowRead` entries that would open a path the turn's `--settings` deny.)
- **Codex**: a `deny` entry for each in the thread's `harness-relay-…` permission profile (not on Windows, whose legacy sandbox cannot deny reading everywhere). Its name changes with each run: Codex merges a profile of the same name from its other config files, such as a trusted project's `.codex/config.toml`, into it, and a more specific entry there (`read` for a folder inside a denied one) opens the path again (tried with `codex sandbox`). Codex 0.167 on the DGX Spark could not use a profile of its own: the thread started, but every turn failed sending its request (`failed to load workspace requirements: invalid input parameter`; Codex's built-in `:workspace` worked). A run that hits this runs again in Codex's legacy sandbox mode, kept for the rest of the server's run: its writes and network as before, without the deny list, so there Codex's commands can read the browsers' folders and the database (they still cannot reach the network, Harness Relay's API included).
- **Grok**: the `deny` list of its custom profile `harness-relay`, which Harness Relay writes into `sandbox.toml` in Grok's home (`~/.grok`, or `grok` in the CLIs' own folder) before each run, between `# >>> harness-relay` and `# <<< harness-relay`, leaving the rest of the file as it is. A custom profile Grok cannot apply makes it refuse to start; on Linux, its `deny` list needs bubblewrap. Grok's `workspace` lets its commands write all of Grok's home, where its own program is (`downloads`, `bin`): the list also denies those, and the folder of the program Harness Relay starts. Grok reads its settings there after its sandbox is on (`sandbox.toml` outside Harness Relay's block, `config.toml`, `managed_config.toml`, `requirements.toml`, `trusted_folders.toml`, `permission.toml`, `hooks-paths`), so they cannot be denied: Harness Relay reads them before each turn (a link as a link; an empty file counts as none, since Grok's sandbox makes them empty when they are missing) and, when a turn changed one, moves the changed one aside (`….changed-<time>`, renamed, not followed), puts it back and fails the turn saying so; a changed `skills` folder is reported the same way, not put back. Grok turns running at the same time share the settings as they were before the first of them, and a turn that starts while another runs first puts back what that one's commands changed. Changes that Grok itself, or you, make to these files during such a turn are put back the same way. Trusting a folder in Harness Relay during one first puts back what its commands changed, then records the trust in the store as the turn found it, and the turn keeps that. (`read_only` in a Grok profile grants reading; it does not stop writing.) On Linux, Grok starts its sandbox by running its own program again through bubblewrap, so a denied program could not start at all (tried): there its program is not denied but checked instead, the links in `~/.grok/bin` and the program file, with a copy kept in `data/tmp`; a change is put back from the copy before another sandboxed turn starts it and after each turn, and fails the turn.
- **Cursor**: deny rules in the turn's own `cli-config.json`, for each path `Read(<path>)`, `Read(<path>/**)`, `Write(<path>)` and `Write(<path>/**)` (the path itself, for the database's files, and everything under it), beside your own deny rules from the account's `cli-config.json`. They bind Cursor's own read and write tools only, and Cursor matches them against the path as written, case-sensitively and without resolving links: another spelling of a protected path (other letter case, on macOS's usual case-insensitive disk) or a link inside the project that leads to one is not denied, and its read tool reads it without asking. Its shell commands have no sandbox, so they are kept from these paths only by asking: a command the user allows (or one on a Cursor team's allowlist) can read and write them.
- **The open agents** (OpenCode, Goose, Cline, OpenHands, Pi): `denyRead` + `denyWrite` for the same paths, as literal names, in [Harness Relay's own sandbox](#harness-relays-own-sandbox); the agent's config paths are `denyWrite` too, so a run cannot widen its next one.

Tried on a Mac in edit mode with Claude Code, Codex and Grok: listing `~/Library/Application Support/Firefox` and reading `data/relay.db` with the shell failed with `Operation not permitted`, reading the database with Claude Code's Read tool or Grok's file tool was refused, and writing in the working directory worked. Claude Code's Read tool was also refused a file in the Firefox folder (a path with spaces). Grok's commands could not write `~/.grok/downloads` nor rename `~/.grok/bin` (before this, they could), and appending to `~/.grok/config.toml` was refused by Grok itself; its sessions stayed writable.

What this does not cover: Codex where it cannot use a profile of its own (see above); Cursor's commands, which have no sandbox, and its hooks and MCP servers; Cursor's read and write tools given another spelling of a protected path, or a link to one; a browser whose folder is not on the list (a new one, a portable one, or Chrome with `--user-data-dir` somewhere else); a command the user allows to run outside the sandbox; what a CLI runs outside its sandbox, such as Claude Code's hooks and local MCP servers (see [What the sandboxes do not cover](#what-the-sandboxes-do-not-cover)); a project's own Claude Code settings (`.claude/settings.json`, `.claude/settings.local.json`), which another agent in edit mode can write, and whose hooks, `sandbox.excludedCommands` and `network.allowUnixSockets` the next Claude Code turn takes; the plugin folders Grok keeps up itself in its home (`marketplace-cache`, `installed-plugins`, `bundles`, `bundled`), which its commands can change for a later run with full access; a change to Grok's settings made by a process a command left running after its turn, which the next turn takes as it finds it; full access; native Windows. A protected path whose name holds `*`, `?` or `[`, which the sandboxes would read as a pattern, makes runs below full access refuse to start, saying which.

Edit mode is also refused in a working directory that holds Harness Relay itself (its folder, or its data folder; the worktrees of parallel mode, inside the data folder, are fine), or what decides how the agents run: your home folder (a project inside it is fine), a CLI's own folder (`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.grok`, `~/.cursor`, or where their variables move them — Cursor's also under `$XDG_CONFIG_HOME/cursor` when that is where it keeps its settings — with `~/.cursor` refused even then, and so are `$XDG_CONFIG_HOME/cursor` (else `~/.config/cursor`) and `%APPDATA%\Cursor`, where Cursor keeps its sign-in on Linux and Windows, wherever its settings are), the CLIs' own folder Harness Relay gives them, or the folder of a CLI's program; holding it or inside it. Agents there change files without asking, and could change Harness Relay's code, a CLI's settings or program, or your shell's. A conversation is refused when it is created, scheduled or changed so (before a missing folder is created), and a turn when it starts. Read-only stays allowed there, since it asks before writing (and Codex cannot write at all). To work on Harness Relay itself, run the copy you use from another folder.

## Platforms

| | macOS | Linux | Windows | WSL2 |
| --- | --- | --- | --- | --- |
| **Codex** | ✅ Seatbelt | ✅ bubblewrap + seccomp | ✅ its own sandbox (see below) | ✅ the Linux sandbox |
| **Claude Code** | ✅ Seatbelt | ✅ bubblewrap + socat | ❌ commands run without a sandbox | ✅ the Linux sandbox |
| **Grok** | ⚠️ Seatbelt, which cannot block the network | ✅ Landlock + seccomp, and bubblewrap for Harness Relay's runs | ❌ not listed in its docs | not verified |
| **Cursor** | ❌ none in ACP mode | ❌ none in ACP mode (not tried) | ❌ none in ACP mode (not tried) | ❌ none in ACP mode (not tried) |
| **Open agents** (Harness Relay's own sandbox) | ✅ Seatbelt | ✅ bubblewrap + socat + ripgrep, and seccomp (x64/arm64) | ❌ refused below full access (alpha in sandbox-runtime) | ✅ the Linux sandbox |

Harness Relay itself runs on all three. On native Windows only Codex has a sandbox; the open agents refuse to run there below full access (run them in WSL2). Cursor has none on any of them in Harness Relay's runs.

### macOS

- Claude Code, Codex and Grok use Seatbelt, which is part of macOS: there is nothing to install.
- **Cursor** applies no sandbox in Harness Relay's runs (tried with `cursor-agent` 2026.11.11): below full access every command it runs asks (except those on a Cursor team's allowlist), and one the user allows runs with the user's full rights, network included.
- **Grok cannot block the network on macOS.** Its docs say that blocking the network of the commands it runs is enforced on Linux only (through seccomp) and does nothing on macOS, for every profile, `read-only` and `strict` included. On every platform, what Grok does itself (web search, web fetch, the model's API) is never blocked.
- A runtime socket that is a symlink can stop Grok's `read-only` and `strict` profiles from starting (see above; both tried).
- Claude Code's docs list what fails under its Seatbelt sandbox: `gh`, `gcloud` and `terraform` may fail TLS verification; `open`, `osascript` and sign-ins in the browser are blocked (Apple Events); git over SSH fails (its tunnel through the sandbox's proxy cannot authenticate on macOS); and a command can listen on or connect to a localhost port only with `network.allowLocalBinding`.

### Linux

- **Claude Code** needs `bubblewrap` and `socat` (`sudo apt-get install bubblewrap socat`, or `sudo dnf install bubblewrap socat`). To block Unix sockets as well, it needs the seccomp filter from `npm install -g @anthropic-ai/sandbox-runtime`. Each command gets a localhost of its own, so it cannot reach a server on the computer's localhost.
- **Codex** uses bubblewrap and seccomp. It takes the first `bwrap` on the `PATH` (outside the working directory), or else one it ships with, and warns at start. Its older Landlock code (`features.use_legacy_landlock`) is rejected for policies that restrict files.
- **Grok** uses Landlock and needs kernel 5.13 or later. Before kernel 6.2 (Landlock ABI 3; the default kernels of Ubuntu 22.04 and Debian 12 are older), a command can still shorten a file outside the paths it may write with `truncate`. A custom profile with a `deny` list also needs bubblewrap, so Harness Relay's runs below full access do (theirs always holds its database). Its docs also say that `workspace`, `read-only` and `strict` refuse to start on Linux "without verified read-only mounts" (the mounts that keep Grok's own settings and hooks from being written). Network blocking (`restrict_network`) uses seccomp and works on Linux.
- bubblewrap needs unprivileged user namespaces. Since 23.10, Ubuntu restricts them with AppArmor, which can stop bubblewrap; Claude Code's docs then say to add an AppArmor profile for `/usr/bin/bwrap`, or to lift the restriction with `sysctl` for a `bwrap` anywhere else.
- **Cursor** needs nothing here, since its ACP mode applies no sandbox on Linux either (from its code; not tried on Linux). Its commands are kept in check by asking alone.

### Docker and dev containers

Containers often keep bubblewrap from working: they may block the user namespaces it needs, or mounting a fresh `/proc`.

- **Claude Code**: `sandbox.enableWeakerNestedSandbox: true` makes it work in an unprivileged container (it reuses the container's `/proc`), with weaker isolation.
- **Codex** warns at start when bubblewrap cannot create user namespaces. Its docs suggest giving the container what bubblewrap needs, or running `codex` with `--sandbox danger-full-access` inside it and letting the container be the sandbox.
- **Grok**: Landlock itself needs no user namespace, but a `deny` list needs bubblewrap, and the read-only mounts of its built-in profiles (see Linux above) may need a mount namespace too (not verified). Not tried in a container.
- **Cursor** has no sandbox to break: the container itself is the only isolation its commands get there (not tried).

### Windows

- **Codex** has a sandbox of its own, in three implementations (`[windows] sandbox = "…"` in `config.toml`):
  - `mxc`, the one its docs recommend: no administrator setup, no extra accounts or firewall rules. It needs Windows 11 24H2 (build 26100.9278) or 25H2 (build 26200.9278) or later. Commands can reach services on loopback, and when a command ends, the processes it left running stop too (so a dev server started in the background stops with it).
  - `elevated`, the legacy fallback its docs prefer when `mxc` is not available: an administrator sets it up once (a UAC prompt, local users and groups, firewall rules, logon rights for those users); commands then run as those lower-privilege users, without administrator rights. IT can run `codex sandbox setup --elevated` from an elevated process ahead of time.
  - `unelevated`, a second legacy fallback: a restricted token derived from your account, with file permissions as the boundary, for when the elevated setup is not possible. Its network isolation is weaker, and it cannot deny reading a path.
  - Windows 11 is recommended; Windows 10 is best effort and needs version 1809 or later. Its log is `CODEX_HOME/.sandbox/sandbox.log`.
- **Claude Code** has no sandbox on native Windows: commands run without one. Use WSL2.
- **Grok**: its docs list only macOS and Linux. Whether Grok then runs without a sandbox on Windows (its docs say a built-in profile that cannot be applied only warns, see below) or refuses to start was not verified.
- **Cursor** has none there either. Harness Relay keeps no protected paths on Windows, so its read and write tools get no deny rules for them there (not tried with the real CLI).

### WSL

- **WSL2**: Codex and Claude Code use their Linux sandbox, with the same requirements (bubblewrap; and `socat` for Claude Code). Whether Grok's Landlock works depends on the WSL2 kernel (not verified). Cursor has no sandbox there either.
- **WSL1** cannot create user namespaces. Claude Code's sandbox needs WSL2, and Codex (since 0.115) refuses the sandboxed commands that need bubblewrap.

## Turning each sandbox on

The commands and settings below turn each CLI's sandbox on, platform by platform, and check that it is on. They are for your own use of each CLI; [the next table](#where-harness-relays-runs-read-these-settings) says which of them Harness Relay's runs pick up. Linux commands use `apt-get` (Debian, Ubuntu), with `dnf` (Fedora) beside them.

| | macOS | Linux | Windows | WSL2 | Container |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | settings only | `bubblewrap` and `socat`, then settings | no sandbox: use WSL2 | as on Linux | as on Linux, plus `enableWeakerNestedSandbox` |
| **Codex** | settings only | settings (`bubblewrap` recommended) | `[windows] sandbox` | as on Linux | give the container what bubblewrap needs, or let the container be the sandbox |
| **Grok** | settings only | kernel 5.13+ with Landlock, and `bubblewrap` for Harness Relay's runs, then settings | not in its docs: use WSL2 | as on Linux, if its kernel has Landlock (not verified) | not tried |
| **Cursor** | nothing to turn on: its ACP mode ignores `--sandbox` and `sandbox.mode` | the same (not tried) | the same (not tried) | the same (not tried) | the same (not tried) |

### Where Harness Relay's runs read these settings

| | Settings that Harness Relay's runs read | What Harness Relay sets itself |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json`, or `claude/settings.json` in [the CLIs' own folder](user-guide.md#agent-sessions-the-clis-own-folder-and-agentsview); a project's `.claude/settings.json` and `.claude/settings.local.json`; managed settings | below full access (not on native Windows), `sandbox.enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed: false`, the ask rule above and the protected paths (`denyRead`, `denyWrite`, `Read` deny rules, see below); your other `sandbox` keys, such as `network.allowedDomains`, are left as they are (not tried) |
| Codex | `~/.codex/config.toml`, or `codex/config.toml` in the CLIs' own folder | below full access, a `harness-relay-…` permission profile for the thread (so your `sandbox_mode` and `[sandbox_workspace_write]` are not used); on Windows the sandbox mode for the permission, and in edit mode `network_access = false`; not other keys, such as `[windows] sandbox` |
| Grok | `GROK_SANDBOX` in the environment Harness Relay was started with; otherwise `[sandbox] profile` in `~/.grok/config.toml`, or `grok/config.toml` in the CLIs' own folder | `GROK_SANDBOX=harness-relay` in read-only and edit mode (`workspace` on Windows), and the `[profiles.harness-relay]` block in `sandbox.toml` in Grok's home (see below); with full access, what you set applies |
| Cursor | `cli-config.json` in its config folder (`~/.cursor`, `cursor` in the CLIs' own folder, or another account's home), copied into each turn's own config folder; never a project's `.cursor/cli.json` (`--disable-project-configs`) | in each turn's config folder: no allow rules, your deny rules plus, below full access, the protected paths (and `Write(**)` in read-only mode), `approvalMode: "allowlist"` (full access: `"unrestricted"`, with `--force`); `sandbox.mode` has no effect over ACP |

Grok keeps the profile a session started with for the life of that session, and refuses to resume it with a different one (its docs). Harness Relay resumes each agent's session from turn to turn, and starts a fresh one, with the conversation so far, when a resume fails. Read-only and edit share a profile, so only a change to or from full access, or a change to the profile you set, makes that happen (Grok sessions from before `harness-relay` also start fresh once).

### On macOS

There is nothing to install for any of them.

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

**Cursor.** Nothing to turn on for Harness Relay's runs: its ACP mode ignores `--sandbox` and `sandbox.mode`. What keeps its commands in check there is asking; for code you do not trust, use read-only, or set **Actions beyond the permission** to refuse.

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

**Cursor.** Nothing to install: Harness Relay's runs have no sandbox on Linux either.

### In Docker and dev containers

- **Claude Code**: in an unprivileged container, add `"enableWeakerNestedSandbox": true` under `sandbox`; the isolation is weaker.
- **Codex**: give the container what bubblewrap needs (user namespaces, its own `/proc`, seccomp), or run `codex --sandbox danger-full-access` in it and let the container be the sandbox. Its docs do not give the container's flags.
- **Grok**: not tried; the Linux checks above apply inside the container.
- **Cursor**: nothing to set; the container is the only sandbox its commands get (not tried).

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

**Claude Code and Grok** have no sandbox on native Windows: run them, and Harness Relay, in WSL2. **Cursor** has none on any system, so WSL2 does not change that for it.

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
| Cursor | Its ACP mode never starts one, so nothing fails and nothing warns: below full access every command asks instead (except those on a Cursor team's allowlist). |

When Grok refuses to start because of its sandbox, the turn fails with Grok's reason. Harness Relay does not check whether a sandbox was actually applied.

## What the sandboxes do not cover

- **Reading.** By default all let commands read almost the whole computer, `~/.ssh` and `~/.aws` included; only Grok's `strict` profile limits reading (to the working directory, system paths and `~/.grok`). Harness Relay keeps every sandbox, [its own](#harness-relays-own-sandbox) included, out of the browsers' folders (the desktop app's window's included) and its own database (see [What agents may not read or write](#what-agents-may-not-read-or-write)), not out of anything else. A Cursor command the user allows (or one on a Cursor team's allowlist), with no sandbox, can read and write anything the user can. Keeping secrets from leaving the computer depends on blocking the network, which Grok cannot do on macOS, and Cursor cannot do anywhere; Harness Relay's own sandbox blocks it on both platforms, but a model backend it allows is reachable in full, so a determined agent could still carry data out through one (the allow-list is by host, not by what the traffic is).
- **Harness Relay's own API.** Grok's sandbox lets commands reach localhost (tried on a Mac: `curl http://127.0.0.1:…` from a Grok command in edit mode got its answer), but Harness Relay's API at `127.0.0.1:8787` takes only signed-in browsers: a program without the browser's cookie and key gets 401 (tried with `curl`), so such a command cannot start a turn (see [Architecture → Signing in](architecture.md#signing-in) for what it does not stop). Claude Code's and Codex's sandboxes, and Harness Relay's own, refused localhost in the same test — Harness Relay's own denies its port by name as well, so even an agent granted a loopback port of its own (OpenCode) cannot reach it. A Cursor command the user allows reaches localhost too, with no sandbox, and gets the same 401.
- **What the open agents run outside their own tools.** Harness Relay's own sandbox covers everything the agent and its subprocesses do; there is no part of the agent that runs outside it (unlike Claude Code's hooks and MCP servers). On Linux it cannot allow a single Unix socket (so a CLI that needs one there must do without), and on macOS a CLI that verifies TLS through the system (Goose) is given the `trustd` service, which is a possible way out (see [Harness Relay's own sandbox](#harness-relays-own-sandbox)).
- **Claude Code's own tools.** Its sandbox covers Bash commands and what they start, not its Read, Edit, Write, WebFetch and WebSearch tools (its permission rules govern those), its hooks, local MCP servers (the tool library's included) or LSP servers.
- **Cursor's own tools.** Its deny rules bind its read and write tools only, not its commands, and only for the path as written: Cursor matches them case-sensitively and without resolving links, so another spelling of a protected path (other letter case, on macOS's usual case-insensitive disk) or a link inside the project that leads to one is not denied, and its read tool reads it without asking. Its hooks (`~/.cursor/hooks.json`, an organisation's, and Claude Code's in `~/.claude/settings.json`, which Cursor loads too, whatever is left out of Claude Code's own runs) run on its tool calls in every run, with no switch to turn them off for one, and the MCP servers it starts run outside any sandbox.
- **A Cursor team's allowlist.** Commands on a Cursor team's auto-run allowlist (set by a team admin in Cursor's dashboard, read from Cursor's servers) may run without asking, outside any sandbox. Harness Relay cannot clear it.
- **Writing outside the working directory and the temp folders fails**, package caches included (`~/.npm`, pip, cargo, Go's build cache). With the network off as well, installing dependencies fails.
- **Git.** Codex's `workspace-write` keeps `.git` read-only: `git add` and `git commit` fail with `.git/index.lock: Operation not permitted` (tried on a Mac). Claude Code keeps `.git/config` and `.git/hooks` from being written. In parallel mode, a worktree's git data lives in the main repository's `.git/worktrees/<name>`, outside the working directory. Harness Relay's snapshots and the commits of worktree results run in the server, outside any sandbox, so they still work. Grok's sandbox lets commands write `.git/config`, `.git/info` and `.git/hooks` (tried on a Mac: `git config core.fsmonitor …` worked), and so can a Cursor command the user allows, or a write to them that the user allows Cursor, so Harness Relay's own git commands, outside any sandbox, never run what a repository's own config names: its hooks and fsmonitor are off, each filter, diff and merge driver its config (or what that includes) defines is emptied, and a diff runs no external diff or textconv (`repoDriverGuards()`). The same goes for the repositories at its submodules, which `git add` runs `git status` in: an agent can write their config, and in a worktree make one where a submodule's folder is empty. Git fetches no missing object (`GIT_NO_LAZY_FETCH`, git 2.44 or later), since a partial clone's remote would be reached through a command the config names, and a `core.worktree` naming a folder other than the repository's own is refused, since a snapshot would take that folder's files in and applying would write there. The user's own drivers, such as git-lfs's in `~/.gitconfig`, still run.
- **Tools that often break in a sandbox** (from Claude Code's docs): Docker and ssh-agent (Unix sockets), git over SSH and `open` and `osascript` (on macOS), watchman (use `jest --no-watchman`), Chromium on Linux (Playwright, which starts it, was not tried).
- **What an approval can do.** In a sandbox, asking the user means asking whether a command may leave it:
  - Claude Code: the model may run the command again outside the sandbox with `dangerouslyDisableSandbox` (`sandbox.allowUnsandboxedCommands: false` takes that way out away). That retry, and a connection to a host that is not on its network allowlist, are asked about in `manual` and `acceptEdits` and refused in `dontAsk`. In a headless `-p` run they come as `can_use_tool` requests (tried on a Mac): a host as `SandboxNetworkAccess`, which Harness Relay shows as reading a web page from that host; and a command Claude Code asks about because of a path (`blocked_path`) the sandbox cannot write, which would fail in the sandbox even once allowed, so Harness Relay runs it outside the sandbox when the user allows it, and the card says so. With refusing, `acceptEdits` still sends the host request, which Harness Relay refuses.
  - Codex: it asks only when the model requests more than the sandbox allows, as today.
  - Grok: a profile cannot be lifted once applied, so approving a call does not let it write outside the profile's paths.
  - Cursor: there is no sandbox to leave, so allowing a command runs it with the user's full rights.
  - The open agents: only a host no rule decides is asked about (an approval of kind `fetch`), and allowing it lets the run reach that host through the proxy; the file rules cannot be lifted, so approving nothing lets the agent write outside the folders its permission allows. A host on this computer, or Harness Relay's own port, is refused without asking.

## What is still missing

Read-only and edit now run in a sandbox with Claude Code, Codex, Grok and the open agents (in Harness Relay's own) where the platform has one; Cursor's commands run in none, on any platform, and are kept in check by asking alone. Full access is meant to run without one: Docker, pushing, installing and writing outside the folder are what it is for. Still missing:

1. **Not taking a setting for a sandbox.** Claude Code and Grok on native Windows, and Grok's network on macOS, can be set but are not enforced, and Cursor's ACP mode applies no sandbox at all. The UI should say whether each agent is really sandboxed on this computer, or refuse a sandboxed mode there.
2. **Checking the requirements on Linux before a run.** When Claude Code's sandbox cannot run, its turn fails and says to install `bubblewrap` and `socat`; Codex's and Grok's requirements (`bwrap`, the kernel version, user namespaces inside a container) are not checked, and nothing says in the user's language what to install for them.
3. **Codex's `elevated` sandbox on Windows** needs its one-time setup, with a UAC prompt; whether a `codex app-server` started in the background can show it was not verified. An administrator can run `codex sandbox setup --elevated` first, or the user can use `mxc` where Windows supports it.

## Sources

- Claude Code: [Sandboxing](https://code.claude.com/docs/en/sandboxing) and [All settings](https://code.claude.com/docs/en/settings-reference).
- Codex: [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security), [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) and the [Linux sandbox README](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md).
- Grok: the sandbox documentation that comes with `grok` 1.0.77 (profiles, platform support, network restrictions).
- Cursor: `cursor-agent` 2026.11.11-043ef28 itself: its ACP server and permission layer, read in its code and tried on a Mac.
