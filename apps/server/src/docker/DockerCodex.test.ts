import * as NodeAssert from "node:assert/strict";

import { ThreadId } from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";

import { dockerContainerNameForThread, rewriteLocalUrlForDocker } from "./DockerCodex.ts";

describe("DockerCodex", () => {
  it("creates deterministic Docker-safe per-thread container names", () => {
    const threadId = ThreadId.make("Thread / With Spaces + Unsafe Characters");
    const name = dockerContainerNameForThread(threadId);

    NodeAssert.equal(name, "t3code-thread-with-spaces-unsafe-characters");
    NodeAssert.match(name, /^t3code-[a-z0-9_.-]+$/u);
  });

  it("rewrites host-loopback MCP URLs for Docker", () => {
    NodeAssert.equal(
      rewriteLocalUrlForDocker("http://127.0.0.1:43123/mcp?thread=abc"),
      "http://host.docker.internal:43123/mcp?thread=abc",
    );
    NodeAssert.equal(
      rewriteLocalUrlForDocker("http://localhost:43123/mcp"),
      "http://host.docker.internal:43123/mcp",
    );
  });

  it("leaves non-local URLs unchanged", () => {
    NodeAssert.equal(
      rewriteLocalUrlForDocker("https://relay.example.test/mcp"),
      "https://relay.example.test/mcp",
    );
  });

  it("does not throw on malformed URL input", () => {
    NodeAssert.equal(rewriteLocalUrlForDocker("not a URL"), "not a URL");
  });
});
