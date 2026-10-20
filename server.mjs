// The extension's process: the page's relay (proxy secret only), the queue
// reads and the two changes, each through the checkout's land-queue.mjs.
// It reads its one setting through the Host API and asks for nothing else.
import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";
import { Deliveries, checkoutProblem } from "./lib/deliveries.mjs";

const env = process.env;
const log = (m) => console.error("[deliveries]", m);

function hostRequest(path) {
  return new Promise((done, fail) => {
    const base = new URL(env.PICODE_URL);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) return fail(new Error("PiCode Host API must use loopback."));
    const target = new URL(path, base);
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(target, { method: "GET", rejectUnauthorized: false, headers: { "X-PiCode-Extension-Token": env.PICODE_EXT_TOKEN } }, (res) => {
      const chunks = [];
      res.on("data", (b) => chunks.push(b));
      res.on("error", fail);
      res.on("end", () => {
        try { done({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") }); } catch (e) { fail(e); }
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error("Host API timeout")));
    req.on("error", fail);
    req.end();
  });
}

// The checkout comes from the extension's settings; DELIVERIES_CHECKOUT is
// for a run outside PiCode (tests, a person at a terminal).
async function checkout() {
  if (env.DELIVERIES_CHECKOUT) return env.DELIVERIES_CHECKOUT;
  if (!env.PICODE_URL) return "";
  const r = await hostRequest("/api/ext/v1/settings");
  return String(r.body?.values?.checkout || "").trim();
}

let current = null;
async function deliveries() {
  const dir = await checkout();
  const problem = checkoutProblem(dir);
  if (problem) { current = null; return { problem }; }
  if (!current || current.checkout !== dir.replace(/\/+$/, "")) current = new Deliveries({ checkout: dir });
  return { d: current };
}

const equal = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

function readBody(req) {
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
    req.on("data", (b) => { size += b.length; if (size <= 4096) chunks.push(b); });
    req.on("end", () => { try { done(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { done({}); } });
  });
}

const MOVES = new Set(["earlier", "later", "first"]);

const server = http.createServer(async (req, res) => {
  const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  if (!equal(req.headers["x-picode-proxy-secret"], env.PICODE_EXT_PROXY_SECRET)) return send(403, { error: "Use the PiCode process relay." });
  const path = new URL(req.url, "http://localhost").pathname;
  try {
    const { d, problem } = await deliveries();
    if (req.method === "GET" && path === "/queue") {
      if (problem) return send(200, { state: "unconfigured", line: problem, banner: "", rows: [], verdicts: [] });
      return send(200, await d.snapshot());
    }
    if (req.method === "POST" && (path === "/move" || path === "/stop")) {
      if (problem) return send(409, { error: problem });
      const body = await readBody(req);
      const ticket = String(body.ticket || "");
      const r = path === "/move"
        ? (MOVES.has(body.how) ? await d.move(ticket, body.how) : { status: 400, error: "Unknown move." })
        : await d.stop(ticket, String(body.branch || ""));
      if (r.status !== 200) log(`${path} ${ticket}: ${r.error}`);
      return r.status === 200 ? send(200, r.body) : send(r.status, { error: r.error });
    }
    send(404, { error: "This action is unavailable." });
  } catch (e) {
    log(e.stack || e.message);
    send(500, { error: "The queue could not be read." });
  }
});

server.listen(Number(env.PICODE_EXT_PORT), "127.0.0.1");
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
