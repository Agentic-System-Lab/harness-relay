# Landing page design guidelines

How the Harness Relay landing page (`site/`) looks, reads and behaves, and what to keep when you change it. The page is published to GitHub Pages by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml); this file stays in the repository and is never served (the workflow drops every `*.md` file and the `*.webp.json` provenance sidecars).

## Goal

- **Reader:** a developer who already uses one or more of the Claude Code, Codex and Grok CLIs.
- **Job of the page:** within a minute, show three real CLIs working in one chat, then get the reader to clone and run it (`npm install && npm run dev`) or open the repository.
- **Primary action:** the copyable clone-and-run command and the GitHub button in the hero. The page ends on the quick start, never on a dead end.

## Principles

1. **Show the run, don't describe it.** The first viewport is the real demo recording with a chapter rail. Every section after it shows the mechanism (mode diagrams, the app's own UI) before it explains it.
2. **The app's world, at poster scale.** The page is recognisably the same product as the app: same neutrals, same agent colours, same three-dot mark, same avatars and pills. It is bolder in scale, not in new decoration.
3. **Colour means an agent.** Claude Code orange, Codex green and Grok violet appear only where that agent acts or is named. Never use them for generic accents, links or section themes.
4. **Facts only.** Every claim must be true of the code in this repository. There are no testimonials, user counts, star counts or benchmarks; do not add any.
5. **Two languages, equal.** English and 繁體中文 pages have the same sections, order and facts.

## Visual system

### Colour

Tokens live at the top of [`assets/site.css`](assets/site.css) and follow the app (`src/web/styles.css`). The page follows the visitor's light/dark setting, like the app.

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

Rules:

- Brand colours as text only at large sizes (the agent names in the headline, 3:1 or better). Small coloured text uses `-ink` on the page and `-lit` on the band.
- On the big discs, Claude Code and Codex take dark text (`#18181b`); Grok takes white, and only at large bold sizes.
- Set the agent with a helper class: `.t-claude`, `.t-codex` or `.t-grok` define `--agent`, `--agent-ink`, `--agent-lit` and `--agent-deep` for everything inside.
- When all three act together (`.t-team`), show all three: stacked avatars, and a progress bar split in three.
- Body text meets 4.5:1, large text 3:1. Check new pairs before shipping.

### Type

| Role | Face | Size | Notes |
| --- | --- | --- | --- |
| Display (h1, h2, h3, brand) | Bricolage Grotesque, self-hosted (`assets/fonts/`, OFL) | h1 `clamp(2.6rem … 5.25rem)`, h2 `clamp(2rem … 3.4rem)` | Weight 700, slightly condensed (`font-stretch` 92–94%), tracking −0.03 to −0.035em, `text-wrap: balance` |
| Body | System UI stack (same as the app) | 16px / 1.6 | Lead paragraphs 17–19.5px in `--muted` |
| Chinese | PingFang TC, then Noto Sans TC, then Microsoft JhengHei | | Headings get looser tracking (−0.01em) and line height (1.12–1.16) under `:lang(zh)` |
| Code | System monospace stack | 13.5px in blocks | Only for real commands, file names and protocol names, never as decoration |

The font file only covers Latin; Chinese always comes from the system stack.

### Shape, space and depth

- Radius: 14px for UI excerpts (the app's `--radius`), 12px for command blocks and the video, 20–22px for large panels, full pills for buttons, tabs and chips.
- Container: max 1200px, side gutter `clamp(16px, 4vw, 32px)`.
- Section rhythm: `clamp(72px, 9vw, 132px)` top and bottom, a hairline between sections, more space above a heading than below it.
- Shadows always have a vertical offset and a soft blur (`--shadow`). No glow, no hard offset shadows, no glass.

### Components

- **Mark:** the three circles from the favicon (`#i-mark` symbol), same geometry as `src/web/components/Logo.tsx`. At page scale it becomes the three agent discs in "Your CLIs, not imitations".
- **Avatar** (`.av`): the member's initial on a `-deep` fill, like the app. Initials match the template or demo member names.
- **Pill** (`.pill`): the app's CLI badge, tinted agent colour with `-ink` text. **Chip** (`.chip`): neutral outline for mode, permission and round labels.
- **Buttons:** primary is ink on light (`.btn-primary`), secondary is outlined (`.btn-ghost`). One primary per view.
- **Command block** (`.cmd`): `$` prompts are not copied; the copy button copies the commands only and confirms with a check.
- **UI excerpts** (`.ui`): approval card, question, changed files, waiting message tray. They recreate the app's components with sample content, and the page says so under them. Keep them faithful to the app when the app changes.
- **Icons:** drawn inline SVG symbols in one 1.8px stroke. No emoji or Unicode glyphs as icons.

## Page structure

| # | Section | Purpose |
| --- | --- | --- |
| 1 | Header | Mark, section links, EN / 中文 switch, GitHub |
| 2 | Hero | Headline with the three agent names in their colours, one sentence, clone-and-run command, GitHub button |
| 3 | Screening (`#demo`) | Demo video and the chapter rail on the dark band |
| 4 | Your CLIs (`#agents`) | How each CLI is driven; the mark at page scale |
| 5 | Modes (`#modes`) | Roundtable, Parallel, Relay as animated diagrams in tabs |
| 6 | Teams (`#teams`) | Design your own vs Auto team; the five built-in templates |
| 7 | You stay in charge (`#control`) | Approvals, questions, diffs, the message tray |
| 8 | Also in every chat (`#more`) | The remaining features as a two-column list |
| 9 | Safety (`#safety`) | Local-only facts and the permission table |
| 10 | Quick start (`#start`) | One row per step (title left, content right): requirements, commands, first steps; then links to the docs |

Avoid: icon-plus-heading card grids, eyebrow labels above headings, section numbers, gradient text, stat counters.

## Motion

- **The signature:** the chapter rail follows the video. The active chapter is highlighted and a 2px bar fills in the colour of whoever acts; clicking a chapter seeks there.
- **Mode diagrams** act out their mode step by step (0.85s per step, then a pause) only while the section is on screen.
- The video plays muted when it scrolls into view and pauses when it leaves; a visitor's pause is respected.
- Easing `cubic-bezier(0.16, 1, 0.3, 1)`. No entrance animation on sections.
- `prefers-reduced-motion`: no autoplay, diagrams show their final state, transitions are instant.
- Without JavaScript everything is still readable: all three mode panels show, diagrams show every step.

## Copy and languages

- Voice: plain, specific, second person, short sentences. Name real things (`claude`, `codex app-server`, `127.0.0.1`). No hype words.
- Use the app's own terms. English: Auto team, Roundtable, Parallel, Relay, Read-only, Edit, Full access, lead agent. 繁體中文: 自動組隊、圓桌、平行、接力、唯讀、可編輯、完全存取、首席 agent (see `src/web/locales/zh-TW.ts`).
- English page: `site/index.html`. Chinese page: `site/zh-TW/index.html` (`lang="zh-Hant-TW"`). A change to one is a change to both.
- The site remembers the visitor's language. Clicking the language switch (header or footer, `data-lang`) stores the choice in `localStorage` under `harness-relay.lang` (`en` or `zh-TW`). On every later visit the inline script in each page's `<head>` sends the visitor to the page in that language before anything renders, keeping the `#section` anchor. Until they choose, the English page follows the browser like the app does: a browser whose first language is Chinese gets `zh-TW/`; a Chinese page opened directly stays as it is.
- Template names and descriptions come from `src/server/presets.ts`; keep them in sync.
- CLI links: Claude Code https://docs.claude.com/en/docs/claude-code, Codex https://github.com/openai/codex, Grok https://github.com/xai-org/grok-build.

## Assets

| File | Source |
| --- | --- |
| `media/demo-en.mp4`, `media/demo-zh-TW.mp4` | Copied from `docs/media/` by the Pages workflow; not stored twice |
| `assets/media/poster-en.webp` | Frame at 0:19.5 of `docs/media/demo-en.mp4` |
| `assets/media/poster-zh-TW.webp` | Frame at 0:17.5 of `docs/media/demo-zh-TW.mp4` |
| `assets/media/og-en.png`, `og-zh-TW.png` | Social preview cards (1200×630) rendered from the page's own styles |
| `assets/fonts/bricolage-grotesque-latin.woff2` | Google Fonts, SIL Open Font License (`assets/fonts/OFL.txt`) |
| `favicon.svg` | Same drawing as the app's favicon |

The origin of each raster is also embedded in the file (PNG text chunk) or in a `*.webp.json` sidecar next to it.

### When the demo is re-recorded

1. Replace the videos in `docs/media/`.
2. Re-cut both posters from a frame that shows the three agents (the team design card works well), and the two screenshots from the same frames: `docs/media/screenshot-en.png` and `docs/media/screenshot-zh-TW.png`, full-size PNGs with their origin in a PNG text chunk. The org's homepage (https://agentic-system-lab.github.io/) and its GitHub profile show them from `main`, so they change there as soon as you push.
3. Re-time the chapters: each chapter's `data-t` (seconds) and its `<time>` label, in both pages. The English and Chinese recordings have different timings and different teams.
4. Update the member initials and names in the chapter rail if the team changed.

## Accessibility

- Skip link, landmarks, one `h1` per page, headings in order.
- Visible focus ring (2px, Grok ink) on every interactive element.
- Mode tabs follow the tabs pattern (arrow keys, Home, End). Diagrams have a text alternative.
- Decorative avatars and discs are hidden from assistive technology; the names next to them carry the meaning.
- Check both colour schemes and widths from 360px to 1600px after a change.

## Previewing locally

```bash
npm run site:preview   # http://127.0.0.1:4180/ and /zh-TW/ (SITE_PORT changes the port)
```

[`scripts/preview-site.ts`](../scripts/preview-site.ts) serves `site/` the way GitHub Pages will: the demo videos come from `docs/media/` under `/media/`, and Markdown files and `*.webp.json` sidecars are not served. To see the first-visit language redirect again, remove the `harness-relay.lang` key from the browser's local storage.
