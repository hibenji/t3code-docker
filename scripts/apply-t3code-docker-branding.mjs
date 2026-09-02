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
  console.log(`[t3code-docker] branded ${relativePath}`);
}

function replaceOnce(content, before, after, label) {
  if (content.includes(after)) return content;
  if (!content.includes(before)) {
    throw new Error(
      `[t3code-docker] Could not find ${label}. Upstream changed; update the branding overlay instead of applying a potentially unsafe patch.`,
    );
  }
  return content.replace(before, after);
}

async function patchDesktopPackage() {
  const file = "apps/desktop/package.json";
  const raw = await read(file);
  const json = JSON.parse(raw);
  json.productName = "T3 Code Docker";
  await write(file, `${JSON.stringify(json, null, 2)}\n`);
}

async function patchBuildScript() {
  const file = "scripts/build-desktop-artifact.ts";
  let content = await read(file);
  content = replaceOnce(
    content,
    'const DESKTOP_APP_ID = "com.t3tools.t3code";',
    'const DESKTOP_APP_ID = "com.hibenji.t3code-docker";',
    "desktop app id",
  );
  content = replaceOnce(
    content,
    'artifactName: "T3-Code-${version}-${arch}.${ext}",',
    'artifactName: "T3-Code-Docker-${version}-${arch}.${ext}",',
    "desktop artifact name",
  );
  await write(file, content);
}

async function patchDesktopProtocol() {
  const file = "apps/desktop/src/electron/ElectronProtocol.ts";
  let content = await read(file);
  content = replaceOnce(
    content,
    'export const DESKTOP_PRODUCTION_SCHEME = "t3code";',
    'export const DESKTOP_PRODUCTION_SCHEME = "t3code-docker";',
    "production desktop protocol",
  );
  content = replaceOnce(
    content,
    'export const DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";',
    'export const DESKTOP_DEVELOPMENT_SCHEME = "t3code-docker-dev";',
    "development desktop protocol",
  );
  await write(file, content);
}

await patchDesktopPackage();
await patchBuildScript();
await patchDesktopProtocol();

console.log(`[t3code-docker] side-by-side branding applied successfully at ${root}`);
