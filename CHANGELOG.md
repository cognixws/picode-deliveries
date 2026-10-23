# Changelog

## 0.2.0 — 2026-10-23

- **Running now**: `make close`, `make ci-scoped` and `make ci` in any worktree, waiting for a CI slot or running, with their branch and age. Read from the checkout's delivery receipts (ADR-0170, amended 2026-10-23); a run whose process is gone is not shown.
- Each land in the queue says its step: waiting its turn, running make close, merging onto main and running make ci, moving main, checking main.
- Recent verdicts also list finished worktree gates ("make close passed: feat/x · 2 min 05 s"), up to eight in all.

## 0.1.1 — 2026-10-23

- Copy names the product: the description, the setting (now **Source folder**) and its messages say COGNIX[WS] instead of the code name PiCode. The saved folder is kept.

## 0.1.0 — 2026-10-20

- The land queue of a PiCode checkout in the bottom dock and as an Apps tile: order, branch, age, pid and state per delivery, the red-main banner and recent verdicts.
- Move earlier, Move later and First; Stop on a delivery that is still waiting, after a confirm that names the branch. Every change runs the checkout's `scripts/land-queue.mjs`.
- One menu for the row, its ⋯ button, a right-click, Shift+F10 and the ContextMenu key.
