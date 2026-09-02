// @effect-diagnostics nodeBuiltinImport:off - Docker workspace mirroring and cross-platform wrapper generation intentionally use Node filesystem/process primitives around the external Docker CLI.
import { execFile } from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { promisify } from "node:util";

import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const execFileAsync = promisify(execFile);

const DEFAULT_IMAGE = "t3code-codex-agent:latest";
const DEFAULT_CODEX_VERSION = "latest";
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_CODEX_HOME = "/root/.codex";
const WRAPPER_DIR_NAME = "docker-codex-wrappers";
const DOCKER_OUTPUT_LIMIT = 16 * 1024 * 1024;

// Host-native generated dependency/build trees are deliberately not copied
// into the Linux container or mirrored back. They are large and commonly hold
// platform-specific binaries that are invalid on the other side of the
// Windows/macOS <-> Linux boundary.
const DEFAULT_IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  ".venv",
  "node_modules",
  ".next",
  ".cache",
  "coverage",
  "dist",
  "build",
  "target",
  "__pycache__",
]);

const FORWARDED_ENVIRONMENT_NAMES = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "T3_MCP_BEARER_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
] as const;

export interface DockerCodexSession {
  readonly containerName: string;
  readonly binaryPath: string;
  readonly workspacePath: typeof CONTAINER_WORKSPACE;
  readonly hostWorkspacePath: string;
}

export interface PrepareDockerCodexSessionInput {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class DockerCodexOperationError extends Schema.TaggedErrorClass<DockerCodexOperationError>()(
  "DockerCodexOperationError",
  {
    action: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.action}: ${this.detail}`;
  }
}

function dockerOperationError(action: string, cause: unknown): DockerCodexOperationError {
  return new DockerCodexOperationError({
    action,
    detail: errorMessage(cause),
    cause,
  });
}

async function docker(args: ReadonlyArray<string>, cwd?: string): Promise<string> {
  const result = await execFileAsync("docker", [...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: DOCKER_OUTPUT_LIMIT,
  });
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

async function dockerSucceeds(args: ReadonlyArray<string>): Promise<boolean> {
  try {
    await docker(args);
    return true;
  } catch {
    return false;
  }
}

function normalizeThreadSuffix(threadId: ThreadId): string {
  const normalized = String(threadId)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "thread").slice(0, 48);
}

export function dockerContainerNameForThread(threadId: ThreadId): string {
  return `t3code-${normalizeThreadSuffix(threadId)}`;
}

function resolveHostCodexHome(homePath: string | undefined): string {
  if (!homePath) {
    return NodePath.join(NodeOs.homedir(), ".codex");
  }
  if (homePath === "~") {
    return NodeOs.homedir();
  }
  if (homePath.startsWith("~/") || homePath.startsWith("~\\")) {
    return NodePath.join(NodeOs.homedir(), homePath.slice(2));
  }
  return homePath;
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await NodeFs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function dockerPortArgs(): Array<string> {
  const raw = process.env.T3CODE_DOCKER_PORTS?.trim();
  if (!raw) return [];

  const ports = raw
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);

  return ports.flatMap((port) => ["-p", `127.0.0.1::${port}`]);
}

function extraIgnoredSegments(): Set<string> {
  const values = process.env.T3CODE_DOCKER_IGNORE?.split(",") ?? [];
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

function isIgnoredRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath === ".") return false;
  const extra = extraIgnoredSegments();
  return relativePath
    .split(/[\\/]+/u)
    .filter(Boolean)
    .some((segment) => DEFAULT_IGNORED_PATH_SEGMENTS.has(segment) || extra.has(segment));
}

async function copyTreeForDocker(source: string, destination: string): Promise<void> {
  await NodeFs.mkdir(destination, { recursive: true });
  await NodeFs.cp(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
    preserveTimestamps: true,
    filter: (candidate) => {
      const relative = NodePath.relative(source, candidate);
      return !isIgnoredRelativePath(relative);
    },
  });
}

async function ensureDefaultImage(image: string): Promise<void> {
  if (await dockerSucceeds(["image", "inspect", image])) {
    return;
  }

  if (image !== DEFAULT_IMAGE) {
    await docker(["pull", image]);
    return;
  }

  const codexVersion = process.env.T3CODE_DOCKER_CODEX_VERSION?.trim() || DEFAULT_CODEX_VERSION;
  const buildDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3code-codex-image-"));
  try {
    const dockerfile = `FROM node:24-bookworm-slim\n\
ARG CODEX_VERSION=latest\n\
RUN apt-get update \\\n && apt-get install -y --no-install-recommends ca-certificates git openssh-client procps \\\n && rm -rf /var/lib/apt/lists/* \\\n && npm install -g "@openai/codex@\${CODEX_VERSION}"\n\
WORKDIR ${CONTAINER_WORKSPACE}\n\
ENV CODEX_HOME=${CONTAINER_CODEX_HOME}\n\
CMD ["sleep", "infinity"]\n`;
    await NodeFs.writeFile(NodePath.join(buildDir, "Dockerfile"), dockerfile, "utf8");
    await docker([
      "build",
      "--pull",
      "--build-arg",
      `CODEX_VERSION=${codexVersion}`,
      "-t",
      image,
      buildDir,
    ]);
  } finally {
    await NodeFs.rm(buildDir, { recursive: true, force: true });
  }
}

async function ensureContainer(input: PrepareDockerCodexSessionInput, image: string): Promise<string> {
  const containerName = dockerContainerNameForThread(input.threadId);
  const exists = await dockerSucceeds(["container", "inspect", containerName]);

  if (!exists) {
    await docker([
      "create",
      "--name",
      containerName,
      "--label",
      "t3code.docker-chat=true",
      "--label",
      `t3code.thread=${String(input.threadId)}`,
      "--add-host",
      "host.docker.internal:host-gateway",
      "--workdir",
      CONTAINER_WORKSPACE,
      "-e",
      `CODEX_HOME=${CONTAINER_CODEX_HOME}`,
      ...dockerPortArgs(),
      image,
      "sleep",
      "infinity",
    ]);
  }

  const running = await docker([
    "container",
    "inspect",
    "--format",
    "{{.State.Running}}",
    containerName,
  ]);
  if (running !== "true") {
    await docker(["start", containerName]);
  }

  return containerName;
}

async function initializeWorkspaceGit(containerName: string): Promise<void> {
  // T3 worktrees have a .git file whose gitdir points to host-only metadata.
  // A copied container workspace therefore gets a local baseline repository so
  // git status/diff remain useful to Codex without sharing host worktree state.
  await docker([
    "exec",
    containerName,
    "sh",
    "-lc",
    [
      `cd ${CONTAINER_WORKSPACE}`,
      "rm -rf .git",
      "git init -q",
      'git config user.name "T3 Code Docker"',
      'git config user.email "t3code-docker@localhost"',
      "git add -A",
      'git commit --allow-empty --no-gpg-sign -qm "T3 Code Docker baseline"',
    ].join(" && "),
  ]);
}

async function syncWorkspaceToContainer(containerName: string, cwd: string): Promise<void> {
  const stageDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3code-docker-in-"));
  try {
    await copyTreeForDocker(NodePath.resolve(cwd), stageDir);
    await docker([
      "exec",
      containerName,
      "sh",
      "-lc",
      `mkdir -p ${CONTAINER_WORKSPACE} && find ${CONTAINER_WORKSPACE} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
    ]);
    await docker(["cp", `${stageDir}${NodePath.sep}.`, `${containerName}:${CONTAINER_WORKSPACE}`]);
    await initializeWorkspaceGit(containerName);
  } finally {
    await NodeFs.rm(stageDir, { recursive: true, force: true });
  }
}

async function removeManagedEntriesMissingFromSource(source: string, destination: string): Promise<void> {
  const sourceEntries = new Set(await NodeFs.readdir(source));
  for (const name of await NodeFs.readdir(destination)) {
    if (DEFAULT_IGNORED_PATH_SEGMENTS.has(name) || extraIgnoredSegments().has(name)) {
      continue;
    }
    if (!sourceEntries.has(name)) {
      await NodeFs.rm(NodePath.join(destination, name), { recursive: true, force: true });
    }
  }
}

async function mirrorDirectory(source: string, destination: string): Promise<void> {
  await NodeFs.mkdir(destination, { recursive: true });
  await removeManagedEntriesMissingFromSource(source, destination);

  for (const entry of await NodeFs.readdir(source, { withFileTypes: true })) {
    if (DEFAULT_IGNORED_PATH_SEGMENTS.has(entry.name) || extraIgnoredSegments().has(entry.name)) {
      continue;
    }

    const sourcePath = NodePath.join(source, entry.name);
    const destinationPath = NodePath.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mirrorDirectory(sourcePath, destinationPath);
      continue;
    }

    await NodeFs.rm(destinationPath, { recursive: true, force: true });
    if (entry.isSymbolicLink()) {
      const linkTarget = await NodeFs.readlink(sourcePath);
      await NodeFs.symlink(linkTarget, destinationPath);
    } else {
      await NodeFs.copyFile(sourcePath, destinationPath);
    }
  }
}

async function syncWorkspaceToHost(containerName: string, cwd: string): Promise<void> {
  const stageDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3code-docker-out-"));
  try {
    await docker(["cp", `${containerName}:${CONTAINER_WORKSPACE}/.`, stageDir]);
    // The local .git baseline is intentionally never copied back; host Git and
    // T3 retain ownership of branch/worktree metadata.
    await NodeFs.rm(NodePath.join(stageDir, ".git"), { recursive: true, force: true });
    await mirrorDirectory(stageDir, NodePath.resolve(cwd));
  } finally {
    await NodeFs.rm(stageDir, { recursive: true, force: true });
  }
}

async function syncCodexHome(containerName: string, homePath: string | undefined): Promise<void> {
  const hostHome = resolveHostCodexHome(homePath);
  if (!(await pathIsDirectory(hostHome))) {
    return;
  }

  await docker(["exec", containerName, "mkdir", "-p", CONTAINER_CODEX_HOME]);
  const source = `${NodePath.resolve(hostHome)}${NodePath.sep}.`;
  await docker(["cp", source, `${containerName}:${CONTAINER_CODEX_HOME}`]);
}

function forwardedEnvironmentNames(environment: NodeJS.ProcessEnv | undefined): Array<string> {
  const source = { ...process.env, ...environment };
  const names = new Set<string>();

  for (const name of FORWARDED_ENVIRONMENT_NAMES) {
    if (source[name] !== undefined) names.add(name);
  }
  for (const name of Object.keys(environment ?? {})) {
    if (/^(?:OPENAI_|T3_MCP_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(name)) {
      names.add(name);
    }
  }

  names.delete("CODEX_HOME");
  return [...names].sort();
}

async function writeWrapper(
  containerName: string,
  environment: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  const wrapperDir = NodePath.join(NodeOs.homedir(), ".t3", WRAPPER_DIR_NAME);
  await NodeFs.mkdir(wrapperDir, { recursive: true });

  const envArgs = forwardedEnvironmentNames(environment).flatMap((name) => ["-e", name]);
  if (process.platform === "win32") {
    const path = NodePath.join(wrapperDir, `${containerName}.cmd`);
    const args = envArgs.map((value) => `"${value}"`).join(" ");
    const content = `@echo off\r\ndocker exec -i -w ${CONTAINER_WORKSPACE} ${args} ${containerName} codex %*\r\n`;
    await NodeFs.writeFile(path, content, "utf8");
    return path;
  }

  const path = NodePath.join(wrapperDir, `${containerName}.sh`);
  const args = envArgs.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
  const content = `#!/usr/bin/env sh\nexec docker exec -i -w ${CONTAINER_WORKSPACE} ${args} ${containerName} codex "$@"\n`;
  await NodeFs.writeFile(path, content, "utf8");
  await NodeFs.chmod(path, 0o755);
  return path;
}

async function prepare(input: PrepareDockerCodexSessionInput): Promise<DockerCodexSession> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"]).catch((cause) => {
      throw new Error(`Docker is not available or Docker Desktop is not running: ${errorMessage(cause)}`);
    });

    const image = process.env.T3CODE_DOCKER_IMAGE?.trim() || DEFAULT_IMAGE;
    await ensureDefaultImage(image);
    const containerName = await ensureContainer(input, image);

    // A previous app-server can survive a disconnected docker-exec client. Kill it
    // before starting a replacement session, but keep the chat container itself.
    await docker([
      "exec",
      containerName,
      "sh",
      "-lc",
      "pkill -f '[c]odex app-server' >/dev/null 2>&1 || true",
    ]);

    await syncWorkspaceToContainer(containerName, input.cwd);
    await syncCodexHome(containerName, input.homePath);
    await docker(["exec", containerName, "codex", "--version"]);

    const binaryPath = await writeWrapper(containerName, input.environment);
    return {
      containerName,
      binaryPath,
      workspacePath: CONTAINER_WORKSPACE,
      hostWorkspacePath: NodePath.resolve(input.cwd),
    };
  } catch (cause) {
    throw new Error(`Failed to prepare Docker-isolated Codex session: ${errorMessage(cause)}`);
  }
}

function asEffect(operation: () => Promise<void>, action: string): Effect.Effect<void, DockerCodexOperationError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => dockerOperationError(action, cause),
  });
}

export function prepareDockerCodexSession(
  input: PrepareDockerCodexSessionInput,
): Effect.Effect<DockerCodexSession, DockerCodexOperationError> {
  return Effect.tryPromise({
    try: () => prepare(input),
    catch: (cause) => dockerOperationError("Docker session preparation failed", cause),
  });
}

export function syncDockerWorkspaceToContainer(
  session: DockerCodexSession,
): Effect.Effect<void, DockerCodexOperationError> {
  return asEffect(
    () => syncWorkspaceToContainer(session.containerName, session.hostWorkspacePath),
    "Failed to refresh Docker workspace from host",
  );
}

export function syncDockerWorkspaceToHost(session: DockerCodexSession): Effect.Effect<void, DockerCodexOperationError> {
  return asEffect(
    () => syncWorkspaceToHost(session.containerName, session.hostWorkspacePath),
    "Failed to mirror Docker workspace back to host",
  );
}

/**
 * T3's MCP bridge listens on the host. A Dockerized Codex process must reach
 * it through Docker's host gateway instead of its own loopback interface.
 */
export function rewriteLocalUrlForDocker(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
      url.hostname = "host.docker.internal";
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}
