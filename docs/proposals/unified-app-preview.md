**English** | [繁體中文](unified-app-preview.zh-TW.md)

# One preview for every app

**Status.** Steps 1 to 3 are built (a `Dockerfile` app, the terminal, compose), with step 4's line in the agents' briefing and the draft to the agent; the [user guide](../user-guide.md#previewing-an-app), [architecture](../architecture.md#container-previews) and [developer guide](../developer-guide.md#app-preview-runtime) describe them. Still open: step 4's builder of Relay's own with limits and a registry-only proxy, and generated builds. The open questions were settled as recommended, with one change found while building it (below, "Open questions"). It extends the [app preview runtime](app-preview-runtime.md), whose static and npm paths stay as they are.

## What exists, and what is missing

Today **Preview app** opens three kinds of project: static HTML (no Docker), an npm frontend that is built, and a Node.js backend with one HTTP entry point. The npm paths are strict: Relay checks every locked package on the host against its SHA-512 from the public registry, and the container never has a network. That guarantee is why they stop at npm.

Agents build much more than that. Three gaps show up in real chats:

- **Other languages.** A Flask or FastAPI app, a Go or Rust server, a Spring app, a PHP site. Each ecosystem locks packages differently, and several have no lockfile with hashes at all.
- **More than one process.** An app with its own database. The todo app that prompted this proposal is a React client, an Express API and PostgreSQL from its `docker-compose.yml`. Today only the client can be previewed, and its API has no database to talk to.
- **Apps without a page.** A command-line tool, a terminal UI, a text game, a REPL. They read from a terminal and write to it. There is nothing to show in a frame.

## The contract

**An app is a container. It serves HTTP, or it talks on its terminal, or both.** The same contract covers every language, because the project, not Relay, says how to build and run it:

| The project has | Relay runs |
| --- | --- |
| `compose.yaml` or `docker-compose.yml` | Its services, rewritten by Relay's rules (below), on a network of their own with no way out. |
| `Dockerfile` | One container built from it. |
| An npm project and no `Dockerfile` | Today's verified offline npm path, unchanged. |
| HTML only | Today's static preview, without Docker. |

A recipe the project declares wins over one Relay would guess: an npm project with a `Dockerfile` runs from the `Dockerfile`. When a folder has none of these, the panel says so and offers a draft to the reply's author: "Add a `Dockerfile` (and a `compose.yaml` if it needs a database) so that the app can be previewed." The agents' briefing gains one line with the same contract, so that a web app or tool an agent makes is previewable from the start, whatever language it chose.

## One runtime, two views

Every container preview runs its main process on a terminal (a TTY). The panel opens on that terminal, which shows the build log and then the app's own output. If the app starts accepting connections on its HTTP port, the panel switches to the page, and the terminal stays one tab away with the server's log. If it never does, it is a terminal app, and the terminal is the preview: the user types into it, resizes it, and sees what a TUI draws.

Nothing has to be declared for this. A web server's log and a CLI's prompt both arrive on the terminal; only the open port tells them apart. When the process exits, the panel shows its exit code with **Run again**, an arguments field for a command-line tool, and **Open a shell** in a fresh container from the same image, for tools that are meant to be called many times. **Add errors to message** takes the terminal's last lines as well as the page's errors, in the same `<preview_console>` block agents already treat as data.

The HTTP port is the one the image declares with `EXPOSE`, when it declares exactly one, and otherwise `PORT` (4173), which Relay sets in the environment as it does today. In a compose file it is the container side of the web service's `ports` entry, which Relay never publishes on the host.

Desktop GUI apps (windows drawn with Tk, Qt or Electron) are out of scope. A remote desktop in the panel could come later.

## Build

Relay sends the snapshot, with the same exclusions and limits as today (no `.git`, `.env*`, credentials, installed dependencies or links), to `docker build` as a tar context on stdin. Nothing on the host is mounted or named. The image is labelled with Relay's owner label and removed when the preview stops; BuildKit's cache stays, within a disk budget Relay prunes by label.

Unlike the npm path, the build needs the network: `pip install`, `go mod download` and `cargo build` fetch packages, and there is no single place to verify them all. This is the one real loosening, and it is bounded:

- Only the build has a network. The app itself never does.
- The build sees the snapshot only: no host paths, Docker socket, Relay data, CLI credentials or the user's environment.
- It reaches no further than an agent does when it runs `npm install` or `pip install` on the host in full access, which is how the todo app got its `node_modules`.
- **Step 4** narrows it further: a BuildKit builder of Relay's own (buildx with the `docker-container` driver) with CPU and memory limits, on an internal network whose only exit is a proxy that allows the package and image registries.

## Run

Each service runs with today's hardening: all capabilities dropped, `no-new-privileges`, the CPU, memory and process limits, no host mounts, no Docker socket, Relay's owner label for cleanup, and the same idle and maximum lifetimes. A single container has `--network=none`. Compose services share one internal network and reach each other by name, and nothing outside.

Two things differ from the npm path, because Relay no longer controls the image. The image chooses its user, and root keeps only the five capabilities official images need to hand their files to their own user and switch to it (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`): postgres, redis and nginx do not start without them. Ports below 1024 are open to any user in the namespace instead of `NET_BIND_SERVICE`. Its own filesystem is writable and disposable, instead of read-only with a scratch folder. **Reload** keeps the running containers and their data, **Rebuild** builds from a new snapshot, and **Stop** removes the containers, networks, volumes and image.

## Reaching the app

The forwarding stays as it is: Relay runs the fixed forwarder (`previewDockerWire.ts`) with Docker exec, and the app only needs its own loopback. An image without Node.js cannot run that forwarder, so it moves into a sidecar: a container of the pinned Node image, unprivileged and read-only, that joins the app container's network namespace (`--network=container:<id>`). It reaches the app on `127.0.0.1` and has no network of its own. For compose, the sidecar joins the web service.

The page keeps everything it has now: its own origin, the credential the proxy consumes, the header allowlist, the CSP and the sandboxed frame.

## The terminal

Relay talks to the terminal through the Docker Engine API on the same local socket or named pipe it already checks: `attach` on the created container (before `start`, so the first prompt is not lost) gives one stream of raw terminal bytes both ways, and `resize` passes the panel's size. The `docker` CLI cannot be used for this: `attach` and `exec -t` refuse when their own input is not a terminal, and the server's never is.

The browser gets the output over SSE, as it gets the rest of the chat, bounded and base64-encoded, and sends keystrokes and resizes with POST requests to `/api/`, behind the usual checks. The panel draws it with xterm.js, loaded only when a terminal opens. xterm.js draws text and runs nothing, but output is still the app's: OSC 52 clipboard writes stay off, and a link opens only when clicked, in a new tab with `noopener`. Only the browser that started the preview can type into it.

## Compose, rewritten

Relay never runs a compose file as it is. It reads the normalized model (`docker compose config --format json`), keeps what an app needs, rewrites what would reach the host and refuses the rest:

- **Kept:** `image`, `build` (with a context inside the snapshot), `command`, `entrypoint`, `environment`, `depends_on`, `healthcheck`, `working_dir`, `user`, `tmpfs`.
- **Rewritten:** every network becomes the preview's internal network, and `ports` become the target the sidecar forwards to, never a published port. A bind mount of a project file becomes a read-only copy from the snapshot. The todo app's `./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro` is the common case. Named volumes become volumes of this preview, removed at **Stop**.
- **Refused, with the reason in the panel:** `privileged`, `cap_add`, `devices`, `network_mode`, `pid` or `ipc` set to `host`, external networks or volumes, the Docker socket, and bind mounts outside the project.
- **Environment:** variables come from the file, never from the user's environment or a `.env` file, which the snapshot withholds. A missing variable stays empty.

Limits apply per service and to the preview as a whole.

## Alternatives not taken

- **A verified offline path per ecosystem**, like npm's: the strongest guarantee, but every language is separate work, several have no hashed lockfile, and none covers a database service or a terminal app. It stays for npm.
- **Generated builds** (Railpack, Cloud Native Buildpacks) as the main path: no `Dockerfile` needed, but they bring large toolchains and their own guesses about the start command. They might fill the gap when a project has no recipe; that is an open question below.
- **Previewing the dev server an agent started on the host:** any language, no Docker, but it runs with the user's own rights outside any isolation, it ends with the agent's turn, and its port can collide with others.
- **A web terminal inside the container** (ttyd, gotty): every image would need the binary. The Engine API needs nothing in the image.
- **A WebSocket for the terminal:** a new dependency and new proxy settings (Vite, Tailscale Serve). SSE and POST reuse what Relay already has. Revisit if typing feels slow.

## Open questions

1. **The build's network in steps 1 to 3:** the default network, as built. The registry-only proxy is still step 4.
2. **Root in the container:** allowed, with the five capabilities above rather than none, since official images need them.
3. **Base images:** any registry, for now.
4. **No recipe at all:** only the draft to the agent, for now; a generated build (Railpack) is still open.
5. **Disk:** each preview's images are removed when it stops, and at startup those a crash left; BuildKit's cache is left to Docker. Whether Settings shows it with a button to clear it is still open.

## Delivery

1. **A `Dockerfile` web app.** Detection in replies and Files, the build with its log in the panel, the sidecar transport, cleanup of images by label, and an end-to-end test with a Flask app on Linux CI.
2. **The terminal.** Engine API attach and resize, SSE and POST, xterm.js, the panel opening on the terminal and switching to the page when the port opens, exit codes, **Run again**, arguments and **Open a shell**. End-to-end tests with a terminal app.
3. **Compose.** Normalizing, rewriting and refusing, the internal network, copies for bind mounts, per-preview volumes, the web service's port. The todo app with PostgreSQL as the acceptance example.
4. **Narrower builds and a better start.** The builder of Relay's own with limits and a registry-only proxy, the agents' briefing line, the draft to the agent, and whatever the open questions decide.

The npm and static paths could move into the same panel later, with the npm build's log in the terminal tab.

## What was tried

On 2026-11-22, on Apple Silicon macOS with OrbStack (Docker 29.8.2, buildx 0.37.2, Compose 5.5.0):

- **`Dockerfile` with a sidecar.** A Flask app (`FROM python:3.13-slim`, `pip install` during the build) built from a tar context on stdin in 11 seconds. It ran with `--network=none`, read-only, all capabilities dropped and the usual limits. A sidecar of the pinned Node image with `--network=container:<app>`, as user 1000 and read-only, reached it on `127.0.0.1:4173` for a POST and a GET. The app could not reach the internet, and the sidecar could not resolve a name.
- **A terminal app over the Engine API.** From Node.js over the Unix socket: a container with `Tty` and `OpenStdin` running a Python `input()` program, with no network, read-only, user 1000 and all capabilities dropped. Attached before start, its prompt arrived, the typed answer and its echo came back, a `resize` to 132×40 reached `shutil.get_terminal_size()`, and `wait` gave the exit code.
- **Compose with an internal network.** Two services of `postgres:16` on a network with `internal: true`: the second reached the first by its service name and queried it, found no external name and could not open a connection to an outside address. It took two seconds.

Not tried yet: Windows (the named pipe for the Engine API), Docker Desktop and Linux Engine, a buildx builder with limits and a proxy, and the compose rewriting itself.
