**English** | [繁體中文](user-guide.zh-TW.md)

# User guide

This guide walks through installing Harness Relay, signing in to the agents, starting a chat (the lead agent designs a team for each question, from your templates), and chatting with the team.

## 1. Install and start

You need Node.js 22.13 or newer and at least one of the agent CLIs (`claude`, `codex`, `grok`) installed. Edit and parallel modes also need [Git](https://git-scm.com/downloads), which Harness Relay uses for snapshots and worktrees.

```bash
npm install
npm run build
npm start
```

Open the sign-in link `npm start` prints in the terminal (`http://127.0.0.1:8787/#code=…`): Harness Relay takes only browsers that signed in, so other programs on your computer, code an agent runs included, cannot drive it. The link works once, within an hour; to sign in another browser later, run `npm run login`, or use **Settings → Signed-in browsers → Sign in another device**, which also lists the signed-in browsers so you can sign them out. After a `git pull`, run `npm install` and `npm run build` again, then `npm start`. (To work on Harness Relay itself, run `npm run dev` instead and open http://localhost:5173; see the [developer guide](developer-guide.md).)

The dots at the bottom of the sidebar show each agent's status: green = ready, orange = not signed in, red = CLI not found.

To use Harness Relay from your phone, a tablet or another computer, share it with your tailnet through `tailscale serve` and add it to the phone's home screen: see [Use it from your phone (Tailscale)](remote-access.md). On the computer, Chrome and Edge can also install it as an app (the install button in the address bar), and Safari on macOS can add it to the Dock (**File → Add to Dock**).

### Desktop app

Instead of `npm start` in a terminal, you can install Harness Relay as a desktop app on macOS (13 Ventura or later, Apple Silicon), Windows 10 or later (x64 or Arm64), or Linux with a desktop (x64 or Arm64). It runs the same server in the background and shows the chat in a window of its own, signed in, with no address bar. Closing the window leaves the server running, with an icon in the menu bar or the system tray, so the chat works on your phone as before. Like `npm start`, it needs the agent CLIs, and Git for edit and parallel modes; it does not need Node.js.

**Install it.** Download the installer for your system from the [website](https://agentic-system-lab.github.io/harness-relay/), which offers the newest release, never a release candidate (a version ending in `-rc`, see [Versions](#versions)), or from [Releases](https://github.com/Agentic-System-Lab/harness-relay/releases), which has release candidates too. Once installed, the app updates itself to the newest version, release candidates included (see **Updates** below).

- **macOS**: `Harness-Relay-<version>-mac-arm64.dmg`, for Macs with Apple Silicon. Open it and drag Harness Relay to Applications. There is no app for Intel Macs: run Harness Relay from the source there (`npm start`, see [Quick start](../README.md#quick-start)). A Mac app from 2026-11-11 or its release candidate was one for both, and does not find the releases after it in its menu: download the new version once from the website.
- **Windows**: `Harness-Relay-<version>-win-x64.exe`, or `Harness-Relay-<version>-win-arm64.exe` on Windows on Arm. It installs for your user only, without administrator rights. Windows 11 on Arm runs the x64 app too (emulated), Windows 10 on Arm does not; the Arm64 one runs natively on both.
- **Linux**: `Harness-Relay-<version>-linux-x86_64.AppImage`, or `Harness-Relay-<version>-linux-arm64.AppImage` on 64-bit Arm (aarch64). Make it executable (`chmod +x`) and run it.

The website names your system on its download button, the processor too where the browser tells it (Chrome and Edge on Windows on Arm, any browser on Linux on Arm); it lists every installer under **Quick start**.

Or build it yourself in a clone, after `npm install`. The installer for the system you build on goes to `desktop/release/`, and `npm run desktop` runs the app without installing it:

```bash
npm install --prefix desktop
npm run desktop:dist
```

`npm run desktop:dist` refuses to start while a Harness Relay runs from `desktop/release/`, whose files it would replace: quit that one first, or build elsewhere with `npm run desktop:dist -- --output <folder>`. Quit any running Harness Relay before you open the new build too, or macOS brings the running one forward instead (one Harness Relay runs at a time). `npx tsx desktop/scripts/check-package.ts` then checks the app it made, as a release is checked.

The installers are not signed for distribution yet (on macOS they are signed ad hoc), so the system warns the first time the app opens:

- **macOS**: *Apple could not verify "Harness Relay"*. Open **System Settings → Privacy & Security** and click **Open Anyway** next to Harness Relay.
- **Windows**: SmartScreen says *Windows protected your PC*. Click **More info**, then **Run anyway**.
- **Linux**: on Ubuntu 24.04 and other systems that restrict unprivileged user namespaces, the AppImage may stop at once with a message about the *SUID sandbox helper*. Start it with `--no-sandbox` (`./Harness-Relay-….AppImage --no-sandbox`); **Open at login** then starts it the same way.

**Signing in.** The app opens the chat with a one-time sign-in link it gets from its server, so the window is signed in without a code to type; **Open in browser** does the same in your default browser. That link is never printed or written to a log, and it works for one minute. The window is a browser of its own: it is listed under **Settings → Signed-in browsers**, and its guided tour and language are its own. To sign in a phone, open **Settings → Signed-in browsers → Sign in another device**, as with `npm start`. If the window shows the sign-in page (its sign-in was revoked, or its link was not used in time), choose **Open Harness Relay** in the app's menu: the window signs in again with a new link. If a browser shows it, choose **Open in browser**. The window keeps its sign-in in the `browser` folder of the app's folder, which agents below full access may not read (on macOS and Linux, where their sandboxes enforce it).

**The window.** Closing it leaves Harness Relay running in the menu bar or the system tray (on macOS its Dock icon goes away until the window opens again); **Quit** (⌘Q on macOS) stops it. Links to other sites open in your default browser, and files you download from the chat are saved through the usual save dialog. Voice input asks for the microphone the first time, and a video's own button shows it full screen. On Windows and Linux, Alt shows the window's menu bar, which has **Quit** too.

**The menu.** The app's icon, Harness Relay's three dots, is in the menu bar on macOS and in the system tray on Windows and Linux. On Windows, a click opens the chat and the menu is on the right button. The menu has:

| Item | What it does |
| --- | --- |
| *Running at http://127.0.0.1:8787* | The server's state: starting, running, stopping or stopped. |
| **Open Harness Relay** | Shows the chat's window. Opening the app again (from the Dock, Launchpad or Start menu) does the same. |
| **Open in browser** | Opens the chat in your default browser instead, signed in. |
| **Share with your phone (Tailscale)…** | Shares the server with your tailnet, which is steps 1 and 2 of [Use it from your phone](remote-access.md#with-the-desktop-app), and shows the address to open on the phone. Once it is shared, **Copy phone address** copies it. |
| **Open at login** | Starts the app when you log in, without opening its window. |
| **Keep this computer awake while running** | Keeps the computer from going to sleep by itself while the app runs, so your phone can reach it. A MacBook still sleeps when you close the lid. |
| **Open data folder**, **Show log** | The app's data folder (see below) and the server's log. |
| **Restart server…**, **Start server** | Restarts the server (replies in progress stop), or starts it again after it stopped. |
| *Version* | The app's version (see [Versions](#versions)). |
| **Update to 2026-11-12…** | Shown when a newer release or release candidate is out: updates the app (see **Updates** below). While it works, the item shows how far the download got, also while the menu stays open, then *Update ready: switches once replies finish* while conversations are still replying. |
| **Switch to the new version now…** | Shown while an update waits for replies to finish: switches at once, after asking, and stops the replies. |
| **Quit Harness Relay** | Stops the server, which stops every agent first, and quits. |

Some Linux desktops hide tray icons (GNOME without the AppIndicator extension, for example). There, opening the app again shows its window (or starts a stopped server), and the window's menu bar (Alt) has **Open in browser** and **Quit** besides editing, zoom and the window. The rest of the menu (**Share with your phone**, **Open at login**, **Keep this computer awake**, **Restart server…**, the log, the data folder and updates) cannot be reached there: install the AppIndicator extension, or use the terminal instead (`tailscale serve`, see [Use it from your phone](remote-access.md)).

**What is different from `npm start`:**

- **Its own folder.** The app keeps its files in `~/Library/Application Support/Harness Relay` on macOS, `%APPDATA%\Harness Relay` on Windows and `~/.config/Harness Relay` on Linux: conversations and settings in its `data` folder, its own settings in `desktop.json`. A clone's `data/` is not used. To bring your conversations along, quit both, then copy what is in the clone's `data/` folder into the app's `data` folder, and enter your API keys and MCP servers' secret values again in Settings (they are in the credential store, under another name: see the next point). Or set `RELAY_DATA_DIR` in your shell profile, which the app reads too. Never run both on the same data at once.
- **Its own API keys.** With its own data folder, the app files API keys in the credential store under `harness-relay-desktop`, apart from `npm start`'s (`harness-relay`), so a key saved or removed in one does not change the other. With `RELAY_DATA_DIR` set, both use `harness-relay`, as the data is shared.
- **Your shell's environment.** On macOS and Linux the app reads the environment your login shell sets up (PATH, API keys and other variables from `~/.zshrc`, `~/.bashrc` and so on), so it finds the CLIs as your terminal does. It reads it again on **Restart server…** and **Start server**: choose one after you install a CLI or change your profile. On Windows, the app gets PATH from the system when it opens, and reads PATH and your user variables again from Windows on **Restart server…** and **Start server**.
- **Always 127.0.0.1, port 8787.** A `PORT` or `HOST` in your shell profile is meant for other programs, so the app ignores it. To use another port, quit the app and set `"port"` in its `desktop.json` (create the file if it is not there: `{ "port": 8790 }`). `npm start` uses port 8787 too, so the two cannot run at once unless one of them uses another port (`npm run dev` uses 8789, so it runs beside the app; beside `npm start` only from another checkout, since one data folder takes one server). If the port is taken, by a Harness Relay you started with `npm start` for example, the app says so and offers to try again.
- **The default working directory** is your home folder until you change it in Settings. Edit mode refuses the home folder itself (agents would change your shell and tool settings without asking): choose a project folder for a conversation in edit mode.
- **The server's log** is `~/Library/Logs/Harness Relay/server.log` on macOS, and `logs/server.log` in the app's folder on Windows and Linux.
- **macOS may ask** whether Harness Relay may access a folder such as Documents or Desktop, the first time an agent works there, whether it may use the microphone, the first time you use voice input, and whether it may use its keys in your keychain after an update. The questions name the app, because the agents run inside it. Choose **Allow** (or **Always Allow**).
- **Quitting** stops every agent first. Force-quitting the app (or a crash) can leave an agent that was replying running, as stopping `npm start` with `kill -9` would. Quitting while the server is still starting (waiting for the keychain, say) stops it at once: it runs no agent yet.

**Updates.** About 30 seconds after it starts, and every 6 hours after that, the app asks GitHub (`api.github.com`) for its releases and takes the newest version, a release candidate too (`2026-11-12-rc` after `2026-11-11`, and `2026-11-12` after `2026-11-12-rc.1`). When it is newer than the app and has an installer for your system (on Windows and Linux, for the processor the app you run was built for), the menu shows **Update to** and its version (**Update to 2026-11-12…**, say). Choosing it asks first; **Release notes** opens the release's page. The app then downloads the installer and checks it against the SHA-256 checksum GitHub publishes for it, the menu showing how far it got (an open menu is opened again about once a second to show it). Before it switches, it waits until no conversation has agents at work: replying, designing a team, waiting for you to approve a tool, changing a team, sorting a conversation into a group, applying a parallel reply or making a branch. A conversation waiting for your answer to an agent's question does not count: it waits for you just the same in the new version. Meanwhile the menu says *Update ready: switches once replies finish*, and **Switch to the new version now…** switches at once, after asking, stopping the replies. Then the app quits and opens again as the new version:

- **macOS**: the new app replaces the one in Applications (or wherever you put it), in place. That takes a folder the app may write in (Applications, for an administrator), and an app that does not run from the `.dmg` itself. If macOS keeps the app from replacing itself (it may ask you to allow **App Management**), the new version's `.dmg` opens: drag Harness Relay into Applications, replacing the old one.
- **Windows**: the installer runs silently once the app has quit, and starts the new version.
- **Linux**: the new AppImage takes the place of the one you run. When that one was named after its version, as downloaded, the new one is named after its own and the old one is removed; **Open at login** follows it. Only the AppImage updates itself.

Until the switch, the app you run stays as it is: quitting it (or restarting the server, or shutting down the computer) while the update waits keeps this version, and the next start removes what the update downloaded (the menu offers the update again). An x64 app on Windows on Arm keeps updating to the x64 app; to run the Arm64 one, install it from the website or the release page.

A Harness Relay that cannot update itself (one run from the source with `npm run desktop`, one in a folder it may not write in, an installer without a checksum) says why and offers the release's page instead: install the new version as you did the first time. To turn the checks off, set `RELAY_UPDATES=off` in your shell profile (or the app's environment).

**Where it keeps things, and uninstalling.** The app's folder is `~/Library/Application Support/Harness Relay` on macOS, `%APPDATA%\Harness Relay` on Windows and `~/.config/Harness Relay` on Linux (`$XDG_CONFIG_HOME/Harness Relay` when that is set). In it: `data` (conversations and settings), `browser` (the window's own browser data, its sign-in included), `desktop.json` (the app's settings), and on Windows and Linux `logs`. To uninstall:

1. Turn **Open at login** off, and stop sharing with your phone if you did (`tailscale serve --https=443 off`, or the HTTPS port the app said it used: see [Use it from your phone](remote-access.md#security)), then quit the app.
2. Remove the app: drag Harness Relay from Applications to the Trash (macOS); **Settings → Apps** (**Installed apps**, or **Apps & features** on Windows 10) → Harness Relay → **Uninstall** (Windows); delete the AppImage (Linux).
3. To remove your data too: delete the app's folder, and on macOS `~/Library/Logs/Harness Relay`. The API keys and MCP servers' secret values are in the credential store under `harness-relay-desktop` (macOS Keychain Access, Windows Credential Manager, or your Linux keyring): delete those entries. On Linux, `~/.config/autostart/harness-relay.desktop` is gone once **Open at login** is off.

### Versions

A version is the date it was released, in Taiwan's time zone: `2026-11-10` is a release, and `2026-11-10-rc` a release candidate, made to be tried before a release. A fix released the same day adds a number: `2026-11-10.1`, `2026-11-10-rc.2`. Once a day's release is out, a fix that day is its patch, and a patch can have a release candidate of its own first: `2026-11-10.1-rc`, then `2026-11-10.1-rc.1`, before `2026-11-10.1`. The menu shows the app's version, and [Releases](https://github.com/Agentic-System-Lab/harness-relay/releases) marks release candidates as pre-releases. An app you build yourself shows the day it was built with `-dev` and the commit, such as `2026-11-10-dev (30f3d4f)`: any release or release candidate of that day or later counts as newer, and is offered as an update.

### Language and the guided tour

The UI is available in **English** and **繁體中文**. On your first visit it follows your browser's language (any Chinese → 繁體中文, otherwise English) and remembers the choice in this browser; switch any time under **Settings & sign-in → Language**. Error messages and system notes from the server follow the same language.

The colours follow your computer's or phone's light or dark mode. To keep one of them whatever the system does, choose **Light** or **Dark** under **Settings & sign-in → Appearance** (**Follow system** goes back to the system's). The choice is remembered in this browser, so a computer and a phone can each have their own; it applies at once, to the other tabs of the browser too, and diagrams in replies are drawn again in it. A page you share follows its reader's own mode.

The first visit also opens a short **guided tour** that points out the main features step by step (← / → to move, Esc to skip). When an update changes the tour (for example to show new features), it opens once more on your next visit. Replay it any time from **Settings & sign-in → Guided tour**.

## 2. Sign in to each agent — Settings & sign-in

Click **⚙ Settings & sign-in** in the sidebar. Each CLI has its own card showing version, account and status.

### Signing in

Pick a method and click **Sign in**. Harness Relay runs that CLI's own login command and shows what you need:

| Agent | Method | What to do |
| --- | --- | --- |
| Claude Code | Claude subscription / Anthropic Console | Open the link, authorise, then paste the code the page shows into the box and click **Submit**. |
| Codex | ChatGPT device code | Open the link, sign in to ChatGPT and enter the one-time code shown (click it to copy). |
| Codex | ChatGPT browser sign-in | A browser opens on this machine; finish signing in there. |
| Grok | xAI device code / xAI browser sign-in | Open the link and confirm the code. |

The panel turns green with **Signed in ✓** when the CLI finishes. Expand **CLI output** to see the raw output if something goes wrong.

> **Codex:** starting a new Codex sign-in signs out the current Codex account first. The page asks for confirmation.

**Sign out** signs the CLI out on this machine, which also affects other places you use that CLI.

### API keys (optional)

Under **API key** on each card:

- **Claude Code** — passed as `ANTHROPIC_API_KEY` (API billing; it takes precedence over your subscription login).
- **Grok** — passed as `XAI_API_KEY`.
- **Codex** — handed to `codex login --with-api-key`; Codex stores it and it replaces the ChatGPT login.

Harness Relay keeps the Claude Code and Grok keys in your system's credential store, filed under `harness-relay` (the [desktop app](#desktop-app)'s under `harness-relay-desktop`): the macOS Keychain, Windows Credential Manager, or the Secret Service on Linux (GNOME Keyring, KWallet). The card says where. On a system without one — such as a Linux server with no desktop session — keys are kept in the database instead, readable only by your user; if you'd rather not, leave the field empty and set `ANTHROPIC_API_KEY` / `XAI_API_KEY` in the environment before starting Harness Relay. Keys saved by an earlier version are moved out of the database the next time the server starts. macOS may ask whether `node` may use the key (for example after Node.js is updated); choose **Always Allow**.

### Default model and reasoning effort

Under **Default model and reasoning effort** choose what an agent uses when its own model/effort is left on *Default*. Leaving these on **CLI default** uses the CLI's own configuration (for example `~/.codex/config.toml`). The same section lets you set a custom **Executable** path if the CLI is not on your `PATH`. A card whose CLI is not found says so, with a link to install it from its website ([Claude Code](https://claude.com/product/claude-code), [Codex](https://openai.com/codex/), [Grok](https://x.ai/build)).

### Lead agent

**✦ Lead agent** picks the CLI (and optionally the model and effort) that designs the team in [Auto team](#auto-team) conversations, and that sorts new conversations into your [groups](#groups). Choose one that is signed in; a small, fast model is usually enough.

**Default working directory** sets the folder new conversations start in. If the folder does not exist yet, Harness Relay asks whether to create it (so does the working directory of a new conversation, or one you change under the team settings).

### What each CLI loads by itself

Each CLI's card has **Skills, MCP servers, hooks, memory and more this CLI loads by itself**: open it and click **Ask** to see that CLI's own setup for the default working directory, separate from the tool library, in a tab each: its **Skills** (with where they come from), its **MCP tools** (each MCP server with its state when the CLI reports it, and the tools it offers), its **Built-in tools** (Claude Code), its **Hooks** (when each runs and where it is set, never its command), its **Subagents** (Claude Code and Grok), its **Plugins**, and the **Instructions** and **Memory** files it reads. Harness Relay asks the CLI without sending a prompt, so no model is called: Claude Code and Codex start their MCP servers while they answer, and Claude Code runs your hooks. To list its tools, Claude Code is sent `/usage`, a command it answers by itself (nothing is spent, and no session is saved); if you have a skill or command named `usage`, that is skipped and the built-in tools are not listed. Opening the section does not ask, so you can change what is left out without starting the CLI. Claude Code and Codex give no list of their instruction files, so those are the files they are documented to read that exist. Click a file, or a skill with a path, to read it (Markdown rendered or as source).

Each tab also leaves things out of every run Harness Relay starts of this CLI: members' turns, the lead agent, and sorting conversations into groups. **Leave all out** at the top of a tab leaves out all of its kind; once the CLI has been asked, the box on each item leaves out just that one, where the CLI can do that. Every change is saved at once, the tab shows what it leaves out, and the section's title shows how many are left out in all. With **Leave all out** on, the items ticked in that tab are kept and apply again when it is cleared. The CLI's own settings files are not changed, so using it in a terminal is not affected, and the tool library's items are still provided. When something is left out, **Ask** also asks the CLI again the way Harness Relay starts it, and marks **left out** each item it then does not load, so you can see what a run actually gets (denying Claude Code's `Bash`, for example, also takes its `Monitor` tool); an item you ticked that the CLI still loads is marked **still loaded**. Ticked items the answer no longer lists (gone since, or a file or skill of a project other than the default working directory) are counted under the list, with a button to clear them. If you change what is left out after asking, ask again; if asking again runs out of time, what the CLI had answered is still marked and the rest is named. What each CLI can leave out:

- **Claude Code**: all of every kind, and one by one: skills by name (plugin and custom commands are listed with them), MCP servers and each of their tools, built-in tools, instruction files, subagents (the built-in ones too) and plugins. Its hooks have no names and its auto memory is one store, so those only all at once. **Leave all out** for skills also covers plugin and custom commands; for MCP, its own servers do not start at all and only the tool library's stay, while a single server you tick still starts and only its tools are kept from the agents (a tool library server of the same name keeps its tools); for built-in tools, agents can then only talk and use MCP tools (tools Harness Relay turns off for the permission stay off whatever is set here, and an agent left with no tool that reads files is not told about the tool library's skills); for instruction files, its `CLAUDE.md` files and rules at every level; for memory, its auto memory; for hooks, those in its settings files and plugins; for subagents, your own and plugins' (the built-in ones stay, unless one of yours or a project's replaces one of them by name: then that name has no subagent in the run); for plugins, every installed plugin with its skills, subagents, hooks and MCP servers. If Claude Code cannot list its plugins, or its subagents cannot be left out (an older Claude Code), the run fails with a message saying so instead of loading them.
- **Codex**: all of a kind, and one by one: skills, the MCP servers in your config files and each of their tools, hooks and plugins. Its MCP switch also turns off ChatGPT apps; servers that come with plugins are set on the Plugins tab. Instruction files are the project's `AGENTS.md` files, all at once: Codex still reads its own `~/.codex/AGENTS.md`. Hooks include plugins' hooks; plugins go with their skills, MCP servers and hooks. If Codex still loads skills, hooks or plugins you left out (an older Codex that does not know the setting), the run fails with a message saying so. Codex lists no subagents and has no switch for its own. Codex keeps the skills list (plugins' skills among them), instruction files and memory a chat started with, so changes to those take effect in new chats; changes to MCP servers, their tools and hooks take effect at the next turn. If Codex cannot list its MCP servers, the run fails with a message saying so instead of running them.
- **Grok**: only all at once, and skills, MCP servers and hooks only the ones it takes from Claude Code and Cursor (a project's `.claude/skills` and its Claude Code plugins' skills among them, but not their hooks). The skills Grok finds by itself still load — `~/.agents/skills`, `~/.grok/skills`, a project's `.grok/skills` and `.agents/skills`, and its built-in ones: list their names in `skills.disabled` in `~/.grok/config.toml` to turn them off, and turn off its own MCP servers there too. That file is Grok's own global setting: what you change there also applies when you use Grok in a terminal, and Harness Relay does not change it. Grok has no switch for one run for single items, instruction files or its plugins (`plugins.disabled` in `~/.grok/config.toml`), and none that leaves out only its own subagents (its subagents switch turns off the built-in ones too).

Grok reads a project's own `AGENTS.md` / `CLAUDE.md`, skills, MCP servers and hooks only in a folder you trusted. When it does not trust the folder, the Grok card says so, and so does the team editor under the working directory when the team has a Grok member. When you start a new chat whose team has a Grok member in such a folder, you are asked first: **Trust and start**, **Start without trusting**, or **Cancel**. Grok decides trust for the whole project: when the working directory is inside a git repository, the folder trusted is the repository's root (links resolved), and the confirmation says so. **Trust this folder** asks you to confirm that folder, then records the trust the same way `grok --trust` does (in `~/.grok/trusted_folders.toml`, or `$GROK_HOME`). Only trust projects you trust: Grok then also runs the project's hooks. The tool library's items reach Grok either way. **Ask again** refreshes the answer (it is kept for a minute).

The links at the top of Settings stay on one row in every language (where they do not fit, they scroll sideways, also with a mouse wheel), stay in view while you scroll, highlight the card you are reading, and jump to each card; each card's title links to itself (for example `#/settings/tools`), so you can bookmark a card. Links elsewhere in the app (a CLI that is not signed in, the lead agent, voice input, the tool library) open the right card.

### Tool library: MCP servers, skills and memory

**Settings → Tool library** sets up tools once for every agent, whichever CLI it runs on. They are given in addition to each CLI's own setup (your `~/.claude`, `~/.codex/config.toml`, `~/.grok` settings keep working), and changes reach an agent at its next turn.

- **MCP servers** — **Add MCP server**, give it a name (letters, digits, `_` and `-`), then either a **local command** (stdio: the command, one argument per line, environment variables) or a **URL** (Streamable HTTP, with HTTP headers). The values of environment variables and headers are usually tokens: they are kept in your system's credential store (like API keys), and the page only shows them masked. When you edit a server, leave a value empty to keep it. Tool calls follow the conversation's permission like any other action: anything beyond it asks you in the chat (or is refused, if the conversation refuses automatically).
- **Skills** — enter a folder with a `SKILL.md`, or a folder of skills (for example `~/.claude/skills`), and click **Add**. When there is more than one skill, every skill in it (the folder itself, and skill folders up to two levels down) is listed: tick the ones to add, or filter and **Select all**. These skills come in addition to each CLI's own: a skill a CLI reads by itself (Claude Code and Grok read `~/.claude/skills`) keeps working whether or not you add it here; adding it here lets every CLI use it and lets you choose who gets it. Each agent's briefing lists the skills' names and descriptions (from the front matter of `SKILL.md`), and the agent reads a skill's `SKILL.md` when a task calls for it. A skill whose `SKILL.md` is gone, or whose name another skill already has, is marked and not given.
- **Memory** — notes put in agents' briefings in every conversation, such as your preferences and project conventions. **All members** is for everyone; the **Claude Code**, **Codex** and **Grok** tabs are only for that CLI's agents and come after the shared part.

**Given by default to** — each MCP server and skill is given to the agents of the CLIs you pick: all three (the default), some, or none (then only to members you tick in the team settings). To change it for one member, see **Tools** under [Team members](#team-members).

### Agent sessions: the CLIs' own folder and AgentsView

**Settings → Agent sessions** has two optional settings. Harness Relay keeps them with its other settings, so you start it with `npm start` (or `npm run dev`) as usual, on macOS, Linux and Windows alike.

**The CLIs' own folder** — by default each CLI uses its usual home (`~/.claude`, `~/.codex`, `~/.grok`), the one you also use when you run it yourself. Enter a folder here (a full path, or one that starts with `~`), or click **Use ~/.relay-agents**, and Harness Relay gives each CLI a home of its own in it: the `claude`, `codex` and `grok` subfolders. Each CLI's sign-in, settings and session records then go there, apart from your own use of the CLIs.

- Sign in to each CLI again (in its card above, or set an API key): the new homes start empty.
- The CLIs no longer read the settings, MCP servers, skills, memory and plugins in your usual homes. The [tool library](#tool-library-mcp-servers-skills-and-memory) still gives its tools to every agent.
- Agents start a fresh session at their next turn, with the conversation's full history: their earlier sessions stay in the old homes.
- The session records are in `claude/projects/`, `codex/sessions/` and `grok/sessions/` in that folder.

Pick a folder outside your projects: Harness Relay refuses one inside its own folder or the default working directory, whose snapshots would take in the CLIs' sign-ins and session records. The folder can't be changed while a conversation runs. Empty the field to go back to the usual homes.

**AgentsView** — [AgentsView](https://www.agentsview.io) is a free tool for browsing agent sessions on your computer: every message, tool call, token and cost. Enter its address here and Harness Relay sends it the conversation after every turn, and when you rename it. Each conversation becomes one session in AgentsView, named after the conversation, with each agent's own session nested under it (the lead agent's and the group sorter's too) and their costs added up. Only addresses on this computer are accepted. When an update fails (for example, AgentsView is not running), the card says why; the chat is not affected.

- Conversations from before you set the address are sent at their next turn.
- Deleting a conversation in Harness Relay leaves what was sent in AgentsView; remove it there if you like.
- **Address to open it (optional)** — **Open AgentsView** opens the address above. To open AgentsView from another device, such as your phone over [Tailscale](remote-access.md#5-browse-agentsview-too-optional), enter that address here instead. Conversations are still sent to the address above.

To see only Harness Relay's sessions in AgentsView, set the CLIs' own folder (above), then run an AgentsView of its own that reads only that folder:

1. Install AgentsView (see [its quick start](https://www.agentsview.io/docs/quickstart/)).
2. Create the file `.relay-agents/agentsview/config.toml` in your home folder:

   ```toml
   [agents.claude]
   dirs = []
   homes = ["~/.relay-agents/claude"]

   [agents.codex]
   dirs = []
   homes = ["~/.relay-agents/codex"]

   [agents.grok]
   dirs = ["~/.relay-agents/grok/sessions"]
   ```

   AgentsView also reads the default folders of the other tools it supports (Cursor, Gemini CLI…) when they exist on your computer. To leave them out, list them in `disabled_agents` (see [AgentsView's configuration](https://www.agentsview.io/docs/configuration/)).
3. Start it with its data in that folder, on a port of your choice (9999 here). macOS and Linux:

   ```bash
   AGENTSVIEW_DATA_DIR=~/.relay-agents/agentsview agentsview serve --port 9999
   ```

   Windows PowerShell:

   ```powershell
   $env:AGENTSVIEW_DATA_DIR = "$HOME\.relay-agents\agentsview"
   agentsview serve --port 9999
   ```

   Windows Command Prompt:

   ```bat
   set AGENTSVIEW_DATA_DIR=%USERPROFILE%\.relay-agents\agentsview
   agentsview serve --port 9999
   ```

   Add `--background` to keep it running after you close the terminal; `agentsview serve stop` (with the same `AGENTSVIEW_DATA_DIR`) stops it.
4. In **Settings → Agent sessions → AgentsView**, enter `http://127.0.0.1:9999` and click **Save**.

AgentsView hides sessions with only one message from the user by default. A conversation with a single message of yours shows up after your next message, or when you turn on **Include single-turn** in AgentsView's session filter.

To browse AgentsView from your phone too, see [Use it from your phone](remote-access.md#5-browse-agentsview-too-optional).

## 3. Start a chat — New chat and templates

Click **＋ New chat**. Here you choose where the team works and what it may do — the **working directory**, the **file permission** and what happens to **actions beyond the permission** (see [Conversation rules](#conversation-rules)) — and whether you confirm the lead agent's teams (**Use the lead agent's team without asking me**; the page remembers your choice). Click **Start chat →** and ask your first question.

You don't pick a team for the chat: the lead agent chooses one for each question (see [Auto team](#auto-team)), from the [templates](#templates) on this page, where you design teams.

### Auto team

Every new question gets its team. The **lead agent** (see [Lead agent](#lead-agent)) reads your question, the conversation so far (in short), the current team and every template in full (built-in and your own: members, roles, mode and rounds), and then keeps the current team, uses a template as it is, adapts one to the question (for example adds or drops a member, rewrites roles, or changes the mode or rounds), or designs a new team from scratch.

- The decision appears in the chat as a **Team design** card: the current team kept, the template it used, the template it adapted, or its new team; why; and each member's full role, folded to a few lines when long (**Show more** shows the rest, also on a [shared page](#sharing-a-conversation)).
- By default you confirm it: click **Confirm team** on the card and the team answers your question. Until then the sidebar marks the conversation **Confirm the team**, and what you write meanwhile (even while the lead agent is still designing) waits above the message box and goes to the team with your question. **Adjust team** opens the team settings, where you change the design yourself or have the lead agent change it (see [Editing the team mid-chat](#editing-the-team-mid-chat)); saving your changes there counts as confirming too. Only the latest design offers **Adjust team**: it is the team now, while earlier cards are history.
- Tick **Use the lead agent's team without asking me** (on the New chat page, or later in **Team settings**) and the team answers right away; the card still shows what the lead agent chose and why (**Used without asking**).
- Not every message is a new question. An answer to an agent's question, a message that @mentions members of the current team (they answer it), **Continue**, **Retry** and scheduled messages go to the current team without a new design.
- Members who stay on (same name and CLI) keep their session and what they learned; new members read the conversation from the start.
- You choose the working directory and the file permission; the lead agent cannot change them.
- When the lead agent designed or adapted a team, the card asks whether to keep it: **Save as template** saves it (you can rename it), and it then shows up under **Templates**, for the lead agent to pick as it is. A template used as it is, or the current team kept, is already there, so the card doesn't ask.
- If the lead agent's answer can't be used (or its CLI fails), the current team is kept (for a first question, the General-question panel is used) and the card says why. If you press **Stop** while it is designing, **Continue** or your next question designs the team again.
- Members that would run on a CLI that isn't signed in are moved to the lead agent's CLI.
- Editing a question (see [Copying, editing and retrying](#copying-editing-and-retrying)) designs its team again (unless the edit @mentions members, who then answer), to be confirmed again unless you use the lead agent's team without asking.
- **No, keep the current team** on the card turns the design down: the team you had answers instead (not offered for a first question, or when the lead agent kept the team). Until you confirm or decline, the conversation keeps its current team: **Retry** or editing an earlier message still uses it (and drops the waiting design). **Team settings** shows the waiting design while it waits, and saving there uses it as you edited it.
- When the team has a Grok member and Grok doesn't trust the working directory, the card says so before you confirm, with **Trust this folder**.

### Templates

Templates are where you design teams; the lead agent picks, adapts or replaces them for each question. The built-in ones:

| Template | Mode | Team |
| --- | --- | --- |
| Architect → Builder → Reviewer | Relay | Claude plans, Codex implements, Grok reviews; they hand off with `@` |
| Three-way debate | Roundtable ×2 | Proposer, pragmatist and skeptic — for design and technology choices |
| Parallel comparison | Parallel | All three solve the same problem independently |
| General-question panel | Roundtable | Analyst → Critic → Synthesizer; for any question, not just code |
| Pair programming + QA | Roundtable | Navigator guides, Driver codes, QA tests |

Click a template (or **＋ New template**) to open it in a dialog: its **name**, a **description** (the lead agent reads it when it picks a template, so say what the team is good for), its **members** (see [Team members](#team-members)) and how they take turns (mode, and rounds or hand-offs; see [Conversation rules](#conversation-rules)). Your own templates are saved in place with **Save template** (once you have changed something) and deleted with ×. Built-in templates can't be changed, but once you have changed something, **Save as my template** keeps your adjusted copy. **＋ New template** starts from a blank team: one member for each CLI that is ready to use, with empty roles. Closing the dialog with changes not saved asks first. A template has no working directory or permission: those belong to the conversation. Built-in templates follow the UI language.

### Team members

Each card is one agent:

- **@name** — the handle used for `@mentions`. Letters, digits, `_` and `-` (Chinese characters work too), unique within the team.
- **Claude Code / Codex / Grok** — which CLI runs this agent. You can have several agents on the same CLI (e.g. two Claude agents with different roles).
- **Position / role** — free text describing the agent's position and responsibilities. This is the most important field: tell the agent what it owns, what it should *not* do, and whom to hand off to.
- **Model** — models reported by the CLI, or **Custom…** to type an id. *Default* uses the default from Settings, or the CLI's own default.
- **Reasoning effort** — only levels the selected model supports are listed (e.g. low / medium / high / xhigh). Switching to a model that doesn't support the chosen level resets it to default.
- **↑ ↓** — reorder. Order is the speaking order in roundtable mode, and the first agent is the **leader** in relay mode.
- **Tools** — what this member gets from the [tool library](#tool-library-mcp-servers-skills-and-memory), as chips; **Change** opens the list to tick them. Ticks start from the library's defaults for the member's CLI (items not given to that CLI by default say so), and the memory tab of another CLI is not listed. Renaming a server or a skill keeps the choices. With an empty library, a link takes you to it. These come in addition to the CLI's own skills and MCP servers, which keep working.

Add members with **＋ Claude Code / ＋ Codex / ＋ Grok** (up to 8).

### Conversation rules

**Mode**

| Mode | Behaviour | Good for |
| --- | --- | --- |
| Roundtable | Agents speak in order; each sees what earlier speakers said. Set the number of rounds (1–5); the run ends early when everyone in a round replies `[PASS]`. | Discussions, reviews, refining an answer |
| Parallel | All agents answer at the same time, independently. In later rounds they see the previous round's answers. | Comparing approaches, getting independent opinions |
| Relay | One agent at a time. An agent hands the floor to a teammate by `@mentioning` them; if it mentions nobody, the floor returns to you. Set the maximum number of hand-offs per message (1–30). | Pipelines: plan → implement → review |

**Working directory** — the folder all agents work in. They share it. Click the box or its arrow, or press ↓, to pick from the working directories in use: the default one first (marked **Default**), then the ones your conversations work in, the most recently used first; folders that no longer exist are left out. As you type, the list keeps only the paths that contain every word you typed (ignoring case, with `~` for your home folder, and `/` and `\` alike on Windows), so a folder name with spaces matches too. Pick one with the mouse, or with ↑ ↓ and Enter; Esc closes the list. The default working directory in Settings has the same list.

**File permission** — what every agent in the conversation may do **without asking**:

| Level | Runs without asking |
| --- | --- |
| Read-only | Reading, searching and looking things up on the web. |
| Edit | Also editing files in the working directory and running project commands such as tests and builds (Claude Code: a list of common ones; Codex: anything inside its sandbox, which has no network). Pushing and publishing are not included. |
| Full access | Everything, without asking. Use only in directories you trust. |

Below full access, every agent's commands run in its CLI's OS sandbox, which lets them write only in the working directory and the temp folders. Codex's sandbox also keeps them off the network, and Claude Code's asks you about each host they want to reach; Grok's can block the network only on Linux. On native Windows only Codex has a sandbox (see [OS sandboxes by platform](sandboxing.md)). The sandboxes also keep agents out of your browsers' folders and Harness Relay's database, and edit mode is refused in a working directory that holds Harness Relay itself, your home folder or a CLI's own folder; to work on Harness Relay, run the copy you use from another folder. Edit is meant for code you trust: tests, builds and project scripts run code the agents can edit, so with Grok an agent could still reach the network through them. For code or instructions you don't trust, use read-only, or refuse actions beyond the permission. In read-only mode Claude Code's file-editing tools are switched off completely.

**Actions beyond the permission** — **Ask me** (default): when an agent wants to do something the permission doesn't cover, the chat asks you (see [Approvals](#approvals)). **Refuse automatically**: such actions are refused right away; the agent is told and tries another way. (Not shown for full access.)

**Git and file safety (edit / full access).** If the working directory is not a git repository yet, Harness Relay runs `git init` there automatically (never in your home directory or a whole drive). A working directory inside a repository that spans your home directory (such as a dotfiles repository) is refused, because every turn would record the whole folder. It never commits to your branch. Then:

- **Roundtable / relay** — agents take turns editing the working directory directly. Each reply records which files that agent changed. While such a conversation is running, other conversations cannot write to the same directory (you get an "is changing" message).
- **Parallel** — each agent works in its **own copy** (a git worktree) so they can't overwrite each other. The working directory is not touched until you choose a result and apply it (see [Reviewing and applying changes](#reviewing-and-applying-changes)).

## 4. Chat

- **Send** with Enter; Shift+Enter for a new line. While typing with an input method (e.g. Chinese), Enter confirms the candidate and does not send. On a phone or tablet, Enter starts a new line and the **↑** button sends (with a hardware keyboard, ⌘/Ctrl+Enter sends too). Your messages keep their line breaks as typed; agent replies are formatted as Markdown. A web address written right against Chinese text (`請看https://github.com/org/repo及…`) ends where the Chinese starts, so the link opens the right page; Chinese that is part of the address (`/wiki/臺灣`, `?q=中文`) stays in it.
- **Attach files** — paste an image (such as a screenshot) straight into the message box, drag files onto it, or click 📎. Up to 10 files of 20 MB each per message, with or without text. Every agent that reads the message gets each file's path to open with its own tools, and images (PNG, JPEG, GIF, WebP) are also shown to it directly. Sent images appear as thumbnails (click to open the full image); other files as chips you can download.
- **Long questions** are folded to their first lines in the chat; click **Show more** to read the whole message (and **Show less** to fold it again).
- **`@mention`** — type `@` to pick a teammate. When your message mentions agents, **only those agents reply** (in relay mode they start the relay). Without mentions, the whole team takes part according to the mode. Text may follow the name directly (`@Builder請實作`); mentions inside code are ignored.
- **Streaming** — replies appear as they're written. Tool activity (file reads, edits, shell commands) and the reasoning between the steps are grouped in one collapsible row that counts them (**5 actions · 4 thoughts**); while it runs, a spinning icon and the step in progress (or the latest line of thinking) show in that row. Open it to see every step in order; a refused or failed step shows its reason. A file path too long for its line keeps its end, so the file name stays in view; hover a step to see its full text. The team chips under the title highlight who is speaking; with a large team the row scrolls sideways (the mouse wheel works too) and follows the speaker. Images and videos an agent saved in the working directory and embedded in its reply (`![chart](out/chart.png)`) are shown in the chat: click an image to open it full size, and videos play in place. Images from websites are shown as links and are never loaded automatically. Files an agent made for you, such as a PDF, slides or a spreadsheet, are links with a download arrow (`[Slides](out/deck.pptx)`): click one to save the file to the device you are using, the computer or a phone through Tailscale. Only files in the working directory (or the agent's worktree) can be downloaded; agents are told to save them there and link them. A link to a file that isn't there says so (**⚠ Cannot download …** after it); click it again once the agent has made the file. Mermaid code blocks are drawn as diagrams: **Source** shows the code, **Copy** copies it, and clicking the diagram switches between fit-to-width and actual size. A table too wide for the chat scrolls sideways: short cells stay on one line and longer ones wrap at a readable width, instead of every column being squeezed to a letter per line. Code blocks scroll sideways too.
- **Add to the discussion while they reply** — the message box stays open while the team is replying. Enter puts your message in a tray above the box; it reaches the next agent before its turn (in parallel mode, before the next round), and whoever was speaking sees it on their next turn. A message that @mentions someone waits for that agent's turn (and messages sent after it wait behind it, so the chat keeps your order). If no turn takes it before the run ends, the team answers it in a new run. In the chat it is marked **Added mid-reply**. Until it is delivered you can **Edit** it (its text goes back into the box) or **Withdraw** it.
- **Stop and ask this instead** — ⌘+Enter (Ctrl+Enter on Windows and Linux) while the team is replying stops it and sends your message right away, after any messages that were waiting; **Stop and send now** on the tray does the same for the waiting messages.
- **■ Stop** — stops the current run and kills the agents' processes. Messages that were waiting stay in the tray (**Not delivered yet**): send them, edit them or withdraw them; your next message or **Continue** sends them first.
- **Continue ↻** — lets the team go on without a new message (another set of rounds, or another relay starting from the leader). Useful after a relay hits its hand-off limit.
- **Passed replies** — an agent with nothing to add replies `[PASS]`; it is shown dimmed as *Nothing to add (PASS)*.
- **Questions to you** — when a good answer depends on something only you know (your situation, goal or preference), an agent asks you first instead of guessing, and the team stops: nobody else speaks, the question is marked **Waiting for your answer**, and the sidebar shows **Answer needed**. Reply in the message box: the agent that asked answers first, with your answer in hand, and then the rest of the round goes on (in parallel mode the ones that asked answer again before the next round; in relay mode the floor goes back to the one that asked). A reply that @mentions someone other than the one that asked starts afresh. **Skip question** (or **Skip, let the team go on** on the question) lets the others go on without your answer. Messages you sent while that agent was replying wait for your answer, and go out with it.
- **What agents think and do** — an agent's reasoning sits in the same collapsed row as its tool steps (its latest line is visible while it streams); open the row and click a thought, listed by its first line, to read all of it. Its plan / to-do list appears as a checklist that updates as it works, and each tool step can be expanded to see its output.
- Each reply shows its duration, and cost and tokens when the CLI reports them.

### Approvals

When an agent wants to do something its permission doesn't cover — install a package, run a command in read-only mode, push code, write outside the working directory, reach a host from its sandbox — its reply shows a card: what it wants to do (the exact command, file, URL or host) and why. When allowing it runs a command outside the sandbox, the card says so. The agent waits until you answer:

- **Allow** — just this once.
- **Always allow "…" in this chat** — this and later requests like it (for commands: the same program and subcommand, e.g. `npm install`; a chained command is only allowed when every part is) are allowed without asking for the rest of the conversation.
- **Decline** — optionally type what it should do instead first; the agent gets your message and carries on.

A banner above the message box points to waiting requests; the sidebar marks the conversation **Needs you** and the browser tab title shows how many conversations need you. Pressing **■ Stop** declines everything still waiting, and a request whose agent stopped (it crashed or timed out) expires. If you allow something in a read-only conversation while another conversation is changing the same directory, it is declined and the agent is told why. Codex runs commands in its sandbox and asks only when it decides it needs more than the sandbox allows.

### Reviewing and applying changes

When an agent changes files, its reply ends with a card listing the files (A added, M modified, D deleted, with lines added/removed):

- **View this turn's diff** — what the agent changed in this turn.
- In parallel mode the card says **in worktree** with the agent's branch, and the agent's latest card also has:
  - **View @name's full result** — everything this agent changed since the round started;
  - **Apply to working directory** — copies that result into your working directory. Nothing is committed: review the changes with your usual tools and commit them yourself.

After you apply one result, the other agents' results are marked as out of date, and the next parallel round starts every agent from the updated directory. If your working directory changed in a way that conflicts with the result, nothing is applied and you get an explanation; ask an agent to redo the work on top of the current state.

### Editing the team mid-chat

Click **Team settings** in the header to change roles, models, effort, mode, permission or working directory. Changes apply from the next turn. Changing an agent's CLI makes that agent start a new session and re-read the chat history. Settings can't be saved while the team is replying. The members shown are the **current team**: the lead agent may change it at your next question (see [Auto team](#auto-team)). Here you can also tick or untick **Use the lead agent's team without asking me**.

To have the lead agent make the change, say what you want in **Ask the lead agent** at the top of **Team settings** (for example "add a tester on Codex", "switch to relay" or "have the Reviewer focus on security") and click **Ask the lead agent** (or press ⌘/Ctrl+Enter). It reads the chat so far and changes the team shown below, not yet the conversation's: its note says why, lists what changed (members added, removed, renamed or moved to another coding agent, rewritten roles, models, the speaking order, the mode), and shows how long it took and what it cost; **Undo** puts the team back as it was, and **Save** uses it (for a design waiting for confirmation, saving confirms it, as above). Members it keeps or renames keep their tools and session; one it moves to another coding agent keeps its tools and re-reads the chat, as when you switch it yourself. If it can't do what you ask (for example, change the permission), it says why and leaves the team as it was. While it works the team can't be edited or saved; **Stop**, or closing **Team settings**, stops it. If the team changes meanwhile (for example, the lead agent finishes designing it), its change is not applied; ask again. You can ask again, or edit its team by hand, before you save.

### Schedules

**Schedule** in the header sends the team a message at set times — in this conversation, or in a new one each time — as if you had sent it — for example "@Reviewer look at the pull requests merged yesterday and list the risks" every weekday at 09:00.

To start from a schedule instead of a chat, click **New schedule**, the calendar button beside **New chat** in the sidebar. Fill in the same choices as below, plus the working directory, the file permission and whether to use the lead agent's team without asking, and click **Create schedule**. Harness Relay opens a chat for it (named after the message unless you give a name), and the lead agent designs a team for the message right away; confirm it on its card. Nothing runs then: the team gets the message at the set times. A time that comes due while the team is being designed or waits for you is tried again for up to 30 minutes, then skipped. If the design was stopped, the schedule window offers **Have the lead agent design the team**.

- **Message** — what to send. As usual, when you @mention members, only they answer; a name that is not on the team reaches nobody (the members the message does @mention answer, or with none, the whole team) — the window warns about it as you type, and **Team settings** warns when you rename or remove a member the message @mentions. With **New schedule** there is no team yet: the lead agent names the members after the names the message @mentions (for example `@Reviewer`), and a team's card warns before you confirm it if one is missing (also for a later question's team, in a chat with a schedule).
- **When** — **Once** (a date and time), **Every day** or **Every week** (pick the days) at a time, or **Every few hours** (counted from when you set its times; changing only the message keeps the rhythm). The next three times and the time zone are shown before you save; times are in the schedule's time zone, and on a device in another zone you can switch it to that device's.
- **Actions outside the permission** — in the runs the schedule starts, nobody may be watching: by default anything an agent wants to do beyond the conversation's permission is **refused automatically** (the agent is told and works around it, and the chat shows what was refused), except what you have already allowed always in this chat. Choose **Ask me** to be asked in the chat as usual; the agent then waits for you (up to 45 minutes per turn). As soon as you write into a scheduled run, it asks you as usual. A conversation set to refuse automatically, or with full access, is not changed by this.
- **Missed times** — Harness Relay only sends while it is running. A time missed while it was closed or the computer slept is **skipped**, with a note in the chat, or **sent once when it starts** (only once, however many were missed).
- **Start a new chat each time** — instead of this chat, each time opens a new one with the same team, settings, "always allow" answers and sidebar group, named after this chat and the time, and sends the message there. Every run starts with a clean context, and this chat does not keep growing; but the agents do not remember earlier runs, so have them keep what must carry over in a file in the working directory. A question waiting for your answer here, or messages waiting in this chat's queue, do not hold it back; it still needs a confirmed team, and it waits while a conversation — this one included — is changing files in the same folder. In parallel mode every new chat gets worktrees and `relay/*` branches of its own, which go only when you delete that chat. The schedule's status links to the chat it last opened, and **Run once now** links to the one it just opened.
- **On** — untick it to pause the schedule without deleting it.

The header shows the schedule (point at it for the next time), and the sidebar shows a clock next to the conversation; both turn amber when the last time was not sent. A message the schedule sent is marked **Scheduled**. A scheduled message waits while the team is replying, like one you send then; it is held back (with a note) while an agent waits for your answer (it never counts as your answer), while the team is still to be confirmed, or while the previous scheduled message is still waiting for the team. If the team was stopped with a scheduled message still waiting, it goes out at the next time. When another conversation (for a schedule that starts a new chat each time, also this one) is changing the same folder, it is tried again for up to 30 minutes. If you answer an agent's question while a scheduled message waits, your answer goes first and the scheduled message follows; if it is for an agent who does not speak in that run, it then gets a run of its own, which refuses approvals like any scheduled run unless the schedule says to ask. **Run once now** sends it right away to try it out; **Delete schedule** removes it. A conversation has one schedule, and you need a confirmed team to turn it on here (**New schedule** turns it on itself and has the lead agent design the team). Scheduled messages go to the current team: the lead agent doesn't design a team for them, since nobody may be there to confirm it. With a schedule on, **Team settings** reminds you that your changes apply to its runs, and warns when the team has full access.

### Browsing files

**Files** in the header opens the conversation's working directory: folders first, a filter for the folder you are in, and ↑ to go up. Click a file to preview it: code with line numbers and highlighting, Markdown rendered (or its source), images and videos. **Download** saves any file to the device you are using, also one that cannot be previewed, such as a PDF or slides. **Copy path** copies the file's full path. To download a whole folder as a ZIP file, use the download button at the end of the toolbar for the folder you are in (the working directory itself too), or the one beside a folder in the list (shown when you point at it). A folder too large to zip — more than 10,000 files and folders or 1 GB, usually because of `node_modules` and the like — is offered without the files git ignores (repositories inside it included), when it is in a git repository; the ZIP file has the same files you can browse, with their permissions, inside a folder of its name (an agent's worktree is named after the working directory and the agent). In parallel mode you can also pick an agent's worktree, to look at its result before you apply it. Only what is inside the chosen folder is shown, `.git` folders are left out, and files over 512 KB show their beginning. On a phone, the list and the preview take turns; **Back to the list** returns.

### Copying, editing and retrying

- The buttons under a message are icons (point at one for its name). Under an agent's reply they are always shown; under your own message they appear when you point at it (on a phone or tablet they are always shown). Under an agent's reply, copy, retry, share and branch are on the left and the reply's time, cost and tokens at the right edge; under your own message, copy and edit sit below the bubble.
- **Copy** (two sheets) copies that message's text as Markdown, exactly as it was written: links keep their full URLs, and formatting, tables, code and line breaks stay as they are (also when you open the app over plain http, for example from a phone). Selecting text yourself copies what is shown instead (a link's text without its URL). **Copy as Markdown** under **Share** in the header copies the whole conversation (see [Sharing a conversation](#sharing-a-conversation)), with each message labelled by who said it (the name and CLI the agent had then); a code block a stopped reply left open is closed. Tool activity is left out.
- **Edit** (a pencil) under one of your own messages lets you change it and send it again (Enter sends, Shift+Enter adds a line, Esc cancels; on a phone or tablet Enter adds a line and **Send** sends). Everything after that message is deleted and the team answers again from there; every agent starts a fresh session and re-reads the history up to your edited message. Files the deleted replies changed are **not** restored — if any of them changed files you are asked to confirm first. Editing is not available while the team is replying.
- **Retry** (two circling arrows) under an agent's reply lets that agent answer again. Its reply and everything after it are deleted (you are asked to confirm when there is anything after it); outside relay mode, the later speakers of the same round answer again too.

### Branching a conversation

To try another direction without losing where a conversation went, branch it: **Branch conversation** (a forking line) under an agent's reply makes a new conversation, **Branch · <title>**, and opens it:

- It holds a copy of every message up to and including that reply (attached files and the changed files' diffs too), and the team, settings, "always allow" answers and sidebar group the original has now (not as they were at that reply). **Continued from <title>** after the chat's title, and on a line after the copied messages, links back to the original (once that is deleted, its title is shown without the link). When the chat's title and the original's do not both fit, each gets half the room (a short one leaves the rest to the other) and ends in …, so both stay in view.
- If that reply asked you something, the question waits for your answer in the branch too, even if you answered it in the original: branch from a question to answer it another way.
- The original stays exactly as it was, and can go on replying meanwhile; only the replies up to the one you branch from must be finished.
- In parallel mode, the images and files a copied reply shows come from that agent's worktree in the original, so they are gone once the original is deleted (its diff stays). A result can only be applied in the conversation that made it.
- The agents in the branch start fresh sessions: on their first turn they are given the copied messages, and from there each conversation goes its own way.
- Both conversations share the working directory, and files are **not** rewound: they are as the original left them, not as they were at that reply. The agents in a branch are told so.
- Branching is not offered on your own messages: to ask something else after your question, branch from the reply before it, or edit the question (which replaces what came after it).
- The first message you send in the branch names it, as a new chat's first question does, so its name says where it went (one you renamed yourself keeps your name). Editing the first copied message makes it a chat of its own (nothing copied is left), named after the edited message.
- In the sidebar the branch is listed under the original, and they stay together in one group: see [Branches in the sidebar](#branches-in-the-sidebar). You can branch a branch too, as deep as you like.
- A branch is always one of the conversation the reply was written in. In a branch, the messages up to where it was branched were copied from the original: branching from one of those replies (the last copied one included) makes a branch of the original, as if you had branched there, listed under it and named after it, not under the branch you clicked in. For a branch of a branch, that may be a conversation further up. Retrying or editing in a branch can likewise move it: once nothing written in the conversation it came from is left in it, it is listed under the one further up (and, while it still has the name it was made with, named after that one).

### Sharing a conversation

**Share** in the header shares the whole conversation; **Share** (a box with an arrow) under an agent's reply shares everything from the start up to and including that reply. Either way, tool calls, thinking, to-do lists, permission requests and changed files are left out. The dialog offers two things:

- **Copy as Markdown** copies the text, each message labelled by who said it.
- **Create link** makes a page that looks like the chat on screen (the title, the team, the messages with their code, tables, diagrams and images; not the mode, permission or schedule tags; a role in a team design too long for a few lines even on a wide screen stays folded with **Show more**, which opens it there too, and shorter ones are shown whole) with Harness Relay's name and logo and when it was shared at its foot (the logo and the link icon beside the time open Harness Relay's website), and puts it on the web as a *secret gist* with your GitHub CLI (`gh`): anyone with the link can open it at gistpreview.github.io, but it is not listed or searchable. Install `gh` 2.66.0 or later from https://cli.github.com and run `gh auth login` once (an older `gh` cannot remove a share without asking; Harness Relay then names the version it needs and the one installed); without it, or signed out, nothing is uploaded and the dialog shows what to do: the install commands for macOS and Windows (each with a copy button), the download page and the Linux guide, the `gh auth login` command and its help, and where to sign up for a GitHub account. Removing a share in Settings shows the same help. The page must stay under 1 MB (gistpreview reads gists through GitHub's API, which cuts larger files off): images are made smaller, and left out when they still do not fit; a conversation too long for it can be shared up to an earlier reply. The page holds everything it shows and loads nothing from anywhere. While the team is still writing a reply in it, create the link once the reply is done; a message you are editing must be sent or cancelled first.

**Files the replies link to.** When the shared replies link to files on your computer (`[Report](out/report.md)`), the dialog lists them under the link, each with its size, and you choose which go along: checked files are uploaded into a second secret gist of their own (kept apart from the page, which GitHub would otherwise cut short), and their links on the page get them there (from `gist.githubusercontent.com`: text and images open in the browser, other files such as PDFs and slides download), so **anyone with the link can download them**. The links to files left unchecked become plain text on the page: their words stay, without the download arrow, with nothing to download. Any kind of file can go along (text, PDFs, slides, images, archives…), up to 50 MB each and 100 MB or 20 files in all; the list says why a file cannot: not found, outside the chat's folders (or in `.git`), or over 50 MB. The files go up with `git` as well as `gh` (gh signs git in, with nothing to set up), so `git` must be installed too. A file whose name git keeps for itself (such as `.gitignore` or `.gitmodules`) goes up with a `_` in front of its name. Only files the reply's own download link would give you are read, from the working directory, the agent's worktree or the attachments, never from `.git`. At first every file that can go along is checked, within the limits, except those whose names say they may hold secrets (dotfiles such as `.env` or `.npmrc`, keys such as `*.pem`, `*.key` or `id_rsa`, and names with secret, credential, password, token or API key in them): those are marked and left for you to check if you mean to. The files are checked again when a reply finishes or a file changes, and what you checked or unchecked stays as you left it; only files new to the list get the default. If a file changed since the list was made so that it can no longer go along, nothing is uploaded and the list is checked again. If Harness Relay stops while the files go up, Settings lists their gist afterwards, marked as not finished, so you can remove it. If the files or the page cannot be uploaded once the files' gist is made, that gist is deleted again; if even that fails, you are told, and that gist is listed in Settings, marked as not finished, so you can remove it.

**Settings → Shared conversations** lists every link you made, the newest first, with what it holds (and how many files went along) and when: open the page, its chat, its gist on GitHub or the gist with its files, and remove the ones that should go, one at a time or several at once. Removing one deletes all of its gists on GitHub (`gh gist delete`): the page's and the one with its files, so the link and the files' links stop working (GitHub may keep serving a removed file from its cache for a few minutes); the share leaves the list only once both are gone, and stays with the reason when one could not be deleted, so you can remove it again. One you already deleted on GitHub just leaves the list. A gist made while `gh` was signed in to another GitHub account stays until you switch back to that account (`gh auth switch`).

### Voice input

Press 🎙 next to Send and speak; press it again (it shows a red timer while recording) and the text appears where the cursor is, so you can fix it, add an `@mention` and send it yourself. Esc cancels a recording, and one recording lasts at most two minutes. Speech is turned into text on your computer by whisper.cpp; the recording is never uploaded.

Voice input is optional. The first time you press 🎙, a dialog explains what will be downloaded and where it goes:

- **The engine** (whisper.cpp) — on macOS it is installed with Homebrew (`brew install whisper-cpp`) and uses the GPU (Metal); on Linux and Windows Harness Relay downloads the official build (about 5–10 MB), which runs on the CPU. If you have whisper.cpp already, it is used.
- **A model** — pick one; the dialog suggests the best fit for your computer (Large v3 Turbo on Apple silicon, Small elsewhere).

Click **Download and install** and keep working: it installs in the background (a dot on 🎙 shows it), and **Settings → Voice input** shows each step, the download progress and the installer's output, with **Cancel install**. Every file is checked against its known contents (SHA-256) before it is used.

In **Settings → Voice input** you can also install it from scratch, download and switch models (**Download and use**, **Use**, **Remove**), choose the spoken language (follow the UI language, auto-detect, Chinese written in Traditional characters, or English), point to your own `whisper-server`, and **Remove voice input** to delete what was downloaded. The engine starts the first time you speak and stops after 10 idle minutes, which frees the memory the model takes.

### Conversation list

The sidebar lists conversations in their [groups](#groups), newest first, each with its state:

| Badge | Meaning |
| --- | --- |
| **Needs you** (orange) | An agent is waiting for your approval. |
| **Confirm the team** (orange) | The lead agent designed a team for your question; confirm it and the team answers ([Auto team](#auto-team)). |
| **Replying** (blue, pulsing) | The team is working. |
| **New reply** (green, bold title) | It finished while you were looking at something else. |
| **Error** (red) | The last reply ended with an error you haven't looked at yet. |

A clock before the time means the conversation has a [schedule](#schedules) (point at it for the next time); it is amber when the last time was not sent. Conversations keep running when you switch to another one (or close the tab); the badges update by themselves. Click the title in the chat header to rename; hover a conversation and click × to delete it. A conversation's title uses the sidebar's whole width and ends in … only when it doesn't fit; the folder and × buttons appear on hover (always on a phone or tablet). A conversation with a large team shows its first few member dots and a **+N** count.

To make room, collapse the sidebar with the panel button next to *Harness Relay*. A button stays in the top-left corner to bring it back. The choice is remembered in this browser. (On a phone the sidebar is a drawer opened with ☰ instead, and the page does not zoom: no pinch or double-tap zoom, and no zooming in on the message box. On a phone or tablet the header is a single row: the title with **Share**, **Files**, **Schedule** and **Team settings**. On a phone these four are under **⋯** at the right of the header, each with its icon (a box with an arrow, a folder, a clock, two people), and **⋯** has a blue dot while a schedule is on, as the clock is blue then. The team, its mode and its permission are under **Team settings**, except that a red **Full access** tag beside the title warns when the agents may run any command. The message box stays one line until you type, and its buttons move below the text when they would leave it too little room.)

### Groups

Click **New group** under **New chat**, type a name and press Enter. Groups appear in the order you made them, and **Other** — the default group, which always exists — comes last: conversations in no group are there.

- **Move a conversation**: drag it onto a group (the group lights up), or hover it, click the folder button and pick a group. On a phone or tablet, where dragging does not work, the folder button is always shown.
- **Sorted for you**: when a new conversation gets its first message and you have groups, the lead agent ([Settings → Lead agent](#lead-agent)) reads the message, next to the team, and puts the conversation in the group it fits; while it decides, the conversation says **Sorting…**. When no group fits it stays in **Other**. This happens once per conversation, and never moves a conversation you have already moved yourself. With no groups, nothing is asked.
- **Rename or delete a group**: hover its name and click the pencil or ×. Deleting a group moves its conversations to **Other**; they are not deleted. Names must be different from each other and from **Other**.
- **Collapse a group**: click its name. A collapsed group shows the dot of its most urgent conversation (needs you, replying, error, new reply). Collapsed groups are remembered in this browser.

#### Branches in the sidebar

A conversation you [branched](#branching-a-conversation) is listed under the conversation the reply you branched from was written in, a little to the right, with a line down the side; its own branches are under it in turn, the oldest first. Branches are indented three levels at most: deeper ones are not indented further, and start with ↳.

- **One family, one group**: a conversation, its branches, theirs and so on stay together in one group (that of the oldest of them). Moving any of them, by dragging or with the folder button, moves all of them; while you drag one, all of them are dimmed. The lead agent sorts only the conversation they all came from.
- **Order**: a family is placed among the group's conversations by its most recent activity, whichever of its conversations that was in; the branches under a conversation stay in the order they were made.
- **Show or hide branches**: a conversation with branches has a button with the branch icon and how many there are under it; click it to hide them, and again to show them. While they are hidden, the button outlines and shows the dot of the most urgent of them. Hidden branches are remembered in this browser. Opening a conversation they hide (a new branch, or one found by search) shows them again.
- **Deleting**: deleting a conversation keeps the conversations branched from it (the confirmation says how many). They stay where they were, under its old title, marked **(deleted)**, which links nowhere and goes once none of them is left; deleting one in the middle keeps the rest of the family together too.
- **Search** results say which conversation a branch was branched from, after the branch icon.

### Search

Click **Search** under **New chat** and type. Conversations whose title or messages — what you and the agents wrote — contain every word you typed are listed in place of the groups, ignoring case: those whose title matches first, then the most recent. Each result shows where it matched, with the words highlighted, its group, the conversation it was branched from (if it was) and how many messages match. Click one to open it; press Escape or × to go back to the groups. Chinese works without spaces: any part of a word matches.

## 5. Tips for writing roles

- Give each agent a distinct responsibility and say what it should **not** do ("don't edit files yourself").
- In relay mode, say explicitly whom to hand off to and when ("when done, list changed files and `@Reviewer`").
- Put the final say with one agent ("you speak last and give the user the final answer").
- To compare several implementations, use **parallel** mode with edit permission: every agent gets its own copy and you apply the one you like. For a plan → build → review flow, use **relay** so each agent builds on the previous one's changes.
- Save the teams the lead agent designed that work well as templates, and give each of your templates a description: the lead agent reads it when it picks one.

## 6. Where data is stored

All conversations, templates and settings are stored in `data/relay.db` (SQLite) in the project folder, readable only by your user. The links you shared are listed there too; the pages themselves, with the files that went along, are secret gists on GitHub. API keys are the exception: they go to your system's credential store (see [API keys](#api-keys-optional)). Files you attach are kept in `data/attachments/<conversation>/`, readable only by your user, and are deleted with the conversation (or when editing an earlier message drops the messages they belonged to). Parallel-mode worktrees live in `data/worktrees/` (on `relay/…` branches of your repository) and are removed when you delete the conversation. Each CLI also keeps its own session history in its usual location (`~/.claude…`, `~/.codex`, `~/.grok`), or in [the CLIs' own folder](#agent-sessions-the-clis-own-folder-and-agentsview) when you set one. Voice input's models (and, on Linux and Windows, its engine) are in `data/voice/`; **Settings → Voice input → Remove voice input** deletes them. The [tool library](#tool-library-mcp-servers-skills-and-memory) is in `data/relay.db` too, except the values of MCP servers' variables and headers, which go to the credential store like API keys. Your language and appearance choices and which version of the tour you finished are kept in the browser. Back up by copying `data/` while the app is stopped. The [desktop app](#desktop-app) keeps the same files in its own data folder instead of `data/`.

## 7. Troubleshooting

| Symptom | What to try |
| --- | --- |
| Agent shows *Not signed in* | Sign in from Settings & sign-in, or set an API key. Then click **Check again**. |
| *Command not found* | Install the CLI (its card in Settings links to its website), or set **Executable** under the provider's **Default model and reasoning effort** section in Settings. |
| A reply ends with an error box | Read the message: it is the CLI's own error (rate limits, auth, invalid model…). Fix it and press **Continue** or resend. |
| Auto team always keeps the current team, or falls back to the General-question panel | The card says why. Check that the lead agent's CLI is signed in (Settings → Lead agent), or pick another lead agent. |
| Agent seems to have forgotten the conversation | If its CLI session could not be resumed, Harness Relay automatically starts a fresh session with the full history; this is expected after changing the working directory or the agent's CLI. |
| Model list is empty or outdated | Click **Check again** on the Settings page to refresh; you can always pick **Custom…** and type a model id. |
| "Is changing" when sending | Another conversation is writing to the same directory. Wait until it finishes, stop it, or use parallel / read-only mode. |
| Apply reports a conflict | Your working directory changed since the agents started. Nothing was applied; send a new message so the agents start again from the current state, or merge the agent's `relay/…` branch yourself. |
| Agent in parallel mode can't run tests | Worktrees don't contain ignored files such as `node_modules/`; ask the agent to install dependencies in its worktree first. |
| An agent seems stuck | Look for a **Needs you** badge or an approval card: it may be waiting for your answer. |
| Saving an API key fails (*Could not save the API key to the system credential store*) | The keychain / keyring is locked or access was denied. Unlock it (or allow access when asked) and save again, or set the environment variable instead. |
| "Reconnecting…" stays up | The server is down or restarting; the page reconnects by itself once it is back. |
| *Forbidden host* when you open it from your phone or another device | Start Harness Relay with that address in `RELAY_ALLOWED_HOSTS`; see [Use it from your phone](remote-access.md#troubleshooting). |
| "Too broad" when choosing a working directory | The folder is inside a git repository rooted at your home directory (such as a dotfiles repository). Pick a project folder, or run `git init` in the project folder. |
| Some messages are in the other language | System notes and errors are written in the language that was active when they happened; switching language doesn't translate them. |
| 🎙 says the microphone is not available | Allow this page to use the microphone (the site permissions next to the address bar), and check the system's privacy settings for your browser. |
| Voice input install fails | Open **Settings → Voice input** and read the error and the install log. On macOS install [Homebrew](https://brew.sh) first; on an older Linux (glibc before 2.34) install whisper.cpp yourself and set the **whisper-server path** under **Advanced**. |
| Transcription is slow | Choose a smaller model in **Settings → Voice input** (Small or Base); without a GPU the large models take several seconds. The first transcription after a while also loads the model. |
| Transcribed Chinese uses Simplified characters, or the wrong language | Set **Spoken language** to Chinese (Traditional) or English instead of auto-detect; a larger model also helps. |
| Every agent is *Not signed in* after setting the CLIs' own folder | Expected: the CLIs' new homes start empty. Sign in to each CLI again in Settings, or set API keys. |
| Settings says *The last update of AgentsView failed* | Start AgentsView, or check the address and port in **Settings → Agent sessions**. `ECONNREFUSED` means nothing listens there. A conversation is sent again after its next turn. |
| A conversation is missing in AgentsView | AgentsView hides sessions with only one message from the user: turn on **Include single-turn** in its session filter. |
| The desktop app says the port is already in use | Quit the Harness Relay you started with `npm start` (or the other program; `npm run dev` uses 8789, not the app's port), then click **Try again**. Or quit the app and set another `"port"` in its `desktop.json` (see [Desktop app](#desktop-app)). |
| The server stops at start: *Another Harness Relay server is using the data folder* | Two servers cannot share one data folder (each would stop the other's runs when it starts). Quit the other one (an `npm start` in the same folder, say), or give this one a folder of its own with `RELAY_DATA_DIR`. |
| The desktop app shows *Command not found* for a CLI that works in your terminal | The app reads your login shell's environment (on Windows, PATH from the system) when it starts the server: after installing a CLI, choose **Restart server…** in its menu. If it still is not found, set **Executable** to the CLI's full path (`which claude` in a terminal) in Settings. |
| The desktop app's AppImage stops at once on Linux | Start it with `--no-sandbox` (see [Desktop app](#desktop-app)). |
| The desktop app's window or your browser shows the sign-in page | The sign-in link was not used in time, or the window was signed out: choose **Open Harness Relay** in the app's menu for its window, **Open in browser** for a browser. |
| The desktop app says its server took too long to start | After an update, macOS may ask whether Harness Relay may use its keys in your keychain, and the server waits for the answer, for three minutes at most. Answer it, then choose **Start server** in the menu. |
| **Open at login** does not start the app on macOS | macOS asks you to approve it: allow Harness Relay in **System Settings → General → Login Items & Extensions**. |
| **Update to …** says Harness Relay cannot update itself, or the update failed | The dialog says why, and offers the release's page: install the new version as the first time. On a Mac, move the app into Applications first (one run from the `.dmg`, or from a folder it may not write in, cannot replace itself). A failed download or check changes nothing: the app runs on as before. |
| **Share with your phone** says it could not read what this computer shares | `tailscale serve status` did not answer, so the app shared nothing (it could have taken over another service or Funnel). Check that Tailscale runs and is signed in, then try again, or share by hand (see [Use it from your phone](remote-access.md)). |
| Port already in use | Start with another port: `PORT=8790 npm start` on macOS and Linux, `$env:PORT=8790; npm start` in Windows PowerShell. The same works for `npm run dev`, whose UI proxy follows `PORT`. |
