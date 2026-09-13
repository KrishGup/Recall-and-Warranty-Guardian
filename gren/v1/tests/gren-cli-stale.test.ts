import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// These tests exercise bin/gren.js's dist-staleness warning by constructing a
// minimal fixture checkout (bin/ + dist/ + src/) so we can control mtimes
// without touching the real repo's dist/src trees.

let tmp: string;

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gren-cli-test-"));
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "dist", "cli"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "cli"), { recursive: true });

  const binSrc = fs.readFileSync(path.join(__dirname, "..", "bin", "gren.js"), "utf8");
  fs.writeFileSync(path.join(dir, "bin", "gren.js"), binSrc);

  // A trivial compiled entry point that just exits cleanly.
  fs.writeFileSync(path.join(dir, "dist", "cli", "main.js"), "process.exitCode = 0;\n");
  fs.writeFileSync(path.join(dir, "src", "cli", "main.ts"), "export {};\n");

  return dir;
}

function run(dir: string) {
  return spawnSync(process.execPath, [path.join(dir, "bin", "gren.js")], {
    encoding: "utf8",
  });
}

describe("bin/gren.js dist staleness warning", () => {
  beforeAll(() => {
    tmp = makeFixture();
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("does not warn when dist is newer than all src files", () => {
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(tmp, "src", "cli", "main.ts"), past, past);
    const now = new Date();
    fs.utimesSync(path.join(tmp, "dist", "cli", "main.js"), now, now);

    const result = run(tmp);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/dist is stale/i);
  });

  it("warns on stderr when a src file is newer than dist/cli/main.js", () => {
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(tmp, "dist", "cli", "main.js"), past, past);
    const now = new Date();
    fs.utimesSync(path.join(tmp, "src", "cli", "main.ts"), now, now);

    const result = run(tmp);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/dist is stale, run npm run build/i);
  });
});
