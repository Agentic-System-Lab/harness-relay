**English** | [繁體中文](app-publish.zh-TW.md)

# Publishing a previewed app

**Status.** Steps 1 and 2 are built: Render and Neon in Settings, **Publish** in the preview panel, the five kinds of app below, Neon for a compose file's PostgreSQL with its init scripts, updates and unpublishing; the [user guide](../user-guide.md#publishing-an-app), [architecture](../architecture.md#publishing-an-app) and [developer guide](../developer-guide.md#app-publishing) describe them. Not yet tried against the real Render and Neon APIs with an account (below, "What was tried"). Step 3 (other hosts) is open. It builds on [one preview for every app](unified-app-preview.md).

## What exists, and what is missing

**Preview app** runs what an agent built, in a disposable container with no network, from a filtered snapshot of its folder. Once the user has tried it there, the next question is how to put it online. Today that means leaving Relay: creating a repository, choosing a host, writing its settings, creating a database and copying its connection string, with the same exclusions done by hand (no `.env`, no credentials).

## The design

**A preview the user has tried is published to the user's own accounts, from the same snapshot.** Relay never hosts anything itself, never has an account of its own at a host, and never publishes on an agent's request.

### Settings

A **Publish to the cloud** card in Settings, beside the shared conversations, since both put something on the internet with the user's own accounts:

- **Render**: an API key (Render's account settings), kept in the credential store like every key. Relay checks it with `GET /owners` and keeps the workspace it names; with several, the user chooses one. A region (Oregon, Ohio, Virginia, Frankfurt, Singapore).
- **Neon**: an API key, kept the same way, and the organization (`GET /users/me/organizations`), chosen when there are several. The database's region follows Render's (Oregon → `aws-us-west-2`, Frankfurt → `aws-eu-central-1`…), so that the app and its database are close.
- **GitHub**: the `gh` sign-in sharing already uses, with the same sign-in from the card when it is missing.
- **Published apps**: each with its address, where it came from, its last publish and its state, a link to Render's dashboard and to its repository, and **Unpublish**.

### The panel

**Publish** appears in the preview panel once the preview works: a static page or build that loaded, a backend that answered, a container whose page opened. It opens a dialog that says, before anything happens:

- what Relay will create: a private GitHub repository, a free Render static site or web service, and a Neon database when the app needs one;
- the address it will have, which anyone with it can open;
- the environment variables the app will get, the ones the compose file sets and the database's, which the user can change and add to;
- what free plans do: a free web service sleeps after 15 minutes without requests and takes about a minute to wake, and its files are lost when it restarts.

The user confirms that it will be public, then **Publish**. The dialog shows each step (repository, push, database, service, build, live) and Render's state until the app is live or the build failed, with a link to its logs on Render. Publishing the same folder again updates the same service: a new commit, then a deploy of that commit.

**What is published is what was previewed.** The preview records a digest of its snapshot. Publishing takes the snapshot again and refuses when it differs: the files changed since the preview, so the user rebuilds the preview and tries it first. The snapshot has the exclusions previews have: no `.git`, `.env*`, credentials, installed dependencies, links or files Relay withholds.

### From the snapshot to Render

Render builds a service from a Git repository or runs an image from a registry. Relay pushes the snapshot to a **private GitHub repository** of the user's, through the user's own `gh` sign-in, as the files of a share are pushed: one commit made with git's `fast-import` in a temporary folder of Relay's data (never a working tree, no hooks, no signing, HTTPS only), with the executable bits the snapshot recorded. Render then builds it on its own (Linux, amd64) machines. Render reads the repository through its GitHub app, so the user's Render account must be connected to GitHub with access to the new repositories (all repositories, or this one added); when it is not, Relay says how, with the link.

| The preview | On Render |
| --- | --- |
| Static HTML | A static site: the folder as it is. |
| An npm build (`dist/`) | A static site: `npm ci` and `npm run build`, publishing `dist` (a workspace member's, with `--workspace`). |
| A Node.js backend | A web service, runtime `node`: `npm ci --include=dev`, then `npm start`, as the preview runs it. |
| A `Dockerfile` | A web service, runtime `docker`, from that `Dockerfile`. |
| A compose file | A web service, runtime `docker`, from the main service's `build`; its PostgreSQL services become Neon databases. |

A compose file is published only when Render's free plan can run it as one service: one app service with a `build` (a context in the snapshot, a Dockerfile file, no build arguments, target or inline Dockerfile, no mounted project files), its `command` as Render's start command, and PostgreSQL services beside it. Anything else (another app service, Redis, MySQL) is refused with the reason, before anything is created.

### The database

Render's free PostgreSQL expires 30 days after it is made, and is deleted with its data 14 days later; Neon's free plan keeps a database (1 GB a project, 100 projects) without a limit in time and scales it to zero when it is idle. So a database is Neon's:

- **A compose file's PostgreSQL service** becomes a Neon project of its own, with the service's `POSTGRES_DB` and `POSTGRES_USER` as its database and role (Neon's own names for `postgres`) and the image's major version (14 to 18) as its PostgreSQL. In the main service's environment, a `postgres://` URL whose host is that service becomes Neon's connection string, the service's name as a host becomes Neon's host, and its password Neon's. With none of them, the app gets `DATABASE_URL`.
- **Its init scripts** (`.sql` files the compose file mounts into `/docker-entrypoint-initdb.d/`, in name order, as PostgreSQL's image runs them) run once on the new database, with `psql` from PostgreSQL's official image pinned by digest (never the compose file's own image, which an agent may have named), in a container of its own (no capabilities, read-only, the connection on its stdin, never in a command line). That container has a network, to reach Neon, so a script with psql's own commands besides `\echo`, `\qecho`, `\set` and `\unset` (which could run a program or touch files here) is refused before anything is made. Other kinds of script (`.sh`, `.sql.gz`) are named in the dialog and not run. A database whose scripts failed part way is deleted, so that the next try starts on a new one.
- **A backend or `Dockerfile` without compose** can have a Neon database too, with a checkbox: the app gets `DATABASE_URL`.

### Environment variables

They go to Render when the service is made, never into the repository: the compose file's (after the database's changes), the database's, and the ones the user adds in the dialog (names like `API_KEY`, at most 100 in all). Relay keeps none of their values. An update leaves them as they are on Render, where the user changes them (the dialog links there).

### Unpublishing

**Unpublish** deletes the Render service and, when the user ticks it, the Neon project (Neon keeps a deleted project for 7 days). The GitHub repository stays, with a link: deleting a repository needs a scope `gh` does not have by default, and it holds what was published.

## Security

- The Render and Neon keys stay in the credential store, never go to the UI (masked), a CLI or an agent, and go only to `api.render.com` and `console.neon.tech` over HTTPS, with no redirect followed and answers read to a limit.
- Only the user's click starts a publish, from the panel of the browser that started the preview, through `/api/` with its usual checks. No agent tool, prompt or reply can publish, unpublish or read the settings.
- The dialog says that the app will be public, and that unlike the preview it has a network.
- The repository is private. What goes in it is the snapshot alone, with the previews' exclusions.
- The app's variables never reach the repository or Relay's database.
- The init scripts' container runs a pinned official image, with only plain SQL and harmless psql commands; it has a network, unlike the preview.
- Stand-ins for the end-to-end tests (`RELAY_RENDER_API_URL`, `RELAY_NEON_API_URL`, `RELAY_PUBLISH_GIT_URL`) are read at startup only, and refused unless they point at this computer.

## Alternatives not taken

- **An image pushed to a registry** (Docker Hub, GitHub's registry) for Render to run: no repository, but another account and token for Render to pull with, a build for amd64 on an Apple Silicon Mac (emulated, slow, and some native packages fail), images of hundreds of megabytes over the user's upload, and a static site as a web service that sleeps.
- **A public repository**, which Render deploys without its GitHub app: the app's source for anyone to read. Never by default.
- **Render's own PostgreSQL**: deleted with its data after 30 to 44 days on the free plan.
- **Hosts besides Render** (Cloud Run, Cloudflare Pages, Koyeb, Zeabur): each its own adapter; step 3.
- **Letting agents publish**: an agent could put a user's files on the internet. Publishing stays a click, like sending a message.

## Open questions

1. Whether Render's API accepts `plan: free` for a service it makes (its schema lists it; only an account settles it), and what it answers when its GitHub app cannot read the repository.
2. Environment variables after the first publish: edited in the dialog (Render's `PUT /env-vars`) or left to Render's dashboard, as now.
3. A custom domain.
4. Other hosts (step 3), behind the same card: Cloudflare Pages for static sites, Cloud Run for containers.

## Delivery

1. **Settings and static sites.** The card, the keys, the sign-in, the repository and push, Render's static sites, the list and unpublishing.
2. **Services and databases.** Web services (`node`, `docker`), compose, Neon with its init scripts, the variables, updates.
3. **Other hosts.**

## What was tried

On 2026-11-22, offline: Render's and Neon's APIs as their reference documents them, through stand-ins (`test/publish*.test.ts` and the end-to-end tests, `e2e/specs/app-publish.spec.ts`); the push with real git into a local repository; `psql` from `postgres:16` against a local PostgreSQL in Docker for the init scripts. Not yet: a real Render or Neon account.
