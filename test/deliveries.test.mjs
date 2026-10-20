// The process against the real scripts/land-queue.mjs of a PiCode checkout
// (PICODE_CHECKOUT, default ../picode), on a queue of its own (LAND_LOCK in
// a temporary folder). Fake waiters are node processes whose command line
// names that checkout's land.mjs; a foreign pid is a plain sleep.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { Deliveries } from "../lib/deliveries.mjs";
import { LINES } from "../lib/queue.mjs";

const here = new URL("..", import.meta.url).pathname;
const checkout = resolve(process.env.PICODE_CHECKOUT || join(here, "..", "picode"));
const have = existsSync(join(checkout, "scripts", "land-queue.mjs"));
const skip = have ? false : `no PiCode checkout at ${checkout} (set PICODE_CHECKOUT)`;
const landPath = join(checkout, "scripts", "land.mjs");

let tmp, lock, qdir, env;
const kids = [];
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "deliveries-"));
  lock = join(tmp, "land.lock");
  qdir = `${lock}.queue`;
  env = { ...process.env, LAND_LOCK: lock };
});
after(() => {
  for (const k of kids) { try { k.kill("SIGTERM"); } catch { /* gone */ } }
  rmSync(tmp, { recursive: true, force: true });
});

const name = (ms, pid) => `${String(ms).padStart(15, "0")}-${pid}.json`;

// A fake waiter: its argv names the checkout's land.mjs (node ignores
// arguments after -e code), and on SIGTERM it removes its own ticket and
// exits 143, as the real waiter does.
function waiter() {
  const code = `const fs=require("fs");process.on("SIGTERM",()=>{for(const n of fs.readdirSync(process.env.QDIR))if(n.endsWith("-"+process.pid+".json"))fs.rmSync(process.env.QDIR+"/"+n);process.exit(143)});setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ["-e", code, landPath, "feat/x"], { env: { ...env, QDIR: qdir }, stdio: "ignore" });
  kids.push(child);
  return child;
}
function foreign() {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  kids.push(child);
  return child;
}
const exited = (child) => new Promise((ok) => (child.exitCode != null || child.signalCode ? ok(child.exitCode) : child.once("exit", (c) => ok(c))));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function fresh() {
  rmSync(qdir, { recursive: true, force: true });
  rmSync(`${lock}.batch`, { recursive: true, force: true });
  mkdirSync(qdir, { recursive: true });
}
function put(ms, pid, body) {
  const n = name(ms, pid);
  writeFileSync(join(qdir, n), JSON.stringify({ pid, time: new Date(Date.now() - 120_000).toISOString(), worktree: "/w", state: "ready", ...body }));
  return n;
}

test("a missing queue folder is an empty queue, not an error", { skip }, async () => {
  rmSync(qdir, { recursive: true, force: true });
  const s = await new Deliveries({ checkout, env }).snapshot();
  assert.equal(s.state, "empty");
  assert.equal(s.line, LINES.empty);
});

test("rows in land-queue order, dead pids omitted, one bad ticket skipped", { skip }, async () => {
  fresh();
  const a = waiter(), b = waiter();
  put(1, a.pid, { branch: "feat/a" });
  put(2, b.pid, { branch: "feat/b", state: "preparing" });
  put(3, 999_999_9, { branch: "feat/dead" });
  writeFileSync(join(qdir, name(4, b.pid)), "{not json");
  const s = await new Deliveries({ checkout, env }).snapshot();
  assert.equal(s.state, "ok");
  assert.deepEqual(s.rows.map((r) => [r.order, r.branch, r.state]), [[1, "feat/a", "ready"], [2, "feat/b", "preparing"]]);
  assert.equal(s.rows[0].age, "2 min");
});

test("every ticket unreadable is an error with Retry", { skip }, async () => {
  fresh();
  const a = waiter();
  writeFileSync(join(qdir, name(1, a.pid)), "{nope");
  const s = await new Deliveries({ checkout, env }).snapshot();
  assert.equal(s.state, "error");
  assert.equal(s.line, LINES.error);
});

test("flock missing is an error", { skip }, async () => {
  fresh();
  const s = await new Deliveries({ checkout, env: { ...env, PATH: "/nonexistent" } }).snapshot();
  assert.equal(s.state, "error");
});

test("Move earlier / later / First go through land-queue.mjs and the order follows", { skip }, async () => {
  fresh();
  const [a, b, c] = [waiter(), waiter(), waiter()];
  const ta = put(1, a.pid, { branch: "feat/a" }), tb = put(2, b.pid, { branch: "feat/b" }), tc = put(3, c.pid, { branch: "feat/c" });
  const d = new Deliveries({ checkout, env });
  const order = async () => (await d.snapshot()).rows.map((r) => r.branch);
  assert.equal((await d.move(tc, "first")).status, 200);
  assert.deepEqual(await order(), ["feat/c", "feat/a", "feat/b"]);
  assert.ok(existsSync(join(qdir, `${tc}.prio`)), "the sidecar is land-queue's");
  assert.equal((await d.move(tb, "earlier")).status, 200);
  assert.deepEqual(await order(), ["feat/c", "feat/b", "feat/a"]);
  assert.equal((await d.move(tc, "later")).status, 200);
  assert.deepEqual(await order(), ["feat/b", "feat/c", "feat/a"]);
  assert.equal((await d.move(tb, "earlier")).status, 409, "already first");
  assert.equal((await d.move(name(9, 1), "first")).status, 410);
  assert.ok(alive(a.pid) && alive(b.pid) && alive(c.pid), "a move signals nobody");
  void ta;
});

test("a landing row is pinned first and a move does not take its place", { skip }, async () => {
  fresh();
  const [a, b] = [waiter(), waiter()];
  put(1, a.pid, { branch: "feat/head", state: "landing" });
  const tb = put(2, b.pid, { branch: "feat/b" });
  const d = new Deliveries({ checkout, env });
  assert.equal((await d.move(tb, "first")).status, 200);
  const s = await d.snapshot();
  assert.deepEqual(s.rows.map((r) => r.branch), ["feat/head", "feat/b"]);
  assert.equal(s.rows[0].reason, LINES.landing);
  assert.ok(!s.rows[0].actions.includes("stop"));
});

test("Stop on a waiting ticket: land-queue drop signals the waiter; the ticket goes", { skip }, async () => {
  fresh();
  const w = waiter();
  const tk = put(1, w.pid, { branch: "feat/stop" });
  const d = new Deliveries({ checkout, env });
  assert.equal((await d.stop(tk, "feat/other")).status, 409, "the confirmed branch must match");
  assert.ok(alive(w.pid));
  const r = await d.stop(tk, "feat/stop");
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(await exited(w), 143);
  assert.equal((await d.snapshot()).state, "empty", "the ticket file agrees");
});

// A8: the cmdline check refuses a pid that is not this checkout's land.mjs.
test("Stop refuses a foreign pid and signals nothing", { skip }, async () => {
  fresh();
  const f = foreign();
  const tk = put(1, f.pid, { branch: "feat/foreign" });
  const r = await new Deliveries({ checkout, env }).stop(tk, "feat/foreign");
  assert.equal(r.status, 409);
  assert.match(r.error, /not this checkout's land/);
  await new Promise((ok) => setTimeout(ok, 200));
  assert.ok(alive(f.pid), "the foreign process is untouched");
  assert.ok(existsSync(join(qdir, tk)));
});

test("Stop refuses landing and claimed rows before any signal", { skip }, async () => {
  fresh();
  const [a, b, leader] = [waiter(), waiter(), waiter()];
  const ta = put(1, a.pid, { branch: "feat/landing", state: "landing" });
  const tb = put(2, b.pid, { branch: "feat/claimed" });
  mkdirSync(`${lock}.batch`, { recursive: true });
  writeFileSync(join(`${lock}.batch`, tb), JSON.stringify({ state: "claimed", leader: ta, leaderPid: leader.pid }));
  const d = new Deliveries({ checkout, env });
  const s = await d.snapshot();
  assert.deepEqual(s.rows.map((r) => [r.branch, r.state, r.reason]), [["feat/landing", "landing", LINES.landing], ["feat/claimed", "claimed", LINES.claimed]]);
  assert.equal((await d.stop(ta, "feat/landing")).status, 409);
  assert.equal((await d.stop(tb, "feat/claimed")).status, 409);
  assert.ok(!existsSync(join(qdir, `${ta}.cancel`)), "no cancel sidecar written");
  assert.equal(JSON.parse(readFileSync(join(`${lock}.batch`, tb), "utf8")).state, "claimed", "claim untouched");
  assert.ok(alive(a.pid) && alive(b.pid));
});

// The process over HTTP: the relay's secret, the unconfigured line, /queue.
test("server: secret, unconfigured checkout, queue", { skip }, async () => {
  fresh();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const start = (extra) => {
    const p = spawn(process.execPath, [join(here, "server.mjs")], { env: { ...env, PICODE_EXT_PORT: String(port), PICODE_EXT_PROXY_SECRET: "s3cret", ...extra }, stdio: "ignore" });
    kids.push(p);
    return p;
  };
  const get = (path, secret) => new Promise((ok, fail) => {
    const tryOnce = (n) => {
      const req = request({ host: "127.0.0.1", port, path, headers: secret ? { "x-picode-proxy-secret": secret } : {} }, (res) => {
        let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => ok({ status: res.statusCode, body: JSON.parse(t) }));
      });
      req.on("error", (e) => (n > 0 ? setTimeout(() => tryOnce(n - 1), 100) : fail(e)));
      req.end();
    };
    tryOnce(30);
  });
  let p = start({ DELIVERIES_CHECKOUT: tmp });
  assert.equal((await get("/queue")).status, 403);
  const u = await get("/queue", "s3cret");
  assert.equal(u.body.state, "unconfigured");
  p.kill("SIGTERM"); await exited(p);
  p = start({ DELIVERIES_CHECKOUT: checkout });
  const q = await get("/queue", "s3cret");
  assert.equal(q.status, 200);
  assert.equal(q.body.state, "empty");
  assert.ok(Array.isArray(q.body.verdicts));
  p.kill("SIGTERM"); await exited(p);
});
