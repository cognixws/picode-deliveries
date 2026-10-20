#!/usr/bin/env node
// The repository's lint: syntax of every script, the manifest's dock rules,
// and the guards of the delivery-dock spec (§3.5, A10) on our own source.
// Exit 0 clean, 1 with every finding on stderr.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const problems = [];
const say = (file, msg) => problems.push(`${relative(root, file) || file}: ${msg}`);

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "var" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(root);
const scripts = files.filter((f) => /\.(mjs|js)$/.test(f));

// 1. Syntax.
for (const f of scripts) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) say(f, `syntax: ${r.stderr.trim().split("\n")[0]}`);
}

// 2. A10: nothing imports PiCode's core.
const SPEC = /(?:import\s[^"']*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;
for (const f of scripts) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(SPEC)) {
    if (/(^|\/)(internal|web)\//.test(m[1]) || m[1].startsWith("@picode/")) say(f, `imports PiCode's core: ${m[1]}`);
  }
}

// 3. §3.5 / D1: the process and its library never signal, write, run git or
// deploy. Changes go through the checkout's land-queue.mjs only. Tests and
// this file are exempt (fixtures start and stop their own fake waiters).
const product = scripts.filter((f) => !f.includes("/test/") && !f.includes("/scripts/"));
const BANNED = [
  [/process\.kill\s*\(/, "sends a signal itself; only land-queue.mjs drop may"],
  [/SIGKILL/, "names SIGKILL"],
  [/\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|mkdir|mkdirSync)\s*\(/, "writes to disk"],
  [/["'`]git["'`]/, "runs git"],
  [/make\s+(deploy|land)/, "deploys or lands"],
  [/PICODE_TOKEN|picode-session|X-PiCode-Client/, "reads PiCode's session"],
];
for (const f of product) {
  const text = readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const [re, why] of BANNED) if (re.test(text)) say(f, why);
}

// 4. The manifest: one dock panel under door G's rules, no permission, no
// agent part.
const mf = join(root, "picode-extension.json");
try {
  const m = JSON.parse(readFileSync(mf, "utf8"));
  const pages = new Set((m.ui?.pages || []).map((p) => p.id));
  const dock = m.contributes?.dockPanels || [];
  if (m.apiVersion !== 10) say(mf, "dockPanels requires apiVersion 10");
  if (dock.length < 1 || dock.length > 2) say(mf, "one or two dock panels");
  for (const p of dock) {
    if (!p.title || p.title.length > 24) say(mf, `dock panel ${p.id}: title 1 to 24 characters`);
    if (!pages.has(p.page) || p.site) say(mf, `dock panel ${p.id}: a page in ui.pages`);
  }
  if (m.permissions?.length) say(mf, "declares Host API permissions");
  if (m.agent) say(mf, "declares an agent part (no agent verbs)");
} catch (e) { say(mf, e.message); }

if (problems.length) {
  process.stderr.write(problems.join("\n") + "\n");
  process.exit(1);
}
process.stdout.write(`lint: ${scripts.length} scripts, manifest ok\n`);
