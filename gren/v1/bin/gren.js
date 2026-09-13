#!/usr/bin/env node
// gren CLI entrypoint. Prefers the compiled build; falls back to tsx for source checkouts.
import { existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "cli", "main.js");

function newestMtimeMs(dir) {
  let newest = -Infinity;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeMs(full));
    } else if (entry.isFile()) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // ignore unreadable file
      }
    }
  }
  return newest;
}

function warnIfDistStale() {
  try {
    const distMtimeMs = statSync(dist).mtimeMs;
    const srcDir = path.join(here, "..", "src");
    const newestSrcMtimeMs = newestMtimeMs(srcDir);
    if (newestSrcMtimeMs > distMtimeMs) {
      console.error("dist is stale, run npm run build");
    }
  } catch {
    // best-effort check; never block execution on failure
  }
}

if (existsSync(dist)) {
  warnIfDistStale();
  await import(pathToFileURL(dist).href);
} else {
  const { spawn } = await import("node:child_process");
  const src = path.join(here, "..", "src", "cli", "main.ts");
  const child = spawn(process.execPath, ["--import", "tsx", src, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}
