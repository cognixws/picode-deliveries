# Deliveries

A COGNIX[WS] extension that shows the land queue of a PiCode checkout in
the bottom dock (door G, `contributes.dockPanels`, apiVersion 10): who
waits, in what order, and the recent verdicts. The same page is an Apps
tile, which is the phone face (the dock stays closed below 768px).

Specification: `docs/plans/delivery-dock-spec.md` in the PiCode
repository (slice F2, decisions D1–D8).

## What it does

| Part | Does | Does not |
|---|---|---|
| Page (`ui/`) | One row per live ticket in queue order: order, branch, relative age, pid, state (`preparing`, `ready`, `landing`, `claimed`, or the raw state). Red-main banner. Recent verdicts with Copy summary / Copy event id | Navigate the host, open the Inbox, drag |
| Process (`server.mjs`, `lib/`) | Reads the queue folder, `var/land-red`, `var/job-events` and `var/completion-receipts` of the checkout. Moves and stops through the checkout's `scripts/land-queue.mjs` | Rename, write or delete a ticket or sidecar, send a signal itself, run git, deploy, write `var/land-red`, read PiCode's session |

Every change is one call to `scripts/land-queue.mjs` (`move` or `drop`):
one mutator, never copied. Before `drop`, the process checks that the
ticket name's pid and the body's pid agree and that the pid's command line
runs this checkout's `scripts/land.mjs`. Anything else is refused and
nothing is signalled.

Stop is offered only on a waiting ticket (`preparing` or `ready`) with no
batch claim. A landing row says "Holding main. Wait for the verdict."; a
claimed row says "In a batch. Stopping it does not take it out." Moves
stay on every row; on a landing row a move is stored and does not take
the lock.

No agent tool, MCP server or command: a person uses the page, an agent
does not (D1). No Host API permission.

## Setup

Install from this folder (Extensions ▸ Install, or a git URL once
published). Turn it on for the instance, then set **PiCode checkout** in
its settings to the repository root (for example `/home/you/picode`). The
queue is `/tmp/picode-land.lock.queue` unless the daemon's environment
sets `LAND_LOCK`, as for `land.mjs`.

## States

| State | Line | Action |
|---|---|---|
| No live ticket | No delivery is waiting. | None |
| First read | Reading the queue… | None |
| Queue folder missing | No delivery is waiting. | None |
| Unreadable folder, every ticket bad, `flock` missing | The queue could not be read. | Retry |
| One bad ticket | Skipped | None |
| Process stopped or extension off | The host's line | Retry |
| Checkout not set | Choose the PiCode checkout this page follows. | Open settings |

A Stop or move shows a busy row ("Stopping…", "Moving…") until the ticket
file agrees: a move until the ticket carries the priority `land-queue.mjs`
wrote, a stop until the ticket is gone. After 30 seconds without that, the
row is released and a notice says the file does not agree yet.

## Context menu (ADR-0289)

One action model for the row, its ⋯ button, a right-click, Shift+F10 and
the ContextMenu key. Evidence: scratch Chromium 2026-10-20, desktop
1440×900 (Apps page and dock) and phone 390×844 (Apps tile).

| Region | Conditions | Menu or absence | Accessible entry | Evidence |
|---|---|---|---|---|
| Queue row | Stop allowed | Move earlier, Move later, First, Stop…, Copy branch, Copy pid | ⋯, Shift+F10, ContextMenu key, right-click | Desktop Apps and dock, light and dark: ⋯ and Shift+F10 on a ready row; in the dock (about 200px) the menu uses compact items, stays inside the frame and never covers its trigger. Phone: ⋯ on a preparing row. Moves at an end are shown disabled |
| Queue row | Landing or claimed | Move earlier, Move later, First, Copy branch, Copy pid. No Stop; the reason is on the row | ⋯, Shift+F10, right-click | Desktop: Shift+F10 on the landing row (Escape closes, focus returns); right-click on the claimed row |
| Confirm | open | No second menu. Stop and Keep; Escape keeps | Stop, Keep | Desktop and phone: text names the branch; Keep left the ticket, Stop removed it |
| Empty | no row | No application menu | None | Desktop dock and phone |
| Error | unreadable | No menu. Retry is the button | Retry | Desktop dock: queue folder made unreadable, Retry recovered after access returned |
| Verdict row | present | Copy summary, Copy event id. Opens nothing in the host | ⋯, Shift+F10, right-click | Desktop: Copy event id pasted back the fixture id |
| Page background | any | No host menu. The frame is its own origin | None | The page binds no background menu |
| Text of a branch name | selection | Native menu and copy. No extra rows | Native | A selection inside the row leaves the native menu |

## Checks

```bash
npm run lint   # syntax, manifest dock rules, no import of PiCode internal/ or web/, no signal/write/git in the process
npm test       # logic + the process against a checkout's real land-queue.mjs (PICODE_CHECKOUT, default ../picode)
```

## License

Apache-2.0.
