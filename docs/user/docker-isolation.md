# Per-chat Docker isolation

This fork adds a **Docker isolation** Codex option to each chat.

## Requirements

- Docker Desktop (Windows/macOS) or Docker Engine (Linux)
- The `docker` CLI must be available to the T3 Code desktop/server process
- Codex provider configured normally in T3 Code

## Using it

1. Create a chat and select a Codex model.
2. Open the model/provider options.
3. Enable **Docker isolation** before sending the first message.
4. Use local or worktree mode normally. Docker execution is independent of T3's workspace mode, so `worktree + Docker` is supported.

The first Docker chat builds a small local image named `t3code-codex-agent:latest`. Later chats reuse it. Each chat gets a persistent container named from its T3 thread id and labeled with `t3code.docker-chat=true`.

## Workspace behavior

T3 copies the selected project/worktree into `/workspace` inside the chat's container. Before each later turn the container is refreshed from the host. When a turn completes, and again when the session stops, container changes are mirrored back to the original host project/worktree.

The following generated/native directories are excluded by default because copying them between Windows/macOS and Linux is normally incorrect and can be very large:

- `.git`
- `.venv`
- `node_modules`
- `.next`
- `.cache`
- `coverage`
- `dist`
- `build`
- `target`
- `__pycache__`

The copied workspace gets an independent Git repository with a baseline commit. This is required for T3 Git worktrees because their `.git` file points to worktree metadata on the host, which is not valid inside the Linux container. Host Git metadata is never overwritten by the container.

## Codex and T3 integration

Codex runs inside the container using its normal `app-server` stdio protocol. T3 remains on the host.

The host Codex home directory is copied into `/root/.codex` so existing Codex authentication/configuration can be reused. Environment variables needed for OpenAI, proxies and the T3 MCP bridge are forwarded to `docker exec` without writing their values into the generated wrapper script.

T3's local MCP URL is changed from loopback to `host.docker.internal` for Docker chats. Containers are created with Docker's `host-gateway` mapping so Codex can still reach T3 tools and approval handling.

## Configuration

Optional environment variables:

- `T3CODE_DOCKER_IMAGE` — use another agent image instead of `t3code-codex-agent:latest`. A missing custom image is pulled automatically.
- `T3CODE_DOCKER_CODEX_VERSION` — Codex npm version installed when T3 builds the default image. Defaults to `latest`.
- `T3CODE_DOCKER_PORTS` — comma-separated container ports to publish on random loopback-only host ports, for example `3000,5173`.
- `T3CODE_DOCKER_IGNORE` — additional comma-separated path-segment names to exclude from host/container synchronization.

## Updating this fork

`.github/workflows/upstream-docker-release.yml` checks the latest stable `pingdotgg/t3code` GitHub release hourly. When this fork does not already contain the same version, it:

1. checks out the exact official release tag;
2. copies `DockerCodex.ts` into it;
3. applies the small integration overlay with `scripts/apply-t3code-docker-overlay.mjs`;
4. typechecks the patched server;
5. builds the Windows x64 desktop installer and updater metadata; and
6. publishes a matching GitHub release in `hibenji/t3code-docker`.

The custom desktop build sets `T3CODE_DESKTOP_UPDATE_REPOSITORY=hibenji/t3code-docker`, so T3 Code's existing update button checks this fork after the first custom build has been installed.

If upstream changes one of the integration points, the overlay intentionally fails instead of applying an uncertain patch. The existing custom release remains available until the overlay is adjusted for the new upstream version.
