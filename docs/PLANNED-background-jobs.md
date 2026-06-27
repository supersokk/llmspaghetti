# ⏸ PLANNED — Background task delegation (local GPU does grunt work)

> Status: idea, not designed in detail, definitely not built.
> Raised 2026-06-27. Capture so it's not lost; do NOT build until the core
> multi-model routing loop is proven and stable.

## The idea

While you work interactively (chatting/coding — possibly against a cloud model
like Claude), you delegate a side-task to a **local** model that runs in the
**background**. You don't wait for it and you don't spend cloud tokens on it.
When it's done, the result is delivered back to you.

Example: you're coding with Claude. You say "document this module." Instead of
spending Claude tokens and blocking the conversation, the task is routed to a
local model that generates the docs in the background while you keep working.

## Why it's compelling

- **Saves cloud tokens** — grunt work (docs, summaries, test scaffolding) goes
  to the local model you already paid for in electricity, not per-token.
- **No waiting** — the interactive thread stays free; the slow job runs async.
- **Uses otherwise-idle local hardware** — your homelab GPU earns its keep
  even when you're "really" using a cloud model.

## The critical constraint (must be explicit)

"Keep working freely" only holds when **foreground ≠ background resource.**

- Foreground = **cloud** (Claude), background = **local GPU** → ✅ works, this
  is the sweet spot.
- Foreground = **local**, background = **local**, single GPU → ❌ the background
  job occupies the GPU; foreground requests queue behind it. You wait anyway.

So this feature is specifically *"cloud foreground + local background,"* OR it
requires enough local compute to run two models at once (second GPU, or a small
foreground model + the background job on the big one). The UI must not promise
"keep working freely" in the single-GPU all-local case — that's a lie there.

## Why it fights the current architecture

Chat is **synchronous** request→response. Background jobs need:

1. **A job queue** — submit, track, cancel. New subsystem.
2. **Async result delivery** — Open WebUI has no native "your job is done, here's
   the output" push. Options:
   - Inject a new assistant message into the thread when the job completes
     (needs Open WebUI write access / a pipe function)
   - A separate "Jobs" panel in Cockpit (decoupled from chat, simpler to build)
   - A notification (browser/desktop) — most work, best UX
3. **Trigger syntax** — how does the user mark a request as background?
   `/bg <task>`? A toggle? Router auto-detecting "this is a long batch task"
   (risky — don't guess on something that changes where the answer goes).

None of these exist. This is a Phase-2+ subsystem, not a routing tweak.

## Honest sequencing

Do NOT start this until:
- Multi-model routing is proven (router picks different models per intent)
- The visible "answered by X" tag exists (you need to see job provenance too)
- The Models tab can show what's loaded / busy (jobs need a resource view)

Capture now, build much later. The differentiation is real; the complexity is
also real. It is not a Phase-1 feature.

## Related
- [PLANNED-model-management.md](PLANNED-model-management.md) — jobs need to know what's loaded/busy
- [PLANNED-routing-fixture-flywheel.md](PLANNED-routing-fixture-flywheel.md) — learning loop, separate concern
- TODO Phase 3 (Models tab — VRAM budget / load state)
