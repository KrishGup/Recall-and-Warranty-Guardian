// Assemble the copyable starter kit in ./kit: a packed gren tarball, a package.json that depends on it,
// the skill, the MCP config, project notes and the starter graphs. Run: npm run kit
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const kit = path.join(root, "kit");
const readme = path.join(kit, "README.md");
const keepReadme = fs.existsSync(readme) ? fs.readFileSync(readme, "utf8") : undefined;

execSync("npm run build", { cwd: root, stdio: "inherit" });
fs.rmSync(kit, { recursive: true, force: true });
fs.mkdirSync(kit, { recursive: true });
const tgz = execSync("npm pack --pack-destination kit", { cwd: root, encoding: "utf8" }).trim().split("\n").pop();
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

fs.writeFileSync(
  path.join(kit, "package.json"),
  JSON.stringify(
    {
      name: "my-gren-project",
      private: true,
      version: "0.1.0",
      type: "module",
      description: "A project that runs graph-engineered multi-agent workflows with gren",
      scripts: { gren: "gren", ui: "gren ui", mcp: "gren mcp", validate: "gren validate graphs/starter-fork-join.yaml", "demo:mock": "gren run graphs/starter-fork-join.yaml --bridge mock --auto-approve --input @graphs/inputs/starter.json" },
      dependencies: { gren: `file:./${tgz}` },
      engines: { node: ">=20" },
    },
    null,
    2,
  ) + "\n",
);
fs.mkdirSync(path.join(kit, "graphs", "inputs"), { recursive: true });
fs.writeFileSync(path.join(kit, "graphs", "inputs", "starter.json"), JSON.stringify({ task: "Should a five-person product team adopt graph-based orchestration for their LLM agents this quarter?" }, null, 2) + "\n");
// gren init does the rest (skill, .mcp.json, CLAUDE.md, graphs, reducers, .gitignore)
execSync(`node bin/gren.js init "${kit}" --force`, { cwd: root, stdio: "inherit" });
if (keepReadme) fs.writeFileSync(readme, keepReadme);
console.log(`\nkit assembled in ${kit} (gren ${version}, ${tgz})`);
