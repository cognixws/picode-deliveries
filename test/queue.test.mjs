import { test } from "node:test";
import assert from "node:assert/strict";
import { LINES, ageLabel, folderHealth, gateVerdicts, isLandCmdline, landStages, moveTarget, publishedReceipts, recentVerdicts, redBanner, rows, runningGates, ticketPid, verifyWaiter } from "../lib/queue.mjs";

const T = (ms, pid) => `${String(ms).padStart(15, "0")}-${pid}.json`;
const ticket = (o) => ({ ticket: T(o.ms ?? 1, o.pid ?? 100), branch: "feat/x", pid: o.pid ?? 100, state: "ready", prio: 0, claim: null, ageSeconds: 30, ...o });

test("ticketPid reads the waiter pid from the name", () => {
  assert.equal(ticketPid(T(1760000000000, 4242)), 4242);
  assert.ok(Number.isNaN(ticketPid("garbage.json")));
  assert.ok(Number.isNaN(ticketPid("1-2.json")));
});

test("rows keep land-queue's order and number them", () => {
  const out = rows([ticket({ branch: "feat/a", ms: 3, pid: 1 }), ticket({ branch: "feat/b", ms: 1, pid: 2 }), ticket({ branch: "feat/c", ms: 2, pid: 3 })]);
  assert.deepEqual(out.map((r) => [r.order, r.branch]), [[1, "feat/a"], [2, "feat/b"], [3, "feat/c"]]);
});

test("a ticket that did not parse is not a row", () => {
  const out = rows([ticket({ branch: "" }), { ticket: T(2, 5) }, null, ticket({ branch: "feat/ok", pid: 6, ms: 3 })]);
  assert.deepEqual(out.map((r) => r.branch), ["feat/ok"]);
});

test("age is relative and says Unknown age without a time", () => {
  assert.equal(ageLabel(10), "just now");
  assert.equal(ageLabel(600), "10 min");
  assert.equal(ageLabel(7200), "2 h");
  assert.equal(ageLabel(3 * 86400), "3 d");
  assert.equal(ageLabel(NaN), "Unknown age");
  assert.equal(rows([ticket({ ageSeconds: null })])[0].age, "Unknown age");
});

// Spec §5: Stop only on a waiting ticket with no claim whose name and body
// name the same pid. Landing and claimed rows have no Stop and say why.
test("safe-row rules", () => {
  const cases = [
    ["preparing", null, 100, true, ""],
    ["ready", null, 100, true, ""],
    ["ready", { state: "released" }, 100, true, ""],
    ["landing", null, 100, false, LINES.landing],
    ["ready", { state: "claimed", leaderPid: 9 }, 100, false, LINES.claimed],
    ["preparing", { state: "claimed" }, 100, false, LINES.claimed],
    ["ready", { state: "done" }, 100, false, ""],
    ["ready", null, 999, false, ""], // body pid differs from the name's
    ["merging", null, 100, false, ""], // a state a newer land adds
  ];
  for (const [state, claim, pid, stop, reason] of cases) {
    const [r] = rows([{ ...ticket({ state, claim }), pid }]);
    assert.equal(r.actions.includes("stop"), stop, `${state} ${JSON.stringify(claim)} pid ${pid}`);
    assert.equal(r.reason, reason, `${state} reason`);
  }
});

test("state shows claimed when the batch file says so, the raw state otherwise", () => {
  assert.equal(rows([ticket({ claim: { state: "claimed" } })])[0].state, "claimed");
  assert.equal(rows([ticket({ state: "merging" })])[0].state, "merging");
  assert.equal(rows([ticket({ state: "" })])[0].state, "unknown");
});

test("moves follow the position; a landing row keeps its moves", () => {
  const out = rows([ticket({ state: "landing", ms: 1, pid: 1 }), ticket({ ms: 2, pid: 2 }), ticket({ ms: 3, pid: 3 })]);
  assert.deepEqual(out[0].actions, ["later", "copy-branch", "copy-pid"]);
  assert.deepEqual(out[1].actions, ["earlier", "later", "first", "stop", "copy-branch", "copy-pid"]);
  assert.deepEqual(out[2].actions, ["earlier", "first", "stop", "copy-branch", "copy-pid"]);
});

test("moveTarget maps onto land-queue.mjs move flags", () => {
  const o = [{ ticket: "a" }, { ticket: "b" }, { ticket: "c" }];
  assert.deepEqual(moveTarget(o, "b", "earlier"), ["--before", "a"]);
  assert.deepEqual(moveTarget(o, "b", "later"), ["--after", "c"]);
  assert.deepEqual(moveTarget(o, "c", "first"), ["--front"]);
  assert.equal(moveTarget(o, "a", "earlier"), null);
  assert.equal(moveTarget(o, "a", "first"), null);
  assert.equal(moveTarget(o, "c", "later"), null);
  assert.equal(moveTarget(o, "zz", "first"), null);
  assert.equal(moveTarget(o, "b", "drag"), null);
});

test("land-red banner: shown unless the marker is pending", () => {
  assert.equal(redBanner(null), "");
  assert.equal(redBanner(JSON.stringify({ branch: "feat/x", time: "t" })), LINES.red);
  assert.equal(redBanner(JSON.stringify({ branch: "feat/x", pending: true })), "");
  assert.equal(redBanner("not json"), LINES.red);
  assert.equal(redBanner(""), LINES.red);
});

function fakeFs(files) {
  return {
    readdirSync(dir) {
      if (files === "ENOENT") throw Object.assign(new Error("no"), { code: "ENOENT" });
      if (files === "EACCES") throw Object.assign(new Error("no"), { code: "EACCES" });
      return Object.keys(files);
    },
    readFileSync(p) { return files[p.split("/").pop()]; },
  };
}

test("folder health: missing is empty, unreadable or all-bad is an error, one bad is skipped", () => {
  assert.deepEqual(folderHealth("/q", fakeFs("ENOENT")), { ok: true, missing: true, tickets: 0, parsed: 0 });
  assert.equal(folderHealth("/q", fakeFs("EACCES")).ok, false);
  assert.equal(folderHealth("/q", fakeFs({ [T(1, 1)]: "{bad", [T(2, 2)]: "nope" })).ok, false);
  const one = folderHealth("/q", fakeFs({ [T(1, 1)]: "{bad", [T(2, 2)]: "{}", "x.prio": "1" }));
  assert.equal(one.ok, true);
  assert.equal(one.parsed, 1);
  assert.equal(folderHealth("/q", fakeFs({})).ok, true);
});

const LAND = "/repo/scripts/land.mjs";
const argv = (...a) => Buffer.from(a.join("\0") + "\0");

test("cmdline check: only this checkout's land.mjs", () => {
  assert.equal(isLandCmdline(argv("node", "scripts/land.mjs", "feat/x"), "/repo", LAND), true);
  assert.equal(isLandCmdline(argv("node", "/repo/scripts/land.mjs", "feat/x"), "/elsewhere", LAND), true);
  assert.equal(isLandCmdline(argv("node", "scripts/land.mjs"), "/other-repo", LAND), false);
  assert.equal(isLandCmdline(argv("node", "/other/scripts/land.mjs"), "/repo", LAND), false);
  assert.equal(isLandCmdline(argv("sleep", "30"), "/repo", LAND), false);
  assert.equal(isLandCmdline(argv("vim", "/repo/scripts/land.mjs.bak"), "/repo", LAND), false);
  assert.equal(isLandCmdline(null, "/repo", LAND), false);
});

test("cmdline check follows a linked checkout to the real land.mjs", () => {
  const real = (p) => p.replace("/linked/", "/repo/");
  assert.equal(isLandCmdline(argv("node", "/linked/scripts/land.mjs"), "/", LAND, real), true);
  assert.equal(isLandCmdline(argv("node", "scripts/land.mjs"), "/linked", LAND, real), true);
  assert.equal(isLandCmdline(argv("node", "scripts/land.mjs"), "/other", LAND, real), false);
});

test("verifyWaiter refuses a foreign pid, a pid mismatch and a gone process", () => {
  const proc = (cmds) => ({ cmdline: (pid) => cmds[pid] ?? null, cwd: () => "/repo" });
  const ok = verifyWaiter({ ticket: T(1, 10), body: { pid: 10 }, landPath: LAND, proc: proc({ 10: argv("node", "scripts/land.mjs", "feat/x") }) });
  assert.deepEqual(ok, { ok: true });
  assert.equal(verifyWaiter({ ticket: T(1, 11), body: { pid: 11 }, landPath: LAND, proc: proc({ 11: argv("sleep", "30") }) }).ok, false);
  assert.equal(verifyWaiter({ ticket: T(1, 12), body: { pid: 13 }, landPath: LAND, proc: proc({ 12: argv("node", "scripts/land.mjs") }) }).ok, false);
  assert.equal(verifyWaiter({ ticket: T(1, 14), body: { pid: 14 }, landPath: LAND, proc: proc({}) }).ok, false);
  assert.equal(verifyWaiter({ ticket: "x.json", body: { pid: 1 }, landPath: LAND, proc: proc({}) }).ok, false);
});

test("verdicts: picode.completion job.finished only, one per id, newest first", () => {
  const e = (id, at, o = {}) => ({ producer: "picode.completion", eventType: "job.finished", eventId: id, occurredAt: at, state: "succeeded", summary: `Land success: ${id}`, ...o });
  const out = recentVerdicts([e("a", "2026-10-20T10:00:00Z"), e("b", "2026-10-20T12:00:00Z"), e("a", "2026-10-20T10:00:00Z"), e("c", "2026-10-20T11:00:00Z", { producer: "picode.panic" }), e("d", "2026-10-20T09:00:00Z", { state: "weird" })], 5);
  assert.deepEqual(out.map((v) => v.eventId), ["b", "a", "d"]);
  assert.equal(out[2].state, "unknown");
  assert.equal(recentVerdicts([e("a", "1"), e("b", "2"), e("c", "3")], 2).length, 2);
});

test("published receipts: lands and CI runs no land owns", () => {
  const out = publishedReceipts([
    { id: "L1", operation: "L1", kind: "land" },
    { id: "C1", operation: "L1", kind: "ci" },
    { id: "C2", operation: "X", kind: "ci" },
    { id: "P1", operation: "P1", kind: "pending" },
    { id: "C3", operation: "P1", kind: "ci" },
  ]);
  assert.deepEqual(out.map((r) => r.id), ["L1", "C2"]);
});

// ---- gates and land stages ----------------------------------------------

const at = (s) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();
const receipt = (o) => ({ schemaVersion: 1, id: o.id || "r", kind: "scoped", sourceRef: "feat/x", outcome: "started", startedAt: at(0), ...o });

test("running now: live started gates, oldest first, with their step and phase", () => {
  const alive = (pid) => pid !== 9;
  const out = runningGates([
    receipt({ id: "a", pid: 1, phase: "running", via: "close", startedAt: at(10) }),
    receipt({ id: "b", pid: 2, phase: "waiting", kind: "full-ci", startedAt: at(5) }),
    receipt({ id: "dead", pid: 9 }),
    receipt({ id: "nopid" }),
    receipt({ id: "land", kind: "land", pid: 3 }),
    receipt({ id: "done", pid: 4, outcome: "passed", finishedAt: at(20) }),
  ], { alive, now: Date.parse(at(0)) + 600_000 });
  assert.deepEqual(out.map((g) => [g.id, g.label, g.phase, g.line]), [
    ["b", "make ci", "waiting", "Waiting for a CI slot"],
    ["a", "make close", "running", "Running checks"],
  ]);
  assert.equal(out[1].branch, "feat/x");
  assert.equal(out[1].age, "10 min");
});

test("a live land's stage reaches its queue row", () => {
  const stages = landStages([receipt({ kind: "land", pid: 77, stage: "verify" }), receipt({ kind: "land", pid: 78, stage: "close" })], (pid) => pid === 77);
  const [row] = rows([{ ticket: "000000000000001-77.json", branch: "feat/x", pid: 77, state: "landing", ageSeconds: 30 }], stages);
  assert.equal(row.reason, "Merging onto main and running make ci · Holding main. Wait for the verdict.");
  const [other] = rows([{ ticket: "000000000000002-78.json", branch: "feat/y", pid: 78, state: "ready", ageSeconds: 30 }], stages);
  assert.equal(other.reason, "");
});

test("finished worktree gates become verdicts; main and land gates do not", () => {
  const out = gateVerdicts([
    receipt({ id: "p", outcome: "passed", via: "close", startedAt: at(0), finishedAt: at(125) }),
    receipt({ id: "f", outcome: "failed", kind: "full-ci", startedAt: at(0), finishedAt: at(30) }),
    receipt({ id: "m", outcome: "passed", sourceRef: "main", finishedAt: at(9) }),
    receipt({ id: "l", outcome: "passed", via: "land", finishedAt: at(9) }),
    receipt({ id: "s", outcome: "started" }),
  ]);
  assert.deepEqual(out.map((v) => [v.eventId, v.state, v.summary]), [
    ["gate:p", "succeeded", "make close passed: feat/x · 2 min 05 s"],
    ["gate:f", "failed", "make ci failed: feat/x · 30 s"],
  ]);
});
