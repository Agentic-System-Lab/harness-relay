**English** | [繁體中文](CONTRIBUTING.zh-TW.md)

# Contributing to Harness Relay

Thanks for helping. Bug reports, ideas, fixes, documentation and translations are all welcome. This page explains how to report a problem, how to set up the project, and what a change needs before it can be merged.

For how the code works, read [Architecture](docs/architecture.md) and the [developer guide](docs/developer-guide.md). Coding agents follow [AGENTS.md](AGENTS.md), which states the same rules in short form.

## Reporting a bug

Open an issue and include:

- what you did, what you expected and what happened instead;
- your operating system, Node.js version (`node --version`) and Harness Relay commit (`git rev-parse --short HEAD`);
- the agent CLIs involved and their versions (`claude --version`, `codex --version`, `grok --version`);
- the conversation's mode (roundtable, parallel or relay), permission (read-only, edit or full access), and whether the lead agent's team is used without asking;
- the error shown on the message (it includes the end of the CLI's stderr) and the `[server]` lines from the `npm run dev` output around that time.

Before you paste logs or screenshots, remove API keys, tokens and anything from your projects you don't want public. Don't attach `data/relay.db`: it holds your conversations and, on a system without an OS credential store, your API keys.

## Reporting a security problem

The server can start agents with write access to your files, so security problems matter. Please don't post the details in a public issue. Open an issue that only says you have a security report, and a maintainer will arrange a private way to send it. [Architecture → Security](docs/architecture.md#security) describes the defences already in place.

## Suggesting a feature

Open an issue that describes the problem you want solved before you describe a solution. For anything larger than a small fix (a new mode, a new agent CLI, a schema change, a new setting), please discuss it in an issue before you write the code, so that the work fits the design.

## Setting up

You need Node.js **22.13 or later**. The agent CLIs (`claude`, `codex`, `grok`) are only needed to try the app by hand; the tests never run them.

```bash
git clone https://github.com/Agentic-System-Lab/harness-relay.git
cd harness-relay
npm install
npm run dev        # API on :8789 (restarts on changes) + UI on http://localhost:5173
```

Working on the desktop app (`desktop/`)? Run `npm install --prefix desktop` once, then `npm run desktop` to build it and run it; the [developer guide](docs/developer-guide.md#the-desktop-app) explains how it works.

`npm run dev` restarts the server whenever a server file changes, and a restart aborts any agent turn that is running. Runtime data goes to `data/` (git-ignored); set `RELAY_DATA_DIR` to keep a test setup apart from your own conversations. The [developer guide](docs/developer-guide.md#running) lists the other environment variables. Harness Relay refuses edit mode in a working directory that holds itself, so to work on this repository with Harness Relay, run the copy you use from another checkout.

## Making a change

Fork the repository (or create a branch if you have write access), branch off `main`, and keep each pull request to one change. The rules below are the ones reviews check most often.

### Code

- Strict TypeScript with ES modules. Shared types live only in `src/shared/types.ts`.
- Start child processes only through `src/server/process.ts`, so they are tracked and stopped on shutdown. Start programs directly, never through a shell; a shell script (`runShellScript()`, or `sh -c` given to `spawnDetached()`) is fixed text, and the values it needs (paths, names, settings) go in its environment, never in its text or its arguments.
- Keep CLI output parsers pure (lines in, `AgentEvent`s out) so they can be tested with recorded output.
- Tests run in Node without a DOM. Put client logic you want to test in plain modules (like `src/web/chat.ts`), not inside components.
- In the desktop app, only `desktop/src/main.ts` imports `electron`. Put the rest in modules without it (like `desktop/src/lifecycle.ts`), which the root `test/` tests like the other code.
- `node:sqlite` cannot bind `undefined`: pass optional values through `nul()`, and wrap writes of several statements in `transaction(db, fn)`.

### Security

- New routes go under `/api/`, so they get the Host/Origin checks, the JSON content-type check on writes, sign-in and the request language. Don't weaken these checks. Only a read-only route the browser loads by itself (an image, a download link) may take the cookie without the key (`BROWSER_LOADS` in `src/server/app.ts`).
- Never send secrets to the client. API keys belong in the OS credential store (`src/server/secrets.ts`), not in the database.
- The server binds to `127.0.0.1`, and agent replies must not make the browser load remote content (images are shown as links; local media goes through the media endpoint's path checks).

### Database

To change the schema, append a new SQL string to `MIGRATIONS` in `src/server/db.ts`; never edit a migration that has been released. Then update the row types and queries in `store.ts` / `settings.ts` and the tests in `test/store.test.ts`.

### Languages

Harness Relay is bilingual: every user-facing string exists in Traditional Chinese (`zh-TW`) and English (`en`).

- **UI**: add the key to `src/web/locales/zh-TW.ts` first (it defines the `Messages` shape), then to `en.ts`.
- **Server messages**: add both translations to `src/server/i18n.ts` and call `t()` where the text is produced.
- **Built-in templates**: `src/server/presets.ts`, in both languages.
- **Prompts to agents** (briefings, turn prompts, the planner prompt) stay in English; agents answer in the user's language.

If you can only write one of the two languages, send the pull request anyway and say so; a maintainer will help with the other.

### Documentation

Docs come in pairs: `README.md` / `README.zh-TW.md`, `CONTRIBUTING.md` / `CONTRIBUTING.zh-TW.md` and `docs/<name>.md` / `docs/<name>.zh-TW.md`. When a change affects behaviour, the HTTP API, the schema, settings, environment variables or the list of tests, update both languages in the same pull request. The developer guide lists every HTTP route and what each test file covers; keep those lists current.

The website in `site/` has an English and a Chinese page. Read [`site/DESIGN-GUIDELINES.md`](site/DESIGN-GUIDELINES.md) before you change it, change both pages together, and preview them with `npm run site:preview`. The installers' file name endings in `site/assets/downloads.js` must stay in step with the names the Release workflow gives them: the download buttons and the desktop app's updates both find the installers by them. The same goes for `UPDATE_INSTALLERS`, the names of the copies the workflow publishes beside them for the app's updates.

### Tests

Add or update tests with every change in behaviour. Tests stay offline: no real CLI runs, no network and no real credential store. Follow the existing patterns:

- a fake runner swapped into `runners` (`test/orchestrator.test.ts`);
- recorded CLI messages for the adapters;
- real temporary git repositories for `workspace.ts`;
- `app.request()` for the HTTP API;
- a fake keyring passed to `SettingsStore`;
- for the end-to-end tests (`e2e/`), the fake CLIs in `e2e/fake-cli/`, which a message steers with `e2e:` directives (see [End-to-end tests](docs/developer-guide.md#end-to-end-tests)).

## Before you open a pull request

Run the same checks as CI:

```bash
npm run typecheck
npm test
npm run build
```

If you changed the UI, the HTTP API, the orchestrator or an adapter, also run the end-to-end tests: `npm run test:e2e` (`npm run test:e2e:install` once first).

If you changed the desktop app, also run `npm run desktop:typecheck`, and try it with `npm run desktop`; for changes to its packaging, build the installer (`npm run desktop:dist`) and check it with `npx tsx desktop/scripts/check-package.ts`.

Releases are made by maintainers with the Release workflow only (**Actions → Release**, from `main`, today's date as the version): never tag a version by hand. See [Releasing](docs/developer-guide.md#releasing) in the developer guide.

[CI](.github/workflows/ci.yml) runs the typecheck, the tests and the build on Node 22 and 24 for every pull request and every push to `main`. It also typechecks and builds the desktop app, runs its bundled server as the app does, and packages it for Linux to check it as a release is checked. [Another workflow](.github/workflows/e2e.yml) runs the end-to-end tests on Linux, macOS and Windows.

If your change affects what agents see or do, also try it in the app with at least one real CLI, and say which ones you used.

## Commit messages

Write commit messages in English.

- **Subject**: an imperative sentence about what the user gets, for example `Let agents ask the user before answering, and wait for the answer`.
- **Body**: short bullet points, grouped under headings when the commit spans several areas. Say what changed and why, mention any schema version bump, and list the docs and locales you updated.

## Pull requests

In the description, say:

- what the change does and why, with a link to the issue it addresses;
- how you tested it (tests added, and which CLIs you ran it with);
- which docs and locale files you updated, or why none were needed;
- for UI changes, screenshots or a short recording, in both languages if the text changed, and on a phone-sized window if the layout changed.

A maintainer reviews every pull request. Expect questions and requests for changes; they are about fitting the change into the project, not about you.

## Working with coding agents

You are welcome to write your change with Claude Code, Codex, Grok or any other agent, including from inside Harness Relay itself. [AGENTS.md](AGENTS.md) gives them the commands, the layout and the rules, and [CLAUDE.md](CLAUDE.md) imports it for Claude Code. You are still responsible for the result: read the diff, run the checks, and make sure every claim in the description is true.

When you change a rule that applies to everyone, change it in AGENTS.md and in this file (both languages).

## License

Harness Relay is licensed under the [Apache License 2.0](LICENSE). Unless you say otherwise, any contribution you submit is licensed under the same terms, as section 5 of the license states.
