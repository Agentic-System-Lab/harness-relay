**English** | [繁體中文](app-preview-runtime.zh-TW.md)

# Runtime for app previews

**Implementation status.** Local app previews include static sites, npm frontend builds and Node.js backends with one HTTP entry point. The original design and platform acceptance criteria follow. Current behaviour and limits are in the [user guide](../user-guide.md#previewing-an-app), [architecture](../architecture.md#app-previews) and [developer guide](../developer-guide.md#app-preview-runtime).

The packaged Electron app and an OrbStack Linux Docker engine were exercised on Apple Silicon macOS. A browser check uses a synthetic HTTPS setup for remote mode. Linux CI exercises a real build, a SQLite backend and the chat panel. Windows Docker Desktop and wildcard HTTPS on physical phones still require their own acceptance runs. The interactive reply formats remain in the [generative UI proposal](preview-and-generative-ui.md).

## What the user can try in the first release

| Project | What happens on Preview | Acceptance example |
| --- | --- | --- |
| Static site or prebuilt frontend | Relay takes a snapshot of the selected public output folder and serves the assets directly. This path works without Docker. | Open an agent's `site/index.html` from its reply. Images, CSS and JavaScript modules load. |
| Frontend that requires a build | A disposable container installs dependencies and runs the build. The selected public artifacts then go to the static preview. | Open a React/Vite project from source and a lockfile, switch views and interact with the page. |
| App with a backend API | A container belonging to this preview runs the app. The same preview URL serves the frontend and its own API. | Add an item in a Node.js and SQLite todo app. It survives a page refresh. Stopping the preview discards its data. |

The proposed first runtime supports Node.js projects with an npm lockfile and one HTTP entry point for the browser. The frontend and backend can share a process or communicate over loopback inside the container. This covers a complete frontend-to-database flow with a defined installation and test matrix. For other languages, external API credentials or separate database services, the panel identifies the missing capability.

## Editing and execution

Agents edit in their existing worktrees with their usual CLI accounts and turn permissions. When the user chooses Preview, the panel identifies the member, folder and project script to be run. Relay copies the files needed for this run, including uncommitted edits, from a root determined by the conversation and member. The copy uses the Files checks on roots and withheld files. It also excludes links, `.git`, `.env*`, package-manager credentials and installed dependencies, and limits file count and total size. Static previews publish only the selected public assets. Backend source and databases stay on the server side. [Existing file boundaries](../../src/server/files.ts)

Both build and runtime execute project code. The trusted preview manager controls Docker, pins the image by digest, runs the workload as a non-root user, mounts the system read-only, and provides size-limited writable scratch space. It drops Linux capabilities, prevents privilege escalation, and limits CPU, memory, processes and elapsed time. The container receives the snapshot, required tools and an explicit set of environment variables. The Docker socket, home directory, host worktree, Relay data and CLI credentials stay on the host. Prefer rootless Docker on Linux. When a runtime is unavailable, the panel explains the issue and still offers static previews. [Docker Engine security](https://docs.docker.com/engine/security/) · [Rootless Docker](https://docs.docker.com/engine/security/rootless/) · [Resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)

Separate fetching packages from executing their scripts. A controlled fetcher retrieves and verifies locked packages from allowed registry endpoints, rejecting arbitrary URLs, Git and external file dependencies. Project install scripts, builds and the backend run offline. The first transport to validate has the app listen on one fixed port inside the container. Relay forwards requests through a Docker exec stdio connection to that port, so the container needs only loopback. The target belongs to the recorded container ID. Neither the page nor startup logs choose a host or port. [Docker's none network](https://docs.docker.com/engine/network/drivers/none/)

## Browser and Relay boundaries

The container isolates build tools and backend execution. Page scripts still execute in the user's browser. Give each preview a dedicated hostname and origin outside the scope of Relay's login cookie. Changing only the port can still send cookies for the same host to a preview's `/api` path. The preview proxy forwards an allowlist of application headers and consumes preview credentials itself. Relay cookies and authentication headers never reach the project. The control API checks the exact Relay UI origin. Verify loopback subdomain resolution locally. A phone requires a resolvable preview hostname with valid TLS in addition to access to Relay's port. [Current API and sign-in behaviour](../../src/server/app.ts) · [RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5)

An authenticated user starts and stops previews. The proxy verifies a revocable credential scoped to the current preview on document, asset and API requests. The panel uses a sandboxed iframe. CSP limits resource loads, form targets and data connections, and allows only Relay to embed it. Test that policy separately from the backend's offline network. The panel accepts bounded error text only from the current frame and origin. Users can edit it before sending it to an agent. A new origin on project change isolates browser storage between previews.

## Feasibility on the three desktop platforms

Relay can serve static snapshots directly on all three systems. Projects that require a build or backend must run as Linux web apps. Publish `linux/amd64` and `linux/arm64` variants and pin the digest of the image index. Install and test dependencies that include native modules inside a container of the target architecture. [Docker multi-platform images](https://docs.docker.com/build/building/multi-platform/)

| Relay host | Proposed validation environment | Platform-specific conditions |
| --- | --- | --- |
| Windows | Start with x64 and Docker Desktop using the WSL 2 backend in Linux container mode. | Hardware virtualization must be enabled. Docker Desktop on Windows Arm is currently labelled Early Access, so track it as an experimental target. Test snapshots from Windows paths containing spaces and Chinese characters, including rejecting a junction that leads outside the worktree. [Windows requirements](https://docs.docker.com/desktop/setup/install/windows-install/) |
| macOS | The Apple Silicon Relay desktop app with Docker Desktop. | Use a macOS version supported by Docker Desktop. Docker also ships an Intel build, while Relay currently packages its Mac desktop app for Apple Silicon only. [Mac requirements](https://docs.docker.com/desktop/setup/install/mac-install/) · [Relay desktop release targets](../../desktop/README.md) |
| Linux | Docker Engine on x64 and arm64, preferably rootless. | Rootless CPU, memory and process limits require cgroup v2, systemd and delegation of the relevant controllers. Verify that limits apply to the running account before enabling dynamic previews. Static previews remain available when those limits are missing. [Rootless resource limits](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources) |

These are feasibility findings. For each supported combination, use the packaged desktop app to open a static site, build a Vite frontend, write to SQLite through the app's API, and stop the preview and check cleanup. Verify preview hostname resolution, credential isolation and error reporting in Electron and supported external browsers.

## Delivery and acceptance

1. **Verify both boundaries first.** Exercise the offline transport, resource limits and cleanup on macOS, Linux and Windows with Linux containers. In a browser, verify that the preview cannot obtain Relay credentials, another preview's data, or files outside the chosen root. Check hostname resolution, TLS and embedded authorization separately on phones.
2. **Deliver the static and frontend-build paths.** Select the right member's snapshot from replies and Files. Run the first two examples in the table. Also cover missing Docker, missing lockfile, a failed build, and identically named files in different worktrees. Rebuild takes a new snapshot after an agent edits the project.
3. **Connect the backend and accept the complete release.** Run the SQLite example in the table. Verify that the container cannot read host credentials, reach the host's Relay API or change the source worktree. Cover startup timeout, repeated starts, stop, idle expiry, conversation deletion and recovery after a Relay crash. Reclaim owned containers and scratch data and revoke old URLs. Runtime checks and startup failures should surface a reason and bounded logs.

## Why Docker

For a single user's local installation, Docker gives a reproducible build environment and limits backend file access to a snapshot. It adds an engine prerequisite and an initial image download. Reusing Relay's OS sandbox would save that installation, but platform coverage differs and long-running services would need their own validation. For a future service running projects from mutually untrusted users, consider per-preview microVMs with a separate guest kernel. Containerizing the agent CLIs themselves would change authentication, tools and approvals and warrants a separate decision. [Relay's platform sandboxes](../sandboxing.md) · [Docker Engine security](https://docs.docker.com/engine/security/) · [Firecracker microVMs](https://firecracker-microvm.github.io/)
