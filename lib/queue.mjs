// What the page shows, decided here so the page only draws it. Pure
// functions: the process passes in what it read (land-queue.mjs list, the
// queue folder, var/land-red, the verdict files) and the clock.
//
// The queue's order, its priority sidecars and every change belong to the
// checkout's scripts/land-queue.mjs (delivery-dock spec §4). Nothing here
// sorts, renames or signals.

import { isAbsolute, resolve } from "node:path";

export const LINES = Object.freeze({
  empty: "No delivery is waiting.",
  loading: "Reading the queue…",
  error: "The queue could not be read.",
  unconfigured: "Choose the COGNIX[WS] source folder this page follows.",
  red: "Main is unverified. Deliveries wait until a green check clears it.",
  landing: "Holding main. Wait for the verdict.",
  claimed: "In a batch. Stopping it does not take it out.",
});

const TICKET = /^(\d{15})-(\d+)\.json$/;

// ticketPid is the waiter pid in a ticket's name, or NaN.
export function ticketPid(name) {
  const m = TICKET.exec(String(name || ""));
  return m ? Number(m[2]) : NaN;
}

// folderHealth reads the queue folder's listing and contents. A missing
// folder is an empty queue. An unreadable folder, or a folder where no ticket
// parses, is an error; one bad ticket among good ones is skipped.
export function folderHealth(dir, fs) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    if (e.code === "ENOENT") return { ok: true, missing: true, tickets: 0, parsed: 0 };
    return { ok: false, reason: e.code || "unreadable" };
  }
  const tickets = names.filter((n) => n.endsWith(".json"));
  let parsed = 0;
  for (const n of tickets) {
    try { JSON.parse(fs.readFileSync(`${dir}/${n}`, "utf8")); parsed++; } catch (e) {
      if (e.code === "ENOENT") parsed++; // the waiter removed it while we read
    }
  }
  if (tickets.length > 0 && parsed === 0) return { ok: false, reason: "no ticket parses" };
  return { ok: true, missing: false, tickets: tickets.length, parsed };
}

// ageLabel is a ticket's age, relative, from the process clock.
export function ageLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unknown age";
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

const STOPPABLE = new Set(["preparing", "ready"]);

// rows turns land-queue.mjs list's tickets, already in queue order, into
// what a row shows and which actions it offers. A ticket without a branch
// did not parse and is not a row (land-queue already omits dead pids).
//
// Stop is offered only on a waiting ticket with no batch claim, whose name
// and body name the same pid (spec §5). Landing and claimed rows say why.
// Moves are offered on every row; on a landing row a move is stored and
// does not take the lock (spec §3.4, §4.1).
export function rows(tickets, stages = new Map()) {
  const live = (Array.isArray(tickets) ? tickets : []).filter((t) => t && typeof t.ticket === "string" && typeof t.branch === "string" && t.branch);
  return live.map((t, i) => {
    const claim = t.claim && typeof t.claim === "object" ? String(t.claim.state || "") : "";
    const claimed = claim === "claimed";
    const state = String(t.state || "");
    const label = claimed ? "claimed" : state || "unknown";
    const samePid = Number.isInteger(t.pid) && ticketPid(t.ticket) === t.pid;
    const stop = STOPPABLE.has(state) && !claim.match(/^(claimed|done)$/) && samePid;
    // A live land's stage says what it does now; a landing row keeps its
    // warning after it (spec §3.4).
    const stage = Number.isInteger(t.pid) ? STAGE_LINE[stages.get(t.pid)] || "" : "";
    const reason = [stage, state === "landing" ? LINES.landing : claimed ? LINES.claimed : ""].filter(Boolean).join(" · ");
    const actions = [];
    if (i > 0) actions.push("earlier");
    if (i < live.length - 1) actions.push("later");
    if (i > 0) actions.push("first");
    if (stop) actions.push("stop");
    actions.push("copy-branch", "copy-pid");
    return {
      ticket: t.ticket,
      order: i + 1,
      branch: t.branch,
      pid: Number.isInteger(t.pid) ? t.pid : null,
      state: label,
      age: ageLabel(t.ageSeconds == null ? NaN : Number(t.ageSeconds)),
      prio: Number.isInteger(t.prio) ? t.prio : 0,
      reason,
      actions,
    };
  });
}

// moveTarget maps a person's move onto land-queue.mjs move arguments:
// Move earlier is --before the previous ticket, Move later --after the next,
// First --front. null when the move does not apply to that position.
export function moveTarget(ordered, ticket, how) {
  const i = ordered.findIndex((r) => r.ticket === ticket);
  if (i < 0) return null;
  if (how === "first") return i > 0 ? ["--front"] : null;
  if (how === "earlier") return i > 0 ? ["--before", ordered[i - 1].ticket] : null;
  if (how === "later") return i < ordered.length - 1 ? ["--after", ordered[i + 1].ticket] : null;
  return null;
}

// redBanner reads var/land-red's text (null when the file is absent). A
// pending marker is the fast-forward in progress: the landing row already
// says it holds main. An unreadable marker still means main is unverified.
export function redBanner(text) {
  if (text == null) return "";
  let red = {};
  try { red = JSON.parse(text) || {}; } catch { red = {}; }
  return red.pending ? "" : LINES.red;
}

// isLandCmdline says whether a process's /proc cmdline runs this checkout's
// scripts/land.mjs (landPath, a real path). A relative argument is resolved
// against the process's own working directory; real resolves links.
export function isLandCmdline(buf, cwd, landPath, real = (p) => p) {
  if (!buf || !landPath) return false;
  const args = Buffer.isBuffer(buf) ? buf.toString("utf8").split("\0") : String(buf).split("\0");
  return args.filter(Boolean).some((arg) => {
    if (!arg.endsWith("land.mjs")) return false;
    if (!isAbsolute(arg) && !cwd) return false;
    const path = isAbsolute(arg) ? resolve(arg) : resolve(cwd, arg);
    return path === landPath || real(path) === landPath;
  });
}

// verifyWaiter is the check before any signal (spec §3.3, D1): the ticket
// name's pid, the body's pid, and the pid's command line running this
// checkout's land.mjs. Anything else is refused.
export function verifyWaiter({ ticket, body, landPath, proc, real }) {
  const named = ticketPid(ticket);
  if (!Number.isInteger(named)) return { ok: false, reason: "The ticket name has no pid." };
  if (!body || body.pid !== named) return { ok: false, reason: "The ticket and its file name different processes." };
  const cmd = proc.cmdline(named);
  if (cmd == null) return { ok: false, reason: "That delivery's process is gone." };
  if (!isLandCmdline(cmd, proc.cwd(named), landPath, real)) return { ok: false, reason: "That process is not this checkout's land." };
  return { ok: true };
}

const STATES = new Set(["succeeded", "failed", "cancelled", "interrupted", "unknown"]);

// verdict keeps a picode.completion job.finished envelope's summary and
// state, or null for anything else.
export function verdict(e) {
  if (!e || e.producer !== "picode.completion" || e.eventType !== "job.finished") return null;
  if (typeof e.eventId !== "string" || !e.eventId) return null;
  return {
    eventId: e.eventId,
    summary: String(e.summary || "").slice(0, 200),
    state: STATES.has(e.state) ? e.state : "unknown",
    at: String(e.occurredAt || ""),
  };
}

// recentVerdicts merges envelopes from every source, one per event id,
// newest first.
export function recentVerdicts(envelopes, limit = 5) {
  const seen = new Map();
  for (const e of envelopes) {
    const v = verdict(e);
    if (v && !seen.has(v.eventId)) seen.set(v.eventId, v);
  }
  return [...seen.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

// publishedReceipts picks the receipts picode.completion publishes as
// envelopes: every finished land, and a CI run that no land owns (a CI
// correlated to a land shares that land's operation id and publishes
// nothing of its own). The daemon consumes var/job-events, so the receipt
// is what stays to read.
export function publishedReceipts(receipts) {
  const lands = new Set(receipts.filter((r) => r?.kind === "land" || r?.kind === "pending").map((r) => r.id));
  return receipts.filter((r) => r && (r.kind === "land" || (r.kind === "ci" && !lands.has(r.operation))));
}

// ---- gates and land stages (ADR-0170 delivery receipts) ------------------
// The checkout's scripts write one receipt per `make ci-scoped`, `make ci`
// and `make land` under <git common dir>/picode-delivery/, with the pid that
// lives for the whole command, what started it (via: close, land), its phase
// (waiting for a CI slot, running) and, for a land, its stage. A started
// receipt whose pid is gone ran into a signal or a crash and is not shown.

const GATE_KIND = { scoped: "make ci-scoped", "full-ci": "make ci" };
const PHASE_LINE = { waiting: "Waiting for a CI slot", running: "Running checks" };
export const STAGE_LINE = Object.freeze({
  queued: "Waiting its turn",
  close: "Running make close",
  verify: "Merging onto main and running make ci",
  "fast-forward": "Moving main",
  checks: "Checking main",
});

// gateLabel names what ran: the command, or the step that ran it.
export function gateLabel(r) {
  if (r.via === "close") return "make close";
  if (r.via === "land") return r.kind === "full-ci" ? "land · make ci" : "land · make close";
  return GATE_KIND[r.kind] || r.kind;
}

const where = (r) => {
  const ref = String(r.sourceRef || "");
  if (ref) return ref;
  const top = String(r.worktree || "");
  return top ? top.split("/").filter(Boolean).pop() : "";
};

// runningGates is what runs now: started scoped or full-ci receipts whose
// pid is alive, oldest first. A land shows on its queue row, not here.
export function runningGates(receipts, { alive, now }) {
  return (Array.isArray(receipts) ? receipts : [])
    .filter((r) => r && r.outcome === "started" && GATE_KIND[r.kind] && Number.isInteger(r.pid) && alive(r.pid))
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
    .map((r) => ({
      id: r.id,
      label: gateLabel(r),
      branch: where(r),
      phase: r.phase === "waiting" ? "waiting" : "running",
      line: PHASE_LINE[r.phase === "waiting" ? "waiting" : "running"],
      age: ageLabel((now - Date.parse(r.startedAt)) / 1000),
      pid: r.pid,
    }));
}

// landStages maps a live land's waiter pid to the step it is on.
export function landStages(receipts, alive) {
  const out = new Map();
  for (const r of Array.isArray(receipts) ? receipts : []) {
    if (r && r.kind === "land" && r.outcome === "started" && Number.isInteger(r.pid) && STAGE_LINE[r.stage] && alive(r.pid)) out.set(r.pid, r.stage);
  }
  return out;
}

const minutes = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
};

// gateVerdicts turns finished worktree gates into verdict envelopes, merged
// with the land and CI completions: a gate on main, or one a land ran, is
// already in those.
export function gateVerdicts(receipts) {
  return (Array.isArray(receipts) ? receipts : [])
    .filter((r) => r && GATE_KIND[r.kind] && (r.outcome === "passed" || r.outcome === "failed") && r.via !== "land" && r.sourceRef !== "main")
    .map((r) => ({
      producer: "picode.completion",
      eventType: "job.finished",
      eventId: "gate:" + r.id,
      state: r.outcome === "passed" ? "succeeded" : "failed",
      summary: `${gateLabel(r)} ${r.outcome}: ${where(r) || "a worktree"}${minutes(Date.parse(r.finishedAt) - Date.parse(r.startedAt)) ? " · " + minutes(Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : ""}`,
      occurredAt: r.finishedAt,
    }));
}
