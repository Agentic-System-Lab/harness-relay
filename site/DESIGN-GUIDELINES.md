# Landing page design guidelines

How the Harness Relay landing page (`site/`), its use-cases page and its docs look, read and behave, and what to keep when you change them. The page is published to GitHub Pages by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml); this file stays in the repository and is never served (the workflow drops every `*.md` file and the `*.webp.json` provenance sidecars).

## Goal

- **Reader:** a developer who already uses one or more of the Claude Code, Codex, Grok, Cursor, Antigravity, Copilot and Muse Code CLIs, or an open-source coding agent (OpenCode, Goose, Cline, OpenHands, Pi) on their own API keys or model.
- **Job of the page:** within a minute, show that the coding agents the reader already has (any mix of the twelve, and one is enough) work in one chat, as three real CLIs do in the demo (Claude Code, Codex and Grok), then get the reader to download the desktop app for their system, try it in a GitHub codespace of their own (nothing to install: `.devcontainer/`, [docs/codespaces.md](../docs/codespaces.md)), or open the repository. There are no commands to start it: running from source (`npm start`, and `npm run dev` for people working on Harness Relay itself) is one line at the end of the quick start, for servers without a desktop, linking to the README.
- **Primary action:** the download button in the hero, named after the visitor's system ("Download for macOS"), beside the installation guide; the Codespaces button (secondary, *Try it free in Codespaces* (在 Codespaces 免費體驗), to `codespaces.new/…/tree/latest-release?quickstart=1`, the newest release, which opens the Codespaces dialog first) and the GitHub button sit under them, the GitHub button last. The buttons' column takes only the width they need, and the lead sentence the rest, so that it reads in a few long lines. The hero is as wide as the header: the headline fills the width (`text-wrap: pretty`, not balanced shorter), and the buttons end at the right edge, under the header's GitHub button (on one column, 920px and narrower, they start at the left). The page ends on the quick start, never on a dead end.

## Principles

1. **Show the run, don't describe it.** The use cases follow the hero. Each card links to its recording and chapter rail. Every section after it shows the mechanism (mode diagrams, the app's own UI) before it explains it.
2. **The app's world, at poster scale.** The page is recognisably the same product as the app: same neutrals, same agent colours, same three-dot mark, same avatars and pills. It is bolder in scale, not in new decoration.
3. **Colour means an agent.** Claude Code orange, Codex green and Grok violet appear only where that agent acts or is named. Never use them for generic accents, links or section themes. The one other colour is the GitHub star's yellow, only on that star. Cursor, Antigravity, Copilot, Muse Code and the five open-source agents have their colours from the app (Settings shows them the same), but only on the dot before their name in their list ("The agents you installed" and "Open-source agents"); their names and everything else about them stay plain: the demo does not show them. So the mark keeps the demo's three. The headline names no agent: it says the reader's own agents, in any mix, work together, so that it never reads as a list of CLIs (and subscriptions) the reader needs. Its one colour is the bar under "coding agent(s)", split in the three (`.team-mark`), as when all three act together; the words themselves stay ink; the lead sentence under it names the demo's three, plainly, says there are twelve to mix, and says one kind of agent is enough.
4. **Facts only.** Every claim must be true of the code in this repository. There are no testimonials, user counts, download counts or benchmarks; do not add any. The numbers about the project are the GitHub star count on the two GitHub buttons and the newest release's version in the quick start, read live from GitHub's API; never write them into the page. The download cards show no installer sizes.
5. **Two languages, equal.** English and 繁體中文 pages have the same sections, order and facts.

## Visual system

### Colour

Tokens live at the top of [`assets/site.css`](assets/site.css) and follow the app (`src/web/styles.css`). The page follows the visitor's light/dark setting, like the app, until they pick a theme with the theme button (see Components). The dark values are written twice, for the system's dark mode (unless `<html data-theme="light">`) and for `data-theme="dark"`, and `test/site-theme.test.ts` checks the two lists are the same. So anything that differs in dark mode is a token in those lists (`--warn`, `--danger`, `--when-light` and `--when-dark` for what shows in one theme only), never a `prefers-color-scheme` query of its own.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#ffffff` | `#141415` | Page background |
| `--surface` | `#f4f4f5` | `#1e1e20` | Command blocks, mode stage, quick start band |
| `--border` | `#e4e4e7` | `#333336` | Hairlines, outlines |
| `--text` | `#18181b` | `#ececec` | Body and headings |
| `--muted` | `#5f5f68` | `#a1a1aa` | Secondary text (5.7:1 or better on every surface) |
| `--band` | `#111113` | `#0a0a0b` | The panels around the use-case recordings |

Agent colours, each in four strengths:

| Agent | Brand (fills, large text) | `-ink` (text on page bg) | `-lit` (text on the band) | `-deep` (avatar fill, white initial) |
| --- | --- | --- | --- | --- |
| Claude Code | `#d97757` | `#b2502c` / dark `#e8906f` | `#e8906f` | `#b2502c` |
| Codex | `#10a37f` | `#0b7a5f` / dark `#34c79d` | `#34c79d` | `#0b7a5f` |
| Grok | `#7c5cff` | `#6440f0` / dark `#a593ff` | `#a593ff` | `#6440f0` |
| Antigravity | `#65a30d` | `#3f6212` / dark `#84cc16` | `#84cc16` | `#3f6212` |
| Copilot | `#0f766e` | `#0f766e` / dark `#2dd4bf` | `#2dd4bf` | `#0f766e` |

Antigravity and Copilot have the four because a use case shows them (its pills and its rail's avatars). All nine below have their brand colour, the same in both themes as in the app (`src/web/styles.css`), for the dot in their list:

| Agent | Token | Colour |
| --- | --- | --- |
| Cursor | `--cursor` | `#d6409f` |
| Antigravity | `--antigravity` | `#65a30d` |
| Copilot | `--copilot` | `#0f766e` |
| Muse Code | `--muse` | `#e11d48` |
| OpenCode | `--opencode` | `#2563eb` |
| Goose | `--goose` | `#b45309` |
| Cline | `--cline` | `#2e7d32` |
| OpenHands | `--openhands` | `#0891b2` |
| Pi | `--pi` | `#64748b` |

Rules:

- Brand colours as text only at large sizes, 3:1 or better (none is on the page now: the headline names no agent). Small coloured text uses `-ink` on the page and `-lit` on the band.
- On the big discs, Claude Code and Codex take dark text (`#18181b`); Grok takes white, and only at large bold sizes.
- Set the agent with a helper class: `.t-claude`, `.t-codex`, `.t-grok`, `.t-antigravity` or `.t-copilot` define `--agent`, `--agent-ink`, `--agent-lit` and `--agent-deep` for everything inside. `.t-cursor`, `.t-muse`, `.t-opencode`, `.t-goose`, `.t-cline`, `.t-openhands` and `.t-pi` define `--agent` only, for their list's dot; keep them changed with the app's colours.
- When all three act together (`.t-team`), show all three: stacked avatars, and a progress bar split in three. The headline's "coding agent(s)" takes the same split as its underline (`.team-mark`), for the agents together.
- Body text meets 4.5:1, large text 3:1. Check new pairs before shipping.

### Type

| Role | Face | Size | Notes |
| --- | --- | --- | --- |
| Display (h1, h2, h3, brand) | Bricolage Grotesque, self-hosted (`assets/fonts/`, OFL) | h1 `clamp(2.6rem … 5.25rem)`, h2 `clamp(2rem … 3.4rem)` | Weight 700, slightly condensed (`font-stretch` 92–94%), tracking −0.03 to −0.035em, `text-wrap: balance` |
| Body | System UI stack (same as the app) | 16px / 1.6 | Lead paragraphs 17–19.5px in `--muted` |
| Chinese | PingFang TC, then Noto Sans TC, then Microsoft JhengHei | | Headings get looser tracking (−0.01em) and line height (1.12–1.16) under `:lang(zh)`. A phrase the headline must not break inside (Chinese breaks between any two characters) goes in `<span class="phrase">` |
| Code | System monospace stack | 13.5px in blocks | Only for real commands, file names and protocol names, never as decoration |

The font file only covers Latin; Chinese always comes from the system stack.

### Shape, space and depth

- Radius: 14px for UI excerpts (the app's `--radius`), 12px for command blocks and the video, 20–22px for large panels, full pills for buttons, tabs and chips.
- Container: max 1200px, side gutter `clamp(16px, 4vw, 32px)` (12px at 360px and below). Text fills the column it is in: a section's head, a lead paragraph, a use case's head and an excerpt's text have no width of their own, on a wide screen as on a phone.
- **No page scrolls sideways**, at any width from 280px (the narrowest phones', folded), in both languages, with the Codespaces dialog open or not (`test/site-header.test.ts`; check every width in Chromium after a change to the layout). At 480px and below a long command or package name in the text (`@earendil-works/pi-coding-agent`) breaks where it must, and the approval card's buttons wrap; at 380px and below the headline scales with the screen (`min(2.6rem, 11.4vw)`), so that the phrases it keeps whole (`.phrase`) fit; at 360px and below the header's controls draw closer (and again at 300px). Something wider than the screen wraps or shrinks; it never widens the page. The one row that scrolls sideways, the use-case cards' on a phone, scrolls inside itself.
- Section rhythm: `clamp(72px, 9vw, 132px)` top and bottom, a hairline between sections, more space above a heading than below it.
- Shadows always have a vertical offset and a soft blur (`--shadow`). No glow, no hard offset shadows, no glass.

### Components

- **Mark:** the three circles from the favicon (`#i-mark` symbol), same geometry as `src/web/components/Logo.tsx`. At page scale it becomes the three agent discs in "The agents you installed, as they are": the app's mark and the demo's three, not a count of the CLIs (the list beside it names Cursor, Antigravity, Copilot and Muse Code too).
- **Avatar** (`.av`): the member's initial on a `-deep` fill, like the app. Initials match the template or demo member names.
- **Pill** (`.pill`): the app's CLI badge, tinted agent colour with `-ink` text. The tint is the agent's colour at 12%, faint enough that each `-ink` keeps 4.5:1 on it in both themes (`test/site-theme.test.ts` checks; at 14% Claude Code's was 4.46:1): to change the tint or an agent colour, keep that test passing. **Chip** (`.chip`): neutral outline for mode, permission and round labels.
- **Buttons:** primary is ink on light (`.btn-primary`), secondary is outlined (`.btn-ghost`). One primary per view: in the hero, the download button.
- **Downloads** (`assets/downloads.js`, a module whose functions `test/site-downloads.test.ts` tests): every download link points at the releases page in the HTML, so the page works without JavaScript. The module reads GitHub's list of releases (kept in `localStorage` under `harness-relay.release` for ten minutes, like the stars), points each `[data-download]` link at its installer (`-mac-arm64.dmg`, `-win-x64.exe`, `-win-arm64.exe`, `-linux-x86_64.AppImage`, `-linux-arm64.AppImage`, as the Release workflow names them) in the newest release (never a release candidate: a kept one from an earlier visit is not shown, and GitHub is asked again), fills in the version line (`data-release` before the version), names the visitor's system on the hero's button (`data-mac`, `data-win`, `data-win-arm64`, `data-linux`, `data-linux-arm64` on `[data-downloads]` hold the words) and marks their card *Your system*. The Mac app is for Apple Silicon only: a Mac counts as one with Apple Silicon unless Chromium's hints say Intel, and then as another system (Safari and Firefox say "Intel" on every Mac). Windows and Linux have a card per processor; the processor comes from Chromium's high-entropy hints (`getHighEntropyValues`), else the user agent or `navigator.platform` (Chromium says x64 in its user agent on any Windows and Linux), else x64; a system the newest release has no installer for gets the releases page, as any other. On a phone the hero's button goes to the quick start, with a line saying Harness Relay runs on a computer. With no release found, nothing changes: the links keep the releases page. When `MIRROR` names the download mirror (`mirror/worker.ts`, for visitors GitHub is slow for; [developer guide](../docs/developer-guide.md#releasing), "The download mirror"), the installers' links go there instead, once the mirror answers a `HEAD` that it has the visitor's installer (else the first one the release has); until then, and whenever it does not, they stay on GitHub. The page counts nothing itself: the mirror has GitHub count each download it serves.
- **Download cards** (`.dl`): one row per system and processor in the quick start (macOS; Windows and Windows on Arm; Linux and Linux on Arm), with the system's icon, name, processor and file type (no size), and the download icon; the visitor's has a firmer outline and the *Your system* label on its edge.
- **Theme button** (`.theme-toggle`, [`assets/theme.js`](assets/theme.js), a module whose functions `test/site-theme.test.ts` tests): the last thing in the header, after the GitHub button, and only there. A round outlined button with one icon: the moon in the light theme, the sun in the dark one, for the theme a press gives; its label says the same (`data-to-dark`, `data-to-light`: "Switch to dark theme" / "切換成深色主題"). Until the visitor presses it the page follows the system's light or dark mode. A press switches to the other theme and keeps it in `localStorage` under `harness-relay.theme` (`light` or `dark`), for both languages; pressing it again for the theme the system has removes the key, and the page follows the system again. The inline script in each page's `<head>` sets `data-theme` on `<html>` from the key before anything renders, so a chosen theme does not flash. The browser's bar colour (`theme-color`) follows, and the other tabs too. Every colour changes at once (no button fades during the switch). Without JavaScript the button is not shown.
- **Star count** (`.stars`): the GitHub buttons in the header and the hero end in the repository's star count after a hairline, with the `#i-star` icon filled yellow (`--star`, with a darker `--star-edge` on a light button; the primary button uses the `--star-inverse` pair), and screen readers hear "12 stars" / "12 顆星". `site.js` reads it from `api.github.com` as the page loads, shortens it like GitHub does in the page's language (English `999`, `1.2K`, `12.3K`, `123K`, `1.2M`; 中文 `999`, `1,234`, `1.2萬`, `12.3萬`, `123萬`) and keeps it in `localStorage` under `harness-relay.stars` for ten minutes (the API allows a visitor 60 requests an hour). When GitHub can't be reached the last count shows; with none, or without JavaScript, the buttons show no count. On phones the header button drops the word "GitHub" and keeps the count.
- **Codespaces dialog** (`.cs-dialog`, a native `<dialog>` that `site.js` opens with `showModal()`; `test/site-codespaces.test.ts`): the hero's Codespaces button and the quick start's Codespaces link (`data-codespaces`) open it before GitHub's page, so the visitor knows what a codespace is and is not first: whose account it runs on and what it costs, that an agent still has to be signed in, what works differently there, who can open it, that it runs the newest release and is counted once (and how to leave it uncounted), and where Harness Relay's link shows, with the codespace's terminal recreated with the sample lines `start.sh` and the server print (`.cs-term`, said so under it like the other UI excerpts) and the link to click underlined beside a neutral ⌘ / Ctrl-click chip. Its one primary button, *Create my codespace*, opens `codespaces.new` on the `latest-release` branch in a new tab, so the directions stay on screen; the full guide is a text link. The two stay at the dialog's bottom on a bar of their own (sticky, the dialog's background, a hairline above), so they are in reach without scrolling, also on a phone, where the rest scrolls under them. They stay on one line down to a 280px screen, in both languages: at 440px and below the dialog takes the width but 8px each side (past the browser's own limit for a modal dialog) and the bar's gaps narrow, at 400px and below the button drops its icon and both go to 14px, at 350px and below to 13px, at 320px and below to 12px with the dialog 4px from each side, at 295px and below with less padding. Only where a phone's fonts are wider still does the bar wrap, rather than make the dialog scroll sideways. Esc, the close button and a click on the backdrop close it; the page behind does not scroll while it is open. A click with a modifier key goes straight to GitHub, and without JavaScript (or `showModal`) both links do. It fits at 390px with every command wrapping inside it.
- **Quick start step:** a step with more than one block (the download cards, text) wraps them in `.step-body`, so they stay together in the right-hand column.
- **Command block** (`.cmd`, not on the page now): `$` prompts are not copied; the copy button copies the commands only and confirms with a check. One command per line, never joined with `&&`: Windows PowerShell 5.1, still the default shell on Windows, rejects `&&`, while separate lines run in every shell.
- **UI excerpts** (`.ui`): approval card, question, changed files, waiting message tray, and Settings → Model connections (`.ui-backends`, from `src/web/components/BackendsSettings.tsx`). They recreate the app's components with sample content, and the page says so under them. Keep them faithful to the app when the app changes.
- **Use-case card** (`.case`, on the landing page): whose work it is (`.case-role`, muted, small), the use case's poster (the frame `npm run use-cases` cuts, 16:10, the excerpts' radius and shadow) and name in one link to its section, then one sentence and its facts row. Its pills are the agents that ran, over the page's background, so they keep the pill's contrast (`test/site-theme.test.ts`). Cards fill a grid of columns at least 320px wide (three, then two, on a wide screen). Where the grid would leave one column (720px and narrower, a phone's), they are one row swiped sideways instead: each card 84% of the column (at most 360px), so the next one shows at the edge; a swipe stops at a card's start (scroll snap), lined up with the text; the row runs to the screen's edges and scrolls inside itself, never the page, and a swipe past either end does not go back a page (`overscroll-behavior-x: contain`).
- **Use-case screen** (`.usecase-screen`): the video and chapter grid (`.screening-grid`) on a dark panel (`--band`, 22px radius) inside the section, the rail's heading an h3 (`.rail-title`). `site.js` gives every screen on a page its own rail, following its own video.
- **Icons:** drawn inline SVG symbols in one 1.8px stroke. No emoji or Unicode glyphs as icons, and no company logos: the systems are a command key (macOS), a four-pane window (Windows) and a penguin (Linux), and GitHub Codespaces is a cloud (`#i-cloud`). The GitHub button keeps GitHub's mark.

## Page structure

| # | Section | Purpose |
| --- | --- | --- |
| 1 | Header | Mark, section links, EN / 中文 switch, GitHub star count, theme. At 980px and narrower the native Explore / 探索 disclosure offers use cases, installation guide and docs. The header stays on one line down to 280px. The language links follow the current section or case in both directions. |
| 2 | Hero | Headline about the visitor’s own agents and a lead explaining how they work together. Show the installation guide beside the download button only in the two-column desktop layout (above 920px). Codespaces and GitHub follow. |
| 3 | Use cases (`#use-cases`) | *Hand it a task*: the twelve use cases as cards, one for each kind of work, (each one's poster, name, one sentence, and its agents and how they ran), each linking to its section on the use-cases page, and a link to the whole page |
| 4 | The agents you installed (`#agents`) | How each signed-in CLI is driven (Claude Code, Codex, Grok, then Cursor, Antigravity, Copilot and Muse Code, with their colours on their dots only); the mark at page scale |
| 5 | Open agents (`#open`) | The five open-source CLIs and how each is driven, the model backends they run on (API keys, your own endpoint, `backend/model`, no subscription) beside an excerpt of Settings → Model connections, and Harness Relay's own sandbox around them |
| 6 | Modes (`#modes`) | Roundtable, Parallel, Relay as animated diagrams in tabs, with a link to the modes section of the docs |
| 7 | Teams (`#teams`) | A team for every question: the lead agent picks it and writes each role for the model its member runs on, reads the answers too (lead review), team checks hold every member to your rules, you design the templates; the five built-in templates. The first three and the checks each link to their section of the docs |
| 8 | You stay in charge (`#control`) | Approvals, questions, diffs, the message tray: two excerpts a row, each its card and its text in two rows of the grid shared with the one beside it (`grid-template-rows: subgrid`), so the two cards are as tall as each other and their texts start on the same line, and a link to the permissions page |
| 9 | Also in every chat (`#more`) | The remaining features as a two-column list, each a few lines at most: two items in a row are about as long (within a line of each other, at every width and in both languages), so a long one sits beside a long one and no row leaves a gap; a feature that needs more says less here, and the lead links the docs that cover the rest |
| 10 | Safety (`#safety`) | Local-only facts (sign-in, the CLIs' own sandboxes, Harness Relay's own sandbox around the open agents) and the permission table, with a link to the sandboxing doc |
| 11 | Quick start (`#start`) | Download the desktop app, connect one assistant, ask the first question. Show the detected system’s installer and first-open instructions. Disclosures hold every installer, agent packages and model backends, and optional phone setup. Keep Codespaces, source and docs links below. |

The header's section links: Use cases (`#use-cases`), Modes, Teams, Safety, Quick start, Docs (`docs/`); on the use-cases page and the docs they lead back to the landing page's sections, Use cases is the use-cases page, and the current one is marked (`aria-current`: the page itself, or `true` for Docs on a docs page other than the overview). The footer also links the docs before the license. The quick start's list is those pages, named as in the docs' menu, then the technical docs that have no page here: open agents, architecture and the developer guide. A link whose topic these pages already cover goes to them; Codespaces, the sandboxes system by system, and running from source stay on GitHub.

### The use-cases page

`use-cases/index.html` and `zh-TW/use-cases/index.html`: twelve kinds of work, from software engineers to localization teams, each a real recording (`npm run use-cases`, [Recording the use cases](../docs/developer-guide.md#recording-the-use-cases)), so the page shows the run first, as the landing page does. The same header and footer as the landing page, its language switch to the other language's use-cases page, and the same `<head>` scripts (the theme, and the language preference, which sends a visitor to the use-cases page in their language).

| # | Section | Purpose |
| --- | --- | --- |
| 1 | Hero (`.uc-hero`) | *Ten kinds of work to hand the team*: what a task assistant is, whatever the reader's work, that each run is real and sped up while the agents work, and a row of links to the ten, named by whose work each is (`.uc-jump`) |
| 2–11 | One per use case (`#fix-a-bug`, `#product-spec`, `#launch-copy`, `#reconcile-accounts`, `#collect-payments`, `#literature-review`, `#write-a-quiz`, `#contract-review`, `#triage-an-alert`, `#design-review`) | Whose work it is (`.usecase-role`, above the name), its name (h2), what it is and why you would hand it over (`.lead`), the agents and how they ran (`.usecase-facts`: their pills, the mode and the permission as chips, as the recording ran, and what else it ran with: lead review, its times, a webhook, the model server), its screen (`.usecase-screen`: the video and its chapter rail, on a dark panel of its own), then what was asked, word for word as typed (`.usecase-ask`), with its links under it (`.usecase-links`: the whole conversation as Harness Relay's Share made it, a secret gist read on the site's own viewer, `share/`, and the files attached to the question as GitHub shows them, kept in `assets/media/use-cases/files/`; never a download), and what it shows, each with its section of the docs (`.usecase-shows`). A use case recorded with stand-in servers, or on a model server of the user's own, says so (`.usecase-note`) |
| 12 | Hand it a task of your own (`.uc-cta`) | The download button for the visitor's system (`downloads.js`), with the link to the landing page's quick start (requirements, the other systems, Codespaces), so the page never ends on a dead end |

Its order is the landing page's list's. Each language's page shows its own recording, as the demo does, so a use case's team, mode and a chapter sentence may differ between the languages; everything else is the same. A use case's words and facts are the recording's: re-record it, and check the lead paragraph, the facts row, the home page's card and the READMEs' line against `review.md`.

### The docs

Keep the Tools page sections `#google-oauth-setup` and `#microsoft-oauth-setup` in both languages, including their headings, linked images and page canonical URL. The Vite plugin in `scripts/oauth-guides.ts` uses these sections for the app’s bundled `/help/oauth/<lang>/<provider>.html` guides and serves edits during development. A missing section or heading fails the build.

`docs/` and `zh-TW/docs/`: how to use Harness Relay, a page per task, for people who use the app rather than work on it. They are the landing page's world at reading scale: the same header and footer, tokens, type and hairlines, the same `<head>` scripts (the theme, and the language preference, which sends a visitor to the page at the same place in their language). Every claim is true of the code, as on the landing page, in plain words: the technical details (each setting's every case, environment variables, files, the sandboxes system by system) stay in the repository's `docs/`, which every page links at its end (`.doc-more`), in the page's language. A link in the page's own text goes to these pages when they cover the topic; `.doc-more` stays on GitHub.

| # | Page | What it covers |
| --- | --- | --- |
| 1 | Overview (`docs/`) | What happens to a question, step by step, with the demo's poster; every page, a line each (`.doc-index`); the app's words (`.doc-terms`) |
| 2 | Install (`install/`) | The download cards (the quick start's, through `downloads.js`), opening it the first time on each system, the window and the menu, what else it needs, updates, uninstalling |
| 3 | Connect your agents (`agents/`) | Settings & sign-in, signing in to each agent, API keys, the open-source agents' model backends, more than one account, models and the lead agent |
| 4 | Your first chat (`first-chat/`) | A link to the full walkthrough in the reader’s language, New chat, asking, the team design card, while they work, their questions and the steps they give you, lead review |
| 5 | Teams and modes (`teams/`) | Auto team, the templates, members, the three modes (`#modes`), team checks (`#checks`), changing the team, writing roles |
| 6 | Permissions and approvals (`permissions/`) | The four levels (`#levels`), what goes beyond them, approval cards, the sandboxes in plain words (the team's protected paths too), the outbox, secrets and fixed commands (`#secrets`), commands you run yourself (`#your-commands`), reviewing and applying changes (checked before a parallel result is applied) |
| 7 | Conversations (`conversations/`) | The list and its badges, groups, pins and search, branching, copying and editing, files, sharing, notifications |
| 8 | Automations (`automations/`) | What starts one, its times and the things it waits for, runs nobody watches (and a fixed command run first), a goal to track, the webhook |
| 9 | Tools (`tools/`) | Harness Relay's browser (and handing it to you), mail and calendar, the outbox, accounts you sign in to, the tool library (MCP servers, skills, memory, long-term memory and the hooks new chats start with), a member's tools, what each agent loads by itself |
| 10 | Use it from your phone (`phone/`) | Sharing it with the phone through Tailscale, signing the phone in, the home screen, notifications, keeping it running, security |
| 11 | Troubleshooting (`troubleshooting/`) | Symptoms and what to try, by topic, where your data is, reporting a problem |

Layout (`.doc-layout`): three columns on a wide screen, the docs' menu (`.doc-nav`: a search field above the pages, the pages in three groups, the current one marked, GitHub's technical docs under them), the page (`.doc-head`: the title and a button that copies the page as Markdown, then `.doc-body`), and its contents (`.doc-toc`, links to each section and its `h3` subheadings, grouped in native disclosures with the current heading marked by `site.js`; the previous automatic branch closes as the reader scrolls, while manually opened branches and the active keyboard control remain visible; Tools follows the groups under Apps and tools), the menu and the contents sticky under the header. The search field stays at the top of the menu while the menu scrolls. On viewports up to 1180px wide and larger tablets with a coarse primary pointer and no hover, search and the button that names the current guide share a sticky row beneath the header. A second sticky row, **On this page**, starts collapsed. It opens the same contents tree in a panel that scrolls within the remaining viewport. Choosing a section closes the panel and moves keyboard focus to the destination below both rows. Escape returns focus to the contents button. The page list opens flush with the search row and covers the entire contents row. Escape restores the row and returns focus to the page selector. Search results and the contents tree close when the reader switches menus. Without JavaScript, all page links and the native contents tree remain in the document. The menu scrolls by itself, so it keeps the current page's highlight inside its padding: it reaches 10px left of the column, so that the links' text lines up with the page. Search reads the pages' HTML in the browser (`assets/docs.js`) and shows the best matching section of each page in that language; the copy button puts the page on the clipboard as Markdown.

A page is one `h1` and its lead, then sections (`<section id>` with an `h2`; `h3` inside), the same section ids in both languages, in the same order. Then the technical docs (`.doc-more`) and the pages before and after (`.doc-pager`, named as in the menu), so a page never ends on a dead end. Its pieces: numbered steps (`.doc-steps`, the quick start's discs), tables (`.doc-table`, the permission table's hairlines; their cells break a long address or command where they must, so a table fits a 280px screen, while a row's name stays whole: a short Chinese one, which could break between any two characters, in `<span class="keep">`), notes (`.doc-note`, neutral, their icon saying what kind: `#i-spark` a tip, `#i-shield` safety, `#i-info` a fact worth knowing), the app's words (`.doc-terms`), and pictures (`.doc-figure`): frames of the use cases' recordings, each language its own, at most two a page, their caption naming the use case and linking it. UI labels are the app's own, in bold, in each language as its locale has them.

To add a page: its two files (one folder deeper than the overview: its paths, its redirect and its language switch), a line in every page's menu, its neighbours' previous and next links, the overview's list, the sitemap, and `DOC_SLUGS` in `test/site-pages.ts`; copy the search field and the copy button with the page (the same words in that language); `test/site-docs.test.ts` checks the rest (the head, the shared icons and menu, the search field and the copy button, the sections and contents, and that every link and picture goes somewhere that is there, GitHub's headings included).

Avoid: icon-plus-heading card grids, eyebrow labels above headings, section numbers, gradient text, stat counters.

### The viewer of shared conversations

`share/index.html` is not one of the site's pages but the viewer a share's link opens (`share/#<owner>/<id>`, with `assets/share.js`): one file for both languages (its words follow the shared page's language, else the browser's), `noindex`, in no sitemap or menu, with no header, footer or JSON-LD. What it shows is the app's page, not the site's: a slim bar (`.share-bar`) in the app's tokens (`src/web/styles.css`: `--bg`, `--border`, `--text`, `--muted` and its font), as the shared page's own foot bar (`.share-brand`) has them, says whose secret gist it is and links to it on GitHub; the shared page fills the rest, in a frame that runs no script. It follows the system's light or dark mode alone, as the shared page does (the site's theme button cannot reach into the frame). While it loads, when the gist cannot be read, and for a gist that is not a page Harness Relay shared (which it never shows), a line in the middle says so, with a link to the website's home page in its language.

## Motion

- **The signature:** each use case’s chapter rail follows its recording. The active chapter is highlighted and a 2px bar fills in the colour of whoever acts; clicking a chapter seeks there. Beside the video the rail is exactly as tall as the video and its chapters scroll inside it, fading out at an edge with more past it; the active chapter is scrolled to the middle of the list as the video plays (not for 4 seconds after the visitor scrolls the list, and a clicked chapter is only brought fully into view). Under the video (920px and narrower) the rail shows every chapter and nothing scrolls by itself.
- **Mode diagrams** act out their mode step by step (0.85s per step, then a pause) only while the section is on screen.
- A video plays muted when it scrolls into view and pauses when it leaves; a visitor's pause is respected. On the use-cases page each video loads only once it plays (`preload="none"`, with its poster).
- Easing `cubic-bezier(0.16, 1, 0.3, 1)`. No entrance animation on sections.
- `prefers-reduced-motion`: no autoplay, diagrams show their final state, transitions are instant, and the chapter list jumps to the active chapter instead of gliding.
- Without JavaScript everything is still readable: all three mode panels show, diagrams show every step.

## Copy and languages

- Voice: plain, specific, second person, short sentences. Name real things (`claude`, `codex app-server`, `127.0.0.1`). No hype words.
- Say *agent*, not *CLI*: "The agents you installed", "one kind of agent is enough", "the twelve agents" (中文「agent」，例如「一種 agent 就能組隊」). *CLI* stays only in a product's name (Codex CLI, Grok CLI, Cursor CLI, Antigravity CLI, GitHub Copilot CLI, GitHub CLI); a program itself is named as code (`claude`, `codex app-server`).
- Use the app's own terms. English: Auto team, Roundtable, Parallel, Relay, Read-only, Edit, Full access, lead agent, Model connections, custom endpoints. 繁體中文: 自動組隊、圓桌、平行、接力、唯讀、可編輯、完全存取、首席 agent、模型連線、自訂端點、開源 agent (see `src/web/locales/zh-TW.ts`).
- English page: `site/index.html`. Chinese page: `site/zh-TW/index.html` (`lang="zh-Hant-TW"`). A change to one is a change to both.
- The meta description is what a search result and an answer engine quote: it starts with the name, says what Harness Relay is, and fits in 160 columns (a Chinese character two). The longer pitch is `og:description`, for link previews. Each page's JSON-LD repeats both, and `site/llms.txt` the page's facts: change them with the copy (`test/site-structured-data.test.ts`).
- The site remembers the visitor's language. Clicking the language switch in the header (`data-lang`) stores the choice in `localStorage` under `harness-relay.lang` (`en` or `zh-TW`). On every later visit the inline script in each page's `<head>` sends the visitor to the page in that language before anything renders, keeping the `#section` anchor. Until they choose, the English page follows the browser like the app does: a browser whose first language is Chinese gets `zh-TW/`; a Chinese page opened directly stays as it is.
- Template names and descriptions come from `src/server/presets.ts`; keep them in sync.
- CLI links: Claude Code https://docs.claude.com/en/docs/claude-code, Codex https://github.com/openai/codex, Grok https://github.com/xai-org/grok-build, Cursor https://cursor.com/cli, Antigravity https://antigravity.google/download, Copilot https://github.com/features/copilot/cli, Muse Code https://dev.meta.ai/products/muse-code/. The open agents link to their packages: OpenCode https://www.npmjs.com/package/opencode-ai, Goose https://formulae.brew.sh/formula/block-goose-cli, Cline https://www.npmjs.com/package/cline, OpenHands https://pypi.org/project/openhands/, Pi https://www.npmjs.com/package/@earendil-works/pi-coding-agent. Keep the tested versions in step with [docs/open-agents.md](../docs/open-agents.md).

## Assets

| File | Source |
| --- | --- |
| `media/demo-en.mp4`, `media/demo-zh-TW.mp4` | Copied from `docs/media/` by the Pages workflow; not stored twice |
| `assets/media/poster-en.webp` | Frame at 0:37.5 of `docs/media/demo-en.mp4` |
| `assets/media/poster-zh-TW.webp` | Frame at 0:31.5 of `docs/media/demo-zh-TW.mp4` |
| `assets/media/og-en.png`, `og-zh-TW.png` | Social preview cards (1200×630) rendered from the page's own styles |
| `assets/media/docs/<page>-<what>-<lang>.webp` | The docs' pictures: frames of the use cases' recordings (`assets/media/use-cases/`), cut with ffmpeg and encoded with `cwebp -q 80`, each frame's origin in a `.webp.json` sidecar |
| `assets/media/docs/publish-<service>-<n>-<what>.webp`, `publish-<service>-relay-<lang>.webp` | The publishing setup guides' steps (`docs/conversations/`, `#render-setup` and `#neon-setup`): screenshots of Render's, Neon's and GitHub's own pages, taken setting up real accounts, shared by both languages since those pages are in English, and of Harness Relay's Settings, one per language. Each crops to its step and outlines the action to take in orange (`#e8590c`); every name, email, avatar (its initial too), account, workspace, organization and project, and every key or token, is blurred before the picture is taken, never after. Each one's origin, and what it blurs, in a `.webp.json` sidecar. The app links those two ids (`src/web/siteDocs.ts`): keep them |
| `assets/media/docs/google-cloud-client-details.png`, `microsoft-entra-desktop-platform.png` | Official [Google Cloud](https://developers.googleblog.com/en/usability-and-safety-updates-to-google-auth-platform/) and [Microsoft Entra](https://learn.microsoft.com/en-us/graph/auth-register-app-v2#configure-platform-settings) console screenshots used in the OAuth setup guides. Both retain their original image data and credit their source in the caption and PNG metadata. |
| `assets/media/use-cases/<case>-<lang>.mp4`, `.webp` | Each use case's recording and its poster, written by `npm run use-cases` (the poster from the frame its use case names, its origin in a `.webp.json` sidecar); the use-cases pages share the landing page's social cards |
| `assets/fonts/bricolage-grotesque-latin.woff2` | Google Fonts, SIL Open Font License (`assets/fonts/OFL.txt`) |
| `favicon.svg` | Same drawing as the app's favicon |
| `sitemap.xml` | The pages for search engines, with their `hreflang` alternates; a new page goes in it, without a `<lastmod>`: the Pages workflow dates each page (developer guide, "Website") |
| `llms.txt` | The app summed up for the coding agents and tools that read [llms.txt](https://llmstxt.org), with links to the docs as Markdown; its facts are the page's (developer guide, "Website", "Answer engines") |
| `google7b263ecdf9adc06e.html` | Google Search Console's verification file, which also keeps the site verified in Bing Webmaster Tools: keep it as it is, never delete it |
| `8de13cb3ba2dccfb84c9d81d70aab5b9.txt` | IndexNow's key, which the Pages workflow names as `INDEXNOW_KEY`: never delete it; a new key renames it, in the same commit (developer guide, "Website", "Search engines") |

The origin of each raster is also embedded in the file (PNG text chunk) or in a `*.webp.json` sidecar next to it.

### When a use case is re-recorded

`npm run use-cases` replaces its videos and posters, re-times its chapter rails and writes its videos' `uploadDate` and `duration` (see [Recording the use cases](../docs/developer-guide.md#recording-the-use-cases)). The rest is by hand, in both languages: its lead paragraph and facts row on the use-cases page, its card on the landing page, and its line in both READMEs, against what `data/use-cases/<case>/<lang>/review.md` says the agents did; the chapter sentences are in `scripts/demo/use-cases/cases.ts`.

### When the demo is re-recorded

The READMEs and the first-chat guides link the full recording in each language. `npm run demo` refreshes the media and writes chapter notes to `data/demo/<lang>/review.md` for checking the recording. See [Recording the demo](../docs/developer-guide.md#recording-the-demo).

1. Replace the videos in `docs/media/`.
2. Re-cut both posters from a frame that shows the three agents (the team design card works well), and the two screenshots from the same frames: `docs/media/screenshot-en.png` and `docs/media/screenshot-zh-TW.png`, full-size PNGs with their origin in a PNG text chunk. The org's homepage (https://agentic-system-lab.github.io/) and its GitHub profile show them from `main`, so they change there as soon as you push.
3. Update the social cards and the poster frame times in this guide.

## Accessibility

- Skip link, landmarks, one `h1` per page, headings in order.
- Visible focus ring (2px, Grok ink) on every interactive element.
- Mode tabs follow the tabs pattern (arrow keys, Home, End). Diagrams have a text alternative.
- Decorative avatars and discs are hidden from assistive technology; the names next to them carry the meaning.
- The mark's links, in the header and the footer, have the name as their label (`aria-label`, "Harness Relay, home" / "Harness Relay 首頁"): at 500px and below the name is hidden in both (`test/site-header.test.ts`).
- Check both colour schemes and widths from 360px to 1600px after a change: the system's light and dark modes, and each theme chosen with the theme button against the other system mode.

## Previewing locally

```bash
npm run site:preview   # http://127.0.0.1:4180/ and /zh-TW/, the docs at /docs/ (SITE_PORT changes the port)
```

[`scripts/preview-site.ts`](../scripts/preview-site.ts) serves `site/` the way GitHub Pages will (the use-cases pages at `/use-cases/` and `/zh-TW/use-cases/`): the demo videos come from `docs/media/` under `/media/`, and Markdown files and `*.webp.json` sidecars are not served. To see the first-visit language redirect again, remove the `harness-relay.lang` key from the browser's local storage; to have the page follow the system's light or dark mode again, remove `harness-relay.theme` (or press the theme button until it shows the system's theme).
