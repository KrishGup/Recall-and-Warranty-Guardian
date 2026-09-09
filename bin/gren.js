#!/usr/bin/env node
// gren CLI entrypoint. Prefers the compiled build; falls back to tsx for source checkouts.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "cli", "main.js");
if (existsSync(dist)) {
  await import(pathToFileURL(dist).href);
} else {
  const { spawn } = await import("node:child_process");
  const src = path.join(here, "..", "src", "cli", "main.ts");
  const child = spawn(process.execPath, ["--import", "tsx", src, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}
