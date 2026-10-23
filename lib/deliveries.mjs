// The process's reads and the two changes it may ask for. Every change is a
// call to the checkout's scripts/land-queue.mjs (delivery-dock spec §4, D7):
// this file never renames a ticket, writes a sidecar or sends a signal.
//
// Reads: the queue folder (LAND_LOCK, as land.mjs), var/land-red,
// var/job-events and var/completion-receipts of the checkout. Writes:
// nothing. No git, no deploy, no PiCode session.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LINES, folderHealth, moveTarget, publishedReceipts, recentVerdicts, redBanner, rows, verifyWaiter } from "./queue.mjs";

export const lockPath = (env = process.env) => env.LAND_LOCK || "/tmp/picode-land.lock";
export const queueDir = (env = process.env) => `${lockPath(env)}.queue`;

// The default /proc reader. A missing process reads as null.
export const procfs = {
  cmdline(pid) {
    try { return readFileSync(`/proc/${pid}/cmdline`); } catch { return null; }
  },
  cwd(pid) {
    try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return ""; }
  },
};

// checkoutProblem says why a folder is not a PiCode checkout this page can
// follow, or "" when it is.
export function checkoutProblem(dir) {
  if (!dir) return LINES.unconfigured;
  if (!resolve(dir).startsWith("/") || resolve(dir) !== dir.replace(/\/+$/, "")) return "The checkout must be an absolute folder.";
  if (!existsSync(join(dir, "scripts", "land-queue.mjs")) || !existsSync(join(dir, "scripts", "land.mjs"))) return "That folder has no scripts/land-queue.mjs. Choose the COGNIX[WS] source folder.";
  return "";
}

function hasFlock(env) {
  return (env.PATH || "").split(":").some((d) => d && existsSync(join(d, "flock")));
}

export class Deliveries {
  // checkout: the PiCode repository root. env: LAND_LOCK and PATH.
  constructor({ checkout, env = process.env, proc = procfs, run = execFile, now = () => Date.now() }) {
    this.checkout = checkout.replace(/\/+$/, "");
    this.env = env;
    this.proc = proc;
    this.run = run;
    this.now = now;
    this.landPath = realPath(join(this.checkout, "scripts", "land.mjs"));
    this.receiptCache = { mtime: 0, verdicts: [] };
  }

  // landQueue runs scripts/land-queue.mjs from the checkout root (its red
  // marker and claim reads are relative to it) and answers {code, out, err}.
  landQueue(args) {
    return new Promise((done) => {
      this.run(process.execPath, [join(this.checkout, "scripts", "land-queue.mjs"), ...args], {
        cwd: this.checkout, env: { ...this.env }, timeout: 20_000, maxBuffer: 4 << 20,
      }, (err, stdout, stderr) => {
        const code = err ? (Number.isInteger(err.code) ? err.code : 1) : 0;
        let out = null;
        try { out = stdout ? JSON.parse(stdout) : null; } catch { out = null; }
        done({ code, out, err: String(stderr || "").replace(/^land-queue:\s*/gm, "").trim() });
      });
    });
  }

  async list() {
    if (!hasFlock(this.env)) return { ok: false, reason: "flock is missing" };
    const health = folderHealth(queueDir(this.env), fs);
    if (!health.ok) return { ok: false, reason: health.reason };
    const r = await this.landQueue(["list"]);
    if (r.code !== 0 || !Array.isArray(r.out?.tickets)) return { ok: false, reason: r.err || "list failed" };
    return { ok: true, tickets: r.out.tickets };
  }

  banner() {
    let text = null;
    try { text = readFileSync(join(this.checkout, "var", "land-red"), "utf8"); } catch (e) {
      if (e.code !== "ENOENT") text = "";
    }
    return redBanner(text);
  }

  // verdicts reads the job-finish spool (what the producer just wrote and
  // the daemon has not taken yet) and the receipts the producer maps,
  // through the checkout's own adapter.
  async verdicts() {
    const envelopes = [];
    const spool = join(this.checkout, "var", "job-events");
    for (const n of safeList(spool)) {
      if (!n.endsWith(".json") || n.startsWith(".")) continue;
      try { envelopes.push(JSON.parse(readFileSync(join(spool, n), "utf8"))); } catch { /* taken or partial */ }
    }
    envelopes.push(...await this.receiptVerdicts());
    return recentVerdicts(envelopes, 5);
  }

  async receiptVerdicts() {
    const dir = join(this.checkout, "var", "completion-receipts");
    let mtime = 0;
    try { mtime = statSync(dir).mtimeMs; } catch { return []; }
    if (mtime === this.receiptCache.mtime) return this.receiptCache.verdicts;
    let envelope;
    try { ({ envelope } = await import(pathToFileURL(join(this.checkout, "scripts", "job-finish-adapter.mjs")).href)); } catch { return []; }
    const recent = safeList(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .map((n) => { try { return { n, t: statSync(join(dir, n)).mtimeMs }; } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.t - a.t).slice(0, 40)
      .map(({ n }) => { try { return JSON.parse(readFileSync(join(dir, n), "utf8")); } catch { return null; } })
      .filter(Boolean);
    const out = [];
    for (const row of publishedReceipts(recent)) {
      try { const e = envelope(row); if (e) out.push(e); } catch { /* not one the adapter maps */ }
    }
    this.receiptCache = { mtime, verdicts: out };
    return out;
  }

  // snapshot is what GET /queue answers.
  async snapshot() {
    const [listed, verdicts] = await Promise.all([this.list(), this.verdicts().catch(() => [])]);
    const banner = this.banner();
    if (!listed.ok) return { state: "error", line: LINES.error, banner, rows: [], verdicts };
    const shown = rows(listed.tickets);
    return { state: shown.length ? "ok" : "empty", line: shown.length ? "" : LINES.empty, banner, rows: shown, verdicts };
  }

  // move: Move earlier, Move later, First. No signal.
  async move(ticket, how) {
    const listed = await this.list();
    if (!listed.ok) return { status: 503, error: LINES.error };
    const ordered = rows(listed.tickets);
    if (!ordered.some((r) => r.ticket === ticket)) return { status: 410, error: "That delivery is no longer in the queue." };
    const args = moveTarget(ordered, ticket, how);
    if (!args) return { status: 409, error: "It is already there." };
    const r = await this.landQueue(["move", ticket, ...args]);
    if (r.code === 0) return { status: 200, body: { ticket, prio: r.out?.prio ?? null } };
    return { status: r.code === 2 ? 409 : 500, error: r.err || "The move did not work." };
  }

  // stop: the safe stop only. The row must still be a waiting ticket with
  // no claim and the same branch the person confirmed, and the pid must be
  // this checkout's land.mjs. Then land-queue.mjs drop sends the signal.
  async stop(ticket, branch) {
    const listed = await this.list();
    if (!listed.ok) return { status: 503, error: LINES.error };
    const row = rows(listed.tickets).find((r) => r.ticket === ticket);
    if (!row) return { status: 410, error: "That delivery is no longer in the queue." };
    if (row.branch !== branch) return { status: 409, error: "That ticket now names another branch. Nothing was stopped." };
    if (!row.actions.includes("stop")) return { status: 409, error: row.reason || "This delivery cannot be stopped from here." };
    const body = readTicket(queueDir(this.env), ticket);
    const check = verifyWaiter({ ticket, body, landPath: this.landPath, proc: this.proc, real: realPath });
    if (!check.ok) return { status: 409, error: `${check.reason} Nothing was stopped.` };
    const r = await this.landQueue(["drop", ticket]);
    if (r.code === 0) return { status: 200, body: { ticket, action: r.out?.action || "signal" } };
    return { status: r.code === 2 ? 409 : 410, error: r.err || "The stop did not work." };
  }
}

function realPath(p) {
  try { return realpathSync(p); } catch { return p; }
}
function safeList(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
function readTicket(dir, ticket) {
  if (!/^\d{15}-\d+\.json$/.test(ticket)) return null;
  try { return JSON.parse(readFileSync(join(dir, ticket), "utf8")); } catch { return null; }
}
