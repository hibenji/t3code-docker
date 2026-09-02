#!/usr/bin/env node

import * as fs from "node:fs/promises";
import * as path from "node:path";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = path.resolve(rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd());

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

async function write(relativePath, content) {
  await fs.writeFile(path.join(root, relativePath), content, "utf8");
  console.log(`[t3code-docker] updated ${relativePath}`);
}

function replaceOnce(content, before, after, label) {
  if (!content.includes(before)) {
    throw new Error(`[t3code-docker] Could not find ${label}. Upstream changed; update the overlay instead of applying a potentially unsafe patch.`);
  }
  return content.replace(before, after);
}

async function patchDockerCodex() {
  const file = "apps/server/src/docker/DockerCodex.ts";
  let content = await read(file);

  const diagnosticsComment =
    "// @effect-diagnostics nodeBuiltinImport:off - Docker workspace mirroring and cross-platform wrapper generation intentionally use Node filesystem/process primitives around the external Docker CLI.\n";
  if (!content.startsWith("// @effect-diagnostics nodeBuiltinImport:off")) {
    content = diagnosticsComment + content;
  }

  if (!content.includes('import * as Schema from "effect/Schema";')) {
    content = replaceOnce(
      content,
      'import * as Effect from "effect/Effect";',
      'import * as Effect from "effect/Effect";\nimport * as Schema from "effect/Schema";',
      "DockerCodex Effect import",
    );
  }

  if (!content.includes("export class DockerCodexOperationError")) {
    const errorHelper = `function errorMessage(cause: unknown): string {\n  return cause instanceof Error ? cause.message : String(cause);\n}`;
    const taggedError = `${errorHelper}\n\nexport class DockerCodexOperationError extends Schema.TaggedErrorClass<DockerCodexOperationError>()(\n  "DockerCodexOperationError",\n  {\n    action: Schema.String,\n    detail: Schema.String,\n    cause: Schema.Defect(),\n  },\n) {\n  override get message(): string {\n    return \`${"${this.action}: ${this.detail}"}\`;\n  }\n}\n\nfunction dockerOperationError(action: string, cause: unknown): DockerCodexOperationError {\n  return new DockerCodexOperationError({\n    action,\n    detail: errorMessage(cause),\n    cause,\n  });\n}`;
    content = replaceOnce(content, errorHelper, taggedError, "DockerCodex error helper");
  }

  content = content.replaceAll(
    "Effect.Effect<void, Error>",
    "Effect.Effect<void, DockerCodexOperationError>",
  );
  content = content.replaceAll(
    "Effect.Effect<DockerCodexSession, Error>",
    "Effect.Effect<DockerCodexSession, DockerCodexOperationError>",
  );
  content = content.replace(
    'catch: (cause) => new Error(`${action}: ${errorMessage(cause)}`),',
    "catch: (cause) => dockerOperationError(action, cause),",
  );
  content = content.replace(
    "catch: (cause) => (cause instanceof Error ? cause : new Error(errorMessage(cause))),",
    'catch: (cause) => dockerOperationError("Docker session preparation failed", cause),',
  );

  await write(file, content);
}

async function patchCodexProvider() {
  const file = "apps/server/src/provider/Layers/CodexProvider.ts";
  let content = await read(file);
  if (content.includes('id: "dockerExecution"')) return;

  const anchor = `  return createModelCapabilities({\n    optionDescriptors,\n  });`;
  const replacement = `  optionDescriptors.push({\n    id: "dockerExecution",\n    label: "Docker isolation",\n    description:\n      "Run this chat's Codex process in a dedicated Docker container with an isolated copy of the workspace.",\n    type: "boolean",\n    currentValue: false,\n  });\n\n${anchor}`;
  content = replaceOnce(content, anchor, replacement, "Codex model capability insertion point");
  await write(file, content);
}

async function patchCodexSessionRuntime() {
  const file = "apps/server/src/provider/Layers/CodexSessionRuntime.ts";
  let content = await read(file);

  if (!content.includes("readonly processCwd?: string;")) {
    content = replaceOnce(
      content,
      `  readonly cwd: string;\n  readonly runtimeMode: RuntimeMode;`,
      `  /** Working directory reported to Codex and used by thread/start. */\n  readonly cwd: string;\n  /** Optional host working directory used only to spawn a wrapper process. */\n  readonly processCwd?: string;\n  readonly runtimeMode: RuntimeMode;`,
      "CodexSessionRuntimeOptions cwd",
    );
  }

  if (!content.includes("cwd: options.processCwd ?? options.cwd,")) {
    content = replaceOnce(
      content,
      `        ChildProcess.make(spawnCommand.command, spawnCommand.args, {\n          cwd: options.cwd,`,
      `        ChildProcess.make(spawnCommand.command, spawnCommand.args, {\n          cwd: options.processCwd ?? options.cwd,`,
      "Codex app-server spawn cwd",
    );
  }

  await write(file, content);
}

async function patchCodexAdapter() {
  const file = "apps/server/src/provider/Layers/CodexAdapter.ts";
  let content = await read(file);

  if (!content.includes("getModelSelectionBooleanOptionValue")) {
    content = replaceOnce(
      content,
      `import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";`,
      `import {\n  getModelSelectionBooleanOptionValue,\n  getModelSelectionStringOptionValue,\n} from "@t3tools/shared/model";`,
      "CodexAdapter model helper import",
    );
  }

  if (!content.includes('from "../../docker/DockerCodex.ts"')) {
    content = replaceOnce(
      content,
      `import * as McpProviderSession from "../../mcp/McpProviderSession.ts";`,
      `import * as McpProviderSession from "../../mcp/McpProviderSession.ts";\nimport {\n  prepareDockerCodexSession,\n  rewriteLocalUrlForDocker,\n  syncDockerWorkspaceToContainer,\n  syncDockerWorkspaceToHost,\n  type DockerCodexSession,\n} from "../../docker/DockerCodex.ts";`,
      "DockerCodex import",
    );
  }

  if (!content.includes("readonly dockerSession?: DockerCodexSession;")) {
    content = replaceOnce(
      content,
      `  readonly eventFiber: Fiber.Fiber<void, never>;\n  stopped: boolean;`,
      `  readonly eventFiber: Fiber.Fiber<void, never>;\n  readonly dockerSession?: DockerCodexSession;\n  stopped: boolean;`,
      "CodexAdapter session context",
    );
  }

  if (!content.includes('getModelSelectionBooleanOptionValue(input.modelSelection, "dockerExecution")')) {
    const before = `        const serviceTier =\n          input.modelSelection?.instanceId === boundInstanceId\n            ? getCodexServiceTierOptionValue(input.modelSelection)\n            : undefined;\n        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);\n        const runtimeInput: CodexSessionRuntimeOptions = {\n          threadId: input.threadId,\n          providerInstanceId: boundInstanceId,\n          cwd: input.cwd ?? process.cwd(),\n          binaryPath: codexConfig.binaryPath,\n          launchArgs: resolveCodexLaunchArgs(codexConfig.launchArgs, options?.environment),\n          ...(options?.environment ? { environment: options.environment } : {}),\n          ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),\n          ...(isCodexResumeCursorSchema(input.resumeCursor)\n            ? { resumeCursor: input.resumeCursor }\n            : {}),\n          runtimeMode: input.runtimeMode,\n          ...(input.modelSelection?.instanceId === boundInstanceId\n            ? { model: input.modelSelection.model }\n            : {}),\n          ...(serviceTier ? { serviceTier } : {}),\n          ...(mcpSession\n            ? {\n                environment: {\n                  ...(options?.environment ?? process.env),\n                  T3_MCP_BEARER_TOKEN: mcpSession.authorizationHeader.replace(/^Bearer\\s+/, ""),\n                },\n                appServerArgs: [\n                  "-c",\n                  \`mcp_servers.t3-code.url=\${mcpSession.endpoint}\`,\n                  "-c",\n                  'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',\n                ],\n              }\n            : {}),\n        };`;

    const after = `        const serviceTier =\n          input.modelSelection?.instanceId === boundInstanceId\n            ? getCodexServiceTierOptionValue(input.modelSelection)\n            : undefined;\n        const useDocker =\n          input.modelSelection?.instanceId === boundInstanceId &&\n          getModelSelectionBooleanOptionValue(input.modelSelection, "dockerExecution") === true;\n        const hostCwd = input.cwd ?? process.cwd();\n        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);\n        const runtimeEnvironment = mcpSession\n          ? {\n              ...(options?.environment ?? process.env),\n              T3_MCP_BEARER_TOKEN: mcpSession.authorizationHeader.replace(/^Bearer\\s+/, ""),\n            }\n          : options?.environment;\n        const dockerSession = useDocker\n          ? yield* prepareDockerCodexSession({\n              threadId: input.threadId,\n              cwd: hostCwd,\n              ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),\n              ...(runtimeEnvironment ? { environment: runtimeEnvironment } : {}),\n            }).pipe(\n              Effect.mapError(\n                (cause) =>\n                  new ProviderAdapterProcessError({\n                    provider: PROVIDER,\n                    threadId: input.threadId,\n                    detail: cause.message,\n                    cause,\n                  }),\n              ),\n            )\n          : undefined;\n        const runtimeInput: CodexSessionRuntimeOptions = {\n          threadId: input.threadId,\n          providerInstanceId: boundInstanceId,\n          cwd: dockerSession?.workspacePath ?? hostCwd,\n          ...(dockerSession ? { processCwd: hostCwd } : {}),\n          binaryPath: dockerSession?.binaryPath ?? codexConfig.binaryPath,\n          launchArgs: resolveCodexLaunchArgs(codexConfig.launchArgs, options?.environment),\n          ...(runtimeEnvironment ? { environment: runtimeEnvironment } : {}),\n          ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),\n          ...(isCodexResumeCursorSchema(input.resumeCursor)\n            ? { resumeCursor: input.resumeCursor }\n            : {}),\n          runtimeMode: input.runtimeMode,\n          ...(input.modelSelection?.instanceId === boundInstanceId\n            ? { model: input.modelSelection.model }\n            : {}),\n          ...(serviceTier ? { serviceTier } : {}),\n          ...(mcpSession\n            ? {\n                appServerArgs: [\n                  "-c",\n                  \`mcp_servers.t3-code.url=\${\n                    dockerSession ? rewriteLocalUrlForDocker(mcpSession.endpoint) : mcpSession.endpoint\n                  }\`,\n                  "-c",\n                  'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',\n                ],\n              }\n            : {}),\n        };`;

    content = replaceOnce(content, before, after, "CodexAdapter runtime construction");
  }

  if (!content.includes("failed to mirror Docker workspace after Codex turn")) {
    const before = `            yield* writeNativeEvent(event);\n            const runtimeEvents = mapToRuntimeEvents(event, event.threadId);`;
    const after = `            yield* writeNativeEvent(event);\n            if (dockerSession && event.method === "turn/completed") {\n              yield* syncDockerWorkspaceToHost(dockerSession).pipe(\n                Effect.catch((cause) =>\n                  Effect.logError("failed to mirror Docker workspace after Codex turn", {\n                    threadId: input.threadId,\n                    containerName: dockerSession.containerName,\n                    cause,\n                  }),\n                ),\n              );\n            }\n            const runtimeEvents = mapToRuntimeEvents(event, event.threadId);`;
    content = replaceOnce(content, before, after, "Codex event Docker sync");
  }

  if (!content.includes("...(dockerSession ? { dockerSession } : {}),")) {
    content = replaceOnce(
      content,
      `          runtime,\n          eventFiber,\n          stopped: false,`,
      `          runtime,\n          eventFiber,\n          ...(dockerSession ? { dockerSession } : {}),\n          stopped: false,`,
      "Codex session Docker state",
    );
  }

  if (!content.includes("Failed to refresh Docker workspace before Codex turn")) {
    const before = `    const session = yield* requireSession(input.threadId);\n    const reasoningEffort =`;
    const after = `    const session = yield* requireSession(input.threadId);\n    if (session.dockerSession) {\n      yield* syncDockerWorkspaceToContainer(session.dockerSession).pipe(\n        Effect.mapError(\n          (cause) =>\n            new ProviderAdapterProcessError({\n              provider: PROVIDER,\n              threadId: input.threadId,\n              detail: \`Failed to refresh Docker workspace before Codex turn: \${cause.message}\`,\n              cause,\n            }),\n        ),\n      );\n    }\n    const reasoningEffort =`;
    content = replaceOnce(content, before, after, "Codex sendTurn Docker refresh");
  }

  if (!content.includes("failed to mirror Docker workspace while stopping Codex session")) {
    const before = `    yield* session.runtime.close.pipe(Effect.ignore);\n    yield* Effect.ignore(Scope.close(session.scope, Exit.void));`;
    const after = `    yield* session.runtime.close.pipe(Effect.ignore);\n    if (session.dockerSession) {\n      yield* syncDockerWorkspaceToHost(session.dockerSession).pipe(\n        Effect.catch((cause) =>\n          Effect.logError("failed to mirror Docker workspace while stopping Codex session", {\n            threadId: session.threadId,\n            containerName: session.dockerSession?.containerName,\n            cause,\n          }),\n        ),\n      );\n    }\n    yield* Effect.ignore(Scope.close(session.scope, Exit.void));`;
    content = replaceOnce(content, before, after, "Codex stopSession Docker sync");
  }

  // Upgrade already-materialized branches from the Effect v3 name used by the
  // first overlay revision without touching unrelated upstream code.
  content = content.replace(
    "syncDockerWorkspaceToHost(dockerSession).pipe(\n                Effect.catchAll(",
    "syncDockerWorkspaceToHost(dockerSession).pipe(\n                Effect.catch(",
  );
  content = content.replace(
    "syncDockerWorkspaceToHost(session.dockerSession).pipe(\n        Effect.catchAll(",
    "syncDockerWorkspaceToHost(session.dockerSession).pipe(\n        Effect.catch(",
  );

  await write(file, content);
}

await patchDockerCodex();
await patchCodexProvider();
await patchCodexSessionRuntime();
await patchCodexAdapter();
console.log(`[t3code-docker] overlay applied successfully at ${root}`);
