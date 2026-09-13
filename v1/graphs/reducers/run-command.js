// Deterministic command runner (tests, builds, linters). Not a side effect: it only reads/executes and reports.
// input: { cwd?, command?, args? }  args: { command: "npm", args: ["test"], timeout_ms: 600000, cwd?: ".", ok_pattern?: "regex" }
import { spawn } from "node:child_process";
import path from "node:path";

export default async function runCommand(input, args, ctx) {
  const command = String(input.command ?? args.command ?? "npm");
  const cmdArgs = Array.isArray(input.args) ? input.args.map(String) : Array.isArray(args.args) ? args.args.map(String) : [];
  const cwd = path.resolve(String(input.cwd ?? args.cwd ?? "."));
  const timeout = Number(args.timeout_ms ?? 600000);
  const started = Date.now();
  ctx.log(`run-command: ${command} ${cmdArgs.join(" ")} (cwd ${cwd})`);
  const result = await new Promise((resolve) => {
    const child = spawn(command, cmdArgs, { cwd, shell: process.platform === "win32", env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    const t = setTimeout(() => { child.kill(); resolve({ exit_code: -1, timed_out: true, stdout: out, stderr: err }); }, timeout);
    child.on("close", (code) => { clearTimeout(t); resolve({ exit_code: code ?? -1, timed_out: false, stdout: out, stderr: err }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ exit_code: -1, timed_out: false, stdout: out, stderr: String(e.message) }); });
  });
  const tail = (s, n = 4000) => (s.length > n ? `…${s.slice(-n)}` : s);
  const okPattern = args.ok_pattern ? new RegExp(String(args.ok_pattern)) : null;
  const passed = result.exit_code === 0 && (!okPattern || okPattern.test(result.stdout + result.stderr));
  return {
    command: `${command} ${cmdArgs.join(" ")}`.trim(),
    cwd: cwd.replace(/\\/g, "/"),
    exit_code: result.exit_code,
    passed,
    timed_out: result.timed_out,
    duration_ms: Date.now() - started,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
  };
}
