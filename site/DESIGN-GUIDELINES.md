# Landing page design guidelines

How the Harness Relay landing page (`site/`) looks, reads and behaves, and what to keep when you change it. The page is published to GitHub Pages by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml); this file stays in the repository and is never served (the workflow drops every `*.md` file and the `*.webp.json` provenance sidecars).

## Goal

- **Reader:** a developer who already uses one or more of the Claude Code, Codex, Grok, Cursor, Antigravity, Copilot and Muse Code CLIs, or an open-source coding agent (OpenCode, Goose, Cline, OpenHands, Pi) on their own API keys or model.
- **Job of the page:** within a minute, show that the coding agents the reader already has (any mix of the twelve, and one is enough) work in one chat, as three real CLIs do in the demo (Claude Code, Codex and Grok), then get the reader to download the desktop app for their system, try it in a GitHub codespace of their own (nothing to install: `.devcontainer/`, [docs/codespaces.md](../docs/codespaces.md)), or open the repository. There are no commands to start it: running from source (`npm start`, and `npm run dev` for people working on Harness Relay itself) is one line at the end of the quick start, for servers without a desktop, linking to the README.
- **Primary action:** the download button in the hero, named after the visitor's system ("Download for macOS"), with the link to the requirements and the other systems beside it; the Codespaces button (secondary, *Try it in Codespaces*, to `codespaces.new/…/tree/latest-release?quickstart=1`, the newest release, which opens the Codespaces dialog first) and the GitHub button sit under them, the GitHub button last. The buttons' column takes only the width they need, and the lead sentence the rest (up to its 38em), so that it reads in a few long lines. The hero is as wide as the header: the headline fills the width (`text-wrap: pretty`, not balanced shorter), and the buttons end at the right edge, under the header's GitHub button (on one column, 920px and narrower, they start at the left). The page ends on the quick start, never on a dead end.

## Principles

1. **Show the run, don't describe it.** The first viewport is the real demo recording with a chapter rail. Every section after it shows the mechanism (mode diagrams, the app's own UI) before it explains it.
2. **The app's world, at poster scale.** The page is recognisably the same product as the app: same neutrals, same agent colours, same three-dot mark, same avatars and pills. It is bolder in scale, not in new decoration.
3. **Colour means an agent.** Claude Code orange, Codex green and Grok violet appear only where that agent acts or is named. Never use them for generic accents, links or section themes. The one other colour is the GitHub star's yellow, only on that star. Cursor, Antigravity, Copilot, Muse Code and the five open-source agents have their colours from the app (Settings shows them the same), but only on the dot before their name in their list ("The agents you installed" and "Open-source agents"); their names and everything else about them stay plain: the demo does not show them. So the mark keeps the demo's three. The headline names no agent: it says the reader's own agents, in any mix, work together, so that it never reads as a list of CLIs (and subscriptions) the reader needs. Its one colour is the bar under "coding agent(s)", split in the three (`.team-mark`), as when all three act together; the words themselves stay ink; the lead sentence under it names all twelve, plainly, and says one kind of agent is enough.
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
| `--band` | `#111113` | `#0a0a0b` | The screening band around the demo |

Agent colours, each in four strengths:

| Agent | Brand (fills, large text) | `-ink` (text on page bg) | `-lit` (text on the band) | `-deep` (avatar fill, white initial) |
| --- | --- | --- | --- | --- |
| Claude Code | `#d97757` | `#b2502c` / dark `#e8906f` | `#e8906f` | `#b2502c` |
| Codex | `#10a37f` | `#0b7a5f` / dark `#34c79d` | `#34c79d` | `#0b7a5f` |
| Grok | `#7c5cff` | `#6440f0` / dark `#a593ff` | `#a593ff` | `#6440f0` |

The other nine take only their brand colour, the same in both themes as in the app (`src/web/styles.css`), for the dot in their list:

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
- Set the agent with a helper class: `.t-claude`, `.t-codex` or `.t-grok` define `--agent`, `--agent-ink`, `--agent-lit` and `--agent-deep` for everything inside. `.t-cursor`, `.t-antigravity`, `.t-copilot`, `.t-muse`, `.t-opencode`, `.t-goose`, `.t-cline`, `.t-openhands` and `.t-pi` define `--agent` only, for their list's dot; keep them changed with the app's colours.
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
- Container: max 1200px, side gutter `clamp(16px, 4vw, 32px)` (12px at 360px and below).
- **No page scrolls sideways**, at any width from 280px (the narrowest phones', folded), in both languages, with the Codespaces dialog open or not (`test/site-header.test.ts`; check every width in Chromium after a change to the layout). At 480px and below a long command or package name in the text (`@earendil-works/pi-coding-agent`) breaks where it must, and the approval card's buttons wrap; at 380px and below the headline scales with the screen (`min(2.6rem, 11.4vw)`), so that the phrases it keeps whole (`.phrase`) fit; at 360px and below the header's controls draw closer (and again at 300px). Something wider than the screen wraps or shrinks; it never widens the page.
- Section rhythm: `clamp(72px, 9vw, 132px)` top and bottom, the screening band around the demo included, a hairline between sections, more space above a heading than below it.
- Shadows always have a vertical offset and a soft blur (`--shadow`). No glow, no hard offset shadows, no glass.

### Components

- **Mark:** the three circles from the favicon (`#i-mark` symbol), same geometry as `src/web/components/Logo.tsx`. At page scale it becomes the three agent discs in "The agents you installed, as they are": the app's mark and the demo's three, not a count of the CLIs (the list beside it names Cursor, Antigravity, Copilot and Muse Code too).
- **Avatar** (`.av`): the member's initial on a `-deep` fill, like the app. Initials match the template or demo member names.
- **Pill** (`.pill`): the app's CLI badge, tinted agent colour with `-ink` text. **Chip** (`.chip`): neutral outline for mode, permission and round labels.
- **Buttons:** primary is ink on light (`.btn-primary`), secondary is outlined (`.btn-ghost`). One primary per view: in the hero, the download button.
- **Downloads** (`assets/downloads.js`, a module whose functions `test/site-downloads.test.ts` tests): every download link points at the releases page in the HTML, so the page works without JavaScript. The module reads GitHub's list of releases (kept in `localStorage` under `harness-relay.release` for ten minutes, like the stars), points each `[data-download]` link at its installer (`-mac-arm64.dmg`, `-win-x64.exe`, `-win-arm64.exe`, `-linux-x86_64.AppImage`, `-linux-arm64.AppImage`, as the Release workflow names them) in the newest release (never a release candidate: a kept one from an earlier visit is not shown, and GitHub is asked again), fills in the version line (`data-release` before the version), names the visitor's system on the hero's button (`data-mac`, `data-win`, `data-win-arm64`, `data-linux`, `data-linux-arm64` on `[data-downloads]` hold the words) and marks their card *Your system*. The Mac app is for Apple Silicon only: a Mac counts as one with Apple Silicon unless Chromium's hints say Intel, and then as another system (Safari and Firefox say "Intel" on every Mac). Windows and Linux have a card per processor; the processor comes from Chromium's high-entropy hints (`getHighEntropyValues`), else the user agent or `navigator.platform` (Chromium says x64 in its user agent on any Windows and Linux), else x64; a system the newest release has no installer for gets the releases page, as any other. On a phone the hero's button goes to the quick start, with a line saying Harness Relay runs on a computer. With no release found, nothing changes: the links keep the releases page. When `MIRROR` names the download mirror (`mirror/worker.ts`, for visitors GitHub is slow for; [developer guide](../docs/developer-guide.md#releasing), "The download mirror"), the installers' links go there instead, once the mirror answers a `HEAD` that it has the visitor's installer (else the first one the release has); until then, and whenever it does not, they stay on GitHub. The page counts nothing itself: the mirror has GitHub count each download it serves.
- **Download cards** (`.dl`): one row per system and processor in the quick start (macOS; Windows and Windows on Arm; Linux and Linux on Arm), with the system's icon, name, processor and file type (no size), and the download icon; the visitor's has a firmer outline and the *Your system* label on its edge.
- **Theme button** (`.theme-toggle`, [`assets/theme.js`](assets/theme.js), a module whose functions `test/site-theme.test.ts` tests): the last thing in the header, after the GitHub button, and only there. A round outlined button with one icon: the moon in the light theme, the sun in the dark one, for the theme a press gives; its label says the same (`data-to-dark`, `data-to-light`: "Switch to dark theme" / "切換成深色主題"). Until the visitor presses it the page follows the system's light or dark mode. A press switches to the other theme and keeps it in `localStorage` under `harness-relay.theme` (`light` or `dark`), for both languages; pressing it again for the theme the system has removes the key, and the page follows the system again. The inline script in each page's `<head>` sets `data-theme` on `<html>` from the key before anything renders, so a chosen theme does not flash. The browser's bar colour (`theme-color`) follows, and the other tabs too. Every colour changes at once (no button fades during the switch). Without JavaScript the button is not shown.
- **Star count** (`.stars`): the GitHub buttons in the header and the hero end in the repository's star count after a hairline, with the `#i-star` icon filled yellow (`--star`, with a darker `--star-edge` on a light button; the primary button uses the `--star-inverse` pair), and screen readers hear "12 stars" / "12 顆星". `site.js` reads it from `api.github.com` as the page loads, shortens it like GitHub does in the page's language (English `999`, `1.2K`, `12.3K`, `123K`, `1.2M`; 中文 `999`, `1,234`, `1.2萬`, `12.3萬`, `123萬`) and keeps it in `localStorage` under `harness-relay.stars` for ten minutes (the API allows a visitor 60 requests an hour). When GitHub can't be reached the last count shows; with none, or without JavaScript, the buttons show no count. On phones the header button drops the word "GitHub" and keeps the count.
- **Codespaces dialog** (`.cs-dialog`, a native `<dialog>` that `site.js` opens with `showModal()`; `test/site-codespaces.test.ts`): the hero's Codespaces button and the quick start's Codespaces link (`data-codespaces`) open it before GitHub's page, so the visitor knows what a codespace is and is not first: whose account it runs on and what it costs, that an agent still has to be signed in, what works differently there, who can open it, that it runs the newest release and is counted once (and how to leave it uncounted), and where Harness Relay's link shows, with the codespace's terminal recreated with the sample lines `start.sh` and the server print (`.cs-term`, said so under it like the other UI excerpts) and the link to click underlined beside a neutral ⌘ / Ctrl-click chip. Its one primary button, *Create my codespace*, opens `codespaces.new` on the `latest-release` branch in a new tab, so the directions stay on screen; the full guide is a text link. The two stay at the dialog's bottom on a bar of their own (sticky, the dialog's background, a hairline above), so they are in reach without scrolling, also on a phone, where the rest scrolls under them. They stay on one line down to a 280px screen, in both languages: at 440px and below the dialog takes the width but 8px each side (past the browser's own limit for a modal dialog) and the bar's gaps narrow, at 400px and below the button drops its icon and both go to 14px, at 350px and below to 13px, at 320px and below to 12px with the dialog 4px from each side, at 295px and below with less padding. Only where a phone's fonts are wider still does the bar wrap, rather than make the dialog scroll sideways. Esc, the close button and a click on the backdrop close it; the page behind does not scroll while it is open. A click with a modifier key goes straight to GitHub, and without JavaScript (or `showModal`) both links do. It fits at 390px with every command wrapping inside it.
- **Quick start step:** a step with more than one block (the download cards, text) wraps them in `.step-body`, so they stay together in the right-hand column.
- **Command block** (`.cmd`, not on the page now): `$` prompts are not copied; the copy button copies the commands only and confirms with a check. One command per line, never joined with `&&`: Windows PowerShell 5.1, still the default shell on Windows, rejects `&&`, while separate lines run in every shell.
- **UI excerpts** (`.ui`): approval card, question, changed files, waiting message tray, and Settings → Model backends (`.ui-backends`, from `src/web/components/BackendsSettings.tsx`). They recreate the app's components with sample content, and the page says so under them. Keep them faithful to the app when the app changes.
- **Icons:** drawn inline SVG symbols in one 1.8px stroke. No emoji or Unicode glyphs as icons, and no company logos: the systems are a command key (macOS), a four-pane window (Windows) and a penguin (Linux), and GitHub Codespaces is a cloud (`#i-cloud`). The GitHub button keeps GitHub's mark.

## Page structure

| # | Section | Purpose |
| --- | --- | --- |
| 1 | Header | Mark, section links, EN / 中文 switch, GitHub with the star count, the theme button. Each stays on one line at any width (`test/site-header.test.ts`): the switch is never squeezed, so 中文 never breaks between its characters, and at 500px and below the mark shows without its name, which does not fit beside the rest under some 481px (the link keeps the name as its label) |
| 2 | Hero | Headline about the reader's own agents in any mix (no agent names, so it never reads as a list to have), a lead that names the twelve, says one kind of agent is enough and that the lead agent designs the team for each question with each model's own traits in mind, the download button for the visitor's system with the link to the requirements beside it, the Codespaces button, GitHub button with the star count |
| 3 | Screening (`#demo`) | Demo video and the chapter rail on the dark band |
| 4 | The agents you installed (`#agents`) | How each signed-in CLI is driven (Claude Code, Codex, Grok, then Cursor, Antigravity, Copilot and Muse Code, with their colours on their dots only); the mark at page scale |
| 5 | Open agents (`#open`) | The five open-source CLIs and how each is driven, the model backends they run on (API keys, your own endpoint, `backend/model`, no subscription) beside an excerpt of Settings → Model backends, and Harness Relay's own sandbox around them |
| 6 | Modes (`#modes`) | Roundtable, Parallel, Relay as animated diagrams in tabs |
| 7 | Teams (`#teams`) | A team for every question: the lead agent picks it and writes each role for the model its member runs on, you design the templates; the five built-in templates |
| 8 | You stay in charge (`#control`) | Approvals, questions, diffs, the message tray |
| 9 | Also in every chat (`#more`) | The remaining features as a two-column list |
| 10 | Safety (`#safety`) | Local-only facts (sign-in, the CLIs' own sandboxes, Harness Relay's own sandbox around the open agents) and the permission table, with a link to the sandboxing doc |
| 11 | Quick start (`#start`) | One row per step (title left, content right): requirements (the CLIs, the open-source ones with the versions tested), the three installers with the newest version and how to open them the first time, first steps, then (optional) opening it on a phone with the app's *Share with your phone*; then trying it in GitHub Codespaces and running from source, in one paragraph, and links to the docs |

Avoid: icon-plus-heading card grids, eyebrow labels above headings, section numbers, gradient text, stat counters.

## Motion

- **The signature:** the chapter rail follows the video. The active chapter is highlighted and a 2px bar fills in the colour of whoever acts; clicking a chapter seeks there. Beside the video the rail is exactly as tall as the video and its chapters scroll inside it, fading out at an edge with more past it; the active chapter is scrolled to the middle of the list as the video plays (not for 4 seconds after the visitor scrolls the list, and a clicked chapter is only brought fully into view). Under the video (920px and narrower) the rail shows every chapter and nothing scrolls by itself.
- **Mode diagrams** act out their mode step by step (0.85s per step, then a pause) only while the section is on screen.
- The video plays muted when it scrolls into view and pauses when it leaves; a visitor's pause is respected.
- Easing `cubic-bezier(0.16, 1, 0.3, 1)`. No entrance animation on sections.
- `prefers-reduced-motion`: no autoplay, diagrams show their final state, transitions are instant, and the chapter list jumps to the active chapter instead of gliding.
- Without JavaScript everything is still readable: all three mode panels show, diagrams show every step.

## Copy and languages

- Voice: plain, specific, second person, short sentences. Name real things (`claude`, `codex app-server`, `127.0.0.1`). No hype words.
- Say *agent*, not *CLI*: "The agents you installed", "one kind of agent is enough", "the twelve agents" (中文「agent」，例如「一種 agent 就能組隊」). *CLI* stays only in a product's name (Codex CLI, Grok CLI, Cursor CLI, Antigravity CLI, GitHub Copilot CLI, GitHub CLI); a program itself is named as code (`claude`, `codex app-server`).
- Use the app's own terms. English: Auto team, Roundtable, Parallel, Relay, Read-only, Edit, Full access, lead agent, model backends, custom endpoints. 繁體中文: 自動組隊、圓桌、平行、接力、唯讀、可編輯、完全存取、首席 agent、模型來源、自訂端點、開源 agent (see `src/web/locales/zh-TW.ts`).
- English page: `site/index.html`. Chinese page: `site/zh-TW/index.html` (`lang="zh-Hant-TW"`). A change to one is a change to both.
- The site remembers the visitor's language. Clicking the language switch in the header (`data-lang`) stores the choice in `localStorage` under `harness-relay.lang` (`en` or `zh-TW`). On every later visit the inline script in each page's `<head>` sends the visitor to the page in that language before anything renders, keeping the `#section` anchor. Until they choose, the English page follows the browser like the app does: a browser whose first language is Chinese gets `zh-TW/`; a Chinese page opened directly stays as it is.
- Template names and descriptions come from `src/server/presets.ts`; keep them in sync.
- CLI links: Claude Code https://docs.claude.com/en/docs/claude-code, Codex https://github.com/openai/codex, Grok https://github.com/xai-org/grok-build, Cursor https://cursor.com/cli, Antigravity https://antigravity.google/download, Copilot https://github.com/features/copilot/cli, Muse Code https://dev.meta.ai/products/muse-code/. The open agents link to their packages: OpenCode https://www.npmjs.com/package/opencode-ai, Goose https://formulae.brew.sh/formula/block-goose-cli, Cline https://www.npmjs.com/package/cline, OpenHands https://pypi.org/project/openhands/, Pi https://www.npmjs.com/package/@earendil-works/pi-coding-agent. Keep the tested versions in step with [docs/open-agents.md](../docs/open-agents.md).

## Assets

| File | Source |
| --- | --- |
| `media/demo-en.mp4`, `media/demo-zh-TW.mp4` | Copied from `docs/media/` by the Pages workflow; not stored twice |
| `assets/media/poster-en.webp` | Frame at 0:28.5 of `docs/media/demo-en.mp4` |
| `assets/media/poster-zh-TW.webp` | Frame at 0:24.3 of `docs/media/demo-zh-TW.mp4` |
| `assets/media/og-en.png`, `og-zh-TW.png` | Social preview cards (1200×630) rendered from the page's own styles |
| `assets/fonts/bricolage-grotesque-latin.woff2` | Google Fonts, SIL Open Font License (`assets/fonts/OFL.txt`) |
| `favicon.svg` | Same drawing as the app's favicon |
| `sitemap.xml` | The pages for search engines, with their `hreflang` alternates; a new page goes in it (developer guide, "Website") |
| `google7b263ecdf9adc06e.html` | Google Search Console's verification file: keep it as it is, never delete it |

The origin of each raster is also embedded in the file (PNG text chunk) or in a `*.webp.json` sidecar next to it.

### When the demo is re-recorded

`npm run demo` records the demo again and does all four steps below for both pages (see [Recording the demo](../docs/developer-guide.md#recording-the-demo)). Afterwards, check the chapter sentences against `data/demo/<lang>/review.md`, which lists what the agents did; the sentences are in `scripts/demo/chapters.ts`.

1. Replace the videos in `docs/media/`.
2. Re-cut both posters from a frame that shows the three agents (the team design card works well), and the two screenshots from the same frames: `docs/media/screenshot-en.png` and `docs/media/screenshot-zh-TW.png`, full-size PNGs with their origin in a PNG text chunk. The org's homepage (https://agentic-system-lab.github.io/) and its GitHub profile show them from `main`, so they change there as soon as you push.
3. Re-time the chapters: each chapter's `data-t` (seconds) and its `<time>` label, in both pages. The English and Chinese recordings have different timings and different teams.
4. Update the member initials and names in the chapter rail if the team changed.

## Accessibility

- Skip link, landmarks, one `h1` per page, headings in order.
- Visible focus ring (2px, Grok ink) on every interactive element.
- Mode tabs follow the tabs pattern (arrow keys, Home, End). Diagrams have a text alternative.
- Decorative avatars and discs are hidden from assistive technology; the names next to them carry the meaning.
- Check both colour schemes and widths from 360px to 1600px after a change: the system's light and dark modes, and each theme chosen with the theme button against the other system mode.

## Previewing locally

```bash
npm run site:preview   # http://127.0.0.1:4180/ and /zh-TW/ (SITE_PORT changes the port)
```

[`scripts/preview-site.ts`](../scripts/preview-site.ts) serves `site/` the way GitHub Pages will: the demo videos come from `docs/media/` under `/media/`, and Markdown files and `*.webp.json` sidecars are not served. To see the first-visit language redirect again, remove the `harness-relay.lang` key from the browser's local storage; to have the page follow the system's light or dark mode again, remove `harness-relay.theme` (or press the theme button until it shows the system's theme).
