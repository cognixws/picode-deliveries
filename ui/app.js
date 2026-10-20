// The Deliveries page: the land queue, its red-main banner and recent
// verdicts. Everything it shows comes from the process (GET /queue); every
// change is a process call that runs the checkout's land-queue.mjs. A row,
// its ⋯ button, a right-click and Shift+F10 / the ContextMenu key open the
// same actions (ADR-0289, spec §3.4).
(async function () {
  const root = document.getElementById("root");
  const live = document.getElementById("live");
  const [proc, links, events, ctxDoor] = await Promise.all(["process", "links", "events", "context"].map((d) => picode.use(d)));
  await picode.use("theme"); // follows PiCode's light or dark
  const inDock = () => ctxDoor?.current()?.source === "dock";

  let snap = null, error = "", confirm = null, note = "", timer = 0, menu = null, stale = false, focusKeep = false, lastKind = "";
  const busy = new Map(); // ticket -> {kind, branch, prio, since}

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const say = (text) => { live.textContent = ""; setTimeout(() => { live.textContent = text; }, 30); };

  async function request(path, body) {
    if (!proc) throw new Error("The extension is off or its process is not running.");
    const r = await proc.request(path, body ? { method: "POST", body } : { method: "GET" });
    let d; try { d = JSON.parse(r.body); } catch { throw new Error("The extension returned an unreadable answer."); }
    if (r.status >= 400) throw Object.assign(new Error(d.error || "That did not work."), { status: r.status });
    return d;
  }

  // ---- reading -----------------------------------------------------------
  async function load() {
    clearTimeout(timer);
    try { snap = await request("/queue"); error = ""; } catch (e) { error = e.message; snap = null; }
    settle();
    root.setAttribute("aria-busy", "false");
    render();
    timer = setTimeout(load, busy.size ? 600 : 3000);
  }

  // A busy row stays busy until the ticket file agrees: a move until the
  // ticket carries the priority land-queue wrote, a stop until the ticket is
  // gone. Never a "done" before that.
  function settle() {
    if (!snap) return;
    for (const [ticket, b] of busy) {
      const row = snap.rows.find((r) => r.ticket === ticket);
      if (b.kind === "stop" && !row) { busy.delete(ticket); say(`${b.branch} stopped. It left the queue.`); continue; }
      if (b.kind === "move" && b.prio != null && (!row || row.prio === b.prio)) { busy.delete(ticket); say(`${b.branch} moved to position ${row ? row.order : "–"}.`); continue; }
      if (Date.now() - b.since > 30_000) {
        busy.delete(ticket);
        note = b.kind === "stop" ? `The stop was sent, but ${b.branch} has not left the queue yet.` : `The move of ${b.branch} has not shown in the queue yet.`;
      }
    }
  }

  // ---- drawing -----------------------------------------------------------
  const ICONS = {
    earlier: '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>',
    later: '<path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/>',
    first: '<path d="M3 2.5h10M8 14V6M3.5 10.5 8 6l4.5 4.5"/>',
    more: '<circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/>',
  };
  const icon = (n) => `<svg viewBox="0 0 16 16" aria-hidden="true" class="${n === "more" ? "fill" : ""}">${ICONS[n]}</svg>`;
  const MOVE_LABEL = { earlier: "Move earlier", later: "Move later", first: "First" };

  function rowHtml(r) {
    const b = busy.get(r.ticket);
    const acts = b
      ? `<span class="busy-label">${b.kind === "stop" ? "Stopping…" : "Moving…"}</span>`
      : ["earlier", "later", "first"].map((m) => `<button type="button" class="icon move" data-act="${m}" aria-label="${MOVE_LABEL[m]}: ${esc(r.branch)}" title="${MOVE_LABEL[m]}" ${r.actions.includes(m) ? "" : "disabled"}>${icon(m)}</button>`).join("")
        + (r.actions.includes("stop") ? `<button type="button" class="danger stop" data-act="stop" aria-label="Stop: ${esc(r.branch)}">Stop…</button>` : `<span class="stop-slot" aria-hidden="true"></span>`)
        + `<button type="button" class="icon" data-act="menu" aria-haspopup="menu" aria-label="More actions: ${esc(r.branch)}" title="More actions">${icon("more")}</button>`;
    const confirmHtml = confirm === r.ticket && !b ? `<li class="confirm" role="group" aria-label="Stop ${esc(r.branch)}?">
        <span>Stop <strong class="mono">${esc(r.branch)}</strong>? It leaves the queue and is not put back. The branch stays.</span>
        <span class="confirm-acts"><button type="button" class="danger-fill" data-act="stop-yes">Stop</button><button type="button" data-act="stop-no">Keep</button></span>
      </li>` : "";
    return `<li class="row${b ? " is-busy" : ""}" data-ticket="${esc(r.ticket)}" data-kind="row" tabindex="0" aria-busy="${b ? "true" : "false"}"
        aria-label="${r.order}. ${esc(r.branch)}, ${esc(r.state)}, ${esc(r.age)}, pid ${r.pid ?? "unknown"}${r.reason ? ". " + esc(r.reason) : ""}">
        <span class="ord" aria-hidden="true">${r.order}</span>
        <span class="main"><span class="branch mono">${esc(r.branch)}</span>${r.reason ? `<span class="reason">${esc(r.reason)}</span>` : ""}</span>
        <span class="metas"><span class="meta age">${esc(r.age)}</span><span class="meta pid mono"><span class="pid-word">pid </span>${r.pid ?? "–"}</span></span>
        <span class="chip st-${esc(r.state.replace(/[^a-z]/g, ""))}">${esc(r.state)}</span>
        <span class="acts">${acts}</span>
      </li>${confirmHtml}`;
  }

  function verdictHtml(v) {
    return `<li class="verdict" data-event="${esc(v.eventId)}" data-kind="verdict" tabindex="0" aria-label="${esc(v.state)}: ${esc(v.summary)}">
        <span class="chip v-${esc(v.state)}">${esc(v.state)}</span>
        <span class="summary">${esc(v.summary)}</span>
        <button type="button" class="icon" data-act="menu" aria-haspopup="menu" aria-label="More actions: ${esc(v.summary)}" title="More actions">${icon("more")}</button>
      </li>`;
  }

  function queueHtml() {
    if (error && /is off|not running/i.test(error)) return `<div class="notice" role="status"><span>Deliveries is turned off. Turn it on to read the queue.</span><button type="button" data-act="settings">Open Extensions</button></div>`;
    if (error) return `<div class="notice error" role="alert"><span>${esc(error)}</span><button type="button" data-act="retry">Retry</button></div>`;
    if (!snap) return `<p class="state-line is-busy" role="status">Reading the queue…</p>`;
    if (snap.state === "unconfigured") return `<div class="notice"><span>${esc(snap.line)}</span><button type="button" class="primary" data-act="settings">Open settings</button></div>`;
    if (snap.state === "error") return `<div class="notice error" role="alert"><span>${esc(snap.line)}</span><button type="button" data-act="retry">Retry</button></div>`;
    if (!snap.rows.length) return `<p class="state-line">${esc(snap.line)}</p>`;
    return `<div class="cols" aria-hidden="true"><span>#</span><span>Branch</span><span>Age</span><span>Pid</span><span>State</span><span></span></div>
      <ol class="rows" aria-label="Deliveries in queue order">${snap.rows.map(rowHtml).join("")}</ol>`;
  }

  function verdictsHtml() {
    if (!snap || snap.state === "unconfigured") return "";
    const list = snap.verdicts || [];
    return `<section class="verdicts" aria-labelledby="verdicts-h"><h2 id="verdicts-h">Recent verdicts</h2>
      ${list.length ? `<ul class="vlist">${list.map(verdictHtml).join("")}</ul>` : `<p class="state-line">No verdict yet.</p>`}</section>`;
  }

  function render() {
    // An open menu keeps its rows under it; the next close draws what changed.
    if (menu) { stale = true; return; }
    stale = false;
    const key = document.activeElement?.closest?.("[data-ticket],[data-event]");
    const focus = key ? { sel: key.dataset.ticket ? `[data-ticket="${CSS.escape(key.dataset.ticket)}"]` : `[data-event="${CSS.escape(key.dataset.event)}"]`, act: document.activeElement.dataset.act || "" } : null;
    root.classList.toggle("in-dock", inDock());
    const kind = error ? "error" : snap?.state || "loading";
    if (kind !== lastKind) { lastKind = kind; scrollTo(0, 0); }
    root.innerHTML = `${inDock() ? "" : `<h1 class="title">Deliveries</h1>`}
      ${snap?.banner ? `<div class="notice warn" role="status"><span>${esc(snap.banner)}</span></div>` : ""}
      ${note ? `<div class="notice error" role="alert"><span>${esc(note)}</span><button type="button" data-act="dismiss">Dismiss</button></div>` : ""}
      <section class="queue" aria-label="Queue">${queueHtml()}</section>
      ${verdictsHtml()}`;
    if (focus) {
      const host = root.querySelector(focus.sel);
      const target = host && ((focus.act && host.querySelector(`[data-act="${focus.act}"]:not([disabled])`)) || host);
      target?.focus({ preventScroll: true });
    }
    if (confirm && focusKeep) { focusKeep = false; root.querySelector('[data-act="stop-no"]')?.focus({ preventScroll: true }); }
  }

  // ---- actions -----------------------------------------------------------
  const rowOf = (ticket) => snap?.rows.find((r) => r.ticket === ticket);
  const verdictOf = (id) => snap?.verdicts.find((v) => v.eventId === id);

  async function copy(text, what) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* the frame may not hold clipboard-write */ }
    if (!ok) {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    say(ok ? `${what} copied.` : `${what} could not be copied. Select it and press Ctrl+C.`);
    if (!ok) { note = `${what} could not be copied. Select it and press Ctrl+C.`; render(); }
  }

  async function move(ticket, how) {
    const r = rowOf(ticket);
    if (!r || busy.has(ticket)) return;
    busy.set(ticket, { kind: "move", branch: r.branch, prio: null, since: Date.now() });
    note = ""; render();
    try {
      const d = await request("/move", { ticket, how });
      const b = busy.get(ticket);
      if (b) b.prio = d.prio;
    } catch (e) { busy.delete(ticket); note = e.message; }
    await load();
  }

  async function stop(ticket) {
    const r = rowOf(ticket);
    confirm = null;
    if (!r || busy.has(ticket)) return render();
    busy.set(ticket, { kind: "stop", branch: r.branch, since: Date.now() });
    note = ""; render();
    try { await request("/stop", { ticket, branch: r.branch }); } catch (e) { busy.delete(ticket); note = e.message; }
    await load();
  }

  function run(kind, id, act) {
    if (kind === "row") {
      const r = rowOf(id);
      if (!r) return;
      if (act === "earlier" || act === "later" || act === "first") return void move(id, act);
      if (act === "stop") { confirm = id; focusKeep = true; return render(); }
      if (act === "stop-yes") return void stop(id);
      if (act === "stop-no") { confirm = null; render(); return root.querySelector(`[data-ticket="${CSS.escape(id)}"]`)?.focus(); }
      if (act === "copy-branch") return void copy(r.branch, "Branch");
      if (act === "copy-pid") return void copy(String(r.pid ?? ""), "Pid");
    }
    if (kind === "verdict") {
      const v = verdictOf(id);
      if (!v) return;
      if (act === "copy-summary") return void copy(v.summary, "Summary");
      if (act === "copy-event") return void copy(v.eventId, "Event id");
    }
  }

  // ---- the one action model: ⋯, right-click, Shift+F10, ContextMenu ------
  function menuItems(kind, id) {
    if (kind === "verdict") return [{ act: "copy-summary", label: "Copy summary" }, { act: "copy-event", label: "Copy event id" }];
    const r = rowOf(id);
    if (!r || busy.has(id)) return [];
    const items = ["earlier", "later", "first"].map((m) => ({ act: m, label: MOVE_LABEL[m], disabled: !r.actions.includes(m) }));
    if (r.actions.includes("stop")) items.push({ sep: true }, { act: "stop", label: "Stop…", danger: true });
    items.push({ sep: true }, { act: "copy-branch", label: "Copy branch" }, { act: "copy-pid", label: "Copy pid" });
    return items;
  }

  function closeMenu(refocus) {
    if (!menu) return;
    const { el, anchor, kind, id } = menu;
    menu = null;
    el.remove();
    if (stale) render();
    if (!refocus) return;
    const host = root.querySelector(kind === "row" ? `[data-ticket="${CSS.escape(id)}"]` : `[data-event="${CSS.escape(id)}"]`);
    const target = anchor?.isConnected ? anchor : host?.querySelector('[data-act="menu"]') || host;
    target?.focus({ preventScroll: true });
  }

  function openMenu(host, at) {
    const kind = host.dataset.kind, id = host.dataset.ticket || host.dataset.event;
    const items = menuItems(kind, id);
    closeMenu(false);
    if (!items.length) return;
    const el = document.createElement("div");
    el.className = "menu";
    el.setAttribute("role", "menu");
    el.setAttribute("aria-label", kind === "row" ? `Actions: ${rowOf(id)?.branch || ""}` : "Verdict actions");
    el.innerHTML = items.map((it) => it.sep ? `<div class="sep" role="separator"></div>`
      : `<button type="button" role="menuitem" data-act="${it.act}" class="${it.danger ? "danger" : ""}" ${it.disabled ? 'aria-disabled="true"' : ""} tabindex="-1">${esc(it.label)}</button>`).join("");
    // A short frame (the dock) gets compact items so the whole menu fits.
    if (innerHeight < 260) el.classList.add("compact");
    document.body.appendChild(el);
    const anchor = host.querySelector('[data-act="menu"]') || host;
    menu = { el, kind, id, anchor: at ? host : anchor };
    const box = el.getBoundingClientRect();
    let x, y;
    if (at) { x = at.x; y = at.y; } else {
      // Below the trigger, else above it, else beside it: never over it.
      const a = anchor.getBoundingClientRect();
      x = a.right - box.width; y = a.bottom + 4;
      if (y + box.height > innerHeight - 4) y = a.top - box.height - 4;
      if (y < 4) { x = a.left - box.width - 4; y = a.top + a.height / 2 - box.height / 2; }
    }
    el.style.left = Math.max(4, Math.min(x, innerWidth - box.width - 4)) + "px";
    el.style.top = Math.max(4, Math.min(y, innerHeight - box.height - 4)) + "px";
    enabled()[0]?.focus();
  }
  const enabled = () => menu ? [...menu.el.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')] : [];

  document.addEventListener("keydown", (e) => {
    if (menu) {
      const list = enabled(), i = list.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); return closeMenu(true); }
      if (e.key === "Tab") return closeMenu(false);
      if (e.key === "ArrowDown") { e.preventDefault(); return list[(i + 1) % list.length]?.focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); return list[(i - 1 + list.length) % list.length]?.focus(); }
      if (e.key === "Home") { e.preventDefault(); return list[0]?.focus(); }
      if (e.key === "End") { e.preventDefault(); return list[list.length - 1]?.focus(); }
      return;
    }
    if (e.key === "Escape" && confirm) { e.preventDefault(); return run("row", confirm, "stop-no"); }
    const host = e.target.closest?.("[data-kind]");
    if (!host || e.target !== host) return;
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") { e.preventDefault(); openMenu(host); }
  });

  document.addEventListener("contextmenu", (e) => {
    const host = e.target.closest?.("[data-kind]");
    if (!host) return; // the background keeps no host menu: the frame is its own origin
    const sel = getSelection();
    if (sel && !sel.isCollapsed && host.contains(sel.anchorNode)) return; // native copy of selected text
    e.preventDefault();
    if (menu && menu.id === (host.dataset.ticket || host.dataset.event)) return; // the keydown already opened it
    const keyboard = e.clientX === 0 && e.clientY === 0;
    openMenu(host, keyboard ? null : { x: e.clientX, y: e.clientY });
  });

  // The pointer moves focus, so one item is highlighted at a time.
  document.addEventListener("mouseover", (e) => {
    const item = menu && e.target.closest?.('.menu [role="menuitem"]');
    if (item && item.getAttribute("aria-disabled") !== "true" && document.activeElement !== item) item.focus({ preventScroll: true });
  });
  document.addEventListener("mousedown", (e) => { if (menu && !menu.el.contains(e.target)) closeMenu(false); });
  addEventListener("blur", () => closeMenu(false));
  addEventListener("resize", () => closeMenu(false));

  document.addEventListener("click", (e) => {
    const item = e.target.closest?.('.menu [role="menuitem"]');
    if (item) {
      e.preventDefault();
      if (item.getAttribute("aria-disabled") === "true") return;
      const { kind, id } = menu;
      closeMenu(true);
      return run(kind, id, item.dataset.act);
    }
    const b = e.target.closest?.("button[data-act]");
    if (!b || b.disabled) return;
    e.preventDefault();
    const act = b.dataset.act;
    if (act === "retry") { error = ""; snap = null; render(); return void load(); }
    if (act === "dismiss") { note = ""; return render(); }
    if (act === "settings") return void links?.open(new URL("/#/extensions/deliveries", location.href).href);
    const host = b.closest("[data-kind]") || root.querySelector(`[data-ticket="${CSS.escape(confirm || "")}"]`);
    if (act === "menu" && host) return menu && menu.anchor === b ? closeMenu(true) : openMenu(host);
    if (act === "stop-yes" || act === "stop-no") return run("row", confirm, act);
    if (host) run(host.dataset.kind, host.dataset.ticket || host.dataset.event, act);
  });

  if (events) events.onChange(() => void load());
  if (ctxDoor) ctxDoor.onChange(() => render());
  render();
  await load();
})().catch(() => {
  const root = document.getElementById("root");
  root.setAttribute("aria-busy", "false");
  root.textContent = "The page could not start. Reopen it from Apps.";
});
